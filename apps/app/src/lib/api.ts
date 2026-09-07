import { extractErrorMessage, toRecord } from "@bb/core-ui";
import type { SystemVoiceTranscriptionResponse } from "@bb/server-contract";
import { apiClient, toRelativeUrl } from "./api-server";
import { appSurfaceRequestInit } from "./app-surface";
import {
  buildFilePreview,
  normalizeFilePreviewMimeType,
  type FilePreview,
  type FilePreviewTarget,
} from "@bb/client-core";
import {
  buildThreadHostFileContentUrl,
  buildThreadStorageContentUrl,
} from "./file-content-urls";

const HTML_DOCUMENT_PATTERN = /<!doctype html|<html[\s>]/i;
const ERROR_EXTRACT_OPTS = {
  legacyKeys: ["detail"] as const,
};

function normalizeErrorText(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

export function requestOptions(signal?: AbortSignal) {
  return signal ? { init: { signal } } : undefined;
}

export class HttpError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly body?: unknown;

  constructor(args: {
    status: number;
    message: string;
    code?: string;
    body?: unknown;
  }) {
    super(`HTTP ${args.status}: ${args.message}`);
    this.name = "HttpError";
    this.status = args.status;
    this.code = args.code;
    this.body = args.body;
  }
}

function deriveHttpErrorMessage(
  status: number,
  statusText: string,
  rawBody: string,
  contentType: string | null,
): string {
  const normalized = normalizeErrorText(rawBody);
  if (normalized.length === 0) {
    return statusText || "Request failed";
  }
  const shouldParseAsJson =
    (contentType?.includes("application/json") ?? false) ||
    normalized.startsWith("{") ||
    normalized.startsWith("[");
  if (shouldParseAsJson) {
    try {
      const parsed = JSON.parse(normalized) as unknown;
      const message = extractErrorMessage(parsed, ERROR_EXTRACT_OPTS);
      if (message) {
        return message;
      }
    } catch {}
  }
  if (HTML_DOCUMENT_PATTERN.test(normalized)) {
    if (status === 401 || status === 403) {
      return "Authentication failed";
    }
    return statusText || "Request failed";
  }
  return (
    (extractErrorMessage(normalized, ERROR_EXTRACT_OPTS) ?? statusText) ||
    "Request failed"
  );
}

function parseHttpErrorBody(
  rawBody: string,
  contentType: string | null,
): unknown | undefined {
  const normalized = normalizeErrorText(rawBody);
  if (normalized.length === 0) {
    return undefined;
  }
  const shouldParseAsJson =
    (contentType?.includes("application/json") ?? false) ||
    normalized.startsWith("{") ||
    normalized.startsWith("[");
  if (!shouldParseAsJson) {
    return undefined;
  }
  try {
    return JSON.parse(normalized) as unknown;
  } catch {
    return undefined;
  }
}

function extractErrorCode(value: unknown): string | undefined {
  const record = toRecord(value);
  if (!record) {
    return undefined;
  }
  return typeof record.code === "string" && record.code.trim().length > 0
    ? record.code
    : undefined;
}

async function throwHttpError(res: Response): Promise<never> {
  const rawBody = await res.text().catch(() => "");
  const contentType = res.headers.get("content-type");
  const message = deriveHttpErrorMessage(
    res.status,
    res.statusText,
    rawBody,
    contentType,
  );
  const body = parseHttpErrorBody(rawBody, contentType);
  throw new HttpError({
    status: res.status,
    message,
    code: extractErrorCode(body),
    body,
  });
}

async function requestResponse(
  responsePromise: Promise<Response>,
): Promise<Response> {
  const res = await responsePromise;
  if (!res.ok) {
    await throwHttpError(res);
  }
  return res;
}

export async function request<T>(
  responsePromise: Promise<Response>,
): Promise<T> {
  const res = await requestResponse(responsePromise);
  const text = await res.text();
  return JSON.parse(text) as T;
}

async function loadFilePreview(
  target: FilePreviewTarget,
  signal?: AbortSignal,
): Promise<FilePreview> {
  const response = await requestResponse(
    fetch(
      target.url,
      appSurfaceRequestInit({
        method: "GET",
        signal,
      }),
    ),
  );
  const contentBytes = new Uint8Array(await response.arrayBuffer());
  return buildFilePreview({
    contentBytes,
    mimeType: normalizeFilePreviewMimeType(
      response.headers.get("content-type"),
    ),
    name: target.name,
    path: target.path,
    url: target.url,
  });
}

async function postMultipart<T>(
  url: URL,
  file: File,
  signal?: AbortSignal,
  fields?: Record<string, string>,
): Promise<T> {
  const formData = new FormData();
  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      formData.set(key, value);
    }
  }
  formData.set("file", file, file.name);
  const res = await fetch(
    toRelativeUrl(url),
    appSurfaceRequestInit({
      method: "POST",
      body: formData,
      signal,
    }),
  );
  if (!res.ok) {
    await throwHttpError(res);
  }
  const text = await res.text();
  return JSON.parse(text) as T;
}

export async function transcribeVoiceInput(
  file: File,
  prompt?: string,
  signal?: AbortSignal,
): Promise<SystemVoiceTranscriptionResponse> {
  const trimmedPrompt = prompt?.trim();
  return postMultipart<SystemVoiceTranscriptionResponse>(
    apiClient.system["voice-transcription"].$url(),
    file,
    signal,
    trimmedPrompt ? { prompt: trimmedPrompt } : undefined,
  );
}

export async function getThreadStorageFilePreview(
  id: string,
  path: string,
  signal?: AbortSignal,
): Promise<FilePreview> {
  return loadFilePreview(
    {
      path,
      url: buildThreadStorageContentUrl(id, path),
    },
    signal,
  );
}

export async function getThreadHostFilePreview(
  id: string,
  path: string,
  signal?: AbortSignal,
): Promise<FilePreview> {
  return loadFilePreview(
    {
      name: path.split("/").at(-1),
      path,
      url: buildThreadHostFileContentUrl(id, path),
    },
    signal,
  );
}
