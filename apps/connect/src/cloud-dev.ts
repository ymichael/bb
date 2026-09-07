export const CLOUD_DEV_HOST_HEADER = "x-bb-cloud-dev-host";
export const SECURE_SESSION_COOKIE = "__Secure-better-auth.session_token";
const LOCAL_SESSION_COOKIE = "better-auth.session_token";
export const SECURE_DESKTOP_SESSION_COOKIE =
  "__Secure-bb-connect.desktop_session";
const LOCAL_DESKTOP_SESSION_COOKIE = "bb-connect.desktop_session";

interface ConnectRuntime {
  accountAppUrl: string;
  baseDomain: string;
  localCloud: boolean;
  sessionCookieName: string;
  desktopSessionCookieName: string;
}

function resolveCloudDevLabel(
  headers: Headers,
  runtime: ConnectRuntime,
): string | null {
  if (!runtime.localCloud) return null;
  const label = headers.get(CLOUD_DEV_HOST_HEADER)?.trim().toLowerCase();
  return label && !label.includes(".") && /^[a-z0-9-]+$/u.test(label)
    ? label
    : null;
}

export function resolveConnectRuntime(env: {
  ACCOUNT_APP_URL?: string;
  BASE_DOMAIN: string;
  CLOUD_DEV?: string;
}): ConnectRuntime {
  const accountAppUrl = new URL(
    env.ACCOUNT_APP_URL?.trim() || `https://${env.BASE_DOMAIN}`,
  );
  if (
    (accountAppUrl.protocol !== "http:" &&
      accountAppUrl.protocol !== "https:") ||
    accountAppUrl.username !== "" ||
    accountAppUrl.password !== "" ||
    accountAppUrl.pathname !== "/" ||
    accountAppUrl.search !== "" ||
    accountAppUrl.hash !== ""
  ) {
    throw new Error("ACCOUNT_APP_URL must be an HTTP(S) origin");
  }

  const cloudDevValue = env.CLOUD_DEV?.trim();
  if (cloudDevValue && cloudDevValue !== "true") {
    throw new Error("CLOUD_DEV must be true when set");
  }
  const localCloud = cloudDevValue === "true";
  if (localCloud) {
    const isLocalAccount =
      accountAppUrl.protocol === "http:" &&
      accountAppUrl.hostname === env.BASE_DOMAIN &&
      env.BASE_DOMAIN.endsWith(".localhost");
    if (!isLocalAccount) {
      throw new Error("CLOUD_DEV is only allowed for local Cloud development");
    }
  }

  return {
    accountAppUrl: accountAppUrl.origin,
    baseDomain: env.BASE_DOMAIN,
    localCloud,
    sessionCookieName: localCloud
      ? LOCAL_SESSION_COOKIE
      : SECURE_SESSION_COOKIE,
    desktopSessionCookieName: localCloud
      ? LOCAL_DESKTOP_SESSION_COOKIE
      : SECURE_DESKTOP_SESSION_COOKIE,
  };
}

export function resolveConnectRequestHost(
  headers: Headers,
  runtime: ConnectRuntime,
): string {
  const ordinaryHost = headers.get("host") ?? "";
  const label = resolveCloudDevLabel(headers, runtime);
  return label === null ? ordinaryHost : `${label}.${runtime.baseDomain}`;
}

export function publicConnectOrigin(
  label: string,
  runtime: Pick<ConnectRuntime, "accountAppUrl" | "baseDomain">,
): string {
  const url = new URL(runtime.accountAppUrl);
  url.hostname = `${label}.${runtime.baseDomain}`;
  return url.origin;
}

export function resolveConnectRequestUrl(
  requestUrl: string,
  headers: Headers,
  runtime: ConnectRuntime,
): URL {
  const parsed = new URL(requestUrl);
  const label = resolveCloudDevLabel(headers, runtime);
  if (label === null) return parsed;
  const publicUrl = new URL(publicConnectOrigin(label, runtime));
  publicUrl.pathname = parsed.pathname;
  publicUrl.search = parsed.search;
  publicUrl.hash = parsed.hash;
  return publicUrl;
}

export function stripCloudDevHeader(headers: Headers): void {
  headers.delete(CLOUD_DEV_HOST_HEADER);
}
