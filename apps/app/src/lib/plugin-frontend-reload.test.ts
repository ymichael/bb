// @vitest-environment jsdom

import type { PluginComposerThreadRowStatus } from "@get-bb/plugin-sdk";
import { QueryClient } from "@tanstack/react-query";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import {
  installForeignDomMutationGuard,
  uninstallForeignDomMutationGuardForTest,
} from "./foreign-dom-mutation-guard";
import { definePluginApp } from "./plugin-app-definition";
import {
  applyPluginCss,
  createPluginFrontendReconcileScheduler,
  createPluginFrontendReconcileState,
  disposePluginFrontends,
  fetchFrontendCandidates,
  reconcilePluginFrontends,
  type PluginFrontendCandidate,
  type PluginFrontendReconcileDeps,
} from "./plugin-frontend";
import { resetPluginCssForTest, retainPluginCss } from "./plugin-css";
import {
  getPluginSlotSnapshot,
  removePluginSlotRegistrations,
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
  usePluginSlots,
} from "./plugin-slots";
import {
  getPluginThreadRowStatus,
  resetPluginThreadRowStatusesForTest,
} from "./plugin-thread-row-status";
import { PluginSlotMount } from "@/components/plugin/PluginSlotMount";
import { PLUGIN_PANEL_ROUTE_PATH } from "./route-paths";
import { applyAppThemeCss } from "./themes";
import { PluginPanelView } from "@/views/PluginPanelView";
import { makeInstalledPlugin } from "@/test/fixtures/plugins";

function candidate(
  pluginId: string,
  hash: string,
  overrides: Partial<PluginFrontendCandidate["bundle"]> = {},
): PluginFrontendCandidate {
  return {
    pluginId,
    bundle: {
      jsUrl: `/api/v1/plugins/${pluginId}/assets/app.js?h=${hash}`,
      cssUrl: `/api/v1/plugins/${pluginId}/assets/app.css?h=${hash}`,
      jsBytes: 1_000,
      hash,
      sdkMajor: 0,
      sdkVersion: "0.1.0",
      compatible: true,
      ...overrides,
    },
  };
}

function pluginModule(sectionTitle: string): Record<string, unknown> {
  return {
    default: definePluginApp((app) => {
      app.slots.homepageSection({
        id: "section",
        title: sectionTitle,
        component: () => null,
      });
    }),
  };
}

function contentScriptModule(
  setup: Parameters<typeof definePluginApp>[0],
): Record<string, unknown> {
  return { default: definePluginApp(setup) };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetPluginThreadRowStatusesForTest();
  resetPluginSlotStoreForTest();
  resetPluginCssForTest();
  uninstallForeignDomMutationGuardForTest();
});

function MountedHomepageSections() {
  const { homepageSections } = usePluginSlots();
  return createElement(
    "div",
    null,
    ...homepageSections.map((section) =>
      createElement(PluginSlotMount, {
        key: `${section.pluginId}/${section.id}/${section.generation}`,
        pluginId: section.pluginId,
        slotKind: "homepageSection",
        slotId: section.id,
        children: createElement(section.component, { projectId: null }),
      }),
    ),
  );
}

interface TestReconcileDeps extends PluginFrontendReconcileDeps {
  fetchCandidates: Mock<() => Promise<PluginFrontendCandidate[]>>;
  importModule: Mock<(url: string) => Promise<unknown>>;
  removeRegistrations: Mock<typeof removePluginSlotRegistrations>;
  setRegistrations: Mock<typeof setPluginSlotRegistrations>;
}

function makeDeps(initial: PluginFrontendCandidate[] = []): TestReconcileDeps {
  return {
    fetchCandidates: vi.fn(
      async (): Promise<PluginFrontendCandidate[]> => initial,
    ),
    importModule: vi.fn(
      async (_url: string): Promise<unknown> => pluginModule("hello"),
    ),
    applyCss: vi.fn(),
    retainCss: vi.fn(() => vi.fn()),
    resetCrashedSlots: vi.fn(),
    setRegistrations: vi.fn(),
    removeRegistrations: vi.fn(),
    beginSlotBatch: () => () => {},
    warn: vi.fn(),
    routePluginId: () => null,
    mountTimeoutMs: undefined as number | undefined,
  };
}

