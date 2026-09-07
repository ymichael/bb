import { describe, expect, it } from "vitest";
import {
  isVisibleTerminalSession,
  pickActiveTerminalId,
  shouldAutoCloseCleanTerminalSession,
  shouldAutoCloseCleanTerminalSessionsForPanel,
  shouldCloseDisconnectedTerminalSession,
} from "./useThreadTerminalController";
import { makeTerminalSession as terminalSession } from "@/test/fixtures/terminal-sessions";

describe("terminal visibility", () => {
  it("does not replace an exact plugin tab with a sibling session", () => {
    const sibling = terminalSession({ id: "term_sibling" });

    expect(
      pickActiveTerminalId([sibling], "term_missing", "term_missing"),
    ).toBeNull();
    expect(
      pickActiveTerminalId([sibling], "term_sibling", "term_sibling"),
    ).toBe("term_sibling");
  });
  it("shows disconnected sessions only while retaining a mounted terminal view", () => {
    const disconnected = terminalSession({
      id: "term_disconnected",
      status: "disconnected",
    });

    expect(
      isVisibleTerminalSession({
        retainedTerminalViewId: null,
        session: disconnected,
      }),
    ).toBe(false);
    expect(
      isVisibleTerminalSession({
        retainedTerminalViewId: "term_disconnected",
        session: disconnected,
      }),
    ).toBe(true);
    expect(
      isVisibleTerminalSession({
        retainedTerminalViewId: null,
        session: terminalSession({ status: "running" }),
      }),
    ).toBe(true);
  });

  it("cleans up only disconnected sessions without a retained terminal view", () => {
    const disconnected = terminalSession({
      id: "term_disconnected",
      status: "disconnected",
    });

    expect(
      shouldCloseDisconnectedTerminalSession({
        retainedTerminalViewId: null,
        session: disconnected,
      }),
    ).toBe(true);
    expect(
      shouldCloseDisconnectedTerminalSession({
        retainedTerminalViewId: "term_disconnected",
        session: disconnected,
      }),
    ).toBe(false);
    expect(
      shouldCloseDisconnectedTerminalSession({
        retainedTerminalViewId: null,
        session: terminalSession({ status: "running" }),
      }),
    ).toBe(false);
  });

  it("auto-closes only clean UI-created terminal sessions", () => {
    const cleanUiCreated = terminalSession({ id: "term_ui" });
    const external = terminalSession({ id: "term_external" });
    const dirty = terminalSession({ id: "term_dirty" });
    const userInput = terminalSession({
      id: "term_user_input",
      lastUserInputAt: 2,
    });

    expect(
      shouldAutoCloseCleanTerminalSession({
        dirtyTerminalIds: new Set(["term_dirty"]),
        session: cleanUiCreated,
        uiCreatedTerminalIds: new Set(["term_ui", "term_dirty"]),
      }),
    ).toBe(true);
    expect(
      shouldAutoCloseCleanTerminalSession({
        dirtyTerminalIds: new Set(),
        session: external,
        uiCreatedTerminalIds: new Set(["term_ui"]),
      }),
    ).toBe(false);
    expect(
      shouldAutoCloseCleanTerminalSession({
        dirtyTerminalIds: new Set(["term_dirty"]),
        session: dirty,
        uiCreatedTerminalIds: new Set(["term_dirty"]),
      }),
    ).toBe(false);
    expect(
      shouldAutoCloseCleanTerminalSession({
        dirtyTerminalIds: new Set(),
        session: userInput,
        uiCreatedTerminalIds: new Set(["term_user_input"]),
      }),
    ).toBe(false);
  });

  it("preserves clean terminals while a compact panel remains persisted", () => {
    expect(
      shouldAutoCloseCleanTerminalSessionsForPanel({
        isPanelOpen: false,
        isPanelPersistedOpen: true,
      }),
    ).toBe(false);
    expect(
      shouldAutoCloseCleanTerminalSessionsForPanel({
        isPanelOpen: true,
        isPanelPersistedOpen: false,
      }),
    ).toBe(false);
    expect(
      shouldAutoCloseCleanTerminalSessionsForPanel({
        isPanelOpen: false,
        isPanelPersistedOpen: false,
      }),
    ).toBe(true);
  });
});
