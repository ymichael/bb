import { isLoopbackHostname } from "./loopback-hostname";

const SEARCH_ENGINE_URL = "https://www.google.com/search";
const HTTP_SCHEME_PATTERN = /^https?:\/\//i;
const WHITESPACE_PATTERN = /\s/u;
const BARE_ADDRESS_PATTERN =
  /^(\[[^\]]+\](?::\d+)?|[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::\d+)?)(?:[/?#]\S*)?$/i;
const BRACKETED_HOST_AUTHORITY_PATTERN = /^\[([^\]]+)\](?::\d+)?$/u;
const HOST_AUTHORITY_PATTERN = /^([a-z0-9-]+(?:\.[a-z0-9-]+)*)(?::\d+)?$/i;
const DOTTED_HOSTNAME_PATTERN = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;
const DECIMAL_OCTET_PATTERN = /^\d+$/u;

function parseBareAddressHost(input: string): string | null {
  const bareAddressMatch = BARE_ADDRESS_PATTERN.exec(input);
  if (bareAddressMatch === null) {
    return null;
  }

  const authority = bareAddressMatch[1] ?? "";
  if (authority.length === 0) {
    return null;
  }

  const bracketedHostMatch = BRACKETED_HOST_AUTHORITY_PATTERN.exec(authority);
  if (bracketedHostMatch !== null) {
    return (bracketedHostMatch[1] ?? "").toLowerCase();
  }

  const hostMatch = HOST_AUTHORITY_PATTERN.exec(authority);
  if (hostMatch === null) {
    return null;
  }

  return (hostMatch[1] ?? "").toLowerCase();
}

function normalizeParsedHost(host: string): string {
  const lower = host.toLowerCase();
  return lower.startsWith("[") && lower.endsWith("]")
    ? lower.slice(1, -1)
    : lower;
}

function parseUrlHost(url: string): string | null {
  try {
    return normalizeParsedHost(new URL(url).hostname);
  } catch {
    return null;
  }
}

function parseIpv4Octets(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) {
    return null;
  }

  const octets: number[] = [];
  for (const part of parts) {
    if (!DECIMAL_OCTET_PATTERN.test(part)) {
      return null;
    }

    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) {
      return null;
    }

    octets.push(octet);
  }

  return octets;
}

function isBareLoopbackHost(host: string): boolean {
  return isLoopbackHostname(host);
}

function isBlockedIpv4Host(host: string): boolean {
  const octets = parseIpv4Octets(host);
  if (octets === null) {
    return false;
  }

  const firstOctet = octets[0] ?? -1;
  const secondOctet = octets[1] ?? -1;
  return (
    firstOctet === 0 ||
    firstOctet === 10 ||
    (firstOctet === 169 && secondOctet === 254) ||
    (firstOctet === 172 && secondOctet >= 16 && secondOctet <= 31) ||
    (firstOctet === 192 && secondOctet === 168) ||
    (firstOctet === 100 && secondOctet >= 64 && secondOctet <= 127) ||
    (firstOctet === 198 && (secondOctet === 18 || secondOctet === 19)) ||
    firstOctet >= 224
  );
}

function isBlockedBareHost(host: string): boolean {
  return host.endsWith(".local") || isBlockedIpv4Host(host);
}

function isPublicBareHost(host: string): boolean {
  const ipv4 = parseIpv4Octets(host);
  if (ipv4 !== null) {
    return !isLoopbackHostname(host) && !isBlockedIpv4Host(host);
  }

  return (
    !isBareLoopbackHost(host) &&
    !isBlockedBareHost(host) &&
    DOTTED_HOSTNAME_PATTERN.test(host)
  );
}

function buildSearchUrl(query: string): string {
  return `${SEARCH_ENGINE_URL}?q=${encodeURIComponent(query)}`;
}

function normalizeUrl(input: string): string | null {
  if (WHITESPACE_PATTERN.test(input)) {
    return null;
  }

  if (HTTP_SCHEME_PATTERN.test(input)) {
    if (parseUrlHost(input) === null) {
      return null;
    }
    return input;
  }

  const rawHost = parseBareAddressHost(input);
  const host = parseUrlHost(`http://${input}`);
  if (rawHost === null || host === null) {
    return null;
  }

  if (parseIpv4Octets(host) !== null && rawHost !== host) {
    return null;
  }

  if (isBareLoopbackHost(host)) {
    return `http://${input}`;
  }

  if (isPublicBareHost(host)) {
    return `https://${input}`;
  }

  return null;
}

export function resolveBrowserAddressInput(rawInput: string): string | null {
  const input = rawInput.trim();
  if (input.length === 0) {
    return null;
  }
  return normalizeUrl(input) ?? buildSearchUrl(input);
}

type BrowserUrlSecurity = "secure" | "insecure" | "none";

export function getBrowserUrlSecurity(url: string): BrowserUrlSecurity {
  if (url.length === 0) {
    return "none";
  }
  try {
    const protocol = new URL(url).protocol;
    if (protocol === "https:") {
      return "secure";
    }
    if (protocol === "http:") {
      return "insecure";
    }
  } catch {
    return "none";
  }
  return "none";
}

export function getBrowserUrlHost(url: string): string {
  if (url.length === 0) {
    return "";
  }
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
