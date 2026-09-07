import { describe, expect, it } from "vitest";
import {
  createEmptyFixedPanelTabsState,
  createHostFilePreviewFixedPanelTab,
  createTerminalFixedPanelTab,
} from "@/lib/fixed-panel-tabs-state";
import {
  buildTerminalSyncedSecondaryFileTabs,
  getRetainedTerminalTabId,
  pruneTerminalTabsForSessions,
  syncTerminalTabsInFixedPanelState,
} from "./terminalPanelTabs";
import { makeTerminalSession as terminalSession } from "@/test/fixtures/terminal-sessions";

interface TabIdentity {
  id: string;
}

function tabIds(tabs: readonly TabIdentity[]): string[] {
  return tabs.map((tab) => tab.id);
}

describe("terminalPanelTabs", () => {
  it("resolves a retained terminal id only from the open active terminal tab", () => {
    const terminalTab = createTerminalFixedPanelTab({ terminalId: "term_1" });
    const fileTab = createHostFilePreviewFixedPanelTab({
      environmentId: "env_1",
      tab: {
        lineRange: null,
        path: "/workspace/file.ts",
      },
      threadId: "thr_1",
    });

    expect(
      getRetainedTerminalTabId({
        activeTab: terminalTab,
        isPanelOpen: true,
      }),
    ).toBe("term_1");
    expect(
      getRetainedTerminalTabId({
        activeTab: terminalTab,
        isPanelOpen: false,
      }),
    ).toBeNull();
    expect(
      getRetainedTerminalTabId({
        activeTab: fileTab,
        isPanelOpen: true,
      }),
    ).toBeNull();
  });

  it("prunes terminal tabs against active or retained terminal sessions", () => {
    const infoTab = createHostFilePreviewFixedPanelTab({
      environmentId: "env_1",
      tab: {
        lineRange: null,
        path: "/workspace/file.ts",
      },
      threadId: "thr_1",
    });
    const retainedTerminal = createTerminalFixedPanelTab({
      terminalId: "term_retained",
    });
    const unretainedTerminal = createTerminalFixedPanelTab({
      terminalId: "term_unretained",
    });
    const runningTerminal = createTerminalFixedPanelTab({
      terminalId: "term_running",
    });

    expect(
      pruneTerminalTabsForSessions({
        retainedTerminalId: "term_retained",
        tabs: [infoTab, retainedTerminal, unretainedTerminal, runningTerminal],
        terminalSessions: [
          terminalSession({
            id: "term_retained",
            status: "disconnected",
          }),
          terminalSession({
            id: "term_unretained",
            status: "disconnected",
          }),
          terminalSession({ id: "term_running" }),
        ],
      }),
    ).toEqual([infoTab, retainedTerminal, runningTerminal]);
  });

  it("adds server terminal sessions missing from local tabs", () => {
    const tabs = buildTerminalSyncedSecondaryFileTabs({
      orderedTabs: [],
      retainedTerminalId: null,
      terminalSessions: [
        terminalSession({ id: "term_1" }),
        terminalSession({ id: "term_2" }),
      ],
    });

    expect(tabIds(tabs)).toEqual([
      "terminal:term_1:none",
      "terminal:term_2:none",
    ]);
  });

  it("preserves local terminal tab order when sessions still exist", () => {
    const localTerminal2 = createTerminalFixedPanelTab({
      terminalId: "term_2",
    });
    const localFile = createHostFilePreviewFixedPanelTab({
      environmentId: "env_1",
      tab: {
        lineRange: null,
        path: "/workspace/file.ts",
      },
      threadId: "thr_1",
    });
    const localTerminal1 = createTerminalFixedPanelTab({
      terminalId: "term_1",
    });
    const tabs = buildTerminalSyncedSecondaryFileTabs({
      orderedTabs: [localTerminal2, localFile, localTerminal1],
      retainedTerminalId: null,
      terminalSessions: [
        terminalSession({ id: "term_1" }),
        terminalSession({ id: "term_2" }),
        terminalSession({ id: "term_3" }),
      ],
    });

    expect(tabIds(tabs)).toEqual([
      "terminal:term_2:none",
      "host-file-preview:%2Fworkspace%2Ffile.ts:thread%3Athr_1%3Aenvironment%3Aenv_1",
      "terminal:term_1:none",
      "terminal:term_3:none",
    ]);
  });

  it("drops stale local terminal tabs when sessions disappear elsewhere", () => {
    const tabs = buildTerminalSyncedSecondaryFileTabs({
      orderedTabs: [
        createTerminalFixedPanelTab({ terminalId: "term_stale" }),
        createTerminalFixedPanelTab({ terminalId: "term_1" }),
      ],
      retainedTerminalId: null,
      terminalSessions: [terminalSession({ id: "term_1" })],
    });

    expect(tabIds(tabs)).toEqual(["terminal:term_1:none"]);
  });

  it("drops disconnected terminal tabs unless they are retained", () => {
    const disconnectedTerminal = createTerminalFixedPanelTab({
      terminalId: "term_disconnected",
    });
    const runningTerminal = createTerminalFixedPanelTab({
      terminalId: "term_running",
    });
    const sessions = [
      terminalSession({
        id: "term_disconnected",
        status: "disconnected",
      }),
      terminalSession({ id: "term_running" }),
    ];

    expect(
      tabIds(
        buildTerminalSyncedSecondaryFileTabs({
          orderedTabs: [disconnectedTerminal, runningTerminal],
          retainedTerminalId: null,
          terminalSessions: sessions,
        }),
      ),
    ).toEqual(["terminal:term_running:none"]);

    expect(
      tabIds(
        buildTerminalSyncedSecondaryFileTabs({
          orderedTabs: [disconnectedTerminal, runningTerminal],
          retainedTerminalId: "term_disconnected",
          terminalSessions: sessions,
        }),
      ),
    ).toEqual([
      "terminal:term_disconnected:none",
      "terminal:term_running:none",
    ]);
  });

  it("syncs missing server terminal sessions into fixed panel state", () => {
    const fileTab = createHostFilePreviewFixedPanelTab({
      environmentId: "env_1",
      tab: {
        lineRange: null,
        path: "/workspace/file.ts",
      },
      threadId: "thr_1",
    });
    const state = createEmptyFixedPanelTabsState({
      secondary: {
        activeTabId: fileTab.id,
        isOpen: true,
        tabs: [fileTab],
      },
    });
    const nextState = syncTerminalTabsInFixedPanelState({
      retainedTerminalId: null,
      state,
      terminalSessions: [
        terminalSession({ id: "term_1" }),
        terminalSession({ id: "term_2" }),
      ],
    });

    expect(tabIds(nextState.secondary.tabs)).toEqual([
      "host-file-preview:%2Fworkspace%2Ffile.ts:thread%3Athr_1%3Aenvironment%3Aenv_1",
      "terminal:term_1:none",
      "terminal:term_2:none",
    ]);
    expect(nextState.secondary.activeTabId).toBe(fileTab.id);
  });

  it("removes stale fixed terminal tabs and clears stale active state", () => {
    const staleTerminalTab = createTerminalFixedPanelTab({
      terminalId: "term_stale",
    });
    const currentTerminalTab = createTerminalFixedPanelTab({
      terminalId: "term_1",
    });
    const state = createEmptyFixedPanelTabsState({
      secondary: {
        activeTabId: staleTerminalTab.id,
        isOpen: true,
        tabs: [staleTerminalTab, currentTerminalTab],
      },
    });
    const nextState = syncTerminalTabsInFixedPanelState({
      retainedTerminalId: null,
      state,
      terminalSessions: [terminalSession({ id: "term_1" })],
    });

    expect(tabIds(nextState.secondary.tabs)).toEqual(["terminal:term_1:none"]);
    expect(nextState.secondary.activeTabId).toBeNull();
  });

  it("removes a disconnected terminal without disturbing the active file tab", () => {
    const terminalTab = createTerminalFixedPanelTab({
      terminalId: "term_disconnected",
    });
    const activeFileTab = createHostFilePreviewFixedPanelTab({
      environmentId: "env_1",
      tab: {
        lineRange: null,
        path: "/workspace/proposal.md",
      },
      threadId: "thr_1",
    });
    const state = createEmptyFixedPanelTabsState({
      secondary: {
        activeTabId: activeFileTab.id,
        isOpen: true,
        tabs: [terminalTab, activeFileTab],
      },
    });

    const nextState = syncTerminalTabsInFixedPanelState({
      retainedTerminalId: null,
      state,
      terminalSessions: [
        terminalSession({
          id: "term_disconnected",
          status: "disconnected",
          title: "zsh",
        }),
      ],
    });

    expect(nextState.secondary.tabs).toEqual([activeFileTab]);
    expect(nextState.secondary.activeTabId).toBe(activeFileTab.id);
  });

  it("keeps fixed panel state identity when terminal tabs already match", () => {
    const terminalTab = createTerminalFixedPanelTab({ terminalId: "term_1" });
    const state = createEmptyFixedPanelTabsState({
      secondary: {
        activeTabId: terminalTab.id,
        isOpen: true,
        tabs: [terminalTab],
      },
    });

    expect(
      syncTerminalTabsInFixedPanelState({
        retainedTerminalId: null,
        state,
        terminalSessions: [terminalSession({ id: "term_1" })],
      }),
    ).toBe(state);
  });

  it("keeps only a retained disconnected terminal in fixed panel state", () => {
    const disconnectedTerminal = createTerminalFixedPanelTab({
      terminalId: "term_disconnected",
    });
    const unretainedTerminal = createTerminalFixedPanelTab({
      terminalId: "term_unretained",
    });
    const state = createEmptyFixedPanelTabsState({
      secondary: {
        activeTabId: disconnectedTerminal.id,
        isOpen: true,
        tabs: [disconnectedTerminal, unretainedTerminal],
      },
    });
    const nextState = syncTerminalTabsInFixedPanelState({
      retainedTerminalId: "term_disconnected",
      state,
      terminalSessions: [
        terminalSession({
          id: "term_disconnected",
          status: "disconnected",
        }),
        terminalSession({
          id: "term_unretained",
          status: "disconnected",
        }),
      ],
    });

    expect(tabIds(nextState.secondary.tabs)).toEqual([
      "terminal:term_disconnected:none",
    ]);
    expect(nextState.secondary.activeTabId).toBe(disconnectedTerminal.id);
  });
});
