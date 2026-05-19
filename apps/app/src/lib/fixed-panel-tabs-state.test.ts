// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  EMPTY_FIXED_PANEL_TABS_STATE,
  FIXED_PANEL_TABS_IDLE_EXPIRY_MS,
  createEmptyFixedPanelTabsState,
  getFixedPanelTabsStateStorageKey,
  normalizeFixedPanelTabsState,
  parseFixedPanelTabsState,
  pruneFixedPanelTabsStorage,
  serializeFixedPanelTabsState,
  type FixedPanelTabsState,
} from "./fixed-panel-tabs-state";

const NOW = 1_700_000_000_000;

afterEach(() => {
  window.localStorage.clear();
});

function workspaceFileTabId(path: string): string {
  return `workspace-file-preview:${encodeURIComponent(path)}`;
}

function terminalTabId(terminalId: string): string {
  return `terminal:${encodeURIComponent(terminalId)}`;
}

function makeFixedPanelTabsState(
  overrides: Partial<FixedPanelTabsState> = {},
): FixedPanelTabsState {
  return createEmptyFixedPanelTabsState({
    secondary: {
      tabs: [
        { id: "thread-info", kind: "thread-info" },
        { id: "git-diff", kind: "git-diff" },
        {
          environmentId: "env-current",
          id: workspaceFileTabId("src/app.ts"),
          kind: "workspace-file-preview",
          lineNumber: 12,
          path: "src/app.ts",
          source: { kind: "working-tree" },
          statusLabel: null,
        },
      ],
      activeTabId: workspaceFileTabId("src/app.ts"),
      isOpen: true,
    },
    bottom: {
      tabs: [
        {
          id: terminalTabId("term_1"),
          kind: "terminal",
          terminalId: "term_1",
        },
      ],
      activeTabId: terminalTabId("term_1"),
    },
    lastUsedAt: NOW,
    ...overrides,
  });
}


describe("fixed panel tabs state storage", () => {
  it("round-trips valid state", () => {
    const state = makeFixedPanelTabsState();
    const storedValue = serializeFixedPanelTabsState({ state });

    expect(
      parseFixedPanelTabsState({
        initialValue: EMPTY_FIXED_PANEL_TABS_STATE,
        now: NOW,
        storedValue,
      }),
    ).toEqual(state);
  });

  it("falls back for invalid JSON, invalid shapes, and unsupported regions", () => {
    const validState = makeFixedPanelTabsState();
    const invalidStoredValues = [
      "{",
      JSON.stringify({ version: 1, secondary: null }),
      JSON.stringify({ ...validState, version: 2 }),
      JSON.stringify({ ...validState, lastUsedAt: -1 }),
      JSON.stringify({
        ...validState,
        secondary: {
          tabs: [
            {
              id: terminalTabId("term_1"),
              kind: "terminal",
              terminalId: "term_1",
            },
          ],
          activeTabId: terminalTabId("term_1"),
        },
      }),
      JSON.stringify({
        ...validState,
        bottom: {
          tabs: [{ id: "thread-info", kind: "thread-info" }],
          activeTabId: "thread-info",
        },
      }),
      JSON.stringify({
        ...validState,
        secondary: {
          ...validState.secondary,
          tabs: [
            {
              environmentId: "env-current",
              id: workspaceFileTabId("src/app.ts"),
              kind: "workspace-file-preview",
              lineNumber: 0,
              path: "src/app.ts",
              source: { kind: "working-tree" },
              statusLabel: null,
            },
          ],
        },
      }),
    ];

    for (const storedValue of invalidStoredValues) {
      expect(
        parseFixedPanelTabsState({
          initialValue: EMPTY_FIXED_PANEL_TABS_STATE,
          now: NOW,
          storedValue,
        }),
      ).toBe(EMPTY_FIXED_PANEL_TABS_STATE);
    }
  });

  it("expires records after the idle window", () => {
    const state = makeFixedPanelTabsState({
      lastUsedAt: NOW - FIXED_PANEL_TABS_IDLE_EXPIRY_MS - 1,
    });

    expect(
      parseFixedPanelTabsState({
        initialValue: EMPTY_FIXED_PANEL_TABS_STATE,
        now: NOW,
        storedValue: serializeFixedPanelTabsState({ state }),
      }),
    ).toBe(EMPTY_FIXED_PANEL_TABS_STATE);
  });

  it("prunes expired and invalid records without touching unrelated storage", () => {
    const freshKey = getFixedPanelTabsStateStorageKey({
      threadId: "thr-fresh",
    });
    const expiredKey = getFixedPanelTabsStateStorageKey({
      threadId: "thr-expired",
    });
    const invalidKey = getFixedPanelTabsStateStorageKey({
      threadId: "thr-invalid",
    });
    window.localStorage.setItem(
      freshKey,
      serializeFixedPanelTabsState({ state: makeFixedPanelTabsState() }),
    );
    window.localStorage.setItem(
      expiredKey,
      serializeFixedPanelTabsState({
        state: makeFixedPanelTabsState({
          lastUsedAt: NOW - FIXED_PANEL_TABS_IDLE_EXPIRY_MS - 1,
        }),
      }),
    );
    window.localStorage.setItem(invalidKey, "{");
    window.localStorage.setItem("bb.unrelated", "keep");

    pruneFixedPanelTabsStorage({ now: NOW });

    expect(window.localStorage.getItem(freshKey)).not.toBeNull();
    expect(window.localStorage.getItem(expiredKey)).toBeNull();
    expect(window.localStorage.getItem(invalidKey)).toBeNull();
    expect(window.localStorage.getItem("bb.unrelated")).toBe("keep");
  });
});

