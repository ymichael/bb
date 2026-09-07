import { Buffer } from "node:buffer";
import { promisify } from "node:util";
import {
  brotliCompress,
  constants as zlibConstants,
  gzip as gzipCompress,
} from "node:zlib";
import type { Context, MiddlewareHandler, Next } from "hono";
import { rankAcceptedAssetEncodings } from "./asset-content-encoding.js";

const brotliCompressAsync = promisify(brotliCompress);
const gzipCompressAsync = promisify(gzipCompress);

const API_RESPONSE_COMPRESSION_MIN_BYTES = 1_024;

const API_BROTLI_QUALITY = 4;

const API_RESPONSE_ENCODINGS = [
  {
    encoding: "br",
    compress: (bytes: Buffer) =>
      brotliCompressAsync(bytes, {
        params: {
          [zlibConstants.BROTLI_PARAM_QUALITY]: API_BROTLI_QUALITY,
          [zlibConstants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
        },
      }),
  },
  {
    encoding: "gzip",
    compress: (bytes: Buffer) => gzipCompressAsync(bytes),
  },
] as const;

const BUFFERED_API_JSON_PATH_PATTERN =
  /^\/api\/v1\/(?!plugins\/[^/]+\/http(?:\/|$))/u;
const NO_TRANSFORM_PATTERN = /(?:^|,)\s*no-transform\s*(?:,|$)/iu;

function isBufferedApiJsonResponse(context: Context): boolean {
  if (context.req.method === "HEAD") {
    return false;
  }
  if (!BUFFERED_API_JSON_PATH_PATTERN.test(context.req.path)) {
    return false;
  }
  const response = context.res;
  if (response.body === null || response.status === 204) {
    return false;
  }
  const headers = response.headers;
  if (headers.has("content-encoding") || headers.has("transfer-encoding")) {
    return false;
  }
  const contentType = headers.get("content-type");
  if (contentType === null || !/^application\/json\b/iu.test(contentType)) {
    return false;
  }
  const cacheControl = headers.get("cache-control");
  return cacheControl === null || !NO_TRANSFORM_PATTERN.test(cacheControl);
}

function appendVaryAcceptEncoding(headers: Headers): void {
  const existing = headers.get("vary");
  if (
    existing !== null &&
    existing
      .split(",")
      .some((value) => value.trim().toLowerCase() === "accept-encoding")
  ) {
    return;
  }
  headers.append("vary", "Accept-Encoding");
}

async function compressBufferedApiJsonResponse(
  context: Context,
): Promise<void> {
  const original = context.res;
  const bytes = Buffer.from(await original.arrayBuffer());
  let body: Uint8Array<ArrayBuffer> = new Uint8Array(bytes);
  let contentEncoding: string | null = null;
  const compressible = bytes.length >= API_RESPONSE_COMPRESSION_MIN_BYTES;
  if (compressible) {
    const candidate = rankAcceptedAssetEncodings(
      context.req.header("accept-encoding"),
      API_RESPONSE_ENCODINGS,
    )[0];
    if (candidate !== undefined) {
      body = new Uint8Array(await candidate.compress(bytes));
      contentEncoding = candidate.encoding;
    }
  }

  context.res = new Response(body, {
    headers: original.headers,
    status: original.status,
    statusText: original.statusText,
  });
  const headers = context.res.headers;
  headers.set("content-length", String(body.byteLength));
  if (compressible) {
    appendVaryAcceptEncoding(headers);
  }
  if (contentEncoding !== null) {
    headers.set("content-encoding", contentEncoding);
  }
}

export function apiJsonCompression(): MiddlewareHandler {
  return async (context: Context, next: Next) => {
    await next();
    if (!isBufferedApiJsonResponse(context)) {
      return;
    }
    await compressBufferedApiJsonResponse(context);
  };
}
