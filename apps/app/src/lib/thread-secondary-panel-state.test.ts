// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  EMPTY_THREAD_SECONDARY_PANEL_STATE,
  LEGACY_THREAD_SECONDARY_PANEL_STORAGE_KEY,
  THREAD_SECONDARY_PANEL_IDLE_EXPIRY_MS,
  clearActiveFileTab,
  clearWorkspaceTabsForEnvironment,
  createEmptyThreadSecondaryPanelState,
  getActiveStorageFilePath,
  getActiveHostFileTab,
  getActiveWorkspaceFileTab,
  getThreadSecondaryPanelStateStorageKey,
  normalizeThreadSecondaryPanelState,
  parseThreadSecondaryPanelState,
  pruneStorageFileTabs,
  pruneThreadSecondaryPanelStorage,
  serializeThreadSecondaryPanelState,
  type ThreadSecondaryPanelState,
} from "./thread-secondary-panel-state";

const NOW = 1_700_000_000_000;

afterEach(() => {
  window.localStorage.clear();
});

function makeState(
  overrides: Partial<ThreadSecondaryPanelState> = {},
): ThreadSecondaryPanelState {
  return createEmptyThreadSecondaryPanelState({
    activePanel: "thread-info",
    environmentId: "env-current",
    fileTabs: {
      workspace: [
        {
          lineNumber: 12,
          path: "src/app.ts",
          source: { kind: "working-tree" },
          statusLabel: null,
        },
      ],
      storage: ["STATUS.md", "notes.md"],
      hostFiles: [{ lineNumber: 9, path: "/Users/me/notes.md" }],
      active: { type: "workspace", path: "src/app.ts" },
    },
    lastUsedAt: NOW,
    ...overrides,
  });
}

describe("thread secondary panel state storage", () => {
  it("round-trips valid state", () => {
    const state = makeState();
    const storedValue = serializeThreadSecondaryPanelState({ state });

    expect(
      parseThreadSecondaryPanelState({
        initialValue: EMPTY_THREAD_SECONDARY_PANEL_STATE,
        now: NOW,
        storedValue,
      }),
    ).toEqual(state);
  });

  it("migrates persisted v1 state without host-file tabs", () => {
    const state = makeState();
    const legacyFileTabs = {
      workspace: state.fileTabs.workspace,
      storage: state.fileTabs.storage,
      active: state.fileTabs.active,
    };

    expect(
      parseThreadSecondaryPanelState({
        initialValue: EMPTY_THREAD_SECONDARY_PANEL_STATE,
        now: NOW,
        storedValue: JSON.stringify({
          ...state,
          fileTabs: legacyFileTabs,
        }),
      }),
    ).toEqual({
      ...state,
      fileTabs: {
        ...legacyFileTabs,
        hostFiles: [],
      },
    });
  });

  it("falls back for invalid JSON and invalid shapes", () => {
    expect(
      parseThreadSecondaryPanelState({
        initialValue: EMPTY_THREAD_SECONDARY_PANEL_STATE,
        now: NOW,
        storedValue: "{",
      }),
    ).toBe(EMPTY_THREAD_SECONDARY_PANEL_STATE);

    expect(
      parseThreadSecondaryPanelState({
        initialValue: EMPTY_THREAD_SECONDARY_PANEL_STATE,
        now: NOW,
        storedValue: JSON.stringify({ version: 1, activePanel: "bad" }),
      }),
    ).toBe(EMPTY_THREAD_SECONDARY_PANEL_STATE);
  });

  it("rejects malformed persisted records at the storage boundary", () => {
    const validState = makeState();
    const invalidStoredValues = [
      { ...validState, version: 2 },
      { ...validState, lastUsedAt: -1 },
      { ...validState, extra: true },
      {
        ...validState,
        fileTabs: {
          ...validState.fileTabs,
          extra: true,
        },
      },
      {
        ...validState,
        fileTabs: {
          ...validState.fileTabs,
          workspace: [{ lineNumber: 0, path: "src/app.ts" }],
        },
      },
      {
        ...validState,
        fileTabs: {
          ...validState.fileTabs,
          hostFiles: [{ lineNumber: 0, path: "/Users/me/notes.md" }],
        },
      },
      {
        ...validState,
        fileTabs: {
          ...validState.fileTabs,
          active: { type: "unknown", path: "src/app.ts" },
        },
      },
      {
        ...validState,
        fileTabs: {
          ...validState.fileTabs,
          active: { type: "workspace", path: "" },
        },
      },
      {
        ...validState,
        fileTabs: {
          ...validState.fileTabs,
          storage: [""],
        },
      },
      {
        ...validState,
        fileTabs: {
          ...validState.fileTabs,
          hostFiles: [{ lineNumber: null, path: "" }],
        },
      },
    ].map((value) => JSON.stringify(value));

    for (const storedValue of invalidStoredValues) {
      expect(
        parseThreadSecondaryPanelState({
          initialValue: EMPTY_THREAD_SECONDARY_PANEL_STATE,
          now: NOW,
          storedValue,
        }),
      ).toBe(EMPTY_THREAD_SECONDARY_PANEL_STATE);
    }
  });

  it("expires records after the idle window", () => {
    const state = makeState({
      lastUsedAt: NOW - THREAD_SECONDARY_PANEL_IDLE_EXPIRY_MS - 1,
    });

    expect(
      parseThreadSecondaryPanelState({
        initialValue: EMPTY_THREAD_SECONDARY_PANEL_STATE,
        now: NOW,
        storedValue: serializeThreadSecondaryPanelState({ state }),
      }),
    ).toBe(EMPTY_THREAD_SECONDARY_PANEL_STATE);
  });

  it("prunes expired and legacy keys without touching unrelated storage", () => {
    const freshKey = getThreadSecondaryPanelStateStorageKey({
      threadId: "thr-fresh",
    });
    const expiredKey = getThreadSecondaryPanelStateStorageKey({
      threadId: "thr-expired",
    });
    const invalidKey = getThreadSecondaryPanelStateStorageKey({
      threadId: "thr-invalid",
    });
    window.localStorage.setItem(
      freshKey,
      serializeThreadSecondaryPanelState({ state: makeState() }),
    );
    window.localStorage.setItem(
      expiredKey,
      serializeThreadSecondaryPanelState({
        state: makeState({
          lastUsedAt: NOW - THREAD_SECONDARY_PANEL_IDLE_EXPIRY_MS - 1,
        }),
      }),
    );
    window.localStorage.setItem(
      LEGACY_THREAD_SECONDARY_PANEL_STORAGE_KEY,
      "thread-info",
    );
    window.localStorage.setItem(invalidKey, "{");
    window.localStorage.setItem("bb.unrelated", "keep");

    pruneThreadSecondaryPanelStorage({ now: NOW });

    expect(window.localStorage.getItem(freshKey)).not.toBeNull();
    expect(window.localStorage.getItem(expiredKey)).toBeNull();
    expect(window.localStorage.getItem(invalidKey)).toBeNull();
    expect(
      window.localStorage.getItem(LEGACY_THREAD_SECONDARY_PANEL_STORAGE_KEY),
    ).toBeNull();
    expect(window.localStorage.getItem("bb.unrelated")).toBe("keep");
  });
});

