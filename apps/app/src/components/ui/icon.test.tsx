// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const sharedUiIconDir = dirname(require.resolve("@bb/shared-ui/icon"));

type IconModule = typeof import("@bb/shared-ui/icon");
type IconRegistryModule = typeof import("@bb/shared-ui/icon-registry");
type IconExtendedModule = typeof import("@bb/shared-ui/icon-extended");

async function freshIconModules(): Promise<{
  icon: IconModule;
  registry: IconRegistryModule;
}> {
  vi.resetModules();
  const [icon, registry] = await Promise.all([
    import("@bb/shared-ui/icon"),
    import("@bb/shared-ui/icon-registry"),
  ]);
  return { icon, registry };
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  cleanup();
  vi.resetModules();
});

describe("Icon core/extended split", () => {
  it("renders a core glyph synchronously before the extended registry loads", async () => {
    const { icon, registry } = await freshIconModules();
    expect(registry.getExtendedIcons()).toBeNull();

    const view = render(<icon.Icon name="ChevronRight" aria-hidden />);
    const svg = view.container.querySelector("svg[data-icon=ChevronRight]");
    expect(svg).not.toBeNull();
    expect(svg?.childElementCount).toBeGreaterThan(0);
    expect(svg?.hasAttribute("data-icon-pending")).toBe(false);
    expect(registry.getExtendedIcons()).toBeNull();
  });

  it("renders an extended glyph as a same-size placeholder, then fills it in when the registry loads", async () => {
    const { icon, registry } = await freshIconModules();

    const view = render(<icon.Icon name="Palette" aria-hidden />);
    const pending = view.container.querySelector("svg[data-icon=Palette]");
    expect(pending).not.toBeNull();
    expect(pending?.hasAttribute("data-icon-pending")).toBe(true);
    expect(pending?.childElementCount).toBe(0);
    expect(pending?.getAttribute("width")).toBe("24");
    expect(pending?.getAttribute("height")).toBe("24");

    await act(async () => {
      await vi.waitUntil(() => registry.getExtendedIcons() !== null, {
        timeout: 5000,
      });
    });

    expect(registry.getExtendedIcons()).not.toBeNull();
    await expect(icon.preloadExtendedIcons()).resolves.toBeUndefined();
    const loaded = view.container.querySelector("svg[data-icon=Palette]");
    expect(loaded?.hasAttribute("data-icon-pending")).toBe(false);
    expect(loaded?.childElementCount).toBeGreaterThan(0);
  });

  it("keeps ICON_NAMES equal to the disjoint union of the core and extended maps", async () => {
    const { icon, registry } = await freshIconModules();
    const extended: IconExtendedModule =
      await import("@bb/shared-ui/icon-extended");

    const extendedKeys = Object.keys(extended.EXTENDED_ICON_MAP).sort();
    expect(extendedKeys).toEqual([...registry.EXTENDED_ICON_NAMES].sort());
    expect(new Set(icon.ICON_NAMES).size).toBe(icon.ICON_NAMES.length);
    for (const name of registry.EXTENDED_ICON_NAMES) {
      expect(icon.ICON_NAMES).toContain(name);
    }
    for (const name of registry.EXTENDED_ICON_NAMES) {
      expect(extended.EXTENDED_ICON_MAP[name].length).toBeGreaterThan(0);
    }
  });

  it("keeps the extended artwork off the static import graph of the boot modules", () => {
    const iconSource = readFileSync(join(sharedUiIconDir, "icon.tsx"), "utf8");
    const registrySource = readFileSync(
      join(sharedUiIconDir, "icon-registry.ts"),
      "utf8",
    );

    expect(iconSource).not.toMatch(/from\s+["']\.\/icon-extended["']/);
    expect(iconSource).toMatch(/import\(\s*["']\.\/icon-extended["']\s*\)/);
    expect(registrySource).not.toMatch(/@hugeicons\/core-free-icons/);
    expect(registrySource).not.toMatch(/from\s+["']\.\/icon-extended["']/);
  });
});
