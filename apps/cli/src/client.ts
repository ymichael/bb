import { hc } from "hono/client";
import type { AppType } from "@beanbag/daemon/app-type";

export function createClient(baseUrl: string) {
  return hc<AppType>(baseUrl);
}

export type Client = ReturnType<typeof createClient>;

export async function unwrap<T>(
  responsePromise: Promise<Response>,
): Promise<T> {
  let res: Response;
  try {
    res = await responsePromise;
  } catch (err: unknown) {
    if (
      err instanceof TypeError &&
      (err as any).cause?.code === "ECONNREFUSED"
    ) {
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
