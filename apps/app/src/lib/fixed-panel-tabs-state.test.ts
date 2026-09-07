import { describe, expect, it, vi } from "vitest";
import { threadTabsSchema } from "@bb/server-contract";
import {
  EMPTY_FIXED_PANEL_TABS_STATE,
  areFixedPanelTabsEquivalent,
  buildFixedPanelTabId,
  createBrowserFixedPanelTab,
  createEmptyFixedPanelTabsState,
  createHostFilePreviewFixedPanelTab,
  createNewTabFixedPanelTab,
  createPluginPanelFixedPanelTab,
  createPluginPageFixedPanelTab,
  createTerminalFixedPanelTab,
  createThreadInfoFixedPanelTab,
  createThreadStorageFilePreviewFixedPanelTab,
  createWorkspaceFilePreviewFixedPanelTab,
  ensureOpenFixedPanelHasActiveTab,
  getFixedPanelTabsStateStorageKey,
  isFixedPanelTabsStateStorageKey,
  parseFixedPanelTabsState,
  serializeFixedPanelTabsState,
  FIXED_PANEL_TABS_STATE_STORAGE_VERSION,
  type FixedPanelTabsState,
  type PluginPanelFixedPanelTab,
} from "./fixed-panel-tabs-state";

const NOW = 1_700_000_000_000;

function makeInitialState(): FixedPanelTabsState {
  return {
    version: FIXED_PANEL_TABS_STATE_STORAGE_VERSION,
    secondary: {
      tabs: [],
      activeTabId: null,
      isOpen: false,
    },
    lastUsedAt: 0,
  };
}

