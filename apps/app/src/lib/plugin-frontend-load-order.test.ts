// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { definePluginApp } from "./plugin-app-definition";
import {
  createPluginFrontendReconcileState,
  orderPluginFrontendCandidates,
  PLUGIN_FRONTEND_LOAD_CONCURRENCY,
  reconcilePluginFrontends,
  type PluginFrontendCandidate,
  type PluginFrontendReconcileDeps,
} from "./plugin-frontend";

function candidate(pluginId: string, jsBytes: number): PluginFrontendCandidate {
  return {
    pluginId,
    bundle: {
      jsUrl: `/api/v1/plugins/${pluginId}/assets/app.js?h=h`,
      cssUrl: `/api/v1/plugins/${pluginId}/assets/app.css?h=h`,
      jsBytes,
      hash: "h",
      sdkMajor: 0,
      sdkVersion: "0.1.0",
      compatible: true,
    },
  };
}

function pluginModule(): Record<string, unknown> {
  return { default: definePluginApp(() => {}) };
}

function makeDeferredImports() {
  const started: string[] = [];
  const resolvers = new Map<string, () => void>();
  const importModule = vi.fn((url: string): Promise<unknown> => {
    started.push(url);
    return new Promise((resolve) => {
      resolvers.set(url, () => resolve(pluginModule()));
    });
  });
  return {
    importModule,
    started,
    resolveNext: async () => {
      const [url, resolve] = [...resolvers][0]!;
      resolvers.delete(url);
      resolve();
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    },
  };
}

function makeDeps(
  candidates: PluginFrontendCandidate[],
  overrides: Partial<PluginFrontendReconcileDeps> = {},
): PluginFrontendReconcileDeps {
  return {
    fetchCandidates: async () => candidates,
    importModule: async () => pluginModule(),
    applyCss: vi.fn(),
    retainCss: vi.fn(() => vi.fn()),
    resetCrashedSlots: vi.fn(),
    setRegistrations: vi.fn(),
    removeRegistrations: vi.fn(),
    warn: vi.fn(),
    routePluginId: () => null,
    beginSlotBatch: () => () => {},
    ...overrides,
  };
}

describe("orderPluginFrontendCandidates", () => {
  it("puts the route-owning plugin first, then ascending bundle size", () => {
    const ordered = orderPluginFrontendCandidates(
      [
        candidate("automations", 1_060_000),
        candidate("secrets", 644_000),
        candidate("keep-awake", 309_000),
        candidate("side-chat", 242_000),
      ],
      "secrets",
    );
    expect(ordered.map((c) => c.pluginId)).toEqual([
      "secrets",
      "side-chat",
      "keep-awake",
      "automations",
    ]);
  });

  it("keeps inventory order for equal sizes and does not mutate the input", () => {
    const input = [candidate("b", 10), candidate("a", 10), candidate("c", 5)];
    const ordered = orderPluginFrontendCandidates(input, null);
    expect(ordered.map((c) => c.pluginId)).toEqual(["c", "b", "a"]);
    expect(input.map((c) => c.pluginId)).toEqual(["b", "a", "c"]);
  });
});

describe("reconcilePluginFrontends load scheduling", () => {
  it("imports at most PLUGIN_FRONTEND_LOAD_CONCURRENCY bundles at once, in priority order", async () => {
    const imports = makeDeferredImports();
    const state = createPluginFrontendReconcileState();
    const deps = makeDeps(
      [
        candidate("big", 900),
        candidate("mid", 500),
        candidate("small", 100),
        candidate("tiny", 10),
        candidate("panel", 700),
      ],
      { importModule: imports.importModule, routePluginId: () => "panel" },
    );
    const done = reconcilePluginFrontends(state, deps);
    for (let i = 0; i < 10; i += 1) await Promise.resolve();

    expect(PLUGIN_FRONTEND_LOAD_CONCURRENCY).toBe(3);
    expect(imports.started).toEqual([
      "/api/v1/plugins/panel/assets/app.js?h=h",
      "/api/v1/plugins/tiny/assets/app.js?h=h",
      "/api/v1/plugins/small/assets/app.js?h=h",
    ]);

    await imports.resolveNext();
    expect(imports.started).toHaveLength(4);
    expect(imports.started[3]).toBe("/api/v1/plugins/mid/assets/app.js?h=h");

    await imports.resolveNext();
    expect(imports.started).toHaveLength(5);
    expect(imports.started[4]).toBe("/api/v1/plugins/big/assets/app.js?h=h");

    await imports.resolveNext();
    await imports.resolveNext();
    await imports.resolveNext();
    await done;
    expect([...state.records.keys()].sort()).toEqual([
      "big",
      "mid",
      "panel",
      "small",
      "tiny",
    ]);
    expect(deps.setRegistrations).toHaveBeenCalledTimes(5);
  });

  it("a rejected import in one lane does not stall the remaining candidates", async () => {
    const state = createPluginFrontendReconcileState();
    const deps = makeDeps(
      [candidate("broken", 1), candidate("fine", 2), candidate("also", 3)],
      {
        importModule: async (url) => {
          if (url.includes("/broken/")) throw new Error("boom");
          return pluginModule();
        },
      },
    );
    await reconcilePluginFrontends(state, deps);
    expect(state.records.get("broken")?.status).toBe("failed");
    expect(state.records.get("fine")?.status).toBe("loaded");
    expect(state.records.get("also")?.status).toBe("loaded");
  });
});
