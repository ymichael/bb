import { isUtf8 } from "node:buffer";
import fs from "node:fs/promises";
import mimeTypes from "mime-types";
import { CommandDispatchError } from "../command-dispatch-support.js";
import { isFsErrorWithCode } from "../fs-errors.js";

const IMAGE_FILE_SIZE_LIMIT_BYTES = 10 * 1024 * 1024;
const NON_IMAGE_FILE_SIZE_LIMIT_BYTES = 25 * 1024 * 1024;
const UTF8_TEXT_MIME_TYPES = new Set([
  "application/ecmascript",
  "application/javascript",
  "application/json",
  "application/ld+json",
  "application/sql",
  "application/toml",
  "application/typescript",
  "application/x-httpd-php",
  "application/x-sh",
  "application/x-typescript",
  "application/xml",
  "application/x-yaml",
  "application/yaml",
  "image/svg+xml",
]);

type FileContentEncoding = "base64" | "utf8";

export interface ReadFileForTransportResult {
  content: string;
  contentEncoding: FileContentEncoding;
  mimeType?: string;
  path: string;
  sizeBytes: number;
}

function isBinaryImageMimeType(mimeType?: string): boolean {
  return Boolean(
    mimeType &&
    mimeType.startsWith("image/") &&
    mimeType !== "image/svg+xml",
  );
}

function getFileSizeLimitBytes(mimeType?: string): number {
  return isBinaryImageMimeType(mimeType)
    ? IMAGE_FILE_SIZE_LIMIT_BYTES
    : NON_IMAGE_FILE_SIZE_LIMIT_BYTES;
}

function isUtf8TextMimeType(mimeType?: string): boolean {
  if (!mimeType) {
    return false;
  }
  return mimeType.startsWith("text/") || UTF8_TEXT_MIME_TYPES.has(mimeType);
}

function getContentEncoding(
  fileContents: Buffer,
  mimeType?: string,
): FileContentEncoding {
  if (isBinaryImageMimeType(mimeType)) {
    return "base64";
  }
  if (isUtf8TextMimeType(mimeType) || isUtf8(fileContents)) {
    return "utf8";
  }
  return "base64";
}

export async function readFileForTransport(
  resolvedPath: string,
  resultPath: string,
): Promise<ReadFileForTransportResult> {
  try {
    const stat = await fs.stat(resolvedPath);
    if (stat.isDirectory()) {
      throw new CommandDispatchError(
        "invalid_path",
        "Path is a directory, not a file",
      );
    }

    const mimeType = mimeTypes.lookup(resultPath) || undefined;
    const fileSizeLimitBytes = getFileSizeLimitBytes(mimeType);
    if (stat.size > fileSizeLimitBytes) {
      throw new CommandDispatchError(
        "file_too_large",
        `File size ${stat.size} bytes exceeds the ${Math.floor(fileSizeLimitBytes / (1024 * 1024))} MB limit`,
      );
    }

    const fileContents = await fs.readFile(resolvedPath);
    const contentEncoding = getContentEncoding(fileContents, mimeType);
    return {
      path: resultPath,
      content:
        contentEncoding === "utf8"
          ? fileContents.toString("utf8")
          : fileContents.toString("base64"),
      contentEncoding,
      ...(mimeType ? { mimeType } : {}),
      sizeBytes: stat.size,
    };
  } catch (error) {
    if (isFsErrorWithCode(error, "ENOENT")) {
      throw new CommandDispatchError(
        "ENOENT",
        `Path does not exist: ${resultPath}`,
      );
    }
    throw error;
  }
}