describe("fixed-panel-tabs-state", () => {
  it("preserves native browser identities and detects a reconnected desktop generation", () => {
    const tab = {
      ...createBrowserFixedPanelTab({
        environmentId: null,
        url: "https://example.com",
      }),
      id: "browser:native-generated-id:none",
      desktopTarget: {
        hostId: "host-1",
        instanceId: "instance-1",
        generation: "generation-1",
      },
    };
    const state = createEmptyFixedPanelTabsState({
      lastUsedAt: NOW,
      secondary: { activeTabId: tab.id, isOpen: true, tabs: [tab] },
    });
    const parsed = parseFixedPanelTabsState({
      initialValue: makeInitialState(),
      now: NOW,
      storedValue: JSON.stringify(state),
    });
    expect(parsed.secondary.tabs).toEqual([tab]);
    expect(parsed.secondary.activeTabId).toBe(tab.id);
    expect(
      areFixedPanelTabsEquivalent(tab, {
        ...tab,
        desktopTarget: { ...tab.desktopTarget, generation: "generation-2" },
      }),
    ).toBe(false);
  });

  it("parses current secondary tab state", () => {
    const now = 1_000;
    const workspaceTab = createWorkspaceFilePreviewFixedPanelTab({
      environmentId: "env-1",
      projectId: null,
      tab: {
        lineRange: {
          startLineNumber: 1,
          endLineNumber: 3,
        },
        path: "src/index.ts",
        source: { kind: "working-tree" },
        statusLabel: null,
      },
    });
    const terminalTab = createTerminalFixedPanelTab({ terminalId: "term-1" });
    const storedState = {
      version: FIXED_PANEL_TABS_STATE_STORAGE_VERSION,
      secondary: {
        tabs: [createThreadInfoFixedPanelTab(), workspaceTab, terminalTab],
        activeTabId: workspaceTab.id,
        isOpen: true,
      },
      bottom: {
        tabs: [],
        activeTabId: null,
      },
      lastUsedAt: now,
    };

    const parsed = parseFixedPanelTabsState({
      initialValue: makeInitialState(),
      now,
      storedValue: JSON.stringify(storedState),
    });
    const expectedWorkspaceTab = createWorkspaceFilePreviewFixedPanelTab({
      environmentId: "env-1",
      projectId: null,
      tab: {
        lineRange: null,
        path: "src/index.ts",
        source: { kind: "working-tree" },
        statusLabel: null,
      },
    });

    expect(parsed.secondary.activeTabId).toBe(expectedWorkspaceTab.id);
    expect(parsed.secondary.tabs.map((tab) => tab.id)).toEqual([
      createThreadInfoFixedPanelTab().id,
      expectedWorkspaceTab.id,
      buildFixedPanelTabId({
        environmentId: null,
        kind: "terminal",
        path: "term-1",
      }),
    ]);
    expect(parsed.secondary.tabs[1]).toMatchObject({
      lineRange: null,
    });
  });

  it("round-trips plugin-page fixed tab identities", () => {
    const fixedTab = createPluginPageFixedPanelTab({
      fixedTabId: "navigation",
      pageId: "tasks",
      pluginId: "tasks",
    });
    const state = createEmptyFixedPanelTabsState({
      lastUsedAt: NOW,
      secondary: {
        activeTabId: fixedTab.id,
        isOpen: true,
        tabs: [fixedTab],
      },
    });

    const parsed = parseFixedPanelTabsState({
      initialValue: EMPTY_FIXED_PANEL_TABS_STATE,
      now: NOW,
      storedValue: serializeFixedPanelTabsState({ state }),
    });

    expect(parsed).toEqual(state);
  });

  it("drops old fixed panel state shapes instead of migrating them", () => {
    const initialValue = makeInitialState();
    const parsed = parseFixedPanelTabsState({
      initialValue,
      now: 1_000,
      storedValue: JSON.stringify({
        version: FIXED_PANEL_TABS_STATE_STORAGE_VERSION,
        secondary: {
          tabs: [{ id: "thread-info", kind: "thread-info" }],
          activeTabId: "thread-info",
        },
        bottom: {
          tabs: [
            { id: "terminal:term-1", kind: "terminal", terminalId: "term-1" },
          ],
          activeTabId: "terminal:term-1",
        },
        lastUsedAt: 1_000,
      }),
    });

    expect(parsed).toBe(initialValue);
  });

  it("closes an open panel when its transient New tab is removed during hydration", () => {
    const newTab = createNewTabFixedPanelTab();
    const state: FixedPanelTabsState = {
      version: FIXED_PANEL_TABS_STATE_STORAGE_VERSION,
      secondary: {
        activeTabId: newTab.id,
        isOpen: true,
        tabs: [newTab],
      },
      lastUsedAt: NOW,
    };

    const storedValue = serializeFixedPanelTabsState({ state });
    expect(JSON.parse(storedValue)).toMatchObject({
      secondary: { activeTabId: null, isOpen: true, tabs: [] },
    });

    const parsed = parseFixedPanelTabsState({
      initialValue: EMPTY_FIXED_PANEL_TABS_STATE,
      now: NOW,
      storedValue,
    });

    expect(parsed.secondary).toEqual({
      activeTabId: null,
      isOpen: false,
      tabs: [],
    });
  });

  it("selects the first surviving tab when the persisted active tab is gone", () => {
    const infoTab = createThreadInfoFixedPanelTab();
    const state: FixedPanelTabsState = {
      version: FIXED_PANEL_TABS_STATE_STORAGE_VERSION,
      secondary: {
        activeTabId: "missing",
        isOpen: true,
        tabs: [infoTab],
      },
      lastUsedAt: NOW,
    };

    expect(ensureOpenFixedPanelHasActiveTab(state).secondary).toEqual({
      activeTabId: infoTab.id,
      isOpen: true,
      tabs: [infoTab],
    });
  });

  it("keeps the persisted active tab when it still exists", () => {
    const firstTab = createBrowserFixedPanelTab({
      environmentId: null,
      url: "https://first.example.com",
    });
    const lastActiveTab = createBrowserFixedPanelTab({
      environmentId: null,
      url: "https://last.example.com",
    });
    const state: FixedPanelTabsState = {
      version: FIXED_PANEL_TABS_STATE_STORAGE_VERSION,
      secondary: {
        activeTabId: lastActiveTab.id,
        isOpen: true,
        tabs: [firstTab, lastActiveTab],
      },
      lastUsedAt: NOW,
    };

    expect(ensureOpenFixedPanelHasActiveTab(state)).toBe(state);
  });

  it("recognizes old versioned storage keys for pruning", () => {
    expect(
      isFixedPanelTabsStateStorageKey(
        getFixedPanelTabsStateStorageKey({ threadId: "thr_current" }),
      ),
    ).toBe(true);
    expect(
      isFixedPanelTabsStateStorageKey(
        "bb.thread.fixedPanelTabsState-thr_old-0",
      ),
    ).toBe(true);
  });
});

