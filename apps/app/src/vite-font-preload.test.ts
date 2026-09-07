import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  reorderHeadForFirstPaint,
  resolveFontPreloadTags,
} from "../vite-font-preload.js";

const bundle = [
  "assets/index-rXrqkkAU.js",
  "assets/inter-latin-ext-wght-normal-BpKOsZoc.woff2",
  "assets/inter-latin-wght-italic-CX2R8fZt.woff2",
  "assets/inter-latin-wght-normal-Dx4kXJAl.woff2",
  "assets/inter-cyrillic-wght-normal-D26zlscB.woff2",
  "assets/index-CXWZ8ak3.css",
];

describe("resolveFontPreloadTags", () => {
  it("preloads only the Inter latin upright subset, as a CORS font request", () => {
    const tags = resolveFontPreloadTags(bundle, "/");

    expect(tags).toHaveLength(1);
    expect(tags[0]).toMatchObject({
      tag: "link",
      injectTo: "head",
      attrs: {
        rel: "preload",
        as: "font",
        type: "font/woff2",
        crossorigin: true,
        href: "/assets/inter-latin-wght-normal-Dx4kXJAl.woff2",
      },
    });
  });

  it("respects a non-root base", () => {
    const [tag] = resolveFontPreloadTags(bundle, "/app/");
    expect(tag.attrs?.href).toBe(
      "/app/assets/inter-latin-wght-normal-Dx4kXJAl.woff2",
    );
  });

  it("emits nothing when the font is not in the bundle", () => {
    expect(resolveFontPreloadTags(["assets/index-abc.js"], "/")).toEqual([]);
  });
});

const builtHtml = [
  "<!doctype html><html><head>",
  '<script>localStorage.getItem("bb.theme")</script>',
  '<script type="module" crossorigin src="/assets/index-rXrqkkAU.js"></script>',
  '<link rel="modulepreload" crossorigin href="/assets/react-abc.js">',
  '<link rel="modulepreload" crossorigin href="/assets/router-def.js">',
  '<link rel="stylesheet" crossorigin href="/assets/index-CXWZ8ak3.css">',
  "</head><body></body></html>",
].join("");

describe("reorderHeadForFirstPaint", () => {
  const fontTags = resolveFontPreloadTags(bundle, "/");

  it("moves the stylesheet and font preload ahead of the script and preload block", () => {
    const html = reorderHeadForFirstPaint(builtHtml, fontTags);

    const themeAt = html.indexOf("bb.theme");
    const fontAt = html.search(/<link[^>]*as="font"/);
    const stylesheetAt = html.search(/<link[^>]*rel="stylesheet"/);
    const entryAt = html.search(/<script type="module"/);
    const firstPreloadAt = html.search(/<link rel="modulepreload"/);

    expect(themeAt).toBeLessThan(fontAt);
    expect(fontAt).toBeLessThan(stylesheetAt);
    expect(stylesheetAt).toBeLessThan(entryAt);
    expect(stylesheetAt).toBeLessThan(firstPreloadAt);
    expect(html.match(/rel="stylesheet"/g)).toHaveLength(1);
    expect(html).toContain('<link fetchpriority="high" rel="stylesheet"');
  });

  it("still front-loads the stylesheet when the font is not in the bundle", () => {
    const html = reorderHeadForFirstPaint(builtHtml, []);
    expect(html.search(/rel="stylesheet"/)).toBeLessThan(
      html.search(/<script type="module"/),
    );
    expect(html).not.toContain('as="font"');
  });

  it("returns the document unchanged when there is nothing to front-load", () => {
    const bare = "<html><head><script>1</script></head><body></body></html>";
    expect(reorderHeadForFirstPaint(bare, [])).toBe(bare);
  });

  it("refuses to move the stylesheet ahead of the pre-paint theme script", () => {
    const themeless = builtHtml.replace("bb.theme", "bb.other");
    expect(() => reorderHeadForFirstPaint(themeless, fontTags)).toThrow(
      /pre-paint theme script/,
    );
  });
});

