// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type {
  BbDesktopBrowserApi,
  BbDesktopBrowserState,
} from "@bb/desktop-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBbDesktopApi,
  createNoopDesktopBrowserApi,
} from "@/test/bb-desktop-test-utils";
import { BrowserTabContent } from "./BrowserTabContent";

const desktopInfo = {
  lastCheckedAt: null,
  latestVersion: null,
  pendingVersion: null,
  platform: "macos" as const,
  updateAvailable: false,
  updateDownloaded: false,
  version: "0.0.0-test",
};

interface BrowserChromeHarness {
  api: BbDesktopBrowserApi;
  emitState: (state: BbDesktopBrowserState) => void;
  emitNativeFocus: (tabId: string) => void;
  focus: ReturnType<typeof vi.fn>;
  goBack: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

function createBrowserChromeHarness(): BrowserChromeHarness {
  const stateListeners = new Set<(state: BbDesktopBrowserState) => void>();
  const focusListeners = new Set<(tabId: string) => void>();
  const focus = vi.fn();
  const goBack = vi.fn();
  const stop = vi.fn();
  const api: BbDesktopBrowserApi = {
    ...createNoopDesktopBrowserApi(),
    goBack,
    focus,
    stop,
    onState(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    onFocus(listener) {
      focusListeners.add(listener);
      return () => focusListeners.delete(listener);
    },
  };
  return {
    api,
    emitState(state) {
      for (const listener of stateListeners) listener(state);
    },
    emitNativeFocus(tabId) {
      for (const listener of focusListeners) listener(tabId);
    },
    focus,
    goBack,
    stop,
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

function renderBrowserChrome(
  harness: BrowserChromeHarness,
  initialUrl = "",
  options: {
    canHandleBrowserCommands?: boolean;
    canShowNativeBrowserView?: boolean;
    onNativeFocus?: () => void;
  } = {},
) {
  window.bbDesktop = createBbDesktopApi(desktopInfo, harness.api);
  return render(
    <>
      <BrowserTabContent
        tabId="browser:test"
        initialUrl={initialUrl}
        addressFocusRequest={null}
        canHandleBrowserCommands={options.canHandleBrowserCommands}
        canShowNativeBrowserView={options.canShowNativeBrowserView ?? false}
        onNativeFocus={options.onNativeFocus}
        visibilityCoordinator={null}
        environmentId={null}
        threadId="thread-1"
        onUpdate={() => {}}
      />
      <button type="button">Outside browser</button>
    </>,
  );
}

function expectChromeVisible(): HTMLElement {
  const chrome = screen.getByTestId("browser-tab-nav-bar");
  expect(chrome.dataset.state).toBe("expanded");
  return chrome;
}

describe("BrowserTabContent persistent navigation", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    window.localStorage.clear();
    delete window.bbDesktop;
  });

  it("keeps the top navigation visible through pointer and focus changes", () => {
    const harness = createBrowserChromeHarness();
    renderBrowserChrome(harness, "https://example.com/docs");
    const chrome = expectChromeVisible();

    fireEvent.pointerLeave(chrome);
    act(() => screen.getByRole("button", { name: "Outside browser" }).focus());
    expectChromeVisible();
    expect(screen.getByLabelText("Address and search bar")).not.toBeNull();
  });

  it("keeps navigation visible while loading and preserves the stop action", () => {
    const harness = createBrowserChromeHarness();
    renderBrowserChrome(harness, "https://example.com/docs");

    act(() => harness.emitState(browserState({ isLoading: true })));
    expectChromeVisible();

    const stopButton = screen.getByRole("button", { name: "Stop loading" });
    fireEvent.click(stopButton);
    expect(harness.stop).toHaveBeenCalledWith("browser:test");
  });

  it("preserves browser navigation actions", () => {
    const harness = createBrowserChromeHarness();
    renderBrowserChrome(harness, "https://example.com/docs");
    expectChromeVisible();

    act(() => harness.emitState(browserState({ canGoBack: true })));
    fireEvent.click(screen.getByRole("button", { name: "Go back" }));
    expect(harness.goBack).toHaveBeenCalledWith("browser:test");
  });

  it.each(["Stop", "Take over"])(
    "releases native control with %s",
    async (action) => {
      const harness = createBrowserChromeHarness();
      const releaseControl = vi.fn();
      harness.api.releaseControl = releaseControl;
      harness.api.getControl = async () => ({
        tabId: "browser:test",
        threadId: "thread-1",
        control: {
          leaseId: "lease-1",
          controllerLabel: "Browser agent",
          expiresAt: Date.now() + 60_000,
        },
      });
      renderBrowserChrome(harness, "https://example.com/docs");
      const button = await screen.findByRole("button", {
        name: action,
      });
      harness.focus.mockClear();
      fireEvent.click(button);
      expect(releaseControl).toHaveBeenCalledWith("browser:test");
      if (action === "Take over")
        expect(harness.focus).toHaveBeenCalledWith("browser:test");
      else expect(harness.focus).not.toHaveBeenCalled();
    },
  );

  it("restores native focus to the logical pane and reports page focus", async () => {
    const harness = createBrowserChromeHarness();
    const onNativeFocus = vi.fn();
    renderBrowserChrome(harness, "https://example.com/docs", {
      canHandleBrowserCommands: true,
      canShowNativeBrowserView: true,
      onNativeFocus,
    });

    await waitFor(() =>
      expect(harness.focus).toHaveBeenCalledWith("browser:test"),
    );
    act(() => harness.emitNativeFocus("browser:other"));
    expect(onNativeFocus).not.toHaveBeenCalled();
    act(() => harness.emitNativeFocus("browser:test"));
    expect(onNativeFocus).toHaveBeenCalledTimes(1);
  });
});
