import { afterEach, describe, expect, it, vi } from "vitest";
import * as react from "react";
import * as jsxRuntime from "react/jsx-runtime";
import clsx from "clsx";
import { Icon } from "@bb/shared-ui/icon";
import {
  createPluginFrontendPageLifecycle,
  installPluginRuntime,
  loadPluginFrontends,
  type PluginFrontendCandidate,
} from "./plugin-frontend";
import { pluginSdkAppImplementation } from "./plugin-sdk-app-impl";

function candidate(
  pluginId: string,
  overrides: Partial<PluginFrontendCandidate["bundle"]> = {},
): PluginFrontendCandidate {
  return {
    pluginId,
    bundle: {
      jsUrl: `/api/v1/plugins/${pluginId}/assets/app.js?h=abc123`,
      cssUrl: `/api/v1/plugins/${pluginId}/assets/app.css?h=abc123`,
      jsBytes: 1_000,
      hash: "abc123",
      sdkMajor: 0,
      sdkVersion: "0.1.0",
      compatible: true,
      ...overrides,
    },
  };
}

describe("loadPluginFrontends", () => {
  it("imports each compatible bundle, links its CSS, and keeps the module namespace", async () => {
    const moduleA = { default: { kind: "plugin-app" } };
    const moduleB = { default: { kind: "other-app" } };
    const importModule = vi
      .fn()
      .mockImplementation(async (url: string) =>
        url.includes("/plugins/a/") ? moduleA : moduleB,
      );
    const injectCss = vi.fn();

    const records = await loadPluginFrontends(
      [candidate("a"), candidate("b", { cssUrl: null })],
      { importModule, injectCss, warn: vi.fn() },
    );

    expect(records.get("a")).toEqual({
      pluginId: "a",
      status: "loaded",
      module: moduleA,
    });
    expect(records.get("b")).toEqual({
      pluginId: "b",
      status: "loaded",
      module: moduleB,
    });
    expect(importModule).toHaveBeenCalledWith(
      "/api/v1/plugins/a/assets/app.js?h=abc123",
    );
    expect(injectCss).toHaveBeenCalledTimes(1);
    expect(injectCss).toHaveBeenCalledWith(
      "a",
      "/api/v1/plugins/a/assets/app.css?h=abc123",
    );
  });

  it("contains an import failure to its own plugin", async () => {
    const good = { default: {} };
    const importModule = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/plugins/broken/")) {
        throw new Error("SyntaxError: unexpected token");
      }
      return good;
    });
    const warn = vi.fn();

    const records = await loadPluginFrontends(
      [candidate("broken"), candidate("fine", { cssUrl: null })],
      { importModule, injectCss: vi.fn(), warn },
    );

    expect(records.get("broken")).toEqual({
      pluginId: "broken",
      status: "failed",
      error: "SyntaxError: unexpected token",
    });
    expect(records.get("fine")).toEqual({
      pluginId: "fine",
      status: "loaded",
      module: good,
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("[plugin:broken] frontend bundle failed to load"),
    );
  });

  it("records a bundle that evaluates to a non-module as failed", async () => {
    const records = await loadPluginFrontends(
      [candidate("odd", { cssUrl: null })],
      {
        importModule: async () => undefined,
        injectCss: vi.fn(),
        warn: vi.fn(),
      },
    );
    expect(records.get("odd")).toMatchObject({
      status: "failed",
      error: expect.stringContaining("module namespace"),
    });
  });

  it("skips incompatible bundles with a needs-update record and a warning", async () => {
    const importModule = vi.fn();
    const warn = vi.fn();

    const records = await loadPluginFrontends(
      [
        candidate("stale", {
          compatible: false,
          sdkMajor: 9,
          sdkVersion: "9.2.0",
        }),
      ],
      { importModule, injectCss: vi.fn(), warn },
    );

    expect(records.get("stale")).toEqual({
      pluginId: "stale",
      status: "needs-update",
      sdkMajor: 9,
      sdkVersion: "9.2.0",
    });
    expect(importModule).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("[plugin:stale]"),
    );
  });
});