describe("workspace file preview fixed panel tabs", () => {
  it("round-trips an active project-source preview tab", () => {
    const projectTab = createWorkspaceFilePreviewFixedPanelTab({
      environmentId: null,
      projectId: "proj_app",
      tab: {
        lineRange: null,
        path: "src/index.ts",
        source: { kind: "working-tree" },
        statusLabel: null,
      },
    });
    const state = createEmptyFixedPanelTabsState({
      secondary: {
        activeTabId: projectTab.id,
        isOpen: true,
        tabs: [projectTab],
      },
      lastUsedAt: NOW,
    });

    const parsed = parseFixedPanelTabsState({
      initialValue: EMPTY_FIXED_PANEL_TABS_STATE,
      now: NOW,
      storedValue: serializeFixedPanelTabsState({ state }),
    });

    expect(parsed.secondary.activeTabId).toBe(projectTab.id);
    expect(parsed.secondary.tabs).toEqual([projectTab]);
  });

  it("does not collide project-source preview tabs for the same path in different projects", () => {
    const firstProjectTab = createWorkspaceFilePreviewFixedPanelTab({
      environmentId: null,
      projectId: "proj_first",
      tab: {
        lineRange: null,
        path: "src/index.ts",
        source: { kind: "working-tree" },
        statusLabel: null,
      },
    });
    const secondProjectTab = createWorkspaceFilePreviewFixedPanelTab({
      environmentId: null,
      projectId: "proj_second",
      tab: {
        lineRange: null,
        path: "src/index.ts",
        source: { kind: "working-tree" },
        statusLabel: null,
      },
    });

    expect(firstProjectTab.id).not.toBe(secondProjectTab.id);
    expect(areFixedPanelTabsEquivalent(firstProjectTab, secondProjectTab)).toBe(
      false,
    );
  });
});

