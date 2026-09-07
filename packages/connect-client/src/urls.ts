type ConnectPublicProtocol = "http:" | "https:";

export function connectPublicProtocol(
  baseDomain: string,
): ConnectPublicProtocol {
  const hostname = new URL(`https://${baseDomain}`).hostname;
  return hostname.endsWith(".localhost") ? "http:" : "https:";
}

export function deriveConnectBaseUrl(serverUrl: string): string {
  return new URL(serverUrl).origin.replace(/\/\/[^.]+\./, "//");
}

export function serverUrlForHandle(baseUrl: string, handle: string): string {
  const url = new URL(baseUrl);
  return `${url.protocol}//${handle}.${url.host}`;
}
