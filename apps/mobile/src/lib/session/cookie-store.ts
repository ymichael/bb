import type { DesktopSession } from "@bb/connect-client";

export interface SessionCookieSpec {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  expires: string;
}

export interface CookieStoreLike {
  set(
    url: string,
    cookie: SessionCookieSpec,
    useWebKit: boolean,
  ): Promise<unknown>;
}

function cookieDomainMatches(domain: string, host: string): boolean {
  const bare = domain.replace(/^\./u, "").toLowerCase();
  return host === bare || host.endsWith(`.${bare}`);
}

export function sessionCookieSpec(
  session: DesktopSession,
  serverUrl: string,
): SessionCookieSpec {
  const { cookie } = session;
  const url = new URL(serverUrl);
  if (!cookieDomainMatches(cookie.domain, url.hostname)) {
    throw new Error(
      `Desktop-session cookie domain ${cookie.domain} does not match ${url.hostname}`,
    );
  }
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: "/",
    secure: url.protocol === "https:",
    httpOnly: true,
    expires: new Date(cookie.expiresAt).toISOString(),
  };
}

export async function installSessionCookie(
  cookieStore: CookieStoreLike,
  serverUrl: string,
  session: DesktopSession,
): Promise<void> {
  const spec = sessionCookieSpec(session, serverUrl);
  await cookieStore.set(serverUrl, spec, false);
  await cookieStore.set(serverUrl, spec, true);
}
