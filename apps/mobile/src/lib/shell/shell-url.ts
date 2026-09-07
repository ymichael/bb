function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

export interface ServerOrigin {
  origin: string;
  prefix: string;
}

export function parseServerUrl(serverUrl: string): ServerOrigin | null {
  try {
    const url = new URL(serverUrl);
    return { origin: url.origin, prefix: trimTrailingSlash(url.pathname) };
  } catch {
    return null;
  }
}

export function buildShellUrl(serverUrl: string, path: string): string {
  const parsed = parseServerUrl(serverUrl);
  const base = parsed
    ? `${parsed.origin}${parsed.prefix}`
    : trimTrailingSlash(serverUrl);
  if (path.length === 0 || path === "/") return `${base}/`;
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

export function isShellNavigation(url: string, serverUrl: string): boolean {
  const server = parseServerUrl(serverUrl);
  if (server === null) return false;
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  if (target.origin !== server.origin) return false;
  if (server.prefix.length === 0) return true;
  return (
    target.pathname === server.prefix ||
    target.pathname.startsWith(`${server.prefix}/`)
  );
}

export function shellPathFromUrl(
  url: string,
  serverUrl: string,
): string | null {
  if (!isShellNavigation(url, serverUrl)) return null;
  const server = parseServerUrl(serverUrl);
  if (server === null) return null;
  const target = new URL(url);
  const pathname = target.pathname.slice(server.prefix.length) || "/";
  return `${pathname}${target.search}`;
}

export function isExternallyOpenable(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return (
      protocol === "http:" || protocol === "https:" || protocol === "mailto:"
    );
  } catch {
    return false;
  }
}