describe("thread-owned file preview fixed panel tabs", () => {
  it("round-trips active host and storage preview tabs with their owner thread", () => {
    const hostTab = createHostFilePreviewFixedPanelTab({
      environmentId: "env_app",
      tab: {
        lineRange: null,
        path: "/tmp/log.txt",
      },
      threadId: "thr_app",
    });
    const storageTab = createThreadStorageFilePreviewFixedPanelTab({
      environmentId: "env_app",
      isPinned: false,
      tab: {
        lineRange: null,
        path: "artifact.txt",
      },
      threadId: "thr_app",
    });
    const state = createEmptyFixedPanelTabsState({
      secondary: {
        activeTabId: storageTab.id,
        isOpen: true,
        tabs: [hostTab, storageTab],
      },
      lastUsedAt: NOW,
    });

    const parsed = parseFixedPanelTabsState({
      initialValue: EMPTY_FIXED_PANEL_TABS_STATE,
      now: NOW,
      storedValue: serializeFixedPanelTabsState({ state }),
    });

    expect(parsed.secondary.activeTabId).toBe(storageTab.id);
    expect(parsed.secondary.tabs).toEqual([hostTab, storageTab]);
  });

  it("does not collide host or storage preview tabs for the same path in different threads", () => {
    const firstHostTab = createHostFilePreviewFixedPanelTab({
      environmentId: "env_first",
      tab: {
        lineRange: null,
        path: "/tmp/log.txt",
      },
      threadId: "thr_first",
    });
    const secondHostTab = createHostFilePreviewFixedPanelTab({
      environmentId: "env_second",
      tab: {
        lineRange: null,
        path: "/tmp/log.txt",
      },
      threadId: "thr_second",
    });
    const firstStorageTab = createThreadStorageFilePreviewFixedPanelTab({
      environmentId: "env_first",
      isPinned: false,
      tab: {
        lineRange: null,
        path: "artifact.txt",
      },
      threadId: "thr_first",
    });
    const secondStorageTab = createThreadStorageFilePreviewFixedPanelTab({
      environmentId: "env_second",
      isPinned: false,
      tab: {
        lineRange: null,
        path: "artifact.txt",
      },
      threadId: "thr_second",
    });

    expect(firstHostTab.id).not.toBe(secondHostTab.id);
    expect(firstStorageTab.id).not.toBe(secondStorageTab.id);
    expect(areFixedPanelTabsEquivalent(firstHostTab, secondHostTab)).toBe(
      false,
    );
    expect(areFixedPanelTabsEquivalent(firstStorageTab, secondStorageTab)).toBe(
      false,
    );
  });

  it("does not collide explicit host previews for the same absolute path", () => {
    const first = createHostFilePreviewFixedPanelTab({
      environmentId: null,
      hostId: "host_first",
      tab: { lineRange: null, path: "/tmp/log.txt" },
      threadId: null,
    });
    const second = createHostFilePreviewFixedPanelTab({
      environmentId: null,
      hostId: "host_second",
      tab: { lineRange: null, path: "/tmp/log.txt" },
      threadId: null,
    });

    expect(first.id).not.toBe(second.id);
    expect(areFixedPanelTabsEquivalent(first, second)).toBe(false);
  });

  it("keeps legacy ownerless host and storage preview tabs parseable", () => {
    const state = {
      version: FIXED_PANEL_TABS_STATE_STORAGE_VERSION,
      secondary: {
        activeTabId: "thread-storage-file-preview:artifact.txt:none",
        isOpen: true,
        tabs: [
          {
            id: "host-file-preview:%2Ftmp%2Flog.txt:none",
            kind: "host-file-preview",
            lineRange: null,
            path: "/tmp/log.txt",
          },
          {
            id: "thread-storage-file-preview:artifact.txt:none",
            isPinned: false,
            kind: "thread-storage-file-preview",
            lineRange: null,
            path: "artifact.txt",
          },
        ],
      },
      lastUsedAt: NOW,
    };

    const parsed = parseFixedPanelTabsState({
      initialValue: EMPTY_FIXED_PANEL_TABS_STATE,
      now: NOW,
      storedValue: JSON.stringify(state),
    });

    expect(parsed.secondary.tabs).toMatchObject([
      {
        environmentId: null,
        hostId: null,
        kind: "host-file-preview",
        threadId: null,
      },
      {
        environmentId: null,
        kind: "thread-storage-file-preview",
        threadId: null,
      },
    ]);
  });
});

