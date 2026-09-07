import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getStoredFaviconColor, getStoredThemeId } from "@bb/db";
import {
  appThemeSchema,
  builtInPaletteCodeThemes,
  defaultAppTheme,
  formatPluginThemeId,
  resolveCodeTheme,
} from "@bb/domain";

function appearanceForPalette(
  themeId: keyof typeof builtInPaletteCodeThemes,
  extras: Partial<typeof defaultAppTheme> = {},
) {
  return {
    ...defaultAppTheme,
    themeId,
    resolvedCodeTheme: resolveCodeTheme(null, themeId),
    ...extras,
  };
}
import {
  themeCatalogResponseSchema,
  systemConfigResponseSchema,
} from "@bb/server-contract";
import { readJson } from "../helpers/json.js";
import { withTestHarness } from "../helpers/test-app.js";

async function writeCustomTheme(
  dataDir: string,
  name: string,
  css: string,
): Promise<void> {
  const dir = join(dataDir, "theme", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "theme.css"), css, "utf8");
}

describe("appearance settings", () => {
  it("defaults appearance to the default palette in /system/config", async () => {
    await withTestHarness(async (harness) => {
      const response = await harness.app.request("/api/v1/system/config");
      expect(response.status).toBe(200);
      const body = systemConfigResponseSchema.parse(await readJson(response));
      expect(body.appearance).toEqual(defaultAppTheme);
      expect(body.customThemes).toEqual([]);
      expect(body.pluginThemes).toEqual([]);
    });
  });

  it("persists a built-in theme and reflects it in /system/config", async () => {
    await withTestHarness(async (harness) => {
      const put = await harness.app.request("/api/v1/settings/appearance", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ themeId: "nord", faviconColor: "default" }),
      });
      expect(put.status).toBe(200);
      expect(appThemeSchema.parse(await readJson(put))).toEqual(
        appearanceForPalette("nord"),
      );
      expect(getStoredThemeId(harness.db)).toBe("nord");

      const config = await harness.app.request("/api/v1/system/config");
      expect(
        systemConfigResponseSchema.parse(await readJson(config)).appearance,
      ).toEqual(appearanceForPalette("nord"));
    });
  });

  it("activates a custom theme discovered on disk", async () => {
    await withTestHarness(async (harness) => {
      const css = ":root { --primary: #ff00ff; }";
      await writeCustomTheme(harness.config.dataDir, "midnight", css);

      const put = await harness.app.request("/api/v1/settings/appearance", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ themeId: "midnight", faviconColor: "default" }),
      });
      expect(put.status).toBe(200);
      expect(appThemeSchema.parse(await readJson(put))).toEqual({
        ...defaultAppTheme,
        themeId: "midnight",
        customCss: css,
      });
      expect(getStoredThemeId(harness.db)).toBe("midnight");

      const config = systemConfigResponseSchema.parse(
        await readJson(await harness.app.request("/api/v1/system/config")),
      );
      expect(config.appearance).toEqual({
        ...defaultAppTheme,
        themeId: "midnight",
        customCss: css,
      });
      expect(config.customThemes).toEqual(["midnight"]);
    });
  });

  it("persists the favicon color independently of the palette", async () => {
    await withTestHarness(async (harness) => {
      const put = await harness.app.request("/api/v1/settings/appearance", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ themeId: "default", faviconColor: "teal" }),
      });
      expect(put.status).toBe(200);
      expect(getStoredFaviconColor(harness.db)).toBe("teal");

      const config = systemConfigResponseSchema.parse(
        await readJson(await harness.app.request("/api/v1/system/config")),
      );
      expect(config.appearance).toEqual({
        ...defaultAppTheme,
        faviconColor: "teal",
      });
    });
  });

  it("persists a complete selection when changing the theme", async () => {
    await withTestHarness(async (harness) => {
      await harness.app.request("/api/v1/settings/appearance", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ themeId: "default", faviconColor: "purple" }),
      });

      const put = await harness.app.request("/api/v1/settings/appearance", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ themeId: "nord", faviconColor: "purple" }),
      });
      expect(appThemeSchema.parse(await readJson(put))).toEqual(
        appearanceForPalette("nord", { faviconColor: "purple" }),
      );
      expect(getStoredFaviconColor(harness.db)).toBe("purple");
    });
  });

  it("rejects an unknown favicon color", async () => {
    await withTestHarness(async (harness) => {
      const response = await harness.app.request(
        "/api/v1/settings/appearance",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            themeId: "default",
            faviconColor: "chartreuse",
          }),
        },
      );
      expect(response.status).toBe(400);
    });
  });

  it("rejects an incomplete appearance selection", async () => {
    await withTestHarness(async (harness) => {
      const response = await harness.app.request(
        "/api/v1/settings/appearance",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ themeId: "nord" }),
        },
      );
      expect(response.status).toBe(400);
    });
  });

  it("lists discovered custom themes in the theme catalog", async () => {
    await withTestHarness(async (harness) => {
      await writeCustomTheme(harness.config.dataDir, "zephyr", ":root {}");
      await writeCustomTheme(harness.config.dataDir, "amber", ":root {}");
      await mkdir(join(harness.config.dataDir, "theme", "incomplete"), {
        recursive: true,
      });

      const response = await harness.app.request("/api/v1/settings/themes");
      expect(response.status).toBe(200);
      const catalog = themeCatalogResponseSchema.parse(
        await readJson(response),
      );
      expect(catalog.dir).toBe(join(harness.config.dataDir, "theme"));
      expect(catalog.custom).toEqual(["amber", "zephyr"]);
      expect(catalog.plugins).toEqual([]);
      expect(catalog.active).toEqual(defaultAppTheme);
    });
  });

  it("lists and activates palettes shipped by loaded plugins", async () => {
    await withTestHarness(async (harness) => {
      const root = join(
        harness.config.dataDir,
        "fixtures",
        "bb-plugin-palette",
      );
      await mkdir(join(root, "themes"), { recursive: true });
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({
          name: "bb-plugin-palette",
          version: "0.1.0",
          bb: {
            name: "Palette fixture",
            description: "Plugin palette fixture.",
            branding: { icon: "Zap" },
            server: "./server.ts",
            themes: [
              {
                id: "ocean",
                name: "Ocean",
                description: "Deep blue",
                css: "./themes/ocean.css",
              },
            ],
          },
        }),
      );
      await writeFile(
        join(root, "server.ts"),
        "export default function () {}\n",
      );
      await writeFile(
        join(root, "themes", "ocean.css"),
        ":root { --canvas: blue; }",
      );
      await harness.pluginService.installPath(root);

      const themeId = formatPluginThemeId("palette", "ocean");
      const catalogResponse = await harness.app.request(
        "/api/v1/settings/themes",
      );
      const catalog = themeCatalogResponseSchema.parse(
        await readJson(catalogResponse),
      );
      expect(catalog.plugins).toEqual([
        {
          id: themeId,
          pluginId: "palette",
          name: "Ocean",
          description: "Deep blue",
        },
      ]);

      const response = await harness.app.request(
        "/api/v1/settings/appearance",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ themeId, faviconColor: "default" }),
        },
      );
      expect(response.status).toBe(200);
      expect(appThemeSchema.parse(await readJson(response))).toEqual({
        ...defaultAppTheme,
        themeId,
        customCss: ":root { --canvas: blue; }",
      });
    });
  });

  it("falls back to default when the active custom theme is deleted", async () => {
    await withTestHarness(async (harness) => {
      await writeCustomTheme(harness.config.dataDir, "ghost", ":root {}");
      await harness.app.request("/api/v1/settings/appearance", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ themeId: "ghost", faviconColor: "default" }),
      });

      await rm(join(harness.config.dataDir, "theme", "ghost"), {
        recursive: true,
        force: true,
      });

      const config = systemConfigResponseSchema.parse(
        await readJson(await harness.app.request("/api/v1/system/config")),
      );
      expect(getStoredThemeId(harness.db)).toBe("ghost");
      expect(config.appearance).toEqual(defaultAppTheme);
      expect(config.customThemes).toEqual([]);
    });
  });

  it("rejects selecting a custom theme that does not exist", async () => {
    await withTestHarness(async (harness) => {
      const response = await harness.app.request(
        "/api/v1/settings/appearance",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            themeId: "nonexistent",
            faviconColor: "default",
          }),
        },
      );
      expect(response.status).toBe(404);
    });
  });

  it("rejects a theme id that is not a safe path segment", async () => {
    await withTestHarness(async (harness) => {
      const response = await harness.app.request(
        "/api/v1/settings/appearance",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ themeId: "../evil", faviconColor: "default" }),
        },
      );
      expect(response.status).toBe(400);
    });
  });

  it("lets a custom UI theme ship Pierre code-theme JSON", async () => {
    await withTestHarness(async (harness) => {
      await writeCustomTheme(harness.config.dataDir, "ocean", ":root {}");
      const darkTheme = {
        name: "Ocean Dark",
        type: "dark",
        colors: { "editor.background": "#001" },
        tokenColors: [],
      };
      await writeFile(
        join(harness.config.dataDir, "theme", "ocean", "pierre-dark.json"),
        JSON.stringify(darkTheme),
        "utf8",
      );

      const put = await harness.app.request("/api/v1/settings/appearance", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ themeId: "ocean", faviconColor: "default" }),
      });
      expect(appThemeSchema.parse(await readJson(put))).toEqual({
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

  it("follows a built-in palette's matching Shiki pair", async () => {
    await withTestHarness(async (harness) => {
      const put = await harness.app.request("/api/v1/settings/appearance", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ themeId: "dracula", faviconColor: "default" }),
      });
      expect(appThemeSchema.parse(await readJson(put))).toEqual(
        appearanceForPalette("dracula"),
      );
    });
  });
});
