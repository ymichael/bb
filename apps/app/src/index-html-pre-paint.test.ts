// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { THEME_STORAGE_KEY } from "./hooks/useTheme";
import {
  APP_THEME_CSS_STORAGE_KEY,
  applyAppThemeCss,
  applyCachedAppThemeCss,
} from "./lib/themes";

const indexHtml = readFileSync(
  resolve(import.meta.dirname, "../index.html"),
  "utf8",
);

function extractInlineScripts(html: string): string[] {
  const scripts: string[] = [];
  const scriptRe = /<script(?![^>]*\btype="module")[^>]*>([\s\S]*?)<\/script>/g;
  for (const match of html.matchAll(scriptRe)) {
    scripts.push(match[1].replaceAll("%MODE%", "test"));
  }
  return scripts;
}

function installDocument(html: string): void {
  const withoutScripts = html.replace(/<script[\s\S]*?<\/script>/g, "");
  const inner = withoutScripts
    .replace(/^[\s\S]*?<html[^>]*>/, "")
    .replace(/<\/html>[\s\S]*$/, "");
  document.documentElement.innerHTML = inner;
  document.documentElement.className = "bb-app-shell-root";
}

function runInlineScripts(): void {
  for (const script of extractInlineScripts(indexHtml)) {
    new Function(script)();
  }
}

function stubPrefersDark(matches: boolean): void {
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
    matches: query === "(prefers-color-scheme: dark)" ? matches : false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

describe("index.html pre-paint script", () => {
  beforeEach(() => {
    localStorage.clear();
    installDocument(indexHtml);
    stubPrefersDark(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    document.documentElement.className = "";
    document.head.innerHTML = "";
    document.body.innerHTML = "";
  });

  it("extracts both inline scripts from index.html", () => {
    expect(extractInlineScripts(indexHtml)).toHaveLength(2);
  });

  it("adds the dark class before paint when the stored preference is dark", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dark");

    runInlineScripts();

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(
      document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
        ?.content,
    ).toBe("#151515");
  });

  it("follows the system scheme when no preference is stored", () => {
    stubPrefersDark(true);

    runInlineScripts();

    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("keeps the light palette when the stored preference is light on a dark system", () => {
    stubPrefersDark(true);
    localStorage.setItem(THEME_STORAGE_KEY, "light");

    runInlineScripts();

    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(
      document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
        ?.content,
    ).toBe("#ffffff");
  });

  it("injects the palette CSS cached by applyAppThemeCss as the last head style", () => {
    const css = ":root { --canvas: oklch(0.3 0.02 250); }";
    applyAppThemeCss(css);
    document.getElementById("bb-app-theme")?.remove();
    expect(localStorage.getItem(APP_THEME_CSS_STORAGE_KEY)).toBe(css);

    runInlineScripts();

    const style = document.getElementById("bb-app-theme");
    expect(style).toBeInstanceOf(HTMLStyleElement);
    expect(style?.textContent).toBe(css);
    expect(document.head.lastElementChild).toBe(style);
  });

  it("does not inject a palette element when no palette is cached", () => {
    runInlineScripts();

    expect(document.getElementById("bb-app-theme")).toBeNull();
  });

  it("lets applyCachedAppThemeCss adopt the pre-paint element and keep it last", () => {
    const css = ".dark { --canvas: oklch(0.2 0.02 250); }";
    localStorage.setItem(APP_THEME_CSS_STORAGE_KEY, css);
    runInlineScripts();
    const devStyle = document.createElement("style");
    devStyle.setAttribute("data-vite-dev-id", "app.css");
    document.head.appendChild(devStyle);

    applyCachedAppThemeCss();

    const styles = document.querySelectorAll("#bb-app-theme");
    expect(styles).toHaveLength(1);
    expect(styles[0].textContent).toBe(css);
    expect(document.head.lastElementChild).toBe(styles[0]);
  });
});
