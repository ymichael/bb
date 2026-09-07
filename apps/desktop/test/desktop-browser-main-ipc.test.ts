import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BB_DESKTOP_BROWSER_MAX_URL_LENGTH,
  type BbDesktopBrowserAttachRequest,
  type BbDesktopBrowserFindInPageRequest,
  type BbDesktopBrowserNavigateRequest,
  type BbDesktopBrowserSetBoundsRequest,
  type BbDesktopBrowserSetVisibleRequest,
  type BbDesktopBrowserStopFindInPageRequest,
} from "@bb/desktop-contract";
import {
  BB_DESKTOP_BROWSER_ATTACH_CHANNEL,
  BB_DESKTOP_BROWSER_DETACH_CHANNEL,
  BB_DESKTOP_BROWSER_FOCUS_CHANNEL,
  BB_DESKTOP_BROWSER_FIND_IN_PAGE_CHANNEL,
  BB_DESKTOP_BROWSER_GO_BACK_CHANNEL,
  BB_DESKTOP_BROWSER_GO_FORWARD_CHANNEL,
  BB_DESKTOP_BROWSER_NAVIGATE_CHANNEL,
  BB_DESKTOP_BROWSER_RELOAD_CHANNEL,
  BB_DESKTOP_BROWSER_SET_BOUNDS_CHANNEL,
  BB_DESKTOP_BROWSER_SET_VISIBLE_CHANNEL,
  BB_DESKTOP_BROWSER_SET_VISIBLE_WITHOUT_FOCUS_CHANNEL,
  BB_DESKTOP_BROWSER_STOP_CHANNEL,
  BB_DESKTOP_BROWSER_STOP_FIND_IN_PAGE_CHANNEL,
} from "../src/desktop-browser-ipc.js";
import { registerDesktopBrowserIpc } from "../src/desktop-browser-main-ipc.js";
import type { DesktopBrowserViewManager } from "../src/desktop-browser-view.js";

const electronMock = vi.hoisted(() => {
  interface FakeWebContents {
    id: number;
  }

  interface FakeBrowserWindow {
    label: string;
  }

  interface FakeIpcEvent {
    sender: FakeWebContents;
  }

  type FakeIpcListener = (event: FakeIpcEvent, payload: unknown) => void;

  const listeners = new Map<string, FakeIpcListener>();
  const windowsBySender = new Map<FakeWebContents, FakeBrowserWindow>();

  return {
    listeners,
    windowsBySender,
    BrowserWindow: {
      fromWebContents(sender: FakeWebContents): FakeBrowserWindow | null {
        return windowsBySender.get(sender) ?? null;
      },
    },
    ipcMain: {
      on(channel: string, listener: FakeIpcListener): void {
        listeners.set(channel, listener);
      },
    },
  };
});

vi.mock("electron", () => ({
  BrowserWindow: electronMock.BrowserWindow,
  ipcMain: electronMock.ipcMain,
}));

type AttachCall = Parameters<DesktopBrowserViewManager["attach"]>[0];
type DetachCall = Parameters<DesktopBrowserViewManager["detach"]>[0];
type FindInPageCall = Parameters<DesktopBrowserViewManager["findInPage"]>[0];
type StopFindInPageCall = Parameters<
  DesktopBrowserViewManager["stopFindInPage"]
>[0];
type NavigateCall = Parameters<DesktopBrowserViewManager["navigate"]>[0];
type SetBoundsCall = Parameters<DesktopBrowserViewManager["setBounds"]>[0];
type SetVisibleCall = Parameters<DesktopBrowserViewManager["setVisible"]>[0];
type TabCommandCall = Parameters<DesktopBrowserViewManager["reload"]>[0];
type WindowResizeCall = Parameters<
  DesktopBrowserViewManager["beginWindowResize"]
>[0];

interface FakeWebContents {
  id: number;
}

interface FakeBrowserWindow {
  label: string;
}

interface FakeRenderer {
  hostWindow: FakeBrowserWindow;
  sender: FakeWebContents;
}

interface SendBrowserIpcArgs {
  channel: string;
  payload: unknown;
  sender: FakeWebContents;
}

class RecordingDesktopBrowserViewManager implements DesktopBrowserViewManager {
  createTab(): never {
    throw new Error("Not used by renderer IPC");
  }

  listTabs(): [] {
    return [];
  }

  closeTab(): void {}

  async captureTab(): Promise<never> {
    throw new Error("Not used by renderer IPC");
  }

  getAutomationTabs(): ReturnType<
    DesktopBrowserViewManager["getAutomationTabs"]
  > {
    return [];
  }

  subscribeAutomationTabs(): () => void {
    return () => undefined;
  }

