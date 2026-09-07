import type { HeaderPair } from "@bb/tunnel-contract";

const SKIP_REQUEST_HEADERS = new Set(["host", "content-length", "connection"]);

interface LoopbackHeaderRewrite {
  publicOrigin: string;
  loopbackOrigin: string;
  host?: string;
}

export function headersForLoopbackRequest(
  headers: HeaderPair[],
  rewrite: LoopbackHeaderRewrite,
): Record<string, string> {
  const forwarded: Record<string, string> = {};
  for (const [name, value] of headers) {
    const lowerName = name.toLowerCase();
    if (SKIP_REQUEST_HEADERS.has(lowerName)) continue;
    forwarded[name] =
      lowerName === "origin" && value === rewrite.publicOrigin
        ? rewrite.loopbackOrigin
        : value;
  }
  if (rewrite.host !== undefined) {
    forwarded.Host = rewrite.host;
  }
  return forwarded;
}
