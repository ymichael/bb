import { createMobileFetch } from "@/lib/sdk/mobile-fetch";

const probeFetch = createMobileFetch((input, init) => fetch(input, init));

export async function hasThreadOnServer(
  serverUrl: string,
  threadId: string,
): Promise<boolean> {
  const url = `${serverUrl.replace(/\/+$/u, "")}/api/v1/threads/${encodeURIComponent(threadId)}`;
  const response = await probeFetch(url, {
    method: "GET",
    headers: new Headers({ accept: "application/json" }),
    signal: AbortSignal.timeout(8_000),
  });
  return response.ok;
}