  public readonly attachCalls: AttachCall[] = [];
  public readonly beginWindowResizeCalls: WindowResizeCall[] = [];
  public readonly destroyAllCalls: string[] = [];
  public readonly detachCalls: DetachCall[] = [];
  public readonly endWindowResizeCalls: WindowResizeCall[] = [];
  public readonly focusCalls: TabCommandCall[] = [];
  public readonly findInPageCalls: FindInPageCall[] = [];
  public readonly stopFindInPageCalls: StopFindInPageCall[] = [];
  public readonly goBackCalls: TabCommandCall[] = [];
  public readonly goForwardCalls: TabCommandCall[] = [];
  public readonly navigateCalls: NavigateCall[] = [];
  public readonly releaseWindowCalls: number[] = [];
  public readonly reloadCalls: TabCommandCall[] = [];
  public readonly setBoundsCalls: SetBoundsCall[] = [];
  public readonly setVisibleCalls: SetVisibleCall[] = [];
  public readonly setVisibleWithoutFocusCalls: SetVisibleCall[] = [];
  public readonly stopCalls: TabCommandCall[] = [];

  attach(args: AttachCall): void {
    this.attachCalls.push(args);
  }

  beginWindowResize(hostWindow: WindowResizeCall): void {
    this.beginWindowResizeCalls.push(hostWindow);
  }

  prepareWindowReload(): void {}

  destroyAll(): void {
    this.destroyAllCalls.push("destroyAll");
  }

  detach(args: DetachCall): void {
    this.detachCalls.push(args);
  }

  endWindowResize(hostWindow: WindowResizeCall): void {
    this.endWindowResizeCalls.push(hostWindow);
  }

  focus(args: TabCommandCall): void {
    this.focusCalls.push(args);
  }

  findInPage(args: FindInPageCall): void {
    this.findInPageCalls.push(args);
  }

  stopFindInPage(args: StopFindInPageCall): void {
    this.stopFindInPageCalls.push(args);
  }

  goBack(args: TabCommandCall): void {
    this.goBackCalls.push(args);
  }

  goForward(args: TabCommandCall): void {
    this.goForwardCalls.push(args);
  }

  navigate(args: NavigateCall): void {
    this.navigateCalls.push(args);
  }

  releaseWindow(hostWebContentsId: number): void {
    this.releaseWindowCalls.push(hostWebContentsId);
  }

  reload(args: TabCommandCall): void {
    this.reloadCalls.push(args);
  }

  setBounds(args: SetBoundsCall): void {
    this.setBoundsCalls.push(args);
  }

  setVisible(args: SetVisibleCall): void {
    this.setVisibleCalls.push(args);
  }

  setVisibleWithoutFocus(args: SetVisibleCall): void {
    this.setVisibleWithoutFocusCalls.push(args);
  }

  stop(args: TabCommandCall): void {
    this.stopCalls.push(args);
  }
}

let nextWebContentsId = 1;

beforeEach(() => {
  electronMock.listeners.clear();
  electronMock.windowsBySender.clear();
  nextWebContentsId = 1;
});

function createTrustedRenderer(label: string): FakeRenderer {
  const sender = { id: nextWebContentsId };
  nextWebContentsId += 1;
  const hostWindow = { label };
  electronMock.windowsBySender.set(sender, hostWindow);
  return { hostWindow, sender };
}

function createUntrustedSender(): FakeWebContents {
  const sender = { id: nextWebContentsId };
  nextWebContentsId += 1;
  return sender;
}

function sendBrowserIpc(args: SendBrowserIpcArgs): void {
  const listener = electronMock.listeners.get(args.channel);
  expect(listener).toBeDefined();
  if (listener === undefined) {
    throw new Error(`Expected listener for ${args.channel}.`);
  }
  listener({ sender: args.sender }, args.payload);
}

function oversizedBrowserUrl(): string {
  return `https://example.com/${"a".repeat(BB_DESKTOP_BROWSER_MAX_URL_LENGTH)}`;
}