describe("fixed panel tabs normalization", () => {
  it("dedupes tabs and clears active ids that no longer exist", () => {
    const normalized = normalizeFixedPanelTabsState({
      state: createEmptyFixedPanelTabsState({
        secondary: {
          tabs: [
            { id: "thread-info", kind: "thread-info" },
            { id: "thread-info", kind: "thread-info" },
            {
              environmentId: "env-current",
              id: workspaceFileTabId("src/app.ts"),
              kind: "workspace-file-preview",
              lineNumber: 12,
              path: "src/app.ts",
              source: { kind: "working-tree" },
              statusLabel: null,
            },
            {
              environmentId: "env-current",
              id: workspaceFileTabId("src/app.ts"),
              kind: "workspace-file-preview",
              lineNumber: 13,
              path: "src/app.ts",
              source: { kind: "head" },
              statusLabel: null,
            },
          ],
          activeTabId: "missing",
          isOpen: true,
        },
        bottom: {
          tabs: [
            {
              id: terminalTabId("term_1"),
              kind: "terminal",
              terminalId: "term_1",
            },
            {
              id: terminalTabId("term_1"),
              kind: "terminal",
              terminalId: "term_1",
            },
          ],
          activeTabId: terminalTabId("term_1"),
        },
        lastUsedAt: NOW,
      }),
    });

    expect(normalized.secondary.tabs).toEqual([
      { id: "thread-info", kind: "thread-info" },
      {
        environmentId: "env-current",
        id: workspaceFileTabId("src/app.ts"),
        kind: "workspace-file-preview",
        lineNumber: 12,
        path: "src/app.ts",
        source: { kind: "working-tree" },
        statusLabel: null,
      },
    ]);
    expect(normalized.secondary.activeTabId).toBeNull();
    expect(normalized.secondary.isOpen).toBe(true);
    expect(normalized.bottom.tabs).toEqual([
      {
        id: terminalTabId("term_1"),
        kind: "terminal",
        terminalId: "term_1",
      },
    ]);
    expect(normalized.bottom.activeTabId).toBe(terminalTabId("term_1"));
  });
});
