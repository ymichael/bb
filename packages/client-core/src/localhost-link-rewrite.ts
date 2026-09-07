export const REWRITE_LOCALHOST_LINKS_STORAGE_KEY = "bb.rewriteLocalhostLinks";

export const REWRITE_LOCALHOST_LINKS_DEFAULT = true;

interface RewriteLocalhostLinkHrefArgs {
  currentHostname: string | undefined;
  enabled: boolean;
  href: string | undefined;
}

const LOOPBACK_LINK_HOSTNAMES = new Set(["127.0.0.1", "localhost"]);

function isRewriteableLoopbackLink(url: URL): boolean {
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    LOOPBACK_LINK_HOSTNAMES.has(url.hostname.toLowerCase())
  );
}

export function rewriteLocalhostLinkHref({
  currentHostname,
  enabled,
  href,
}: RewriteLocalhostLinkHrefArgs): string | undefined {
  if (!enabled || href === undefined || currentHostname === undefined) {
    return href;
  }

  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return href;
  }

  if (!isRewriteableLoopbackLink(url)) {
    return href;
  }

  url.hostname = currentHostname;
  return url.toString();
}
