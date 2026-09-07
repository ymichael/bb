const BB_URL_SCHEME = "bb";

export interface LinkProfileLike {
  id: string;
  serverUrl: string;
}

export type IncomingLink =
  | { kind: "scheme"; path: string }
  | { kind: "web"; origin: string; pathname: string; search: string }
  | { kind: "foreign" };

export type LinkResolution =
  | { kind: "passthrough" }
  | {
      kind: "navigate";
      path: string;
      profileId: string | null;
    }
  | {
      kind: "unknown-server";
      serverUrl: string;
      path: string;
    };

const ADD_SERVER_PATH = "/settings/servers/add";

const DEVELOPER_ROUTE_PREFIXES = ["/dev", "/e2e"] as const;

export function isDeveloperRoutePath(path: string): boolean {
  const pathname = path.split("?", 1)[0] ?? "";
  return DEVELOPER_ROUTE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

const SCHEME_URL_PATTERN = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/iu;

function splitPathAndSearch(rest: string): {
  pathname: string;
  search: string;
} {
  const withoutHash = rest.split("#", 1)[0] ?? "";
  const queryIndex = withoutHash.indexOf("?");
  const rawPath =
    queryIndex === -1 ? withoutHash : withoutHash.slice(0, queryIndex);
  const search = queryIndex === -1 ? "" : withoutHash.slice(queryIndex);
  const pathname = `/${rawPath.replace(/^\/+/u, "")}`;
  return {
    pathname: pathname.length > 1 ? pathname.replace(/\/+$/u, "") : "/",
    search,
  };
}

export function parseIncomingLink(
  url: string,
  scheme: string = BB_URL_SCHEME,
): IncomingLink {
  const match = SCHEME_URL_PATTERN.exec(url.trim());
  if (!match) return { kind: "foreign" };
  const [, protocol, rest] = match;
  if (!protocol || rest === undefined) return { kind: "foreign" };
  if (protocol.toLowerCase() === scheme) {
    const { pathname, search } = splitPathAndSearch(rest);
    return { kind: "scheme", path: `${pathname}${search}` };
  }
  if (protocol === "http" || protocol === "https") {
    try {
      const parsed = new URL(url.trim());
      const pathname =
        parsed.pathname.length > 1 ? parsed.pathname.replace(/\/+$/u, "") : "/";
      return {
        kind: "web",
        origin: parsed.origin,
        pathname,
        search: parsed.search,
      };
    } catch {
      return { kind: "foreign" };
    }
  }
  return { kind: "foreign" };
}

interface ProfileMatch {
  profile: LinkProfileLike;
  pathname: string;
}

function profilePrefix(
  serverUrl: string,
): { origin: string; prefix: string } | null {
  try {
    const url = new URL(serverUrl);
    return { origin: url.origin, prefix: url.pathname.replace(/\/+$/u, "") };
  } catch {
    return null;
  }
}

export function matchProfileForWebLink(
  profiles: readonly LinkProfileLike[],
  origin: string,
  pathname: string,
): ProfileMatch | null {
  let best: ProfileMatch | null = null;
  let bestPrefixLength = -1;
  for (const profile of profiles) {
    const parsed = profilePrefix(profile.serverUrl);
    if (!parsed || parsed.origin !== origin) continue;
    const { prefix } = parsed;
    const inside =
      prefix.length === 0 ||
      pathname === prefix ||
      pathname.startsWith(`${prefix}/`);
    if (!inside || prefix.length <= bestPrefixLength) continue;
    bestPrefixLength = prefix.length;
    const remainder = pathname.slice(prefix.length);
    best = { profile, pathname: remainder.length > 0 ? remainder : "/" };
  }
  return best;
}

export function addServerPathForLink(serverUrl: string, next: string): string {
  const params = new URLSearchParams();
  params.set("serverUrl", serverUrl);
  if (next !== "/") params.set("next", next);
  return `${ADD_SERVER_PATH}?${params.toString()}`;
}
