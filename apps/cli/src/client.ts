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
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
  }
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}