describe("reconcilePluginFrontends", () => {
  it.each(["running", "needs-configuration", "degraded"] as const)(
    "loads frontend candidates for a plugin with %s status",
    async (status) => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                plugins: [
                  makeInstalledPlugin({
                    id: "account-pool",
                    status,
                    app: {
                      hasApp: true,
                      bundle: candidate("account-pool", "v1").bundle,
                    },
                  }),
                ],
              }),
              { headers: { "content-type": "application/json" } },
            ),
        ),
      );

      await expect(fetchFrontendCandidates(queryClient)).resolves.toEqual([
        candidate("account-pool", "v1"),
      ]);
    },
  );

  it("re-imports a plugin exactly once when its bundle hash changes, replacing registrations wholesale", async () => {
    const state = createPluginFrontendReconcileState();
    const deps = makeDeps([
      candidate("hello", "aaa"),
      candidate("other", "s1", { cssUrl: null }),
    ]);

    await reconcilePluginFrontends(state, deps);
    expect(deps.importModule).toHaveBeenCalledTimes(2);
    expect(deps.setRegistrations).toHaveBeenCalledTimes(2);

    deps.importModule.mockClear();
    deps.setRegistrations.mockClear();
    await reconcilePluginFrontends(state, deps);
    expect(deps.importModule).not.toHaveBeenCalled();
    expect(deps.setRegistrations).not.toHaveBeenCalled();

    deps.fetchCandidates.mockResolvedValue([
      candidate("hello", "bbb"),
      candidate("other", "s1", { cssUrl: null }),
    ]);
    await reconcilePluginFrontends(state, deps);
    expect(deps.importModule).toHaveBeenCalledTimes(1);
    expect(deps.importModule).toHaveBeenCalledWith(
      "/api/v1/plugins/hello/assets/app.js?h=bbb",
    );
    expect(deps.setRegistrations).toHaveBeenCalledTimes(1);
    expect(deps.setRegistrations).toHaveBeenCalledWith(
      "hello",
      expect.objectContaining({
        homepageSections: [expect.objectContaining({ id: "section" })],
      }),
    );
    expect(deps.resetCrashedSlots).toHaveBeenCalledWith("hello");
    expect(deps.applyCss).toHaveBeenCalledWith(
      "hello",
      "/api/v1/plugins/hello/assets/app.css?h=bbb",
    );
  });

  it("waits for the stylesheet before publishing registrations", async () => {
    const state = createPluginFrontendReconcileState();
    const deps = makeDeps([candidate("hello", "aaa")]);
    const cssGate: { release: (() => void) | null } = { release: null };
    vi.mocked(deps.applyCss).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          cssGate.release = resolve;
        }),
    );

    const done = reconcilePluginFrontends(state, deps);
    for (let tick = 0; tick < 20; tick++) await Promise.resolve();
    expect(deps.applyCss).toHaveBeenCalledWith(
      "hello",
      "/api/v1/plugins/hello/assets/app.css?h=aaa",
    );
    expect(deps.setRegistrations).not.toHaveBeenCalled();

    cssGate.release?.();
    await done;
    expect(deps.setRegistrations).toHaveBeenCalledWith(
      "hello",
      expect.anything(),
    );
  });

  it("reloading twice leaves exactly one homepage section registered (design §9 exit criterion)", async () => {
    resetPluginSlotStoreForTest();
    const state = createPluginFrontendReconcileState();
    const fetchCandidates = vi.fn(
      async (): Promise<PluginFrontendCandidate[]> => [
        candidate("hello", "v1"),
      ],
    );
    const deps: PluginFrontendReconcileDeps = {
      fetchCandidates,
      importModule: async () => pluginModule("hello"),
      applyCss: vi.fn(),
      retainCss: vi.fn(() => vi.fn()),
      resetCrashedSlots: vi.fn(),
      setRegistrations: setPluginSlotRegistrations,
      removeRegistrations: removePluginSlotRegistrations,
      beginSlotBatch: () => () => {},
      warn: vi.fn(),
      routePluginId: () => null,
    };

    await reconcilePluginFrontends(state, deps);
    fetchCandidates.mockResolvedValue([candidate("hello", "v2")]);
    await reconcilePluginFrontends(state, deps);
    fetchCandidates.mockResolvedValue([candidate("hello", "v3")]);
    await reconcilePluginFrontends(state, deps);

    const snapshot = getPluginSlotSnapshot();
    expect(snapshot.homepageSections).toHaveLength(1);
    expect(snapshot.homepageSections[0]).toMatchObject({
      pluginId: "hello",
      id: "section",
      generation: 3,
    });
    resetPluginSlotStoreForTest();
  });

  it("publishes CSS before a cold deep-link panel registration can render", async () => {
    const state = createPluginFrontendReconcileState();
    const preparedDuringRender = vi.fn();
    const deps = makeDeps([candidate("hello", "cold")]);
    deps.applyCss = applyPluginCss;
    deps.retainCss = retainPluginCss;
    deps.setRegistrations = vi.fn(setPluginSlotRegistrations);
    deps.removeRegistrations = vi.fn(removePluginSlotRegistrations);
    deps.importModule.mockResolvedValue({
      default: definePluginApp((app) => {
        app.slots.navPanel({
          id: "panel",
          icon: "PanelTop",
          path: "panel",
          title: "Cold panel",
          component: ({ subPath }) => {
            const prepared = document.head.querySelector(
              'link[data-bb-plugin-css-preload="hello"], link[data-bb-plugin-css="hello"]',
            );
            preparedDuringRender(prepared?.getAttribute("href") ?? null);
            return createElement("div", null, `cold panel body:${subPath}`);
          },
        });
      }),
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        createElement(
          MemoryRouter,
          { initialEntries: ["/plugins/hello/panel/notes/today.md"] },
          createElement(
            Routes,
            null,
            createElement(Route, {
              path: PLUGIN_PANEL_ROUTE_PATH,
              element: createElement(PluginPanelView),
            }),
          ),
        ),
      );
    });

    await act(async () => {
      await reconcilePluginFrontends(state, deps);
    });

    expect(preparedDuringRender).toHaveBeenCalledWith(
      "/api/v1/plugins/hello/assets/app.css?h=cold",
    );
    expect(container.textContent).toContain("cold panel body:notes/today.md");
    expect(
      document.head.querySelector('link[data-bb-plugin-css="hello"]'),
    ).not.toBeNull();

    act(() => root.unmount());
    container.remove();
  });

  it("retains CSS for a content script's whole generation, including cleanup", async () => {
    const state = createPluginFrontendReconcileState();
    const deps = makeDeps([candidate("shell-owner", "v1")]);
    const events: string[] = [];
    const stylesheetIsActive = () =>
      document.head.querySelector('link[data-bb-plugin-css="shell-owner"]') !==
      null;
    deps.applyCss = applyPluginCss;
    deps.retainCss = retainPluginCss;
    deps.importModule.mockResolvedValue(
      contentScriptModule((app) => {
        app.contentScripts.register({
          id: "shell-dom",
          mount() {
            events.push(`mount:${stylesheetIsActive()}`);
            return () => {
              events.push(`dispose:${stylesheetIsActive()}`);
            };
          },
        });
      }),
    );

    await reconcilePluginFrontends(state, deps);
    expect(events).toEqual(["mount:true"]);
    expect(stylesheetIsActive()).toBe(true);

    deps.fetchCandidates.mockResolvedValue([]);
    await reconcilePluginFrontends(state, deps);
    expect(events).toEqual(["mount:true", "dispose:true"]);
    expect(stylesheetIsActive()).toBe(false);
  });

  it("keeps the active sheet through a real generation reload and a failed CSS replacement", async () => {
    const state = createPluginFrontendReconcileState();
    const deps = makeDeps([candidate("hello", "v1")]);
    deps.applyCss = applyPluginCss;
    deps.retainCss = retainPluginCss;
    deps.setRegistrations = vi.fn(setPluginSlotRegistrations);
    deps.removeRegistrations = vi.fn(removePluginSlotRegistrations);
    deps.importModule.mockImplementation(async (url: string) => {
      const version = /[?&]h=([^&]+)/.exec(url)?.[1] ?? "unknown";
      return {
        default: definePluginApp((app) => {
          app.slots.homepageSection({
            id: "section",
            title: version,
            component: () =>
              createElement("div", null, `generation ${version}`),
          });
        }),
      };
    });
    const links = () => [
      ...document.head.querySelectorAll<HTMLLinkElement>(
        'link[data-bb-plugin-css="hello"]',
      ),
    ];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(createElement(MountedHomepageSections)));

    await act(async () => {
      await reconcilePluginFrontends(state, deps);
    });
    expect(container.textContent).toContain("generation v1");
    links()[0]?.dispatchEvent(new Event("load"));

    deps.fetchCandidates.mockResolvedValue([candidate("hello", "v2")]);
    await act(async () => {
      await reconcilePluginFrontends(state, deps);
    });
    expect(container.textContent).toContain("generation v2");
    expect(links().map((link) => link.getAttribute("href"))).toEqual([
      "/api/v1/plugins/hello/assets/app.css?h=v1",
      "/api/v1/plugins/hello/assets/app.css?h=v2",
    ]);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    links()[1]?.dispatchEvent(new Event("error"));
    expect(links().map((link) => link.getAttribute("href"))).toEqual([
      "/api/v1/plugins/hello/assets/app.css?h=v1",
    ]);
    expect(container.textContent).toContain("generation v2");
    warn.mockRestore();

    deps.fetchCandidates.mockResolvedValue([candidate("hello", "v3")]);
    await act(async () => {
      await reconcilePluginFrontends(state, deps);
    });
    expect(links().map((link) => link.getAttribute("href"))).toEqual([
      "/api/v1/plugins/hello/assets/app.css?h=v1",
      "/api/v1/plugins/hello/assets/app.css?h=v3",
    ]);
    links()[1]?.dispatchEvent(new Event("load"));
    expect(links().map((link) => link.getAttribute("href"))).toEqual([
      "/api/v1/plugins/hello/assets/app.css?h=v3",
    ]);

    act(() => root.unmount());
    container.remove();
  });

  it("drops registrations, CSS, and record when a plugin disappears from the inventory", async () => {
    const state = createPluginFrontendReconcileState();
    const deps = makeDeps([candidate("hello", "v1")]);
    await reconcilePluginFrontends(state, deps);
    expect(state.records.get("hello")?.status).toBe("loaded");

    deps.fetchCandidates.mockResolvedValue([]);
    await reconcilePluginFrontends(state, deps);
    expect(deps.removeRegistrations).toHaveBeenCalledWith("hello");
    expect(deps.applyCss).toHaveBeenLastCalledWith("hello", null);
    expect(state.records.has("hello")).toBe(false);
    expect(state.appliedHashes.has("hello")).toBe(false);
  });

  it.each([401, 403])(
    "removes active frontends when plugin inventory access fails with %s",
    async (status) => {
      const state = createPluginFrontendReconcileState();
      const deps = makeDeps([candidate("hello", "v1")]);
      await reconcilePluginFrontends(state, deps);
      deps.removeRegistrations.mockClear();
      vi.mocked(deps.applyCss).mockClear();

      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({ code: "unauthorized", message: "Unauthorized" }),
              {
                status,
                headers: { "content-type": "application/json" },
              },
            ),
        ),
      );
      deps.fetchCandidates = vi.fn(() => fetchFrontendCandidates(queryClient));

      await reconcilePluginFrontends(state, deps);

      expect(deps.removeRegistrations).toHaveBeenCalledWith("hello");
      expect(deps.applyCss).toHaveBeenLastCalledWith("hello", null);
      expect(state.records.has("hello")).toBe(false);
      expect(state.appliedHashes.has("hello")).toBe(false);
    },
  );

  it("preserves active frontends when the plugin inventory request fails", async () => {
    const state = createPluginFrontendReconcileState();
    const deps = makeDeps([candidate("hello", "v1")]);
    await reconcilePluginFrontends(state, deps);
    deps.removeRegistrations.mockClear();
    vi.mocked(deps.applyCss).mockClear();

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline");
      }),
    );
    deps.fetchCandidates = vi.fn(() => fetchFrontendCandidates(queryClient));

    await expect(reconcilePluginFrontends(state, deps)).rejects.toThrow(
      "offline",
    );
    expect(state.records.get("hello")?.status).toBe("loaded");
    expect(state.appliedHashes.get("hello")).toBe("v1");
    expect(deps.removeRegistrations).not.toHaveBeenCalled();
    expect(deps.applyCss).not.toHaveBeenCalled();
  });

  it("deactivates stale UI when a replacement import fails or needs an SDK update", async () => {
    const state = createPluginFrontendReconcileState();
    const deps = makeDeps([candidate("hello", "v1")]);
    await reconcilePluginFrontends(state, deps);

    deps.fetchCandidates.mockResolvedValue([candidate("hello", "v2")]);
    deps.importModule.mockRejectedValueOnce(new Error("SyntaxError"));
    await reconcilePluginFrontends(state, deps);
    expect(state.records.get("hello")).toMatchObject({ status: "failed" });
    expect(deps.removeRegistrations).toHaveBeenCalledWith("hello");
    expect(deps.applyCss).toHaveBeenLastCalledWith("hello", null);
    expect(state.appliedHashes.has("hello")).toBe(false);
    expect(state.diagnostics.get("hello")).toMatchObject({
      status: "failed",
      active: null,
      lastFailure: { phase: "load" },
    });

    deps.removeRegistrations.mockClear();
    deps.fetchCandidates.mockResolvedValue([
      candidate("hello", "v3", { compatible: false, sdkMajor: 9 }),
    ]);
    await reconcilePluginFrontends(state, deps);
    expect(state.records.get("hello")).toMatchObject({
      status: "needs-update",
    });
    expect(deps.removeRegistrations).not.toHaveBeenCalled();
    expect(state.appliedHashes.has("hello")).toBe(false);
  });

  it("mounts once, skips repeated reconciliation, and disposes exactly once on reload and removal", async () => {
    const state = createPluginFrontendReconcileState();
    const deps = makeDeps([candidate("hello", "v1")]);
    const events: string[] = [];
    deps.importModule.mockImplementation(async (url: string) => {
      const version = url.includes("h=v2") ? "v2" : "v1";
      return contentScriptModule((app) => {
        app.contentScripts.register({
          id: "enhance",
          mount({ pluginId, generation, signal }) {
            events.push(`${version}:mount:${pluginId}:${generation}`);
            signal.addEventListener(
              "abort",
              () => events.push(`${version}:abort`),
              { once: true },
            );
            return () => {
              events.push(`${version}:dispose`);
            };
          },
        });
      });
    });

    await reconcilePluginFrontends(state, deps);
    await reconcilePluginFrontends(state, deps);
    expect(events).toEqual(["v1:mount:hello:1"]);

    deps.fetchCandidates.mockResolvedValue([candidate("hello", "v2")]);
    await reconcilePluginFrontends(state, deps);
    expect(events).toEqual([
      "v1:mount:hello:1",
      "v1:abort",
      "v1:dispose",
      "v2:mount:hello:2",
    ]);

    deps.fetchCandidates.mockResolvedValue([]);
    await reconcilePluginFrontends(state, deps);
    await reconcilePluginFrontends(state, deps);
    expect(events).toEqual([
      "v1:mount:hello:1",
      "v1:abort",
      "v1:dispose",
      "v2:mount:hello:2",
      "v2:abort",
      "v2:dispose",
    ]);
  });

  it("keeps content-script thread statuses across routes and clears them on deactivation", async () => {
    const state = createPluginFrontendReconcileState();
    const deps = makeDeps([candidate("prompt-shaper", "v1")]);
    deps.importModule.mockResolvedValue(
      contentScriptModule((app) => {
        app.contentScripts.register({
          id: "thread-status",
          mount({ experimental_setThreadRowStatus }) {
            experimental_setThreadRowStatus?.("thr_source", {
              icon: "AiContentGenerator01",
              label: "Improve Prompt is improving the draft",
              tone: "running",
            });
          },
        });
      }),
    );

    await reconcilePluginFrontends(state, deps);
    expect(getPluginThreadRowStatus("thr_source")).toEqual({
      icon: "AiContentGenerator01",
      label: "Improve Prompt is improving the draft",
      tone: "running",
    });

    deps.fetchCandidates.mockResolvedValue([]);
    await reconcilePluginFrontends(state, deps);
    expect(getPluginThreadRowStatus("thr_source")).toBeNull();
  });

  it("rolls back a status from a partially mounted generation and rejects its retained setter", async () => {
    const state = createPluginFrontendReconcileState();
    const deps = makeDeps([candidate("prompt-shaper", "v1")]);
    let retainedSetter:
      | ((
          threadId: string,
          status: PluginComposerThreadRowStatus | null,
        ) => void)
      | undefined;
    deps.importModule.mockResolvedValue(
      contentScriptModule((app) => {
        app.contentScripts.register({
          id: "thread-status",
          mount({ experimental_setThreadRowStatus }) {
            retainedSetter = experimental_setThreadRowStatus;
            retainedSetter?.("thr_source", {
              icon: "AiContentGenerator01",
              label: "Partial generation",
              tone: "running",
            });
          },
        });
        app.contentScripts.register({
          id: "broken",
          mount() {
            throw new Error("later mount failed");
          },
        });
      }),
    );

    await reconcilePluginFrontends(state, deps);
    expect(getPluginThreadRowStatus("thr_source")).toBeNull();

    retainedSetter?.("thr_source", {
      icon: "AiContentGenerator01",
      label: "Stale callback",
      tone: "running",
    });
    expect(getPluginThreadRowStatus("thr_source")).toBeNull();
  });

  it("does not let a retained old-generation setter overwrite its replacement", async () => {
    const state = createPluginFrontendReconcileState();
    const deps = makeDeps([candidate("prompt-shaper", "v1")]);
    let oldSetter:
      | ((
          threadId: string,
          status: PluginComposerThreadRowStatus | null,
        ) => void)
      | undefined;
    deps.importModule.mockImplementation(async (url: string) =>
      contentScriptModule((app) => {
        app.contentScripts.register({
          id: "thread-status",
          mount({ experimental_setThreadRowStatus }) {
            if (url.includes("h=v1")) {
              oldSetter = experimental_setThreadRowStatus;
            }
            experimental_setThreadRowStatus?.("thr_source", {
              icon: "AiContentGenerator01",
              label: url.includes("h=v1")
                ? "Old generation"
                : "Replacement generation",
              tone: "running",
            });
          },
        });
      }),
    );

    await reconcilePluginFrontends(state, deps);
    deps.fetchCandidates.mockResolvedValue([candidate("prompt-shaper", "v2")]);
    await reconcilePluginFrontends(state, deps);
    expect(getPluginThreadRowStatus("thr_source")?.label).toBe(
      "Replacement generation",
    );

    oldSetter?.("thr_source", {
      icon: "AiContentGenerator01",
      label: "Late old generation",
      tone: "running",
    });
    expect(getPluginThreadRowStatus("thr_source")?.label).toBe(
      "Replacement generation",
    );
  });

  it("warns and ignores non-string and blank content-script thread ids", async () => {
    const state = createPluginFrontendReconcileState();
    const deps = makeDeps([candidate("prompt-shaper", "v1")]);
    deps.importModule.mockResolvedValue(
      contentScriptModule((app) => {
        app.contentScripts.register({
          id: "thread-status",
          mount({ experimental_setThreadRowStatus }) {
            const setStatus = experimental_setThreadRowStatus as
              | ((threadId: unknown, status: unknown) => void)
              | undefined;
            setStatus?.(42, {
              icon: "AiContentGenerator01",
              label: "Invalid number id",
            });
            setStatus?.("   ", {
              icon: "AiContentGenerator01",
              label: "Invalid blank id",
            });
          },
        });
      }),
    );

    await expect(
      reconcilePluginFrontends(state, deps),
    ).resolves.toBeUndefined();
    expect(getPluginThreadRowStatus("42")).toBeNull();
    expect(deps.warn).toHaveBeenCalledTimes(2);
    expect(deps.warn).toHaveBeenCalledWith(
      expect.stringContaining('"threadId" must be a non-empty string'),
    );
  });

  it("disposes the old generation and rolls back a failed multi-script candidate in reverse order", async () => {
    const state = createPluginFrontendReconcileState();
    const deps = makeDeps([candidate("hello", "v1")]);
    const events: string[] = [];
    let oldSignal: AbortSignal | undefined;
    deps.importModule.mockResolvedValueOnce(
      contentScriptModule((app) => {
        app.contentScripts.register({
          id: "old",
          mount({ signal }) {
            oldSignal = signal;
            events.push("old:mount");
            return () => {
              events.push("old:dispose");
            };
          },
        });
      }),
    );
    await reconcilePluginFrontends(state, deps);

    deps.fetchCandidates.mockResolvedValue([candidate("hello", "v2")]);
    deps.importModule.mockResolvedValueOnce(
      contentScriptModule((app) => {
        for (const id of ["first", "second"] as const) {
          app.contentScripts.register({
            id,
            mount() {
              events.push(`${id}:mount`);
              return () => {
                events.push(`${id}:dispose`);
              };
            },
          });
        }
        app.contentScripts.register({
          id: "broken",
          mount() {
            events.push("broken:mount");
            throw new Error("candidate exploded");
          },
        });
        app.contentScripts.register({
          id: "never",
          mount() {
            events.push("never:mount");
          },
        });
      }),
    );
    await reconcilePluginFrontends(state, deps);

    expect(events).toEqual([
      "old:mount",
      "old:dispose",
      "first:mount",
      "second:mount",
      "broken:mount",
      "second:dispose",
      "first:dispose",
    ]);
    expect(oldSignal?.aborted).toBe(true);
    expect(deps.setRegistrations).toHaveBeenCalledTimes(1);
    expect(state.appliedHashes.has("hello")).toBe(false);
    expect(state.diagnostics.get("hello")).toMatchObject({
      status: "failed",
      active: null,
      lastFailure: {
        phase: "mount",
        scriptId: "broken",
        message: "candidate exploded",
      },
    });
  });

  it("contains a throwing replacement setup and deactivates the stale generation", async () => {
    const state = createPluginFrontendReconcileState();
    const deps = makeDeps([candidate("hello", "v1")]);
    const cleanup = vi.fn();
    deps.importModule.mockResolvedValueOnce(
      contentScriptModule((app) => {
        app.contentScripts.register({
          id: "old",
          mount: () => cleanup,
        });
      }),
    );
    await reconcilePluginFrontends(state, deps);

    deps.fetchCandidates.mockResolvedValue([candidate("hello", "v2")]);
    deps.importModule.mockResolvedValueOnce(
      contentScriptModule(() => {
        throw new Error("setup failed");
      }),
    );
    await reconcilePluginFrontends(state, deps);

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(state.appliedHashes.has("hello")).toBe(false);
    expect(state.diagnostics.get("hello")?.lastFailure).toMatchObject({
      phase: "setup",
      message: "setup failed",
    });
  });

  it("times out a stuck async mount without preventing another plugin from activating", async () => {
    const state = createPluginFrontendReconcileState();
    const deps = makeDeps([candidate("stuck", "v1"), candidate("fine", "v1")]);
    deps.mountTimeoutMs = 1;
    deps.importModule.mockImplementation(async (url: string) =>
      url.includes("/stuck/")
        ? contentScriptModule((app) => {
            app.contentScripts.register({
              id: "never-settles",
              mount: () => new Promise<void>(() => {}),
            });
          })
        : contentScriptModule((app) => {
            app.contentScripts.register({
              id: "fine",
              mount: () => {},
            });
          }),
    );

    await reconcilePluginFrontends(state, deps);

    expect(state.diagnostics.get("stuck")).toMatchObject({
      status: "failed",
      lastFailure: {
        phase: "mount",
        scriptId: "never-settles",
        message: "mount timed out after 1ms",
      },
    });
    expect(state.diagnostics.get("fine")).toMatchObject({ status: "active" });
    expect(deps.setRegistrations).toHaveBeenCalledWith(
      "fine",
      expect.any(Object),
    );
  });

  it("aborts async work before cleanup and contains async disposer failures", async () => {
    const state = createPluginFrontendReconcileState();
    const deps = makeDeps([candidate("hello", "v1")]);
    const events: string[] = [];
    deps.importModule.mockResolvedValue(
      contentScriptModule((app) => {
        app.contentScripts.register({
          id: "async-work",
          async mount({ signal }) {
            events.push("mount");
            signal.addEventListener("abort", () => events.push("abort"), {
              once: true,
            });
            await Promise.resolve();
            return async () => {
              events.push(`dispose:${signal.aborted}`);
              throw new Error("cleanup rejected");
            };
          },
        });
      }),
    );
    await reconcilePluginFrontends(state, deps);
    deps.fetchCandidates.mockResolvedValue([]);
    await reconcilePluginFrontends(state, deps);

    expect(events).toEqual(["mount", "abort", "dispose:true"]);
    expect(deps.warn).toHaveBeenCalledWith(
      expect.stringContaining("cleanup rejected"),
    );
  });

  it("keeps independent instances per app window and tears each down once", async () => {
    const stateA = createPluginFrontendReconcileState();
    const stateB = createPluginFrontendReconcileState();
    const signals: AbortSignal[] = [];
    const cleanup = vi.fn();
    const module = contentScriptModule((app) => {
      app.contentScripts.register({
        id: "per-window",
        mount({ signal }) {
          signals.push(signal);
          return cleanup;
        },
      });
    });
    const depsA = makeDeps([candidate("hello", "v1")]);
    const depsB = makeDeps([candidate("hello", "v1")]);
    depsA.importModule.mockResolvedValue(module);
    depsB.importModule.mockResolvedValue(module);

    await Promise.all([
      reconcilePluginFrontends(stateA, depsA),
      reconcilePluginFrontends(stateB, depsB),
    ]);
    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);

    await disposePluginFrontends(stateA, depsA);
    await disposePluginFrontends(stateA, depsA);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    expect(cleanup).toHaveBeenCalledTimes(1);

    await disposePluginFrontends(stateB, depsB);
    expect(signals[1]?.aborted).toBe(true);
    expect(cleanup).toHaveBeenCalledTimes(2);
  });

  it("aborts a pending mount on app teardown and never commits it afterward", async () => {
    const state = createPluginFrontendReconcileState();
    const deps = makeDeps([candidate("hello", "v1")]);
    const cleanup = vi.fn();
    let resolveMount: ((dispose: () => void) => void) | undefined;
    let retainedSetter:
      | ((
          threadId: string,
          status: PluginComposerThreadRowStatus | null,
        ) => void)
      | undefined;
    deps.importModule.mockResolvedValue(
      contentScriptModule((app) => {
        app.contentScripts.register({
          id: "pending",
          mount: ({ experimental_setThreadRowStatus }) => {
            retainedSetter = experimental_setThreadRowStatus;
            retainedSetter?.("thr_pending", {
              icon: "AiContentGenerator01",
              label: "Pending activation",
              tone: "running",
            });
            return new Promise<() => void>((resolve) => {
              resolveMount = resolve;
            });
          },
        });
      }),
    );

    const reconcile = reconcilePluginFrontends(state, deps);
    await vi.waitFor(() => expect(resolveMount).toBeTypeOf("function"));
    expect(getPluginThreadRowStatus("thr_pending")?.label).toBe(
      "Pending activation",
    );
    await disposePluginFrontends(state, deps);
    expect(getPluginThreadRowStatus("thr_pending")).toBeNull();
    retainedSetter?.("thr_pending", {
      icon: "AiContentGenerator01",
      label: "Late pending activation",
      tone: "running",
    });
    expect(getPluginThreadRowStatus("thr_pending")).toBeNull();
    resolveMount?.(cleanup);
    await reconcile;

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(deps.setRegistrations).not.toHaveBeenCalled();
    expect(state.activeGenerations.size).toBe(0);
    expect(state.diagnostics.size).toBe(0);
  });

  it("removes a stale CSS link when the new bundle ships no CSS", async () => {
    const state = createPluginFrontendReconcileState();
    const deps = makeDeps([candidate("hello", "v1")]);
    await reconcilePluginFrontends(state, deps);
    expect(deps.applyCss).toHaveBeenCalledWith(
      "hello",
      "/api/v1/plugins/hello/assets/app.css?h=v1",
    );

    deps.fetchCandidates.mockResolvedValue([
      candidate("hello", "v2", { cssUrl: null }),
    ]);
    await reconcilePluginFrontends(state, deps);
    expect(deps.applyCss).toHaveBeenLastCalledWith("hello", null);
  });

  it("does not let a content script steal a React-owned host node", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    installForeignDomMutationGuard();

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        createElement(
          "a",
          { href: "?path=src/app.ts", "data-testid": "file-link" },
          "src/app.ts",
        ),
      );
    });
    const link = container.querySelector("[data-testid='file-link']");
    expect(link).toBeInstanceOf(HTMLAnchorElement);
    const reactParent = link!.parentNode;

    const state = createPluginFrontendReconcileState();
    const deps = makeDeps([candidate("file-reveal", "v1")]);
    deps.importModule.mockResolvedValue(
      contentScriptModule((app) => {
        app.contentScripts.register({
          id: "file-reveal-buttons",
          mount() {
            const control = document.querySelector("[data-testid='file-link']");
            if (
              !(control instanceof HTMLElement) ||
              control.parentNode === null
            ) {
              return;
            }
            const group = document.createElement("span");
            const button = document.createElement("button");
            control.parentNode.insertBefore(group, control);
            group.append(control, button);
          },
        });
      }),
    );

    await reconcilePluginFrontends(state, deps);
    expect(link!.parentNode).toBe(reactParent);
    expect(container.querySelector("button")).not.toBeNull();

    act(() => root.unmount());
    container.remove();
  });

  it("does not let an async content-script mount steal a React-owned node", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    installForeignDomMutationGuard();

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        createElement(
          "a",
          { href: "?path=src/app.ts", "data-testid": "async-file-link" },
          "src/app.ts",
        ),
      );
    });
    const link = container.querySelector("[data-testid='async-file-link']");
    expect(link).toBeInstanceOf(HTMLAnchorElement);
    const reactParent = link!.parentNode;

    const state = createPluginFrontendReconcileState();
    const deps = makeDeps([candidate("file-reveal", "v1")]);
    deps.importModule.mockResolvedValue(
      contentScriptModule((app) => {
        app.contentScripts.register({
          id: "file-reveal-buttons",
          async mount() {
            await Promise.resolve();
            const control = document.querySelector(
              "[data-testid='async-file-link']",
            );
            if (
              !(control instanceof HTMLElement) ||
              control.parentNode === null
            ) {
              return;
            }
            const group = document.createElement("span");
            const button = document.createElement("button");
            control.parentNode.insertBefore(group, control);
            group.append(control, button);
          },
        });
      }),
    );

    await reconcilePluginFrontends(state, deps);
    expect(link!.parentNode).toBe(reactParent);

    act(() => root.unmount());
    container.remove();
  });
});