describe("installPluginRuntime", () => {
  type RuntimeHost = typeof globalThis & { __bbPluginRuntime?: unknown };

  afterEach(() => {
    delete (globalThis as RuntimeHost).__bbPluginRuntime;
  });

  it("exposes the app's own runtime modules on every shim slot, exactly once", () => {
    installPluginRuntime();
    const runtime = (globalThis as RuntimeHost).__bbPluginRuntime as Record<
      string,
      unknown
    >;
    expect(Object.keys(runtime).sort()).toEqual([
      "classVarianceAuthority",
      "clsx",
      "jsxDevRuntime",
      "jsxRuntime",
      "pierreDiffs",
      "pierreDiffsReact",
      "pluginSdkApp",
      "radixAlertDialog",
      "radixContextMenu",
      "radixDialog",
      "radixDropdownMenu",
      "radixHoverCard",
      "radixMenubar",
      "radixNavigationMenu",
      "radixPopover",
      "radixSelect",
      "radixTooltip",
      "react",
      "reactDom",
      "reactDomClient",
      "sharedUiIcon",
      "sonner",
      "tailwindMerge",
      "vaul",
    ]);
    expect((runtime.clsx as { default: unknown }).default).toBe(clsx);
    expect((runtime.sharedUiIcon as { Icon: unknown }).Icon).toBe(Icon);
    expect((runtime.react as { useState: unknown }).useState).toBe(
      react.useState,
    );
    expect((runtime.jsxRuntime as { jsx: unknown }).jsx).toBe(jsxRuntime.jsx);
    expect(runtime.pluginSdkApp).toBe(pluginSdkAppImplementation);

    installPluginRuntime();
    expect((globalThis as RuntimeHost).__bbPluginRuntime).toBe(runtime);
  });

  it("hands plugins every @pierre/diffs/react export, with the diff components gated", async () => {
    installPluginRuntime();
    const runtime = (globalThis as RuntimeHost).__bbPluginRuntime as Record<
      string,
      unknown
    >;
    const pierreDiffsReact = await import("@pierre/diffs/react");
    const slot = runtime.pierreDiffsReact as Record<string, unknown>;
    expect(Object.keys(slot).sort()).toEqual(
      Object.keys(pierreDiffsReact).sort(),
    );
    expect(slot.useVirtualizer).toBe(pierreDiffsReact.useVirtualizer);
    expect(slot.WorkerPoolContext).toBe(pierreDiffsReact.WorkerPoolContext);
    expect(slot.FileDiff).not.toBe(pierreDiffsReact.FileDiff);
    expect(slot.File).not.toBe(pierreDiffsReact.File);
  });
});

describe("createPluginFrontendPageLifecycle", () => {
  function createDeps() {
    return {
      restore: vi.fn(),
      teardown: vi.fn(),
    };
  }

  it("keeps frontends mounted when the page enters the back/forward cache", () => {
    const deps = createDeps();
    const lifecycle = createPluginFrontendPageLifecycle(deps);
    lifecycle.onPageHide({ persisted: true });
    expect(deps.teardown).not.toHaveBeenCalled();

    lifecycle.onPageShow({ persisted: true });
    expect(deps.restore).toHaveBeenCalledTimes(1);
  });

  it("tears down on a real unload and delegates a later persisted restore", () => {
    const deps = createDeps();
    const lifecycle = createPluginFrontendPageLifecycle(deps);
    lifecycle.onPageHide({ persisted: false });
    expect(deps.teardown).toHaveBeenCalledTimes(1);

    lifecycle.onPageShow({ persisted: true });
    expect(deps.restore).toHaveBeenCalledTimes(1);
  });

  it("ignores the initial (non-persisted) pageshow", () => {
    const deps = createDeps();
    createPluginFrontendPageLifecycle(deps).onPageShow({ persisted: false });
    expect(deps.restore).not.toHaveBeenCalled();
  });
});
