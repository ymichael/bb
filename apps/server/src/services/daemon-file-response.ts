import { Buffer } from "node:buffer";
import type { HostDaemonCommandResultByType } from "@bb/host-daemon-contract";
import { ApiError } from "../errors.js";

const OCTET_STREAM_MIME_TYPE = "application/octet-stream";

export type DaemonFileReadResult = HostDaemonCommandResultByType["host.read_file"];

function buildFileContentHeaders(
  result: DaemonFileReadResult,
): HeadersInit {
  return {
    "content-type": result.mimeType ?? OCTET_STREAM_MIME_TYPE,
    "x-bb-content-encoding": result.contentEncoding,
    "x-bb-size-bytes": String(result.sizeBytes),
  };
}

function decodeFileContent(result: DaemonFileReadResult): ArrayBuffer {
  const bytes = result.contentEncoding === "utf8"
    ? Buffer.from(result.content, "utf8")
    : Buffer.from(result.content, "base64");
  return Uint8Array.from(bytes).buffer;
}

export function createDaemonFileContentResponse(
  result: DaemonFileReadResult,
): Response {
  return new Response(decodeFileContent(result), {
    status: 200,
    headers: buildFileContentHeaders(result),
  });
}

export function remapDaemonFileRouteError(error: unknown): never {
  if (!(error instanceof ApiError)) {
    throw error;
  }

  if (error.body.code === "ENOENT") {
    throw new ApiError(404, error.body.code, error.body.message, error.body.retryable);
  }
  if (error.body.code === "invalid_path") {
    throw new ApiError(400, error.body.code, error.body.message, error.body.retryable);
  }
  if (error.body.code === "file_too_large") {
    throw new ApiError(413, error.body.code, error.body.message, error.body.retryable);
  }
  throw error;
}
