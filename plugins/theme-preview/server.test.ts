import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import plugin, { buildCatalog, classifySelector, createCatalogLoader, parseThemeSwatches } from "./server";

describe("classifySelector", () => {
  it("accepts the mode roots and rejects element-scoped blocks", () => {
    expect(classifySelector(":root, .light")).toBe("shared");
    expect(classifySelector(":root")).toBe("shared");
    expect(classifySelector(":root:not(.dark)")).toBe("light");
    expect(classifySelector(":root:not(.dark), .light:not(.dark)")).toBe("light");
    expect(classifySelector(".dark")).toBe("dark");
    expect(classifySelector(".dark .fixed.bg-sidebar")).toBeNull();
    expect(classifySelector("code:not(pre code)")).toBeNull();
  });
});

describe("parseThemeSwatches", () => {
  const css = `
    :root, .light { --canvas: #f4f4f4; --sidebar: #e4e4e4; --card: #fff; --primary: #0a0a0a;
                    --file-accent: #405663; --foreground: #0a0a0a; --font-sans: Helvetica; --font-mono: Courier; }
    .dark { --canvas: #1a1a1a; --sidebar: #0a0a0a; --card: #212121; --primary: #ffffff;
            --file-accent: #9db6c6; --foreground: #cecbc4; }
    :root:not(.dark) { --primary: #2e6f95; }
    .dark .fixed.bg-sidebar { --sidebar: #070707; }
  `;

  it("resolves each mode with later declarations winning", () => {
    const { light, dark } = parseThemeSwatches(css);
    expect(light?.primary).toBe("#2e6f95");
    expect(light?.canvas).toBe("#f4f4f4");
    expect(dark?.primary).toBe("#ffffff");
    // the element-scoped override describes one surface, not the palette
    expect(dark?.sidebar).toBe("#0a0a0a");
  });

  it("keeps light-only overrides out of the dark swatch", () => {
    const parsed = parseThemeSwatches(`
      :root, .light { --canvas: #eeeeee; }
      .dark { --canvas: #222222; }
      :root:not(.dark), .light:not(.dark) { --canvas: #fefefe; }
    `);
    expect(parsed.light?.canvas).toBe("#fefefe");
    expect(parsed.dark?.canvas).toBe("#222222");
  });

  it("falls back across token candidates and overlays the base palette", () => {
    const { light, dark } = parseThemeSwatches(css);
    expect(light?.fontSans).toBe("Helvetica");
    expect(dark?.fontSans).toBe("Helvetica");
    expect(parseThemeSwatches(":root { --background: #fff; }").light?.canvas).toBe("#fff");
    expect(parseThemeSwatches(":root { --background: #fff; }").dark?.canvas).toBe("#fff");
  });

  it("resolves shared, mode-specific, derived, and inherited values", () => {
    const parsed = parseThemeSwatches(`
      :root { --brand: #456789; --primary: var(--brand); }
      :root:not(.dark) { --canvas: #fefefe; }
      .dark { --brand: #abcdef; --file-accent: var(--missing, var(--brand)); }
    `);
    expect(parsed.light?.primary).toBe("#456789");
    expect(parsed.light?.canvas).toBe("#fefefe");
    expect(parsed.dark?.primary).toBe("#abcdef");
    expect(parsed.dark?.accent).toBe("#abcdef");
    expect(parsed.dark?.canvas).toBe("oklch(0.195 0 0)");
  });
});