function viteEmittedIndexHtml(): string {
  const source = readFileSync(
    resolve(import.meta.dirname, "../index.html"),
    "utf8",
  );
  const sourceEntryTag =
    /[ \t]*<script type="module" src="\/src\/main\.tsx"><\/script>\n/;
  expect(source).toMatch(sourceEntryTag);
  const injected = [
    '<script type="module" crossorigin src="/assets/index-rXrqkkAU.js"></script>',
    '<link rel="modulepreload" crossorigin href="/assets/rolldown-runtime-abc.js">',
    '<link rel="modulepreload" crossorigin href="/assets/boot-vendor-def.js">',
    '<link rel="stylesheet" crossorigin href="/assets/index-CXWZ8ak3.css">',
  ]
    .map((tag) => `    ${tag}\n`)
    .join("");
  return source
    .replace(sourceEntryTag, "")
    .replace("  </head>", `${injected}  </head>`);
}

describe("reorderHeadForFirstPaint on the document Vite emits from index.html", () => {
  it("front-loads the stylesheet and font preload, after the theme script and ahead of every script and modulepreload", () => {
    const emitted = viteEmittedIndexHtml();
    const html = reorderHeadForFirstPaint(
      emitted,
      resolveFontPreloadTags(bundle, "/"),
    );

    const themeScriptAt = html.indexOf("bb.theme");
    const fontPreloadAt = html.search(/<link[^>]*as="font"/);
    const stylesheetAt = html.search(/<link[^>]*rel="stylesheet"/);
    const entryAt = html.search(/<script type="module"[^>]*src=/);
    const modulepreloadsAt = [
      ...html.matchAll(/<link rel="modulepreload"/g),
    ].map((match) => match.index);
    const headEndAt = html.indexOf("</head>");

    expect(themeScriptAt).toBeGreaterThan(-1);
    expect(fontPreloadAt).toBeGreaterThan(-1);
    expect(stylesheetAt).toBeGreaterThan(-1);
    expect(entryAt).toBeGreaterThan(-1);
    expect(modulepreloadsAt).toHaveLength(2);

    expect(themeScriptAt).toBeLessThan(fontPreloadAt);
    expect(fontPreloadAt).toBeLessThan(stylesheetAt);
    expect(stylesheetAt).toBeLessThan(entryAt);
    for (const modulepreloadAt of modulepreloadsAt) {
      expect(stylesheetAt).toBeLessThan(modulepreloadAt);
    }
    expect(Math.max(...modulepreloadsAt)).toBeLessThan(headEndAt);
    expect(html.match(/rel="stylesheet"/g)).toHaveLength(1);
    expect(html.match(/<script type="module"/g)).toHaveLength(1);
    expect(html).toMatch(/boot-vendor-def\.js">\n  <\/head>/);
  });
});

const distIndexHtmlPath = resolve(import.meta.dirname, "../dist/index.html");

describe.skipIf(!existsSync(distIndexHtmlPath))(
  "emitted dist/index.html head order",
  () => {
    it("puts the stylesheet and font preload before every modulepreload, after the theme script", () => {
      const html = readFileSync(distIndexHtmlPath, "utf8");
      const stylesheetAt = html.search(/<link[^>]*rel="stylesheet"/);
      const fontPreloadAt = html.search(/<link[^>]*as="font"/);
      const firstModulepreloadAt = html.search(/<link rel="modulepreload"/);
      const themeScriptAt = html.indexOf("bb.theme");

      expect(stylesheetAt).toBeGreaterThan(-1);
      expect(fontPreloadAt).toBeGreaterThan(-1);
      expect(firstModulepreloadAt).toBeGreaterThan(-1);
      expect(themeScriptAt).toBeGreaterThan(-1);

      expect(themeScriptAt).toBeLessThan(stylesheetAt);
      expect(stylesheetAt).toBeLessThan(firstModulepreloadAt);
      expect(fontPreloadAt).toBeLessThan(firstModulepreloadAt);
    });
  },
);