describe("thread secondary panel tab normalization", () => {
  it("normalizes storage tabs away for non-manager threads", () => {
    const normalized = normalizeThreadSecondaryPanelState({
      isManagerThread: false,
      state: makeState({
        fileTabs: {
          workspace: [],
          storage: ["STATUS.md"],
          hostFiles: [],
          active: { type: "storage", path: "STATUS.md" },
        },
      }),
    });

    expect(normalized.fileTabs.storage).toEqual([]);
    expect(normalized.fileTabs.active).toBeNull();
  });

  it("clears workspace tabs when the environment changes", () => {
    const state = makeState();

    const nextState = clearWorkspaceTabsForEnvironment({
      environmentId: "env-next",
      state,
    });

    expect(nextState.environmentId).toBe("env-next");
    expect(nextState.fileTabs.workspace).toEqual([]);
    expect(nextState.fileTabs.active).toBeNull();
    expect(nextState.fileTabs.storage).toEqual(state.fileTabs.storage);
    expect(nextState.fileTabs.hostFiles).toEqual(state.fileTabs.hostFiles);
  });

  it("prunes storage tabs against the available thread storage files", () => {
    const state = makeState({
      fileTabs: {
        workspace: [],
        storage: ["STATUS.md", "missing.md"],
        hostFiles: [],
        active: { type: "storage", path: "missing.md" },
      },
    });

    const nextState = pruneStorageFileTabs({
      isManagerThread: true,
      pinnedStorageFilePath: "STATUS.md",
      state,
      storageFiles: [{ path: "STATUS.md" }],
    });

    expect(nextState.fileTabs.storage).toEqual(["STATUS.md"]);
    expect(nextState.fileTabs.active).toBeNull();
  });

  it("selects only active tabs that still exist", () => {
    const workspaceState = makeState();
    expect(getActiveWorkspaceFileTab(workspaceState)).toEqual({
      lineNumber: 12,
      path: "src/app.ts",
      source: { kind: "working-tree" },
      statusLabel: null,
    });

    const storageState = makeState({
      fileTabs: {
        workspace: [],
        storage: ["STATUS.md"],
        hostFiles: [],
        active: { type: "storage", path: "STATUS.md" },
      },
    });
    expect(getActiveStorageFilePath(storageState)).toBe("STATUS.md");

    const hostFileState = makeState({
      fileTabs: {
        workspace: [],
        storage: [],
        hostFiles: [{ lineNumber: 9, path: "/Users/me/notes.md" }],
        active: { type: "host-file", path: "/Users/me/notes.md" },
      },
    });
    expect(getActiveHostFileTab(hostFileState)).toEqual({
      lineNumber: 9,
      path: "/Users/me/notes.md",
    });

    expect(clearActiveFileTab(storageState).fileTabs.active).toBeNull();
  });
});