describe("applyPluginCss", () => {
  afterEach(() => {
    resetPluginCssForTest();
    vi.useRealTimers();
  });

  function links(pluginId: string): HTMLLinkElement[] {
    return [
      ...document.head.querySelectorAll<HTMLLinkElement>(
        `link[data-bb-plugin-css="${pluginId}"]`,
      ),
    ];
  }

  function preloads(pluginId: string): HTMLLinkElement[] {
    return [
      ...document.head.querySelectorAll<HTMLLinkElement>(
        `link[data-bb-plugin-css-preload="${pluginId}"]`,
      ),
    ];
  }

  it("keeps the old link until the new one loads, then removes it (no unstyled flash)", () => {
    retainPluginCss("hello");
    applyPluginCss("hello", "/assets/app.css?h=aaa");
    expect(links("hello")).toHaveLength(1);
    links("hello")[0]?.dispatchEvent(new Event("load"));

    applyPluginCss("hello", "/assets/app.css?h=bbb");
    const during = links("hello");
    expect(during.map((l) => l.getAttribute("href"))).toEqual([
      "/assets/app.css?h=aaa",
      "/assets/app.css?h=bbb",
    ]);

    during[1]?.dispatchEvent(new Event("load"));
    const after = links("hello");
    expect(after).toHaveLength(1);
    expect(after[0]?.getAttribute("href")).toBe("/assets/app.css?h=bbb");
  });

  it("on load error, drops the new link and keeps the old sheet working", () => {
    retainPluginCss("hello");
    applyPluginCss("hello", "/assets/app.css?h=aaa");
    links("hello")[0]?.dispatchEvent(new Event("load"));
    applyPluginCss("hello", "/assets/app.css?h=bbb");
    const fresh = links("hello")[1];

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fresh?.dispatchEvent(new Event("error"));
    warn.mockRestore();

    const after = links("hello");
    expect(after).toHaveLength(1);
    expect(after[0]?.getAttribute("href")).toBe("/assets/app.css?h=aaa");
  });

  it("keeps the same element for an unchanged URL and removes it on null", () => {
    retainPluginCss("hello");
    applyPluginCss("hello", "/assets/app.css?h=aaa");
    const first = links("hello")[0];
    applyPluginCss("hello", "/assets/app.css?h=aaa");
    expect(links("hello")[0]).toBe(first);

    applyPluginCss("hello", null);
    expect(links("hello")).toHaveLength(0);
  });

  it("preloads inactive CSS and removes the sheet only after its final consumer releases", async () => {
    vi.useFakeTimers();
    applyPluginCss("hello", "/assets/app.css?h=aaa");
    expect(preloads("hello")).toHaveLength(1);
    expect(preloads("hello")[0]?.fetchPriority).toBe("low");
    expect(links("hello")).toHaveLength(0);

    preloads("hello")[0]?.dispatchEvent(new Event("load"));
    expect(preloads("hello")).toHaveLength(0);
    const releaseFirst = retainPluginCss("hello");
    const releaseSecond = retainPluginCss("hello");
    expect(links("hello")).toHaveLength(1);

    releaseFirst();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(links("hello")).toHaveLength(1);
    releaseSecond();
    await vi.advanceTimersByTimeAsync(0);
    expect(links("hello")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(links("hello")).toHaveLength(0);
    expect(preloads("hello")).toHaveLength(0);
  });

  it("keeps the same sheet when a consumer retains within the grace window", async () => {
    vi.useFakeTimers();
    applyPluginCss("hello", "/assets/app.css?h=aaa");
    preloads("hello")[0]?.dispatchEvent(new Event("load"));
    const releaseFirst = retainPluginCss("hello");
    const first = links("hello")[0];
    expect(first).toBeDefined();
    first?.dispatchEvent(new Event("load"));

    releaseFirst();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(links("hello")[0]).toBe(first);
    const releaseSecond = retainPluginCss("hello");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(links("hello")).toHaveLength(1);
    expect(links("hello")[0]).toBe(first);
    expect(preloads("hello")).toHaveLength(0);

    releaseSecond();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(links("hello")).toHaveLength(0);
  });

  it("reattaches the sheet when its load completes during the grace and a consumer retains", async () => {
    vi.useFakeTimers();
    applyPluginCss("hello", "/assets/app.css?h=aaa");
    preloads("hello")[0]?.dispatchEvent(new Event("load"));
    const releaseFirst = retainPluginCss("hello");
    const first = links("hello")[0];
    expect(first).toBeDefined();

    releaseFirst();
    await vi.advanceTimersByTimeAsync(200);
    first?.dispatchEvent(new Event("load"));
    expect(links("hello")[0]).toBe(first);
    await vi.advanceTimersByTimeAsync(300);
    const releaseSecond = retainPluginCss("hello");
    expect(links("hello")).toHaveLength(1);
    expect(links("hello")[0]).toBe(first);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(links("hello")).toHaveLength(1);
    expect(preloads("hello")).toHaveLength(0);

    releaseSecond();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(links("hello")).toHaveLength(0);
  });

  it("adopts a changed URL that finishes loading during the grace and reuses it on retain", async () => {
    vi.useFakeTimers();
    applyPluginCss("hello", "/assets/app.css?h=aaa");
    preloads("hello")[0]?.dispatchEvent(new Event("load"));
    const releaseFirst = retainPluginCss("hello");
    links("hello")[0]?.dispatchEvent(new Event("load"));

    applyPluginCss("hello", "/assets/app.css?h=bbb");
    const fresh = links("hello")[1];
    expect(fresh?.getAttribute("href")).toBe("/assets/app.css?h=bbb");
    releaseFirst();
    await vi.advanceTimersByTimeAsync(200);
    fresh?.dispatchEvent(new Event("load"));
    expect(links("hello").map((l) => l.getAttribute("href"))).toEqual([
      "/assets/app.css?h=bbb",
    ]);
    await vi.advanceTimersByTimeAsync(300);
    const releaseSecond = retainPluginCss("hello");
    expect(links("hello").map((l) => l.getAttribute("href"))).toEqual([
      "/assets/app.css?h=bbb",
    ]);
    expect(links("hello")[0]).toBe(fresh);
    expect(preloads("hello")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);

    releaseSecond();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(links("hello")).toHaveLength(0);
  });

  it("applies a URL that is republished after a flip-flop discarded its in-flight sheet", async () => {
    vi.useFakeTimers();
    retainPluginCss("hello");
    applyPluginCss("hello", "/assets/app.css?h=aaa");
    links("hello")[0]?.dispatchEvent(new Event("load"));

    applyPluginCss("hello", "/assets/app.css?h=bbb");
    const inflight = links("hello")[1];
    expect(inflight?.getAttribute("href")).toBe("/assets/app.css?h=bbb");
    applyPluginCss("hello", "/assets/app.css?h=aaa");
    inflight?.dispatchEvent(new Event("load"));
    expect(links("hello").map((l) => l.getAttribute("href"))).toEqual([
      "/assets/app.css?h=aaa",
    ]);

    applyPluginCss("hello", "/assets/app.css?h=bbb");
    expect(links("hello").map((l) => l.getAttribute("href"))).toEqual([
      "/assets/app.css?h=aaa",
      "/assets/app.css?h=bbb",
    ]);
    retainPluginCss("hello");
    expect(links("hello")).toHaveLength(2);
    links("hello")
      .find((l) => l.getAttribute("href") === "/assets/app.css?h=bbb")
      ?.dispatchEvent(new Event("load"));
    expect(links("hello").map((l) => l.getAttribute("href"))).toEqual([
      "/assets/app.css?h=bbb",
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("removes the sheet at once and cancels the timer when the URL is cleared during the grace", async () => {
    vi.useFakeTimers();
    applyPluginCss("hello", "/assets/app.css?h=aaa");
    preloads("hello")[0]?.dispatchEvent(new Event("load"));
    const release = retainPluginCss("hello");
    expect(links("hello")).toHaveLength(1);

    release();
    expect(vi.getTimerCount()).toBe(1);
    applyPluginCss("hello", null);
    expect(links("hello")).toHaveLength(0);
    expect(preloads("hello")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(1_500);
    expect(links("hello")).toHaveLength(0);
    expect(preloads("hello")).toHaveLength(0);
  });

  it("swaps to one preload of the new URL when it changes during the grace", async () => {
    vi.useFakeTimers();
    applyPluginCss("hello", "/assets/app.css?h=aaa");
    preloads("hello")[0]?.dispatchEvent(new Event("load"));
    const release = retainPluginCss("hello");
    links("hello")[0]?.dispatchEvent(new Event("load"));
    expect(links("hello")).toHaveLength(1);

    release();
    applyPluginCss("hello", "/assets/app.css?h=bbb");
    expect(links("hello")).toHaveLength(0);
    expect(preloads("hello").map((l) => l.getAttribute("href"))).toEqual([
      "/assets/app.css?h=bbb",
    ]);
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(1_500);
    expect(links("hello")).toHaveLength(0);
    expect(preloads("hello").map((l) => l.getAttribute("href"))).toEqual([
      "/assets/app.css?h=bbb",
    ]);
  });

  it("never ties app-wide bb.themes palette CSS to plugin UI mounts", async () => {
    vi.useFakeTimers();
    const paletteCss = ":root { --canvas: rebeccapurple; }";
    applyAppThemeCss(paletteCss);
    const palette = document.getElementById("bb-app-theme");
    expect(palette?.textContent).toBe(paletteCss);

    applyPluginCss("palette-owner", "/assets/app.css?h=palette-owner");
    preloads("palette-owner")[0]?.dispatchEvent(new Event("load"));
    expect(links("palette-owner")).toHaveLength(0);
    expect(document.getElementById("bb-app-theme")).toBe(palette);
    expect(palette?.textContent).toBe(paletteCss);

    const release = retainPluginCss("palette-owner");
    release();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(links("palette-owner")).toHaveLength(0);
    expect(document.getElementById("bb-app-theme")).toBe(palette);
    expect(palette?.textContent).toBe(paletteCss);

    applyAppThemeCss("");
    palette?.remove();
  });
});

describe("createPluginFrontendReconcileScheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces a burst of schedules into one run", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {});
    const scheduler = createPluginFrontendReconcileScheduler({
      run,
      debounceMs: 250,
    });

    scheduler.schedule();
    scheduler.schedule();
    scheduler.schedule();
    expect(run).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(250);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("serializes runs: a schedule landing mid-run queues one follow-up, never overlaps", async () => {
    vi.useFakeTimers();
    let active = 0;
    let maxActive = 0;
    let release = (): void => {};
    const run = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      active -= 1;
    });
    const scheduler = createPluginFrontendReconcileScheduler({
      run,
      debounceMs: 250,
    });

    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(250);
    expect(run).toHaveBeenCalledTimes(1);

    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(250);
    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(250);
    expect(run).toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);

    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
