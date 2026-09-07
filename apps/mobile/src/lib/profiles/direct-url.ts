export type DirectUrlWarning = "insecure-http";

export type DirectUrlErrorCode =
  | "empty"
  | "missing-scheme"
  | "unsupported-scheme"
  | "invalid-url"
  | "http-domain";

export type DirectUrlValidation =
  | { ok: true; serverUrl: string; warning: DirectUrlWarning | null }
  | { ok: false; code: DirectUrlErrorCode; message: string };

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const IPV4_PATTERN = /^\d{1,3}(\.\d{1,3}){3}$/;

function isIpLiteral(hostname: string): boolean {
  if (IPV4_PATTERN.test(hostname)) return true;
  return hostname.startsWith("[") && hostname.endsWith("]");
}

export function isLoopbackHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(lower)) return true;
  return lower.startsWith("127.");
}

function isCleartextAllowedHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (isLoopbackHost(lower) || isIpLiteral(lower)) return true;
  if (lower.endsWith(".local") || lower.endsWith(".localhost")) return true;
  return !lower.includes(".");
}

function normalizeServerUrl(url: URL): string {
  const path = url.pathname.replace(/\/+$/u, "");
  return `${url.origin}${path}`;
}

export function validateDirectServerUrl(input: string): DirectUrlValidation {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { ok: false, code: "empty", message: "Enter a server URL." };
  }
  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//iu.exec(trimmed);
  if (!schemeMatch) {
    return {
      ok: false,
      code: "missing-scheme",
      message: "Start the URL with http:// or https://.",
    };
  }
  const scheme = schemeMatch[1]?.toLowerCase();
  if (scheme !== "http" && scheme !== "https") {
    return {
      ok: false,
      code: "unsupported-scheme",
      message: `Unsupported scheme "${scheme}". Use http:// or https://.`,
    };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return {
      ok: false,
      code: "invalid-url",
      message: "That URL is not valid.",
    };
  }
  if (url.hostname.length === 0) {
    return {
      ok: false,
      code: "invalid-url",
      message: "That URL is not valid.",
    };
  }
  const serverUrl = normalizeServerUrl(url);
  if (url.protocol === "https:") {
    return { ok: true, serverUrl, warning: null };
  }
  if (isLoopbackHost(url.hostname)) {
    return { ok: true, serverUrl, warning: null };
  }
  if (isCleartextAllowedHost(url.hostname)) {
    return { ok: true, serverUrl, warning: "insecure-http" };
  }
  return {
    ok: false,
    code: "http-domain",
    message:
      "Plain http:// only works for IP addresses and .local names. Use https:// for domain names (for example a Tailscale Serve URL).",
  };
}
