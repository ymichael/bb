import { HttpError } from "./api";
import { buildThreadStorageContentUrl } from "./file-content-urls";

const READ_TYPE = "bb-status:read";
const WRITE_TYPE = "bb-status:write";
const RESULT_TYPE = "bb-status:result";

export interface IframeStatusBridgeRequest {
  id: number;
  type: "bb-status:read" | "bb-status:write";
  path: string;
  data?: unknown;
}

export interface IframeStatusBridgeSuccessResult {
  id: number;
  type: "bb-status:result";
  ok: true;
  data?: unknown;
}

export interface IframeStatusBridgeFailureResult {
  id: number;
  type: "bb-status:result";
  ok: false;
  error: string;
}

export type IframeStatusBridgeResult =
  | IframeStatusBridgeSuccessResult
  | IframeStatusBridgeFailureResult;

interface ParsedIframeStatusBridgeRequest {
  id: number;
  type: "bb-status:read" | "bb-status:write";
  path: string;
  data?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseIframeStatusBridgeRequest(
  raw: unknown,
): ParsedIframeStatusBridgeRequest | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== "number" || !Number.isFinite(raw.id)) return null;
  if (raw.type !== READ_TYPE && raw.type !== WRITE_TYPE) return null;
  if (typeof raw.path !== "string" || raw.path.length === 0) return null;
  const parsed: ParsedIframeStatusBridgeRequest = {
    id: raw.id,
    type: raw.type,
    path: raw.path,
  };
  if (raw.type === WRITE_TYPE) {
    parsed.data = raw.data;
  }
  return parsed;
}

interface ExecuteReadArgs {
  fetchImpl: typeof fetch;
  path: string;
  threadId: string;
}

interface ExecuteWriteArgs {
  data: unknown;
  fetchImpl: typeof fetch;
  path: string;
  threadId: string;
}

/**
 * Resolves to the JSON-decoded contents of `path` for the given thread. When
 * the file does not exist (404), resolves to `null` so the HTML page can
 * render an empty initial state without a try/catch. Other HTTP failures
 * reject. Non-JSON responses resolve to the raw text — the page decides
 * whether to handle that.
 */
export async function executeIframeStatusRead({
  fetchImpl,
  path,
  threadId,
}: ExecuteReadArgs): Promise<unknown> {
  const response = await fetchImpl(
    buildThreadStorageContentUrl(threadId, path),
    {
      method: "GET",
    },
  );
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new HttpError({
      status: response.status,
      message: `Failed to read ${path}: HTTP ${response.status}`,
    });
  }
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * Writes `data` to `path` for the given thread. Strings are stored as-is with
 * `text/plain`; any other value is JSON-stringified with `application/json`.
 */
export async function executeIframeStatusWrite({
  data,
  fetchImpl,
  path,
  threadId,
}: ExecuteWriteArgs): Promise<void> {
  const url = buildThreadStorageContentUrl(threadId, path);
  const isString = typeof data === "string";
  const body = isString ? data : JSON.stringify(data);
  const response = await fetchImpl(url, {
    method: "PUT",
    headers: {
      "content-type": isString ? "text/plain" : "application/json",
    },
    body,
  });
  if (!response.ok) {
    throw new HttpError({
      status: response.status,
      message: `Failed to write ${path}: HTTP ${response.status}`,
    });
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

interface HandleIframeStatusRequestArgs {
  fetchImpl: typeof fetch;
  request: ParsedIframeStatusBridgeRequest;
  threadId: string;
}

export async function handleIframeStatusRequest({
  fetchImpl,
  request,
  threadId,
}: HandleIframeStatusRequestArgs): Promise<IframeStatusBridgeResult> {
  try {
    if (request.type === READ_TYPE) {
      const data = await executeIframeStatusRead({
        fetchImpl,
        path: request.path,
        threadId,
      });
      return { id: request.id, type: RESULT_TYPE, ok: true, data };
    }
    await executeIframeStatusWrite({
      data: request.data,
      fetchImpl,
      path: request.path,
      threadId,
    });
    return { id: request.id, type: RESULT_TYPE, ok: true };
  } catch (error) {
    return {
      id: request.id,
      type: RESULT_TYPE,
      ok: false,
      error: errorMessage(error),
    };
  }
}
