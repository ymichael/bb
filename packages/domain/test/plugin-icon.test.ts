import { describe, expect, it } from "vitest";
import {
  isNamespacedGlyph,
  parseNamespacedGlyph,
  PLUGIN_ICON_NAME_MAX_LENGTH,
  PLUGIN_ICONS_MAX_COUNT,
  pluginPackageJsonSchema,
} from "../src/index.js";

describe("namespaced glyphs", () => {
  it("splits a declared-icon reference into its plugin id and name", () => {
    expect(parseNamespacedGlyph("echo-provider/receipt")).toEqual({
      pluginId: "echo-provider",
      name: "receipt",
    });
    expect(parseNamespacedGlyph("acp/cursor-2")).toEqual({
      pluginId: "acp",
      name: "cursor-2",
    });
    expect(isNamespacedGlyph("echo-provider/receipt")).toBe(true);
  });

  it("leaves host glyphs, paths, and malformed references alone", () => {
    for (const glyph of [
      "FileText",
      "Zap",
      "./icons/receipt.svg",
      "echo-provider/",
      "/receipt",
      "echo-provider/Receipt",
      "echo-provider/-receipt",
      "Echo/receipt",
      "a/b/c",
      "",
    ]) {
      expect(parseNamespacedGlyph(glyph), glyph).toBeNull();
      expect(isNamespacedGlyph(glyph), glyph).toBe(false);
    }
  });
});

describe("bb.branding.icon grammar", () => {
  function manifest(icon: string) {
    return pluginPackageJsonSchema.safeParse({
      name: "bb-plugin-icons",
      version: "0.1.0",
      bb: {
        name: "Icons",
        description: "Declares icons.",
        branding: { icon, experimental_icons: { logo: "./icons/logo.svg" } },
        server: "./server.ts",
      },
    });
  }

  it("takes a host glyph name or a plugin-relative svg path", () => {
    expect(manifest("Zap").success).toBe(true);
    expect(manifest("./icons/logo.svg").success).toBe(true);
  });

  it("refuses the namespaced declared-icon form, naming the value", () => {
    const parsed = manifest("icons/logo");
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["bb", "branding", "icon"]);
    expect(parsed.error?.issues[0]?.message).toMatch(
      /^"icons\/logo" is a namespaced glyph/u,
    );
  });
});

describe("bb.branding.experimental_icons grammar", () => {
  function manifest(icons: unknown) {
    return pluginPackageJsonSchema.safeParse({
      name: "bb-plugin-icons",
      version: "0.1.0",
      bb: {
        name: "Icons",
        description: "Declares icons.",
        branding: { icon: "Zap", experimental_icons: icons },
        server: "./server.ts",
      },
    });
  }

  it("accepts a name → plugin-relative svg map", () => {
    const parsed = manifest({
      receipt: "./icons/receipt.svg",
      "mood-2": "./icons/MOOD.SVG",
    });
    expect(parsed.success).toBe(true);
  });

  it("names the violation: bad name, non-svg path, path without ./, too many entries", () => {
    const badName = manifest({ Receipt: "./icons/receipt.svg" });
    expect(badName.success).toBe(false);
    expect(badName.error?.issues[0]?.path).toEqual([
      "bb",
      "branding",
      "experimental_icons",
      "Receipt",
    ]);

    const longName = manifest({
      ["r".repeat(PLUGIN_ICON_NAME_MAX_LENGTH + 1)]: "./icons/receipt.svg",
    });
    expect(longName.success).toBe(false);

    const png = manifest({ receipt: "./icons/receipt.png" });
    expect(png.success).toBe(false);
    expect(png.error?.issues[0]?.message).toMatch(/plugin-relative \.svg/u);

    const bare = manifest({ receipt: "icons/receipt.svg" });
    expect(bare.success).toBe(false);

    const tooMany = manifest(
      Object.fromEntries(
        Array.from({ length: PLUGIN_ICONS_MAX_COUNT + 1 }, (_, index) => [
          `icon-${index}`,
          "./icons/icon.svg",
        ]),
      ),
    );
    expect(tooMany.success).toBe(false);
    expect(tooMany.error?.issues[0]?.message).toMatch(/at most/u);
  });
});
