// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { BB_DESKTOP_BROWSER_MAX_FIND_TEXT_LENGTH } from "@bb/desktop-contract";
import type {
  BbDesktopBrowserApi,
  BbDesktopBrowserFindInPageRequest,
  BbDesktopBrowserFindResult,
  BbDesktopBrowserState,
  BbDesktopBrowserStopFindInPageRequest,
} from "@bb/desktop-contract";
import { defaultAppSettings } from "@bb/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBbDesktopApi,
  createNoopDesktopBrowserApi,
} from "@/test/bb-desktop-test-utils";
import { AppCommandProvider } from "@/components/commands/AppCommandProvider";
import { BrowserTabContent } from "./BrowserTabContent";

const FIND_KEYBINDING = {
  command: "browser.find" as const,
  desktopOnly: true,
  shortcut: {
    key: "f",
    mod: false,
    meta: false,
    control: true,
    alt: false,
    shift: false,
  },
  when: {
    all: ["mainSurface" as const, "browserFocus" as const],
    none: ["modalOpen" as const],
  },
};

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemConfig: () => ({
    data: {
      generalSettings: defaultAppSettings,
      keybindings: [FIND_KEYBINDING],
    },
  }),
}));

const desktopInfo = {
  lastCheckedAt: null,
  latestVersion: null,
  pendingVersion: null,
  platform: "macos" as const,
  updateAvailable: false,
  updateDownloaded: false,
  version: "0.0.0-test",
};

interface FindHarness {
  api: BbDesktopBrowserApi;
  emitFindResult: (result: BbDesktopBrowserFindResult) => void;
  emitState: (state: BbDesktopBrowserState) => void;
  findInPage: ReturnType<
    typeof vi.fn<(r: BbDesktopBrowserFindInPageRequest) => void>
  >;
  stopFindInPage: ReturnType<
    typeof vi.fn<(r: BbDesktopBrowserStopFindInPageRequest) => void>
  >;
}

