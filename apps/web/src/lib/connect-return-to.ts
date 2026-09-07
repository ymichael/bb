export const DASHBOARD_PATH = "/dashboard";

function appBaseDomain(appHostname: string): string {
  return appHostname.startsWith("www.")
    ? appHostname.slice("www.".length)
    : appHostname;
}

export function connectReturnTo(
  rawReturnTo: string | null | undefined,
  appOrigin: string,
): string | null {
  if (!rawReturnTo || rawReturnTo === "null" || rawReturnTo === "undefined")
    return null;

  let appUrl: URL;
  let returnToUrl: URL;
  try {
    appUrl = new URL(appOrigin);
    returnToUrl = new URL(rawReturnTo);
  } catch {
    return null;
  }

  if (returnToUrl.protocol !== appUrl.protocol) return null;

  const baseDomain = appBaseDomain(appUrl.hostname);
  const suffix = `.${baseDomain}`;
  if (!returnToUrl.hostname.endsWith(suffix)) return null;

  const handle = returnToUrl.hostname.slice(0, -suffix.length);
  if (!handle || handle.includes(".")) return null;

  return returnToUrl.toString();
}
