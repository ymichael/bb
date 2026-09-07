import type { HtmlTagDescriptor, Plugin } from "vite";

const PRELOADED_FONT_BASENAME = "inter-latin-wght-normal";
const PRELOADED_FONT_FILE_RE = new RegExp(
  `(^|/)${PRELOADED_FONT_BASENAME}(-[\\w-]+)?\\.woff2$`,
);

export function resolveFontPreloadTags(
  bundleFileNames: Iterable<string>,
  base: string,
): HtmlTagDescriptor[] {
  const fileName = [...bundleFileNames].find((name) =>
    PRELOADED_FONT_FILE_RE.test(name),
  );
  if (fileName === undefined) return [];
  return [
    {
      tag: "link",
      attrs: {
        rel: "preload",
        as: "font",
        type: "font/woff2",
        crossorigin: true,
        href: `${base}${fileName}`,
      },
      injectTo: "head",
    },
  ];
}

function serializeTag(tag: HtmlTagDescriptor): string {
  const attrs = Object.entries(tag.attrs ?? {})
    .filter(([, value]) => value !== undefined && value !== false)
    .map(([name, value]) => (value === true ? name : `${name}="${value}"`))
    .join(" ");
  return `<${tag.tag} ${attrs}>`;
}

export function reorderHeadForFirstPaint(
  html: string,
  fontPreloadTags: HtmlTagDescriptor[],
): string {
  const stylesheets: string[] = [];
  const withoutStylesheets = html.replace(
    /[ \t]*<link[^>]*rel="stylesheet"[^>]*>\n?/g,
    (tag) => {
      stylesheets.push(tag.trim());
      return "";
    },
  );

  const block = [
    ...fontPreloadTags.map(serializeTag),
    ...stylesheets.map((tag) =>
      tag.includes("fetchpriority")
        ? tag
        : tag.replace("<link ", '<link fetchpriority="high" '),
    ),
  ].join("");
  if (block === "") return html;

  const anchor = firstPreloadableTagIndex(withoutStylesheets);
  const themeScriptAt = withoutStylesheets.indexOf("bb.theme");
  if (themeScriptAt === -1 || anchor <= themeScriptAt) {
    throw new Error(
      "bb:font-preload: the pre-paint theme script must precede the injected asset tags in index.html; refusing to move the stylesheet ahead of it",
    );
  }
  return (
    withoutStylesheets.slice(0, anchor) +
    block +
    withoutStylesheets.slice(anchor)
  );
}

function firstPreloadableTagIndex(html: string): number {
  const candidates = [
    html.search(/<link rel="modulepreload"/),
    html.search(/<script type="module"[^>]*src=/),
    html.indexOf("</head>"),
  ].filter((index) => index >= 0);
  if (candidates.length === 0) {
    throw new Error("bb:font-preload: built index.html has no <head>");
  }
  return Math.min(...candidates);
}

export function fontPreload(): Plugin {
  let base = "/";
  return {
    name: "bb:font-preload",
    apply: "build",
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        if (ctx.bundle === undefined) return html;
        return reorderHeadForFirstPaint(
          html,
          resolveFontPreloadTags(Object.keys(ctx.bundle), base),
        );
      },
    },
  };
}
