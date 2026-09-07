import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CUSTOM_THEME_CSS_MAX_LENGTH,
  defaultAppTheme,
  resolveCodeTheme,
} from "@bb/domain";
import {
  listCustomThemeNames,
  readCustomThemeCss,
  resolveAppTheme,
  resolveThemeRootPath,
} from "../../src/services/system/custom-themes.js";

async function writeTheme(root: string, name: string, css: string) {
  await mkdir(join(root, name), { recursive: true });
  await writeFile(join(root, name, "theme.css"), css, "utf8");
}

describe("custom themes service", () => {
  let dataDir: string;
  let themeRoot: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "bb-theme-test-"));
    themeRoot = resolveThemeRootPath(dataDir);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("returns no themes when the theme dir is absent", () => {
    expect(listCustomThemeNames(themeRoot)).toEqual([]);
  });

  it("lists only directories with a theme.css, sorted, safe names only", async () => {
    await writeTheme(themeRoot, "solar", ":root {}");
    await writeTheme(themeRoot, "aurora", ":root {}");
    await mkdir(join(themeRoot, "no-css"), { recursive: true });
    await writeFile(join(themeRoot, "loose.css"), ":root {}", "utf8");

    expect(listCustomThemeNames(themeRoot)).toEqual(["aurora", "solar"]);
  });

  it("resolves a built-in id without reading disk", () => {
    expect(resolveAppTheme(themeRoot, "nord", "blue")).toEqual({
      ...defaultAppTheme,
      themeId: "nord",
      faviconColor: "blue",
      resolvedCodeTheme: resolveCodeTheme(null, "nord"),
    });
  });

  it("resolves a custom theme's CSS from disk", async () => {
    await writeTheme(themeRoot, "ocean", ":root { --primary: #06f; }");
    expect(resolveAppTheme(themeRoot, "ocean", "teal")).toEqual({
      ...defaultAppTheme,
      themeId: "ocean",
      customCss: ":root { --primary: #06f; }",
      faviconColor: "teal",
    });
  });

  it("falls back to default palette but keeps the favicon tint for a missing or unsafe selection", () => {
    expect(resolveAppTheme(themeRoot, "missing", "pink")).toEqual({
      ...defaultAppTheme,
      faviconColor: "pink",
    });
    expect(resolveAppTheme(themeRoot, "../escape", "pink")).toEqual({
      ...defaultAppTheme,
      faviconColor: "pink",
    });
  });

  it("rejects oversized stylesheets so the broadcast payload stays bounded", async () => {
    await writeTheme(
      themeRoot,
      "huge",
      "a".repeat(CUSTOM_THEME_CSS_MAX_LENGTH + 1),
    );
    expect(readCustomThemeCss(themeRoot, "huge")).toBeNull();
    expect(resolveAppTheme(themeRoot, "huge", "default")).toEqual(
      defaultAppTheme,
    );
  });

  it("loads convention Pierre JSON files next to theme.css", async () => {
    await writeTheme(themeRoot, "ocean", ":root {}");
    const darkTheme = { name: "Ocean Dark", type: "dark", tokenColors: [] };
    await writeFile(
      join(themeRoot, "ocean", "pierre-dark.json"),
      JSON.stringify(darkTheme),
      "utf8",
    );
    expect(resolveAppTheme(themeRoot, "ocean", "default")).toEqual({
      ...defaultAppTheme,
      themeId: "ocean",
      customCss: ":root {}",
      resolvedCodeTheme: {
        dark: "bb:ocean:dark",
        light: "pierre-light",
        files: { "bb:ocean:dark": { ...darkTheme, name: "bb:ocean:dark" } },
      },
    });
  });
});