function createFindHarness(): FindHarness {
  const stateListeners = new Set<(state: BbDesktopBrowserState) => void>();
  const findListeners = new Set<(result: BbDesktopBrowserFindResult) => void>();
  const findInPage = vi.fn<(r: BbDesktopBrowserFindInPageRequest) => void>();
  const stopFindInPage =
    vi.fn<(r: BbDesktopBrowserStopFindInPageRequest) => void>();
  const api: BbDesktopBrowserApi = {
    ...createNoopDesktopBrowserApi(),
    onState(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    findInPage,
    stopFindInPage,
    onFindResult(listener) {
      findListeners.add(listener);
      return () => findListeners.delete(listener);
    },
  };
  return {
    api,
    emitFindResult(result) {
      for (const listener of findListeners) listener(result);
    },
    emitState(state) {
      for (const listener of stateListeners) listener(state);
    },
    findInPage,
    stopFindInPage,
  };
}

function findResult(
  overrides: Partial<BbDesktopBrowserFindResult> = {},
): BbDesktopBrowserFindResult {
  return {
    tabId: "browser:test",
    requestId: 1,
    activeMatchOrdinal: 1,
    matches: 5,
    finalUpdate: true,
    ...overrides,
  };
}

function browserState(
  overrides: Partial<BbDesktopBrowserState> = {},
): BbDesktopBrowserState {
  return {
    tabId: "browser:test",
    url: "https://example.com/docs",
    title: "Example docs",
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    errorText: null,
    ...overrides,
  };
}

function renderBrowser(harness: FindHarness, initialUrl: string) {
  window.bbDesktop = createBbDesktopApi(desktopInfo, harness.api);
  return render(
    <AppCommandProvider>
      <BrowserTabContent
        tabId="browser:test"
        initialUrl={initialUrl}
        addressFocusRequest={null}
        canShowNativeBrowserView={true}
        visibilityCoordinator={null}
        environmentId={null}
        threadId="thread-1"
        onUpdate={() => {}}
      />
      <button type="button">Outside browser</button>
    </AppCommandProvider>,
  );
}

function pressFindChord(target: Element) {
  fireEvent.keyDown(target, { key: "f", code: "KeyF", ctrlKey: true });
}

function findInput(): HTMLInputElement {
  return screen.getByRole("textbox", { name: /Find in page/ });
}

describe("BrowserTabContent find in page", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    window.localStorage.clear();
    delete window.bbDesktop;
  });

  it("opens the find bar from the chord only while the browser pane has focus", () => {
    const harness = createFindHarness();
    renderBrowser(harness, "https://example.com/docs");

    pressFindChord(screen.getByRole("button", { name: "Outside browser" }));
    expect(screen.queryByTestId("browser-find-bar")).toBeNull();

    pressFindChord(screen.getByLabelText(/Address and search bar/));
    expect(screen.getByTestId("browser-find-bar")).not.toBeNull();
  });

  it("does not open the find bar when the tab has no page", () => {
    const harness = createFindHarness();
    renderBrowser(harness, "");

    pressFindChord(screen.getByLabelText(/Address and search bar/));
    expect(screen.queryByTestId("browser-find-bar")).toBeNull();
  });

  it("searches as the query changes, steps with Enter/Shift+Enter, and shows the count", () => {
    const harness = createFindHarness();
    renderBrowser(harness, "https://example.com/docs");
    pressFindChord(screen.getByLabelText(/Address and search bar/));

    fireEvent.change(findInput(), { target: { value: "needle" } });
    expect(harness.findInPage).toHaveBeenLastCalledWith({
      tabId: "browser:test",
      text: "needle",
      forward: true,
      newSession: true,
    });

    act(() => harness.emitFindResult(findResult({ tabId: "browser:other" })));
    expect(screen.queryByTestId("browser-find-match-count")).toBeNull();

    act(() =>
      harness.emitFindResult(findResult({ activeMatchOrdinal: 2, matches: 7 })),
    );
    expect(screen.getByTestId("browser-find-match-count").textContent).toBe(
      "2/7",
    );

    fireEvent.keyDown(findInput(), { key: "Enter" });
    expect(harness.findInPage).toHaveBeenLastCalledWith({
      tabId: "browser:test",
      text: "needle",
      forward: true,
      newSession: false,
    });
    fireEvent.keyDown(findInput(), { key: "Enter", shiftKey: true });
    expect(harness.findInPage).toHaveBeenLastCalledWith({
      tabId: "browser:test",
      text: "needle",
      forward: false,
      newSession: false,
    });

    fireEvent.change(findInput(), { target: { value: "" } });
    expect(harness.stopFindInPage).toHaveBeenLastCalledWith({
      tabId: "browser:test",
      action: "clearSelection",
    });
    expect(screen.queryByTestId("browser-find-match-count")).toBeNull();
  });

  it("closes on Escape, clears highlights, and re-runs the query when reopened", () => {
    const harness = createFindHarness();
    renderBrowser(harness, "https://example.com/docs");
    pressFindChord(screen.getByLabelText(/Address and search bar/));
    fireEvent.change(findInput(), { target: { value: "needle" } });
    act(() => harness.emitFindResult(findResult()));
    harness.findInPage.mockClear();
    harness.stopFindInPage.mockClear();

    fireEvent.keyDown(findInput(), { key: "Escape" });
    expect(screen.queryByTestId("browser-find-bar")).toBeNull();
    expect(harness.stopFindInPage).toHaveBeenCalledWith({
      tabId: "browser:test",
      action: "clearSelection",
    });

    pressFindChord(screen.getByLabelText(/Address and search bar/));
    expect(findInput().value).toBe("needle");
    expect(harness.findInPage).toHaveBeenCalledWith({
      tabId: "browser:test",
      text: "needle",
      forward: true,
      newSession: true,
    });
  });

  it("drops a stale match count when the same URL reloads", () => {
    const harness = createFindHarness();
    renderBrowser(harness, "https://example.com/docs");
    act(() => harness.emitState(browserState({ isLoading: false })));
    pressFindChord(screen.getByLabelText(/Address and search bar/));
    fireEvent.change(findInput(), { target: { value: "needle" } });
    act(() => harness.emitFindResult(findResult()));
    expect(screen.getByTestId("browser-find-match-count").textContent).toBe(
      "1/5",
    );

    act(() => harness.emitState(browserState({ isLoading: true })));
    expect(screen.queryByTestId("browser-find-match-count")).toBeNull();
    expect(findInput().value).toBe("needle");
  });

  it("ends the native find session when the component unmounts with the bar open", () => {
    const harness = createFindHarness();
    const view = renderBrowser(harness, "https://example.com/docs");
    pressFindChord(screen.getByLabelText(/Address and search bar/));
    fireEvent.change(findInput(), { target: { value: "needle" } });
    harness.stopFindInPage.mockClear();

    view.unmount();
    expect(harness.stopFindInPage).toHaveBeenCalledWith({
      tabId: "browser:test",
      action: "clearSelection",
    });
  });

  it("does not touch the native find session on unmount when the bar is closed", () => {
    const harness = createFindHarness();
    const view = renderBrowser(harness, "https://example.com/docs");
    view.unmount();
    expect(harness.stopFindInPage).not.toHaveBeenCalled();
  });

  it("caps the query at the contract limit", () => {
    const harness = createFindHarness();
    renderBrowser(harness, "https://example.com/docs");
    pressFindChord(screen.getByLabelText(/Address and search bar/));
    expect(findInput().maxLength).toBe(BB_DESKTOP_BROWSER_MAX_FIND_TEXT_LENGTH);

    const oversized = "a".repeat(BB_DESKTOP_BROWSER_MAX_FIND_TEXT_LENGTH + 10);
    fireEvent.change(findInput(), { target: { value: oversized } });
    const sent = harness.findInPage.mock.lastCall?.[0];
    expect(sent?.text).toHaveLength(BB_DESKTOP_BROWSER_MAX_FIND_TEXT_LENGTH);
    expect(findInput().value).toHaveLength(
      BB_DESKTOP_BROWSER_MAX_FIND_TEXT_LENGTH,
    );
  });

  it("drops a stale match count when the page navigates", () => {
    const harness = createFindHarness();
    renderBrowser(harness, "https://example.com/docs");
    act(() => harness.emitState(browserState()));
    pressFindChord(screen.getByLabelText(/Address and search bar/));
    fireEvent.change(findInput(), { target: { value: "needle" } });
    act(() => harness.emitFindResult(findResult()));
    expect(screen.getByTestId("browser-find-match-count").textContent).toBe(
      "1/5",
    );

    act(() =>
      harness.emitState(browserState({ url: "https://example.com/other" })),
    );
    expect(screen.queryByTestId("browser-find-match-count")).toBeNull();
  });
});
