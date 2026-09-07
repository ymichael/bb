export const GITHUB_URL = "https://github.com/get-bb/bb";
export const DISCORD_URL = "https://discord.gg/kvBU6tJhcJ";
export const X_URL = "https://x.com/get_bb_app";
export const DOWNLOAD_MACOS_FALLBACK_URL =
  "https://github.com/get-bb/bb/releases/tag/desktop-latest";
export const DOWNLOAD_MACOS_RELEASE_ASSET_BASE_URL =
  "https://github.com/get-bb/bb/releases/download/desktop-latest";
export const DOWNLOAD_MACOS_VERSION_FEED_URL = `${DOWNLOAD_MACOS_RELEASE_ASSET_BASE_URL}/desktop-version.json`;
const DOWNLOAD_MACOS_REDIRECT_PATH = "/download/macos";
export const SUBSCRIBE_PATH = "/api/subscribe";
export const CLI_COMMAND = "npx bb-app@latest";

export type CtaPlacement =
  | "nav"
  | "hero"
  | "cli"
  | "loops"
  | "local"
  | "closer"
  | "footer";

export function downloadMacosHref(placement: CtaPlacement): string {
  return `${DOWNLOAD_MACOS_REDIRECT_PATH}?placement=${placement}`;
}

declare const __SITE_ORIGIN__: string;
const SITE_URL = __SITE_ORIGIN__;
export const SITE_TITLE = "bb: the IDE that builds itself";
export const SITE_DESCRIPTION =
  "bb can control, customize, and automate itself, laying the groundwork for your own software factory. Fully open source and local-first, with Claude Code, Codex, Cursor, Pi, OpenCode, Grok, omp, and Hermes.";
export const OG_DESCRIPTION =
  "bb can control, customize, and automate itself, laying the groundwork for your own software factory.";

export function unfurlMeta(title: string, description: string, path: string) {
  return [
    { property: "og:title", content: title },
    { property: "og:description", content: description },
    { property: "og:type", content: "website" },
    { property: "og:url", content: `${SITE_URL}${path}` },
    { property: "og:site_name", content: "bb" },
    { property: "og:image", content: `${SITE_URL}/og.png` },
    { property: "og:image:width", content: "2400" },
    { property: "og:image:height", content: "1260" },
    {
      property: "og:image:alt",
      content:
        "bb logo — The IDE that builds itself. Free, open source, and local-first.",
    },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: title },
    { name: "twitter:description", content: description },
    { name: "twitter:image", content: `${SITE_URL}/og.png` },
  ];
}
