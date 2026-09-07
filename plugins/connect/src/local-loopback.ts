export function resolveLocalCloudLoopbackUrl(
  serverUrl: string | undefined,
  rawDevAppPort: string | undefined,
): string | null {
  if (!serverUrl || !rawDevAppPort) return null;
  const port = Number(rawDevAppPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;

  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" || !url.hostname.endsWith(".localhost")) {
    return null;
  }
  return `http://127.0.0.1:${port}`;
}
