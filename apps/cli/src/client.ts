import { hc } from "hono/client";
import type { AppType } from "@beanbag/daemon/app-type";

export function createClient(baseUrl: string) {
  return hc<AppType>(baseUrl);
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

function normalizeErrorText(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function extractCanonicalErrorMessage(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  return typeof value.message === "string" && value.message.trim().length > 0
    ? normalizeErrorText(value.message)
    : null;
}

function extractLegacyErrorMessage(value: unknown): string | null {
  if (typeof value === "string") {
    const normalized = normalizeErrorText(value);
    return normalized.length > 0 ? normalized : null;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const message = extractLegacyErrorMessage(entry);
      if (message) {
        return message;
      }
    }
    return null;
  }
  if (!isRecord(value)) {
    return null;
  }
  const legacyCandidates = [value.detail];
  for (const candidate of legacyCandidates) {
    const message = extractLegacyErrorMessage(candidate);
    if (message) {
      return message;
    }
  }
  return null;
}

async function readHttpErrorMessage(res: Response): Promise<string> {
  const rawBody = await res.text().catch(() => "");
  const normalized = normalizeErrorText(rawBody);
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
      extractCanonicalErrorMessage(parsed) ??
      extractLegacyErrorMessage(parsed) ??
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
        "Cannot connect to Beanbag daemon. Ensure it is running and BB_DAEMON_URL is correct.",
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
