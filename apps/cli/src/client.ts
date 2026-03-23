import { createApiClient, type ApiClient } from "@bb/server-contract";
import { extractErrorMessage } from "@bb/core-ui";

export function createClient(baseUrl: string): ApiClient {
  return createApiClient(baseUrl);
}

export type Client = ReturnType<typeof createClient>;

type TypeErrorWithCause = TypeError & {
  cause?: { code?: unknown };
};

function isTypeErrorWithCauseCode(
  err: unknown,
  expectedCode: string,
): err is TypeErrorWithCause {
  if (!(err instanceof TypeError)) {
    return false;
  }
  const cause = (err as { cause?: unknown }).cause;
  if (!cause || typeof cause !== "object") {
    return false;
  }
  return (cause as { code?: unknown }).code === expectedCode;
}

const ERROR_EXTRACT_OPTS = { legacyKeys: ["detail"] as const };

async function readHttpErrorMessage(res: Response): Promise<string> {
  const rawBody = await res.text().catch(() => "");
  const normalized = rawBody.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return res.statusText;
  }

  const contentType = res.headers.get("content-type");
  const shouldParseJson =
    (contentType?.includes("application/json") ?? false) ||
    normalized.startsWith("{") ||
    normalized.startsWith("[");
  if (!shouldParseJson) {
    return normalized;
  }

  try {
    const parsed = JSON.parse(normalized) as unknown;
    return (
      extractErrorMessage(parsed, ERROR_EXTRACT_OPTS) ??
      normalized
    );
  } catch {
    return normalized;
  }
}

export async function unwrap<T>(
  responsePromise: Promise<Response>,
): Promise<T> {
  let res: Response;
  try {
    res = await responsePromise;
  } catch (err) {
    if (isTypeErrorWithCauseCode(err, "ECONNREFUSED")) {
      throw new Error(
        "Cannot connect to BB server. Ensure it is running and BB_SERVER_URL is correct.",
      );
    }
    throw err;
  }
  if (!res.ok) {
    const message = await readHttpErrorMessage(res);
    throw new Error(`HTTP ${res.status}: ${message}`);
  }
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}