describe("plugin file opener owner state", () => {
  it("persists native preview context while dropping transient line selection", () => {
    const tab = {
      ...createPluginPanelFixedPanelTab({
        actionId: "file-opener:markdown",
        paramsJson: JSON.stringify({ path: "docs/readme.md" }),
        pluginId: "docs",
        title: "readme.md",
      }),
      fileOpenerOwner: {
        kind: "workspace-file-preview" as const,
        environmentId: "env_docs",
        projectId: null,
        tab: {
          lineRange: { startLineNumber: 8, endLineNumber: 12 },
          path: "docs/readme.md",
          source: { kind: "working-tree" as const },
          statusLabel: null,
        },
        threadId: "thr_docs",
      },
    } satisfies PluginPanelFixedPanelTab;
    const state = createEmptyFixedPanelTabsState({
      secondary: {
        activeTabId: tab.id,
        isOpen: true,
        tabs: [tab],
      },
      lastUsedAt: NOW,
    });

    const parsed = parseFixedPanelTabsState({
      initialValue: EMPTY_FIXED_PANEL_TABS_STATE,
      now: NOW,
      storedValue: serializeFixedPanelTabsState({ state }),
    });

    expect(parsed.secondary.tabs[0]).toMatchObject({
      actionId: "file-opener:markdown",
      fileOpenerOwner: {
        environmentId: "env_docs",
        projectId: null,
        tab: {
          lineRange: null,
          path: "docs/readme.md",
          source: { kind: "working-tree" },
          statusLabel: null,
        },
        threadId: "thr_docs",
      },
    });
  });
});

describe("terminal tab target", () => {
  it("keeps the target through a storage round trip and the thread-tabs contract", () => {
    const target = {
      kind: "host_path" as const,
      hostId: "host_1",
      cwd: "/Users/dev",
    };
    const tab = createTerminalFixedPanelTab({ terminalId: "term_abc", target });
    const state = createEmptyFixedPanelTabsState({
      secondary: { activeTabId: tab.id, isOpen: true, tabs: [tab] },
      lastUsedAt: NOW,
    });

    const parsed = parseFixedPanelTabsState({
      initialValue: EMPTY_FIXED_PANEL_TABS_STATE,
      now: NOW,
      storedValue: serializeFixedPanelTabsState({ state }),
    });

    expect(parsed.secondary.tabs[0]).toMatchObject({
      kind: "terminal",
      target,
    });
    expect(() =>
      threadTabsSchema.parse([parsed.secondary.tabs[0]]),
    ).not.toThrow();
  });

  it("treats terminal tabs with different targets as not equivalent", () => {
    const threadTab = createTerminalFixedPanelTab({
      terminalId: "term_abc",
      target: { kind: "thread", threadId: "thr_a" },
    });
    const environmentTab = createTerminalFixedPanelTab({
      terminalId: "term_abc",
      target: { kind: "environment", environmentId: "env_a" },
    });

    expect(areFixedPanelTabsEquivalent(threadTab, environmentTab)).toBe(false);
  });
});

describe("legacy side-chat tabs", () => {
  it("does not require crypto.randomUUID for generated tab ids", () => {
    const originalCrypto = globalThis.crypto;
    vi.stubGlobal("crypto", {
      getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto),
      randomUUID: undefined,
      subtle: originalCrypto.subtle,
    });

    try {
      const browserTab = createBrowserFixedPanelTab({
        environmentId: null,
        url: "",
      });

      expect(browserTab.id).toMatch(/^browser:.+:none$/);
    } finally {
      vi.stubGlobal("crypto", originalCrypto);
    }
  });

  it("drops tabs persisted before the native side chat was removed", () => {
    const browserTab = createBrowserFixedPanelTab({
      environmentId: null,
      url: "https://example.com",
    });
    const stored = JSON.stringify({
      version: FIXED_PANEL_TABS_STATE_STORAGE_VERSION,
      lastUsedAt: NOW,
      secondary: {
        activeTabId: "side-chat:legacy",
        isOpen: true,
        tabs: [
          browserTab,
          {
            id: "side-chat:legacy",
            kind: "side-chat",
            sourceMessageText: "anchor",
            sourceSeqEnd: null,
            threadId: "thr_legacy",
            title: "Side chat",
          },
        ],
      },
    });

    const parsed = parseFixedPanelTabsState({
      initialValue: EMPTY_FIXED_PANEL_TABS_STATE,
      now: NOW,
      storedValue: stored,
    });

    expect(parsed.secondary.tabs).toEqual([browserTab]);
  });
});
