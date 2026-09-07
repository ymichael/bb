const MARKETPLACE_HTML_CACHE_CONTROL = "public, max-age=300, must-revalidate";

function isMarketplaceHtmlPath(pathname: string): boolean {
  if (pathname.startsWith("/marketplace/v1/")) return false;
  if (pathname.startsWith("/marketplace/v2/")) return false;
  return pathname === "/marketplace" || pathname.startsWith("/marketplace/");
}

export function marketplaceResponseStatus(
  pathname: string,
  loaderData: ReadonlyArray<unknown>,
): number | null {
  if (!isMarketplaceHtmlPath(pathname)) return null;
  for (const value of loaderData) {
    if (
      typeof value === "object" &&
      value !== null &&
      "status" in value &&
      value.status === "unavailable"
    ) {
      return 503;
    }
  }
  return null;
}

export function marketplaceHtmlCacheControl(
  pathname: string,
  status: number,
): string | null {
  if (!isMarketplaceHtmlPath(pathname)) return null;
  return status === 200 ? MARKETPLACE_HTML_CACHE_CONTROL : "no-store";
}
