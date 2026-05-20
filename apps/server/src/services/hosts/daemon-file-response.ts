import { Buffer } from "node:buffer";
import type { HostDaemonCommandResultByType } from "@bb/host-daemon-contract";
import { ApiError } from "../../errors.js";

const OCTET_STREAM_MIME_TYPE = "application/octet-stream";

export type DaemonFileReadResult =
  | HostDaemonCommandResultByType["host.read_file"]
  | HostDaemonCommandResultByType["host.read_file_relative"];

interface CreateDaemonFileContentResponseOptions {
  headers?: HeadersInit;
}

function buildFileContentHeaders(
  result: DaemonFileReadResult,
  options: CreateDaemonFileContentResponseOptions,
): Headers {
  const headers = new Headers(options.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", result.mimeType ?? OCTET_STREAM_MIME_TYPE);
  }
  return headers;
}

export function decodeDaemonFileContent(
  result: DaemonFileReadResult,
): ArrayBuffer {
  const bytes =
    result.contentEncoding === "utf8"
      ? Buffer.from(result.content, "utf8")
      : Buffer.from(result.content, "base64");
  const view = Uint8Array.from(bytes);
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

export function createDaemonFileContentResponse(
  result: DaemonFileReadResult,
  options: CreateDaemonFileContentResponseOptions = {},
): Response {
  return new Response(decodeDaemonFileContent(result), {
    status: 200,
    headers: buildFileContentHeaders(result, options),
  });
}

export function remapDaemonFileRouteError(error: unknown): never {
  if (!(error instanceof ApiError)) {
    throw error;
  }

  if (error.body.code === "ENOENT") {
    throw new ApiError(
      404,
      error.body.code,
      error.body.message,
      error.body.retryable,
    );
  }
  if (error.body.code === "invalid_path") {
    throw new ApiError(
      400,
      error.body.code,
      error.body.message,
      error.body.retryable,
    );
  }
  if (error.body.code === "file_too_large") {
    throw new ApiError(
      413,
      error.body.code,
      error.body.message,
      error.body.retryable,
    );
  }
  throw error;
}