describe("registerDesktopBrowserIpc", () => {
  it("dispatches valid browser commands only from BrowserWindow-owned senders", () => {
    const manager = new RecordingDesktopBrowserViewManager();
    registerDesktopBrowserIpc(manager);
    const renderer = createTrustedRenderer("main-window");
    const untrustedSender = createUntrustedSender();
    const attachRequest: BbDesktopBrowserAttachRequest = {
      threadId: "thread-1",
      tabId: "browser:a",
      url: "http://localhost:5173/",
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      visible: true,
    };
    const navigateRequest: BbDesktopBrowserNavigateRequest = {
      tabId: "browser:a",
      url: "https://example.com/",
    };

    sendBrowserIpc({
      channel: BB_DESKTOP_BROWSER_ATTACH_CHANNEL,
      payload: attachRequest,
      sender: renderer.sender,
    });
    sendBrowserIpc({
      channel: BB_DESKTOP_BROWSER_ATTACH_CHANNEL,
      payload: attachRequest,
      sender: untrustedSender,
    });
    sendBrowserIpc({
      channel: BB_DESKTOP_BROWSER_NAVIGATE_CHANNEL,
      payload: navigateRequest,
      sender: renderer.sender,
    });
    sendBrowserIpc({
      channel: BB_DESKTOP_BROWSER_RELOAD_CHANNEL,
      payload: { tabId: "browser:a" },
      sender: renderer.sender,
    });
    sendBrowserIpc({
      channel: BB_DESKTOP_BROWSER_FOCUS_CHANNEL,
      payload: { tabId: "browser:a" },
      sender: renderer.sender,
    });

    expect(manager.attachCalls).toHaveLength(1);
    expect(manager.attachCalls[0]?.hostWindow).toBe(renderer.hostWindow);
    expect(manager.attachCalls[0]?.request).toEqual(attachRequest);
    expect(manager.navigateCalls).toHaveLength(1);
    expect(manager.navigateCalls[0]?.hostWindow).toBe(renderer.hostWindow);
    expect(manager.navigateCalls[0]?.request).toEqual(navigateRequest);
    expect(manager.reloadCalls).toEqual([
      { hostWindow: renderer.hostWindow, tabId: "browser:a" },
    ]);
    expect(manager.focusCalls).toEqual([
      { hostWindow: renderer.hostWindow, tabId: "browser:a" },
    ]);
  });

  it("dispatches validated find-in-page requests and rejects malformed ones", () => {
    const manager = new RecordingDesktopBrowserViewManager();
    registerDesktopBrowserIpc(manager);
    const renderer = createTrustedRenderer("main-window");
    const untrustedSender = createUntrustedSender();
    const findRequest: BbDesktopBrowserFindInPageRequest = {
      tabId: "browser:a",
      text: "WebContents",
      forward: true,
      newSession: true,
    };
    const stopRequest: BbDesktopBrowserStopFindInPageRequest = {
      tabId: "browser:a",
      action: "clearSelection",
    };

    for (const payload of [
      { ...findRequest, text: "" },
      { ...findRequest, text: "a".repeat(1025) },
      { ...findRequest, forward: "yes" },
      { ...findRequest, extra: true },
      { tabId: "browser:a", text: "x" },
    ]) {
      sendBrowserIpc({
        channel: BB_DESKTOP_BROWSER_FIND_IN_PAGE_CHANNEL,
        payload,
        sender: renderer.sender,
      });
    }
    sendBrowserIpc({
      channel: BB_DESKTOP_BROWSER_FIND_IN_PAGE_CHANNEL,
      payload: findRequest,
      sender: untrustedSender,
    });
    sendBrowserIpc({
      channel: BB_DESKTOP_BROWSER_FIND_IN_PAGE_CHANNEL,
      payload: findRequest,
      sender: renderer.sender,
    });
    sendBrowserIpc({
      channel: BB_DESKTOP_BROWSER_STOP_FIND_IN_PAGE_CHANNEL,
      payload: { tabId: "browser:a", action: "explode" },
      sender: renderer.sender,
    });
    sendBrowserIpc({
      channel: BB_DESKTOP_BROWSER_STOP_FIND_IN_PAGE_CHANNEL,
      payload: stopRequest,
      sender: renderer.sender,
    });

    expect(manager.findInPageCalls).toEqual([
      { hostWindow: renderer.hostWindow, request: findRequest },
    ]);
    expect(manager.stopFindInPageCalls).toEqual([
      { hostWindow: renderer.hostWindow, request: stopRequest },
    ]);
  });

  it("rejects malformed attach and navigate payloads before manager dispatch", () => {
    const manager = new RecordingDesktopBrowserViewManager();
    registerDesktopBrowserIpc(manager);
    const renderer = createTrustedRenderer("main-window");
    const validAttachRequest: BbDesktopBrowserAttachRequest = {
      threadId: "thread-1",
      tabId: "browser:a",
      url: "",
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      visible: false,
    };

    for (const payload of [
      { ...validAttachRequest, extra: true },
      { ...validAttachRequest, tabId: "" },
      { ...validAttachRequest, url: oversizedBrowserUrl() },
      { ...validAttachRequest, bounds: { x: 0, y: 0, width: -1, height: 600 } },
    ]) {
      sendBrowserIpc({
        channel: BB_DESKTOP_BROWSER_ATTACH_CHANNEL,
        payload,
        sender: renderer.sender,
      });
    }

    for (const payload of [
      { tabId: "browser:a", url: "" },
      { tabId: "browser:a", url: oversizedBrowserUrl() },
      { tabId: "browser:a", url: "https://example.com/", extra: true },
    ]) {
      sendBrowserIpc({
        channel: BB_DESKTOP_BROWSER_NAVIGATE_CHANNEL,
        payload,
        sender: renderer.sender,
      });
    }

    expect(manager.attachCalls).toEqual([]);
    expect(manager.navigateCalls).toEqual([]);
  });

  it("rejects malformed bounds, visibility, and tab-command payloads", () => {
    const manager = new RecordingDesktopBrowserViewManager();
    registerDesktopBrowserIpc(manager);
    const renderer = createTrustedRenderer("main-window");
    const boundsRequest: BbDesktopBrowserSetBoundsRequest = {
      tabId: "browser:a",
      bounds: { x: 0, y: 0, width: 800, height: 600 },
    };
    const visibleRequest: BbDesktopBrowserSetVisibleRequest = {
      tabId: "browser:a",
      visible: true,
    };

    sendBrowserIpc({
      channel: BB_DESKTOP_BROWSER_SET_BOUNDS_CHANNEL,
      payload: {
        ...boundsRequest,
        bounds: { x: 0.5, y: 0, width: 1, height: 1 },
      },
      sender: renderer.sender,
    });
    sendBrowserIpc({
      channel: BB_DESKTOP_BROWSER_SET_BOUNDS_CHANNEL,
      payload: boundsRequest,
      sender: renderer.sender,
    });
    sendBrowserIpc({
      channel: BB_DESKTOP_BROWSER_SET_VISIBLE_CHANNEL,
      payload: { tabId: "browser:a", visible: "yes" },
      sender: renderer.sender,
    });
    sendBrowserIpc({
      channel: BB_DESKTOP_BROWSER_SET_VISIBLE_WITHOUT_FOCUS_CHANNEL,
      payload: visibleRequest,
      sender: renderer.sender,
    });
    sendBrowserIpc({
      channel: BB_DESKTOP_BROWSER_SET_VISIBLE_CHANNEL,
      payload: visibleRequest,
      sender: renderer.sender,
    });

    for (const channel of [
      BB_DESKTOP_BROWSER_DETACH_CHANNEL,
      BB_DESKTOP_BROWSER_FOCUS_CHANNEL,
      BB_DESKTOP_BROWSER_GO_BACK_CHANNEL,
      BB_DESKTOP_BROWSER_GO_FORWARD_CHANNEL,
      BB_DESKTOP_BROWSER_RELOAD_CHANNEL,
      BB_DESKTOP_BROWSER_STOP_CHANNEL,
    ]) {
      sendBrowserIpc({
        channel,
        payload: { tabId: "", extra: true },
        sender: renderer.sender,
      });
    }

    sendBrowserIpc({
      channel: BB_DESKTOP_BROWSER_DETACH_CHANNEL,
      payload: { tabId: "browser:a" },
      sender: renderer.sender,
    });
    sendBrowserIpc({
      channel: BB_DESKTOP_BROWSER_GO_BACK_CHANNEL,
      payload: { tabId: "browser:a" },
      sender: renderer.sender,
    });
    sendBrowserIpc({
      channel: BB_DESKTOP_BROWSER_GO_FORWARD_CHANNEL,
      payload: { tabId: "browser:a" },
      sender: renderer.sender,
    });
    sendBrowserIpc({
      channel: BB_DESKTOP_BROWSER_STOP_CHANNEL,
      payload: { tabId: "browser:a" },
      sender: renderer.sender,
    });

    expect(manager.setBoundsCalls).toEqual([
      { hostWindow: renderer.hostWindow, request: boundsRequest },
    ]);
    expect(manager.setVisibleCalls).toEqual([
      { hostWindow: renderer.hostWindow, request: visibleRequest },
    ]);
    expect(manager.setVisibleWithoutFocusCalls).toEqual([
      { hostWindow: renderer.hostWindow, request: visibleRequest },
    ]);
    expect(manager.detachCalls).toEqual([
      { hostWindow: renderer.hostWindow, tabId: "browser:a" },
    ]);
    expect(manager.goBackCalls).toEqual([
      { hostWindow: renderer.hostWindow, tabId: "browser:a" },
    ]);
    expect(manager.goForwardCalls).toEqual([
      { hostWindow: renderer.hostWindow, tabId: "browser:a" },
    ]);
    expect(manager.stopCalls).toEqual([
      { hostWindow: renderer.hostWindow, tabId: "browser:a" },
    ]);
  });
});
