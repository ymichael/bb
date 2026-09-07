export function realtimeUrlForServer(serverUrl: string): string {
  const url = new URL(serverUrl);
  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  else throw new Error(`Unsupported server URL scheme: ${url.protocol}`);
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/ws`;
  url.search = "";
  url.hash = "";
  return url.href;
}
