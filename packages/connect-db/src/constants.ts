const HANDLE_REGEX = /^[a-z0-9][a-z0-9-]{2,29}$/;

const HANDLE_MIN_LENGTH = 3;
export const HANDLE_MAX_LENGTH = 30;

export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  "www",
  "default",
  "api",
  "app",
  "bb",
  "connect",
  "dashboard",
  "getbb",

  "about",
  "blog",
  "careers",
  "changelog",
  "community",
  "doc",
  "docs",
  "download",
  "downloads",
  "feedback",
  "forum",
  "help",
  "jobs",
  "legal",
  "pricing",
  "privacy",
  "roadmap",
  "status",
  "support",
  "terms",

  "abuse",
  "account",
  "accounts",
  "admin",
  "auth",
  "billing",
  "login",
  "logout",
  "oauth",
  "password",
  "register",
  "reset",
  "security",
  "settings",
  "signin",
  "signout",
  "signup",
  "sso",
  "trust",
  "verify",

  "assets",
  "cdn",
  "dns",
  "edge",
  "email",
  "files",
  "ftp",
  "gateway",
  "git",
  "images",
  "imap",
  "internal",
  "mail",
  "media",
  "mx",
  "ns1",
  "ns2",
  "origin",
  "pop",
  "proxy",
  "relay",
  "root",
  "smtp",
  "static",
  "system",
  "tunnel",
  "upload",
  "uploads",
  "websocket",
  "ws",

  "alpha",
  "beta",
  "canary",
  "demo",
  "dev",
  "preview",
  "prod",
  "production",
  "stage",
  "staging",
  "test",
]);

export const MAX_PER_ACCOUNT = 20;

export const CONNECT_CODE_TTL_MS = 10 * 60 * 1000;

export const SERVER_OFFLINE_AFTER_MS = 90 * 1000;

export const CONNECT_SESSION_EXPIRES_IN_SECONDS = 7 * 24 * 60 * 60;
export const CONNECT_SESSION_UPDATE_AGE_SECONDS = 24 * 60 * 60;

export type HandleValidationError =
  | "too-short"
  | "too-long"
  | "invalid-format"
  | "reserved";

export function validateHandle(handle: string): HandleValidationError | null {
  if (handle.length < HANDLE_MIN_LENGTH) return "too-short";
  if (handle.length > HANDLE_MAX_LENGTH) return "too-long";
  if (handle.includes("--")) return "invalid-format";
  if (!HANDLE_REGEX.test(handle)) return "invalid-format";
  if (RESERVED_HANDLES.has(handle)) return "reserved";
  return null;
}

export const validateLabel = validateHandle;
export const validateSubdomain = validateHandle;

const SHARE_PORT_TARGET = /^[1-9]\d{0,4}$/;

function isValidShareTarget(target: string): boolean {
  if (!SHARE_PORT_TARGET.test(target)) return false;
  const port = Number(target);
  return port >= 1 && port <= 65535;
}

interface VisitorHost {
  handle: string;
  target: string | null;
}

export function parseVisitorHost(
  host: string,
  baseDomain: string,
): VisitorHost | null {
  const suffix = `.${baseDomain}`;
  if (!host.endsWith(suffix)) return null;
  const label = host.slice(0, -suffix.length);
  if (!label || label.includes(".")) return null;

  const sep = label.indexOf("--");
  if (sep === -1) {
    return { handle: label.toLowerCase(), target: null };
  }

  const handle = label.slice(0, sep).toLowerCase();
  const target = label.slice(sep + 2);
  if (!handle || !isValidShareTarget(target)) return null;
  return { handle, target };
}
