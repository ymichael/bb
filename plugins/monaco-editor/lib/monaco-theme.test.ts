import { describe, expect, it } from "vitest";
import type { PluginCodeThemeData } from "@get-bb/plugin-sdk/app";
import {
  applyCodeTheme,
  editorBackground,
  monacoThemeName,
  toMonacoTheme,
} from "./monaco-theme.js";

function theme(
  overrides: Partial<PluginCodeThemeData> = {},
): PluginCodeThemeData {
  return {
    name: "bb:nord:light:1f4c9a2b",
    type: "light",
    fg: "#2e3440",
    bg: "#eceff4",
    colors: {},
    tokenColors: [],
    ...overrides,
  };
}

const MONACO_THEME_NAME = /^[a-zA-Z0-9-]+$/;

describe("monacoThemeName", () => {
  it("maps BB's namespaced, fingerprinted names into what Monaco accepts", () => {
    expect(monacoThemeName("bb:nord:light:1f4c9a2b")).toMatch(
      MONACO_THEME_NAME,
    );
    expect(monacoThemeName("catppuccin-mocha")).toMatch(MONACO_THEME_NAME);
  });

  it("keeps distinct theme names distinct", () => {
    expect(monacoThemeName("bb:nord:light")).not.toBe(
      monacoThemeName("bb:nord:dark"),
    );
  });
});

describe("toMonacoTheme", () => {
  it("takes its base from the theme's own type", () => {
    expect(toMonacoTheme(theme({ type: "dark" })).base).toBe("vs-dark");
    expect(toMonacoTheme(theme({ type: "light" })).base).toBe("vs");
  });

  it("emits a default rule so unmatched tokens do not fall back to the base theme", () => {
    expect(toMonacoTheme(theme()).rules[0]).toEqual({
      token: "",
      foreground: "2e3440",
    });
  });

  it("expands short hex and drops colors Monaco's rule parser would throw on", () => {
    const { rules } = toMonacoTheme(
      theme({
        tokenColors: [
          { scope: "comment", settings: { foreground: "#abc" } },
          { scope: "keyword", settings: { foreground: "not-a-color" } },
          { scope: "string", settings: { foreground: "#11223344" } },
        ],
      }),
    );
    expect(rules).toContainEqual({ token: "comment", foreground: "aabbcc" });
    expect(rules).toContainEqual({ token: "string", foreground: "11223344" });
    expect(rules.some((rule) => rule.token === "keyword")).toBe(false);
  });

  it("splits both spellings of a multi-scope rule into one rule each", () => {
    const { rules } = toMonacoTheme(
      theme({
        tokenColors: [
          {
            scope: ["variable", "entity.name"],
            settings: { foreground: "#111111" },
          },
          {
            scope: "constant, support.type",
            settings: { foreground: "#222222" },
          },
        ],
      }),
    );
    expect(rules).toContainEqual({ token: "variable", foreground: "111111" });
    expect(rules).toContainEqual({
      token: "entity.name",
      foreground: "111111",
    });
    expect(rules).toContainEqual({ token: "constant", foreground: "222222" });
    expect(rules).toContainEqual({
      token: "support.type",
      foreground: "222222",
    });
  });

  it("keeps only the font styles Monaco understands", () => {
    const { rules } = toMonacoTheme(
      theme({
        tokenColors: [
          {
            scope: "comment",
            settings: {
              foreground: "#111111",
              fontStyle: "italic strikethrough",
            },
          },
          { scope: "keyword", settings: { fontStyle: "bold underline" } },
        ],
      }),
    );
    expect(rules).toContainEqual({
      token: "comment",
      foreground: "111111",
      fontStyle: "italic",
    });
    expect(rules).toContainEqual({
      token: "keyword",
      fontStyle: "bold underline",
    });
  });

  it("fills the editor surface from the theme's own pair when it declares no workbench colors", () => {
    expect(toMonacoTheme(theme()).colors).toEqual({
      "editor.background": "#eceff4",
      "editor.foreground": "#2e3440",
    });
  });

  it("prefers declared workbench colors and drops values Color.fromHex would read as red", () => {
    expect(
      toMonacoTheme(
        theme({
          colors: {
            "editor.background": "#1e1e1e",
            "editorCursor.foreground": "#88c0d0",
            "editor.selectionBackground": "rgba(0,0,0,0.2)",
          },
        }),
      ).colors,
    ).toEqual({
      "editor.background": "#1e1e1e",
      "editorCursor.foreground": "#88c0d0",
      "editor.foreground": "#2e3440",
    });
  });
});

describe("applyCodeTheme", () => {
  function fakeMonaco(defined: string[]) {
    return {
      editor: { defineTheme: (name: string) => defined.push(name) },
    } as unknown as Parameters<typeof applyCodeTheme>[0];
  }

  it("falls back to Monaco's stock pair before the first theme document resolves", () => {
    const defined: string[] = [];
    expect(
      applyCodeTheme(fakeMonaco(defined), { mode: "dark", theme: null }),
    ).toEqual({ name: "vs-dark", base: "vs-dark" });
    expect(defined).toEqual([]);
  });

  it("keys the widget base on the applied document, so a mid-switch frame stays coherent", () => {
    expect(
      applyCodeTheme(fakeMonaco([]), { mode: "dark", theme: theme() }).base,
    ).toBe("vs");
  });
});

describe("editorBackground", () => {
  it("prefers the declared workbench color over the theme's own pair", () => {
    expect(
      editorBackground(theme({ colors: { "editor.background": "#1e1e2e" } })),
    ).toBe("#1e1e2e");
  });

  it("falls back to the theme's background, and to nothing before one resolves", () => {
    expect(editorBackground(theme())).toBe("#eceff4");
    expect(editorBackground(null)).toBeNull();
  });

  it("reports nothing for a background the browser could not paint", () => {
    expect(
      editorBackground(
        theme({ bg: "not-a-color", colors: { "editor.background": "red" } }),
      ),
    ).toBeNull();
  });
});