describe("createCatalogLoader", () => {
  it("shares one catalog refresh across overlapping callers", async () => {
    let catalogCalls = 0;
    let releaseCatalog!: () => void;
    const catalogBlocked = new Promise<void>((resolve) => { releaseCatalog = resolve; });
    const bb = {
      sdk: {
        theme: {
          catalog: async () => {
            catalogCalls += 1;
            await catalogBlocked;
            return { active: { themeId: "default" }, custom: [], dir: null };
          },
        },
        plugins: { list: async () => ({ plugins: [] }) },
      },
      log: { info() {}, warn() {} },
    } as unknown as BbPluginApi;

    const catalogLoader = createCatalogLoader(bb);
    const first = catalogLoader.catalog();
    const second = catalogLoader.catalog();

    expect(catalogCalls).toBe(1);
    releaseCatalog();
    await Promise.all([first, second]);
  });

  it("times out a stuck catalog request, aborts it, and allows a healthy retry", async () => {
    vi.useFakeTimers();
    try {
      let catalogCalls = 0;
      let firstSignal: AbortSignal | undefined;
      const warn = vi.fn();
      const bb = {
        sdk: {
          theme: {
            catalog: ({ signal }: { signal?: AbortSignal } = {}) => {
              catalogCalls += 1;
              if (catalogCalls === 1) {
                firstSignal = signal;
                return new Promise(() => undefined);
              }
              return Promise.resolve({ active: { themeId: "default" }, custom: [], dir: null });
            },
          },
          plugins: { list: async () => ({ plugins: [] }) },
        },
        log: { info() {}, warn },
      } as unknown as BbPluginApi;

      const catalogLoader = createCatalogLoader(bb);
      const failed = catalogLoader.catalog().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(5_000);

      expect(warn).toHaveBeenCalledWith("theme-preview: theme catalog still pending after 5000ms");
      await vi.advanceTimersByTimeAsync(10_000);
      const error = await failed;
      expect(error).toEqual(expect.objectContaining({ message: "theme-preview: theme catalog timed out after 15000ms" }));
      expect(firstSignal?.aborted).toBe(true);

      const recovered = await catalogLoader.catalog();
      expect(recovered.activeThemeId).toBe("default");
      expect(catalogCalls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a stuck plugin list without poisoning the next catalog refresh", async () => {
    vi.useFakeTimers();
    try {
      let pluginListCalls = 0;
      let firstSignal: AbortSignal | undefined;
      const warn = vi.fn();
      const bb = {
        sdk: {
          theme: {
            catalog: async () => ({ active: { themeId: "default" }, custom: [], dir: null }),
          },
          plugins: {
            list: ({ signal }: { signal?: AbortSignal } = {}) => {
              pluginListCalls += 1;
              if (pluginListCalls === 1) {
                firstSignal = signal;
                return new Promise(() => undefined);
              }
              return Promise.resolve({ plugins: [] });
            },
          },
        },
        log: { info() {}, warn },
      } as unknown as BbPluginApi;

      const catalogLoader = createCatalogLoader(bb);
      const degraded = catalogLoader.catalog();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(warn).toHaveBeenCalledWith("theme-preview: plugin list still pending after 5000ms");
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(degraded).resolves.toEqual(expect.objectContaining({ activeThemeId: "default" }));
      expect(firstSignal?.aborted).toBe(true);
      expect(warn).toHaveBeenCalledWith(
        "theme-preview: plugin list unavailable: Error: theme-preview: plugin list timed out after 15000ms",
      );
      await expect(catalogLoader.catalog()).resolves.toEqual(expect.objectContaining({ activeThemeId: "default" }));
      expect(pluginListCalls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("acknowledges a selection without waiting for catalog enrichment", async () => {
    let activeThemeId = "theme-a";
    let blockPluginList = false;
    let releasePluginList!: () => void;
    const pluginListBlocked = new Promise<void>((resolve) => { releasePluginList = resolve; });
    const bb = {
      sdk: {
        theme: {
          catalog: async () => ({ active: { themeId: activeThemeId }, custom: ["theme-a", "theme-b"], dir: null }),
          set: async (themeId: string) => { activeThemeId = themeId; },
        },
        plugins: {
          list: async () => {
            if (blockPluginList) await pluginListBlocked;
            return { plugins: [] };
          },
        },
      },
      log: { info() {}, warn() {} },
    } as unknown as BbPluginApi;

    const catalogLoader = createCatalogLoader(bb);
    await catalogLoader.catalog();
    blockPluginList = true;

    const selection = catalogLoader.setTheme("theme-b");
    const outcome = await Promise.race([
      selection.then((catalog) => ({ status: "resolved" as const, catalog })),
      new Promise<{ status: "pending" }>((resolve) => setTimeout(() => resolve({ status: "pending" }), 10)),
    ]);

    releasePluginList();
    await selection;
    expect(outcome.status).toBe("resolved");
    if (outcome.status === "resolved") expect(outcome.catalog.activeThemeId).toBe("theme-b");
  });

  it("serializes overlapping selections so the latest requested theme wins", async () => {
    let activeThemeId = "initial";
    const setCalls: string[] = [];
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const bb = {
      sdk: {
        theme: {
          catalog: async () => ({ active: { themeId: activeThemeId }, custom: [], dir: null }),
          set: async (themeId: string) => {
            setCalls.push(themeId);
            if (themeId === "theme-a") {
              markFirstStarted();
              await firstBlocked;
            }
            activeThemeId = themeId;
          },
        },
        plugins: { list: async () => ({ plugins: [] }) },
      },
      log: { info() {}, warn() {} },
    } as unknown as BbPluginApi;

    const catalogLoader = createCatalogLoader(bb);
    const first = catalogLoader.setTheme("theme-a");
    await firstStarted;
    const second = catalogLoader.setTheme("theme-b");
    await Promise.resolve();

    expect(setCalls).toEqual(["theme-a"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(setCalls).toEqual(["theme-a", "theme-b"]);
    expect(activeThemeId).toBe("theme-b");
  });

  it("does not let a stale request reapply a theme selected by a newer request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "theme-preview-catalog-"));
    for (const id of ["theme-a", "theme-b"]) {
      await mkdir(join(directory, id));
      await writeFile(join(directory, id, "theme.css"), `:root { --canvas: #${id === "theme-a" ? "aaaaaa" : "bbbbbb"}; }`);
    }

    let activeThemeId = "theme-a";
    let pluginListCalls = 0;
    let resumeFirstPluginList!: () => void;
    const firstPluginList = new Promise<void>((resolve) => { resumeFirstPluginList = resolve; });
    const setCalls: string[] = [];
    const bb = {
      sdk: {
        theme: {
          catalog: async () => ({ active: { themeId: activeThemeId }, custom: ["theme-a", "theme-b"], dir: directory }),
          set: async (themeId: string) => { setCalls.push(themeId); activeThemeId = themeId; },
        },
        plugins: {
          list: async () => {
            pluginListCalls += 1;
            if (pluginListCalls === 1) await firstPluginList;
            return { plugins: [] };
          },
        },
      },
      log: { info() {}, warn() {} },
    } as unknown as BbPluginApi;

    const catalogLoader = createCatalogLoader(bb);
    const stale = catalogLoader.catalog();
    const latest = await catalogLoader.setTheme("theme-b");
    expect(latest.activeThemeId).toBe("theme-b");
    resumeFirstPluginList();
    const late = await stale;

    expect(late.activeThemeId).toBe("theme-a");
    expect(activeThemeId).toBe("theme-b");
    expect(setCalls).toEqual(["theme-b"]);
    await rm(directory, { recursive: true, force: true });
  });

  it("reapplies the active theme and increments the revision after an external write", async () => {
    const directory = await mkdtemp(join(tmpdir(), "theme-preview-revision-"));
    const themeDirectory = join(directory, "theme-a");
    const filePath = join(themeDirectory, "theme.css");
    await mkdir(themeDirectory);
    await writeFile(filePath, ":root { --canvas: #ffffff; }");
    const setCalls: string[] = [];
    const bb = {
      sdk: {
        theme: {
          catalog: async () => ({ active: { themeId: "theme-a" }, custom: ["theme-a"], dir: directory }),
          set: async (themeId: string) => { setCalls.push(themeId); },
        },
        plugins: { list: async () => ({ plugins: [] }) },
      },
      log: { info() {}, warn() {} },
    } as unknown as BbPluginApi;

    try {
      const loader = createCatalogLoader(bb);
      expect((await loader.catalog()).revision).toBe(0);

      await writeFile(filePath, ":root { --canvas: #dddddd; }\n/* external and longer */");
      expect((await loader.catalog()).revision).toBe(1);
      expect(setCalls).toEqual(["theme-a"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("theme watcher", () => {
  it("stops promptly when aborted during the initial catalog request", async () => {
    let start!: (signal: AbortSignal) => Promise<void>;
    let markCatalogStarted!: () => void;
    const catalogStarted = new Promise<void>((resolve) => { markCatalogStarted = resolve; });
    let catalogSignal: AbortSignal | undefined;
    const bb = {
      background: {
        service(_name: string, options: { start(signal: AbortSignal): Promise<void> }) {
          start = options.start;
        },
      },
      sdk: {
        theme: {
          catalog: ({ signal }: { signal?: AbortSignal } = {}) => {
            catalogSignal = signal;
            markCatalogStarted();
            return new Promise((_resolve, reject) => {
              signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
          },
        },
      },
      rpc: { register() {} },
      log: { info() {}, warn() {} },
    } as unknown as BbPluginApi;

    await plugin(bb);
    const controller = new AbortController();
    const running = start(controller.signal);
    await catalogStarted;
    controller.abort();

    await expect(running).resolves.toBeUndefined();
    expect(catalogSignal).toBe(controller.signal);
  });
});

describe("RPC registration", () => {
  it("exposes only catalog loading and theme selection", async () => {
    let handlerNames: string[] = [];
    const bb = {
      background: { service() {} },
      rpc: {
        register(_contract: unknown, handlers: object) {
          handlerNames = Object.keys(handlers).sort();
        },
      },
      log: { info() {}, warn() {} },
    } as unknown as BbPluginApi;

    await plugin(bb);

    expect(handlerNames).toEqual(["setTheme", "themeCatalog"]);
  });
});

describe("comments", () => {
  it("does not let a commented selector swallow the block after it", () => {
    const css = `/* .dark .fixed.bg-sidebar { --sidebar: #000; } */ :root { --canvas: #f4f4f4; }`;
    expect(parseThemeSwatches(css).light?.canvas).toBe("#f4f4f4");
  });
});

describe("buildCatalog", () => {
  it("lists custom and plugin themes, keeps an unlisted active id, and attaches swatches", async () => {
    const out = await buildCatalog(
      {
        active: { themeId: "default" },
        custom: ["endless"],
        plugins: [{ id: "plugin:endless:endless-color", name: "Endless Color" }],
      },
      async (id) => (id === "endless" ? ":root { --canvas: #f4f4f4; }" : null),
    );
    expect(out.activeThemeId).toBe("default");
    expect(out.themes.map((t) => t.id).slice(0, 3)).toEqual(["endless", "plugin:endless:endless-color", "default"]);
    // bundled palettes carry swatches extracted from bb's source
    const nord = out.themes.find((t) => t.id === "nord");
    expect(nord?.dark?.primary).toBe("#88c0d0");
    expect(nord?.light?.canvas).toBe("#eceff4");
    expect(out.themes[0].light?.canvas).toBe("#f4f4f4");
    expect(out.themes[1].light).toBeNull();
    expect(out.revision).toBe(0);
  });
});
