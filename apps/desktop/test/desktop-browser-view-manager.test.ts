import type { RenderProcessGoneDetails, WebContentsView } from "electron";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import {
  DESKTOP_BROWSER_BROKER_DESCRIPTOR_FILE,
  desktopBrowserRegistrationSchema,
  desktopBrowserChangedSchema,
} from "@bb/host-daemon-contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BbDesktopBrowserViewBounds } from "@bb/desktop-contract";
import { createDesktopBrowserCdpAdapter } from "../src/desktop-browser-cdp-adapter.js";
import { createDesktopBrowserBroker } from "../src/desktop-browser-broker.js";
import { createDesktopBrowserBrokerClient } from "../src/desktop-browser-broker-client.js";
import { captureDesktopBrowserPage } from "../src/desktop-browser-capture.js";
import type { DesktopBrowserCdpPage } from "../src/desktop-browser-cdp.js";
import {
  createDesktopBrowserViewManager as createProductionDesktopBrowserViewManager,
  isAllowedBrowserPermission,
  type CreateDesktopBrowserViewManagerArgs,
  type DesktopBrowserViewManager,
  type DesktopBrowserHostContentBounds,
  type DesktopBrowserHostContentView,
  type DesktopBrowserHostWebContents,
  type DesktopBrowserHostWebContentsPayload,
  type DesktopBrowserHostWindow,
} from "../src/desktop-browser-view.js";

function createDesktopBrowserViewManager(
  args: Partial<CreateDesktopBrowserViewManagerArgs> = {},
): DesktopBrowserViewManager {
  return createProductionDesktopBrowserViewManager({
    dispatchAppCommand: () => undefined,
    focusHostWebContents: () => undefined,
    resolveAppCommand: () => null,
    ...args,
  });
}

interface FakePreventableEvent {
  defaultPrevented: boolean;
  preventDefault(): void;
}

interface FakeWebContentsEvent {}

interface FakeNavigationEvent extends FakePreventableEvent {
  initiator?: FakeWebFrameMain | null;
  isMainFrame: boolean;
  url: string;
}

type FakeVoidWebContentsListener = () => void;

type FakeWillFrameNavigateListener = (event: FakeNavigationEvent) => void;

type FakeWillRedirectListener = (
  event: FakeNavigationEvent,
  url: string,
  isInPlace: boolean,
  isMainFrame: boolean,
) => void;

type FakeDidNavigateListener = (
  event: FakeWebContentsEvent,
  url: string,
) => void;

type FakeDidNavigateInPageListener = (
  event: FakeWebContentsEvent,
  url: string,
  isMainFrame: boolean,
) => void;

type FakePageTitleUpdatedListener = (
  event: FakePreventableEvent,
  title: string,
) => void;

type FakeDidFailLoadListener = (
  event: FakeWebContentsEvent,
  errorCode: number,
  errorDescription: string,
  validatedURL: string,
  isMainFrame: boolean,
) => void;

interface FakeContextMenuParams {
  editFlags: {
    canCopy: boolean;
    canCut: boolean;
    canPaste: boolean;
    canRedo: boolean;
    canSelectAll: boolean;
    canUndo: boolean;
  };
}

type FakeContextMenuListener = (
  event: FakeWebContentsEvent,
  params: FakeContextMenuParams,
) => void;

interface FakeInput {
  alt: boolean;
  control: boolean;
  isAutoRepeat: boolean;
  isComposing: boolean;
  key: string;
  meta: boolean;
  shift: boolean;
  type: string;
}

type FakeBeforeInputListener = (
  event: FakePreventableEvent,
  input: FakeInput,
) => void;

type FakeRenderProcessGoneDetails = Pick<
  RenderProcessGoneDetails,
  "exitCode" | "reason"
>;

type FakeRenderProcessGoneListener = (
  event: FakeWebContentsEvent,
  details: FakeRenderProcessGoneDetails,
) => void;

interface FakeFoundInPageResult {
  activeMatchOrdinal: number;
  finalUpdate: boolean;
  matches: number;
  requestId: number;
  selectionArea: { height: number; width: number; x: number; y: number };
}

type FakeFoundInPageListener = (
  event: FakeWebContentsEvent,
  result: FakeFoundInPageResult,
) => void;

interface FakeFindInPageCall {
  options: { findNext: boolean; forward: boolean };
  text: string;
}

interface FakeWebContentsEventMap {
  destroyed: FakeVoidWebContentsListener;
  focus: FakeVoidWebContentsListener;
  "before-input-event": FakeBeforeInputListener;
  "will-frame-navigate": FakeWillFrameNavigateListener;
  "will-redirect": FakeWillRedirectListener;
  "did-start-loading": FakeVoidWebContentsListener;
  "did-stop-loading": FakeVoidWebContentsListener;
  "did-finish-load": FakeVoidWebContentsListener;
  "did-navigate": FakeDidNavigateListener;
  "did-navigate-in-page": FakeDidNavigateInPageListener;
  "did-start-navigation": FakeVoidWebContentsListener;
  "page-title-updated": FakePageTitleUpdatedListener;
  "did-fail-load": FakeDidFailLoadListener;
  "context-menu": FakeContextMenuListener;
  "render-process-gone": FakeRenderProcessGoneListener;
  "found-in-page": FakeFoundInPageListener;
}

interface FakeDebuggerEventMap {
  detach: () => void;
  message: (
    event: FakeWebContentsEvent,
    method: string,
    params: unknown,
    sessionId: string,
  ) => void;
}

interface FakeWebFrameMain {
  origin: string;
}

interface FakeSessionEvent {
  preventDefault(): void;
}

type FakeSessionListener = (event: FakeSessionEvent) => void;

type FakePermissionRequestHandler = (
  webContents: unknown,
  permission: string,
  callback: (granted: boolean) => void,
) => void;

type FakePermissionCheckHandler = (
  webContents: unknown,
  permission: string,
) => boolean;

interface FakeWindowOpenDetails {
  disposition: "foreground-tab" | "new-window";
  features: string;
  frameName: string;
  url: string;
}

interface FakeBrowserWindowOptions {
  alwaysOnTop?: boolean;
  center?: boolean;
  frame?: boolean;
  height?: number;
  show?: boolean;
  title?: string;
  transparent?: boolean;
  width?: number;
  webContents?: FakePopupWebContents;
  x?: number;
  y?: number;
  webPreferences?: {
    allowRunningInsecureContent?: boolean;
    contextIsolation?: boolean;
    nodeIntegration?: boolean;
    partition?: string;
    sandbox?: boolean;
    webSecurity?: boolean;
  };
}

interface FakePopupWebContents {
  emitWindowOpen(
    url: string,
    details?: Partial<Omit<FakeWindowOpenDetails, "url">>,
  ): FakeWindowOpenDecision;
}

interface FakeWindowOpenDecision {
  action: "allow" | "deny";
  createWindow?: (options: FakeBrowserWindowOptions) => FakePopupWebContents;
}

type FakeWindowOpenHandler = (
  details: FakeWindowOpenDetails,
) => FakeWindowOpenDecision;

const electronMock = vi.hoisted(() => {
  interface FakeNativeImage {
    isEmpty(): boolean;
    toJPEG(quality: number): Buffer;
    getSize(): { width: number; height: number };
    resize(size: { width: number; height: number }): FakeNativeImage;
  }

  interface FakeDidFailLoadArgs {
    errorCode: number;
    errorDescription: string;
    isMainFrame: boolean;
    validatedURL: string;
  }

  type FakeWebContentsListeners = {
    [TEventName in keyof FakeWebContentsEventMap]: Array<
      FakeWebContentsEventMap[TEventName]
    >;
  };

  class FakePreventableEventImpl implements FakePreventableEvent {
    public defaultPrevented = false;

    preventDefault(): void {
      this.defaultPrevented = true;
    }
  }

  class FakeNavigationEventImpl
    extends FakePreventableEventImpl
    implements FakeNavigationEvent
  {
    public readonly initiator?: FakeWebFrameMain | null;
    public readonly isMainFrame: boolean;
    public readonly url: string;

    constructor(args: {
      initiatorOrigin?: string | null;
      isMainFrame: boolean;
      url: string;
    }) {
      super();
      this.initiator =
        args.initiatorOrigin === undefined
          ? undefined
          : args.initiatorOrigin === null
            ? null
            : { origin: args.initiatorOrigin };
      this.isMainFrame = args.isMainFrame;
      this.url = args.url;
    }
  }

  const fakeWebContentsEvent: FakeWebContentsEvent = {};

  const fakeCapturedImage: FakeNativeImage = {
    isEmpty: () => false,
    toJPEG: () => Buffer.from("jpeg-bytes"),
    getSize: () => ({ width: 1280, height: 720 }),
    resize: (size) => ({ ...fakeCapturedImage, getSize: () => size }),
  };

  class FakeDebugger {
    private attached = false;
    private readonly listeners: {
      [TEventName in keyof FakeDebuggerEventMap]: Array<
        FakeDebuggerEventMap[TEventName]
      >;
    } = { detach: [], message: [] };
    public readonly attachCalls: string[] = [];
    public detachCalls = 0;
    public sendCommand = vi
      .fn<
        (
          method: string,
          params: Parameters<DesktopBrowserCdpPage["send"]>[1],
          sessionId?: string,
        ) => Promise<unknown>
      >()
      .mockResolvedValue({});

    isAttached(): boolean {
      return this.attached;
    }

    attach(protocolVersion: string): void {
      this.attachCalls.push(protocolVersion);
      this.attached = true;
    }

    detach(): void {
      this.detachCalls += 1;
      this.attached = false;
      for (const listener of [...this.listeners.detach]) listener();
    }

    on<TEventName extends keyof FakeDebuggerEventMap>(
      event: TEventName,
      listener: FakeDebuggerEventMap[TEventName],
    ): void {
      this.listeners[event].push(listener);
    }

    off<TEventName extends keyof FakeDebuggerEventMap>(
      event: TEventName,
      listener: FakeDebuggerEventMap[TEventName],
    ): void {
      const index = this.listeners[event].indexOf(listener);
      if (index !== -1) this.listeners[event].splice(index, 1);
    }

    emitMessage(method: string, params: unknown, sessionId: string): void {
      for (const listener of [...this.listeners.message]) {
        listener(fakeWebContentsEvent, method, params, sessionId);
      }
    }
  }

  class FakeWebContents {
    public readonly debugger = new FakeDebugger();
    private backgroundThrottling = true;
    getBackgroundThrottling(): boolean {
      return this.backgroundThrottling;
    }
    setBackgroundThrottling(value: boolean): void {
      this.backgroundThrottling = value;
    }
    public activeHistoryIndex = 0;
    public canGoBackResult = false;
    public canGoForwardResult = false;
    public destroyed = false;
    public focusCalls = 0;
    public readonly goBackCalls: string[] = [];
    public readonly goForwardCalls: string[] = [];
    public historyEntries: Array<{ title: string; url: string }> = [];
    public readonly id: number;
    public readonly loadURLCalls: string[] = [];
    public readonly findInPageCalls: FakeFindInPageCall[] = [];
    public readonly stopFindInPageCalls: string[] = [];
    public reloadCalls = 0;
    public readonly pendingCaptureResolvers: Array<
      (image: FakeNativeImage) => void
    > = [];
    private readonly listeners: FakeWebContentsListeners = {
      destroyed: [],
      focus: [],
      "before-input-event": [],
      "will-frame-navigate": [],
      "will-redirect": [],
      "did-start-loading": [],
      "did-stop-loading": [],
      "did-finish-load": [],
      "did-navigate": [],
      "did-navigate-in-page": [],
      "did-start-navigation": [],
      "page-title-updated": [],
      "did-fail-load": [],
      "context-menu": [],
      "render-process-gone": [],
      "found-in-page": [],
    };
    private title = "";
    private url = "";
    private windowOpenHandler: FakeWindowOpenHandler | null = null;

    constructor(id: number) {
      this.id = id;
    }

    public readonly navigationHistory = {
      canGoBack: (): boolean => this.canGoBackResult,
      canGoForward: (): boolean => this.canGoForwardResult,
      getActiveIndex: (): number => this.activeHistoryIndex,
      getEntryAtIndex: (index: number): { title: string; url: string } | null =>
        this.historyEntries[index] ?? null,
      goBack: (): void => {
        this.goBackCalls.push("goBack");
      },
      goForward: (): void => {
        this.goForwardCalls.push("goForward");
      },
    };

    capturePage(): Promise<FakeNativeImage> {
      return new Promise((resolve) => {
        this.pendingCaptureResolvers.push(resolve);
      });
    }

    close(): void {
      if (this.destroyed) return;
      this.destroyed = true;
      for (const listener of this.listeners.destroyed) listener();
    }

    focus(): void {
      this.focusCalls += 1;
      this.emitFocus();
    }

    findInPage(
      text: string,
      options: { findNext: boolean; forward: boolean },
    ): number {
      this.findInPageCalls.push({ text, options });
      return this.findInPageCalls.length;
    }

    stopFindInPage(action: string): void {
      this.stopFindInPageCalls.push(action);
    }

    emitFoundInPage(result: FakeFoundInPageResult): void {
      for (const listener of this.listeners["found-in-page"]) {
        listener(fakeWebContentsEvent, result);
      }
    }

    getTitle(): string {
      return this.title;
    }

    getURL(): string {
      return this.url;
    }

    isDestroyed(): boolean {
      return this.destroyed;
    }

    isLoadingMainFrame(): boolean {
      return false;
    }

    loadURL(url: string): Promise<void> {
      this.url = url;
      this.loadURLCalls.push(url);
      return Promise.resolve();
    }

    on<TEventName extends keyof FakeWebContentsEventMap>(
      eventName: TEventName,
      listener: FakeWebContentsEventMap[TEventName],
    ): void {
      this.listeners[eventName].push(listener);
    }

    off<TEventName extends keyof FakeWebContentsEventMap>(
      eventName: TEventName,
      listener: FakeWebContentsEventMap[TEventName],
    ): void {
      const index = this.listeners[eventName].indexOf(listener);
      if (index !== -1) this.listeners[eventName].splice(index, 1);
    }

    emitDidStartNavigation(): void {
      for (const listener of this.listeners["did-start-navigation"]) listener();
    }

    reload(): void {
      this.reloadCalls += 1;
    }

    setWindowOpenHandler(handler: FakeWindowOpenHandler): void {
      this.windowOpenHandler = handler;
    }

    stop(): void {}

    emitDidFailLoad(args: FakeDidFailLoadArgs): void {
      for (const listener of this.listeners["did-fail-load"]) {
        listener(
          fakeWebContentsEvent,
          args.errorCode,
          args.errorDescription,
          args.validatedURL,
          args.isMainFrame,
        );
      }
    }

    emitFocus(): void {
      for (const listener of this.listeners.focus) listener();
    }

    emitRenderProcessGone(details: FakeRenderProcessGoneDetails): void {
      for (const listener of this.listeners["render-process-gone"]) {
        listener(fakeWebContentsEvent, details);
      }
    }

    emitDidFinishLoad(): void {
      for (const listener of this.listeners["did-finish-load"]) {
        listener();
      }
    }

    emitBeforeInput(
      input: Partial<FakeInput> & Pick<FakeInput, "key">,
    ): boolean {
      const event = new FakePreventableEventImpl();
      const resolvedInput: FakeInput = {
        alt: false,
        control: false,
        isAutoRepeat: false,
        isComposing: false,
        meta: false,
        shift: false,
        type: "keyDown",
        ...input,
      };
      for (const listener of this.listeners["before-input-event"]) {
        listener(event, resolvedInput);
      }
      return event.defaultPrevented;
    }

    emitDidNavigate(url: string): void {
      this.url = url;
      for (const listener of this.listeners["did-navigate"]) {
        listener(fakeWebContentsEvent, url);
      }
    }

    emitDidNavigateInPage(url: string): void {
      this.url = url;
      for (const listener of this.listeners["did-navigate-in-page"]) {
        listener(fakeWebContentsEvent, url, true);
      }
    }

    emitPageTitleUpdated(title: string): boolean {
      this.title = title;
      const event = new FakePreventableEventImpl();
      for (const listener of this.listeners["page-title-updated"]) {
        listener(event, title);
      }
      return event.defaultPrevented;
    }

    emitWillFrameNavigate(
      url: string,
      isMainFrame: boolean,
      initiatorOrigin?: string | null,
    ): boolean {
      const event = new FakeNavigationEventImpl({
        initiatorOrigin,
        isMainFrame,
        url,
      });
      for (const listener of this.listeners["will-frame-navigate"]) {
        listener(event);
      }
      return event.defaultPrevented;
    }

    emitWillRedirect(
      url: string,
      isMainFrame: boolean,
      initiatorOrigin?: string | null,
    ): boolean {
      const event = new FakeNavigationEventImpl({
        initiatorOrigin,
        isMainFrame,
        url,
      });
      for (const listener of this.listeners["will-redirect"]) {
        listener(event, url, false, isMainFrame);
      }
      return event.defaultPrevented;
    }

    emitWindowOpen(
      url: string,
      details: Partial<Omit<FakeWindowOpenDetails, "url">> = {},
    ): FakeWindowOpenDecision {
      if (this.windowOpenHandler === null) {
        throw new Error("Expected a window open handler to be registered.");
      }
      return this.windowOpenHandler({
        disposition: "foreground-tab",
        features: "",
        frameName: "",
        ...details,
        url,
      });
    }
  }

  let nextWebContentsId = 1;

  class FakeWebContentsView {
    public readonly boundsCalls: BbDesktopBrowserViewBounds[] = [];
    public readonly webContents: FakeWebContents;
    public visible = false;

    constructor(
      public readonly options: { webPreferences: { partition: string } },
    ) {
      this.webContents = new FakeWebContents(nextWebContentsId);
      nextWebContentsId += 1;
    }

    setBounds(bounds: BbDesktopBrowserViewBounds): void {
      this.boundsCalls.push(bounds);
    }

    setVisible(visible: boolean): void {
      this.visible = visible;
    }
  }

  class FakeBrowserWindow {
    public readonly options: FakeBrowserWindowOptions;
    public readonly webContents: FakePopupWebContents;
    public closeCalls = 0;
    public destroyCalls = 0;
    public readonly loadURLCalls: string[] = [];
    public readonly titleCalls: string[] = [];
    private closedListener: (() => void) | null = null;
    private destroyed = false;

    constructor(options: FakeBrowserWindowOptions) {
      this.options = options;
      if (options.webContents === undefined) {
        this.webContents = new FakeWebContents(nextWebContentsId);
        nextWebContentsId += 1;
      } else {
        this.webContents = options.webContents;
      }
    }

    close(): void {
      this.closeCalls += 1;
    }

    destroy(): void {
      this.destroyCalls += 1;
      this.destroyed = true;
      this.closedListener?.();
    }

    isDestroyed(): boolean {
      return this.destroyed;
    }

    loadURL(url: string): Promise<void> {
      this.loadURLCalls.push(url);
      return Promise.resolve();
    }

    once(_eventName: "closed", listener: () => void): void {
      this.closedListener = listener;
    }

    setTitle(title: string): void {
      this.titleCalls.push(title);
    }
  }

  class FakeSession {
    public readonly willDownloadListeners: FakeSessionListener[] = [];
    public permissionCheckHandler: FakePermissionCheckHandler | null = null;
    public permissionRequestHandler: FakePermissionRequestHandler | null = null;
    on(eventName: "will-download", listener: FakeSessionListener): void {
      this.willDownloadListeners.push(listener);
    }

    setPermissionCheckHandler(handler: FakePermissionCheckHandler): void {
      this.permissionCheckHandler = handler;
    }

    setPermissionRequestHandler(handler: FakePermissionRequestHandler): void {
      this.permissionRequestHandler = handler;
    }
  }

  const fakeSessions: FakeSession[] = [];
  const fakeViews: FakeWebContentsView[] = [];
  const fakeWindows: FakeBrowserWindow[] = [];

  return {
    fakeCapturedImage,
    fakeSessions,
    fakeViews,
    fakeWindows,
    createFakeWebContents() {
      const contents = new FakeWebContents(nextWebContentsId);
      nextWebContentsId += 1;
      return contents;
    },
    FakeBrowserWindow: class extends FakeBrowserWindow {
      constructor(options: FakeBrowserWindowOptions) {
        super(options);
        fakeWindows.push(this);
      }
    },
    FakeWebContentsView: class extends FakeWebContentsView {
      constructor(options: { webPreferences: { partition: string } }) {
        super(options);
        fakeViews.push(this);
      }
    },
    session: {
      fromPartition() {
        const fakeSession = new FakeSession();
        fakeSessions.push(fakeSession);
        return fakeSession;
      },
    },
  };
});

vi.mock("electron", () => ({
  BrowserWindow: electronMock.FakeBrowserWindow,
  WebContentsView: electronMock.FakeWebContentsView,
  session: electronMock.session,
  nativeImage: { createFromBuffer: () => electronMock.fakeCapturedImage },
}));

interface FakeHostWindowArgs {
  contentBounds: DesktopBrowserHostContentBounds;
  webContentsId: number;
}

class FakeHostWebContents implements DesktopBrowserHostWebContents {
  public destroyed = false;
  public readonly sentPayloads: DesktopBrowserHostWebContentsPayload[] = [];
  public readonly sentChannels: string[] = [];
  public readonly id: number;

  constructor(id: number) {
    this.id = id;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  send(channel: string, payload: DesktopBrowserHostWebContentsPayload): void {
    this.sentChannels.push(channel);
    this.sentPayloads.push(payload);
  }
}

class FakeContentView implements DesktopBrowserHostContentView {
  public readonly addedViews: WebContentsView[] = [];
  public readonly removedViews: WebContentsView[] = [];

  addChildView(view: WebContentsView): void {
    this.addedViews.push(view);
  }

  removeChildView(view: WebContentsView): void {
    this.removedViews.push(view);
  }
}

class FakeHostWindow implements DesktopBrowserHostWindow {
  public contentBounds: DesktopBrowserHostContentBounds;
  public destroyed = false;
  public readonly contentView = new FakeContentView();
  public readonly webContents: FakeHostWebContents;

  constructor({ contentBounds, webContentsId }: FakeHostWindowArgs) {
    this.contentBounds = contentBounds;
    this.webContents = new FakeHostWebContents(webContentsId);
  }

  getContentBounds(): DesktopBrowserHostContentBounds {
    return this.contentBounds;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }
}

beforeEach(() => {
  vi.useRealTimers();
  electronMock.fakeSessions.length = 0;
  electronMock.fakeViews.length = 0;
  electronMock.fakeWindows.length = 0;
});

async function settlePendingCaptures(
  view: (typeof electronMock.fakeViews)[number],
): Promise<void> {
  for (const resolve of view.webContents.pendingCaptureResolvers.splice(0)) {
    resolve(electronMock.fakeCapturedImage);
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function snapshotPushesOf(
  hostWindow: FakeHostWindow,
): Array<{ tabId: string; dataUrl: string | null }> {
  const pushes: Array<{ tabId: string; dataUrl: string | null }> = [];
  for (const payload of hostWindow.webContents.sentPayloads) {
    if ("dataUrl" in payload) {
      pushes.push(payload);
    }
  }
  return pushes;
}

function findResultPushesOf(
  hostWindow: FakeHostWindow,
): Array<{ tabId: string; requestId: number }> {
  const pushes: Array<{ tabId: string; requestId: number }> = [];
  for (const payload of hostWindow.webContents.sentPayloads) {
    if ("requestId" in payload) {
      pushes.push(payload);
    }
  }
  return pushes;
}

interface AttachBrowserTabArgs {
  hostWindow: FakeHostWindow;
  manager: DesktopBrowserViewManager;
  tabId: string;
  url: string;
}

function attachBrowserTab(args: AttachBrowserTabArgs): void {
  args.manager.attach({
    hostWindow: args.hostWindow,
    request: {
      threadId: "thread-1",
      tabId: args.tabId,
      url: args.url,
      bounds: { x: 100, y: 50, width: 500, height: 350 },
      visible: true,
    },
  });
}

function requireFakeView(
  index: number,
): (typeof electronMock.fakeViews)[number] {
  const view = electronMock.fakeViews[index];
  expect(view).toBeDefined();
  if (view === undefined) {
    throw new Error("Expected the browser view to be created.");
  }
  return view;
}

function createRendererRecoveryFixture(webContentsId: number) {
  const manager = createDesktopBrowserViewManager({
    partition: "persist:test",
  });
  const hostWindow = new FakeHostWindow({
    contentBounds: { width: 700, height: 450 },
    webContentsId,
  });
  attachBrowserTab({
    manager,
    hostWindow,
    tabId: "browser:a",
    url: "https://example.com/original",
  });
  return { manager, hostWindow, view: requireFakeView(0) };
}

function openTabPushesOf(hostWindow: FakeHostWindow): string[] {
  const pushes: string[] = [];
  for (const payload of hostWindow.webContents.sentPayloads) {
    if ("url" in payload && !("tabId" in payload)) {
      pushes.push(payload.url);
    }
  }
  return pushes;
}

function scopedOpenTabPushesOf(
  hostWindow: FakeHostWindow,
): Array<{ tabId: string; url: string }> {
  const pushes: Array<{ tabId: string; url: string }> = [];
  for (const payload of hostWindow.webContents.sentPayloads) {
    if ("url" in payload && "tabId" in payload && !("title" in payload)) {
      pushes.push(payload);
    }
  }
  return pushes;
}

function createCdpAdapterFixture() {
  const fixture = createRendererRecoveryFixture(91);
  const createTab = vi.fn(async () => "browser:a");
  const activateTab = vi.fn(async () => undefined);
  const closeTab = vi.fn(async () => undefined);
  const adapter = createDesktopBrowserCdpAdapter({
    manager: fixture.manager,
    createTab,
    activateTab,
    closeTab,
  });
  const scope = { hostWebContentsId: 91, threadId: "thread-1" };
  const page = adapter.listTabs(scope)[0];
  if (page === undefined) throw new Error("Expected a native CDP page");
  return { ...fixture, adapter, scope, page, createTab, activateTab, closeTab };
}

describe("DesktopBrowserCdpAdapter", () => {
  it.each(["complete", "timeout"])(
    "requests frames only while a native screenshot is pending: %s",
    async (outcome) => {
      vi.useFakeTimers();
      const { page, view } = createCdpAdapterFixture();
      try {
        page.attach();
        await Promise.resolve();
        let complete: (value: { data: string }) => void = () => {
          throw new Error("Screenshot not started");
        };
        const screenshot = new Promise<{ data: string }>((resolve) => {
          complete = resolve;
        });
        view.webContents.debugger.sendCommand.mockReturnValueOnce(screenshot);
        const frames = vi
          .spyOn(view.webContents, "capturePage")
          .mockResolvedValue(electronMock.fakeCapturedImage);
        const params = {
          format: "jpeg",
          quality: 63,
          clip: { x: 2, y: 3, width: 400, height: 200, scale: 0.5 },
          captureBeyondViewport: true,
        };
        const pending = page.send("Page.captureScreenshot", params, "child");
        const assertion =
          outcome === "timeout"
            ? expect(pending).rejects.toThrow(
                "Native browser screenshot timed out",
              )
            : expect(pending).resolves.toEqual({ data: "encoded-image" });
        await vi.advanceTimersByTimeAsync(48);
        expect(frames.mock.calls.length).toBeGreaterThan(1);
        expect(frames).toHaveBeenLastCalledWith(undefined, {
          stayHidden: true,
          stayAwake: true,
        });
        expect(view.webContents.debugger.sendCommand).toHaveBeenLastCalledWith(
          "Page.captureScreenshot",
          params,
          "child",
        );
        if (outcome === "complete") complete({ data: "encoded-image" });
        else await vi.advanceTimersByTimeAsync(5000);
        await assertion;
        const frameCount = frames.mock.calls.length;
        await vi.advanceTimersByTimeAsync(1000);
        expect(frames).toHaveBeenCalledTimes(frameCount);
        expect(view.webContents.focusCalls).toBe(1);
        expect(vi.getTimerCount()).toBe(0);
        complete({ data: "late-image" });
      } finally {
        page.detach();
        vi.useRealTimers();
      }
    },
  );
  it.each(["failure", "cancel", "reattach"])(
    "blocks commands when initialization encounters %s",
    async (mode) => {
      const { page, view } = createCdpAdapterFixture();
      let complete: () => void = () => {
        throw new Error("Expected pending preparation");
      };
      const prepared = new Promise<Record<string, never>>((resolve, reject) => {
        complete = () =>
          mode === "failure"
            ? reject(new Error("Preparation failed"))
            : resolve({});
      });
      const nativeSend = view.webContents.debugger.sendCommand;
      nativeSend.mockReturnValueOnce(prepared);
      page.attach();
      const controller = new AbortController();
      const pending = page.send(
        "Input.dispatchMouseEvent",
        { type: "mousePressed" },
        "child",
        controller.signal,
      );
      const rejected = expect(pending).rejects.toThrow(
        mode === "failure"
          ? /Preparation failed/
          : mode === "cancel"
            ? /abort/i
            : /attachment changed/,
      );
      if (mode === "cancel") controller.abort();
      if (mode === "reattach") {
        page.detach();
        page.attach();
      }
      complete();
      await rejected;
      expect(
        nativeSend.mock.calls.every(
          ([method]) => method === "Emulation.setFocusEmulationEnabled",
        ),
      ).toBe(true);
      if (mode === "cancel") {
        await page.send(
          "Runtime.enable",
          {},
          "other",
          new AbortController().signal,
        );
        expect(nativeSend).toHaveBeenLastCalledWith(
          "Runtime.enable",
          {},
          "other",
        );
      }
      page.detach();
    },
  );

  it("retains live wrappers while hidden and stops exposing removed targets", async () => {
    const { manager, hostWindow, view, adapter, scope, page } =
      createCdpAdapterFixture();
    expect(adapter.listTabs({ ...scope, threadId: "other" })).toEqual([]);
    expect(adapter.listTabs({ ...scope, hostWebContentsId: 910 })).toEqual([]);
    manager.setVisible({
      hostWindow,
      request: { tabId: "browser:a", visible: false },
    });
    view.webContents.emitDidNavigate("https://example.com/next");
    view.webContents.emitPageTitleUpdated("Next");
    expect(adapter.listTabs(scope)[0]).toBe(page);
    expect(page.url).toBe("https://example.com/next");
    expect(page.title).toBe("Next");
    page.attach();
    await Promise.resolve();
    page.attach();
    await Promise.resolve();
    expect(view.webContents.debugger.attachCalls).toEqual(["1.3"]);
    manager.detach({ hostWindow, tabId: "browser:a" });
    expect(adapter.listTabs(scope)).toEqual([]);
    await expect(page.send("Runtime.enable", {})).rejects.toThrow(
      "no longer available",
    );
    expect(
      view.webContents.debugger.sendCommand,
    ).toHaveBeenCalledExactlyOnceWith("Emulation.setFocusEmulationEnabled", {
      enabled: true,
    });
  });

  it("validates debugger JSON and forwards native child session IDs", async () => {
    const { page, view } = createCdpAdapterFixture();
    const nativeDebugger = view.webContents.debugger;
    page.attach();
    await Promise.resolve();
    nativeDebugger.sendCommand.mockResolvedValueOnce({
      result: { value: [1, null, "ok"] },
    });
    await expect(
      page.send("Runtime.evaluate", { expression: "value" }, "child-1"),
    ).resolves.toEqual({
      result: { value: [1, null, "ok"] },
    });
    expect(nativeDebugger.sendCommand).toHaveBeenCalledWith(
      "Runtime.evaluate",
      { expression: "value" },
      "child-1",
    );
    nativeDebugger.sendCommand.mockResolvedValueOnce({
      value: () => undefined,
    });
    await expect(page.send("Runtime.evaluate", {})).rejects.toThrow();
    nativeDebugger.sendCommand.mockResolvedValueOnce([]);
    await expect(page.send("Runtime.evaluate", {})).rejects.toThrow();

    const listener = vi.fn();
    const unsubscribe = page.onMessage(listener);
    nativeDebugger.emitMessage(
      "Runtime.consoleAPICalled",
      { args: [{ value: "ok" }] },
      "child-1",
    );
    nativeDebugger.emitMessage(
      "Runtime.consoleAPICalled",
      { value: () => undefined },
      "child-1",
    );
    nativeDebugger.emitMessage("Runtime.consoleAPICalled", [], "child-1");
    expect(listener).toHaveBeenCalledExactlyOnceWith(
      "Runtime.consoleAPICalled",
      { args: [{ value: "ok" }] },
      "child-1",
    );
    unsubscribe();
    nativeDebugger.emitMessage("Runtime.consoleAPICalled", {}, "");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("rejects another debugger controller and invalidates commands across detach and reattach", async () => {
    const { page, view } = createCdpAdapterFixture();
    const nativeDebugger = view.webContents.debugger;
    nativeDebugger.attach("external");
    expect(() => page.attach()).toThrow("already has a controller");
    page.detach();
    expect(nativeDebugger.isAttached()).toBe(true);
    expect(nativeDebugger.detachCalls).toBe(0);
    nativeDebugger.detach();
    page.attach();
    await Promise.resolve();
    expect(view.webContents.getBackgroundThrottling()).toBe(false);
    const listener = vi.fn();
    const offDetach = page.onDetach(listener);
    let completeResponse: () => void = () => {
      throw new Error("Expected a pending debugger response");
    };
    const response = new Promise<Record<string, never>>((resolve) => {
      completeResponse = () => resolve({});
    });
    nativeDebugger.sendCommand.mockReturnValueOnce(response);
    const pending = page.send("Runtime.enable", {});
    nativeDebugger.detach();
    expect(listener).toHaveBeenCalledTimes(1);
    await expect(page.send("Runtime.enable", {})).rejects.toThrow(
      "not attached",
    );
    page.attach();
    await Promise.resolve();
    completeResponse();
    await expect(pending).rejects.toThrow("attachment changed");
    offDetach();
    page.detach();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(view.webContents.getBackgroundThrottling()).toBe(true);
  });

  function holdCdpCaptures(view: (typeof electronMock.fakeViews)[number]) {
    const captures: Array<() => void> = [];
    view.webContents.debugger.sendCommand.mockImplementation((method) => {
      if (method !== "Page.captureScreenshot") return Promise.resolve({});
      return new Promise((resolve) =>
        captures.push(() => resolve({ data: "png" })),
      );
    });
    return () => {
      const complete = captures.shift();
      if (complete === undefined)
        throw new Error("Expected pending render capture");
      complete();
    };
  }

  it("shares the initial render barrier without reordering pointer commands", async () => {
    const { page, view } = createCdpAdapterFixture();
    const completeCapture = holdCdpCaptures(view);
    page.attach();
    await Promise.resolve();
    const nativeSend = view.webContents.debugger.sendCommand;
    const down = page.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: 20,
      y: 20,
    });
    const up = page.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: 20,
      y: 20,
    });
    expect(nativeSend).toHaveBeenNthCalledWith(
      2,
      "Page.captureScreenshot",
      {
        format: "png",
        captureBeyondViewport: false,
        optimizeForSpeed: true,
      },
      undefined,
    );
    completeCapture();
    await Promise.all([down, up]);
    expect(nativeSend.mock.calls.slice(2).map((call) => call[1])).toEqual([
      { type: "mousePressed", x: 20, y: 20 },
      { type: "mouseReleased", x: 20, y: 20 },
    ]);
    await page.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    expect(
      nativeSend.mock.calls.filter(
        (call) => call[0] === "Page.captureScreenshot",
      ),
    ).toHaveLength(1);
    view.webContents.emitDidStartNavigation();
    const next = page.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: 30,
      y: 30,
    });
    expect(
      nativeSend.mock.calls.filter(
        (call) => call[0] === "Page.captureScreenshot",
      ),
    ).toHaveLength(2);
    completeCapture();
    await next;
    page.detach();
  });

  it.each(["navigation", "reattach"])(
    "rejects buffered input after %s changes the page",
    async (change) => {
      const { page, view } = createCdpAdapterFixture();
      const completeCapture = holdCdpCaptures(view);
      page.attach();
      await Promise.resolve();
      const pending = page.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: 20,
        y: 20,
      });
      const rejected = expect(pending).rejects.toThrow("changed before input");
      if (change === "navigation") view.webContents.emitDidStartNavigation();
      else {
        page.detach();
        page.attach();
        await Promise.resolve();
      }
      completeCapture();
      await rejected;
      expect(
        view.webContents.debugger.sendCommand.mock.calls
          .map((call) => call[0])
          .filter((method) => method !== "Emulation.setFocusEmulationEnabled"),
      ).toEqual(["Page.captureScreenshot"]);
      const next = page.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: 30,
        y: 30,
      });
      completeCapture();
      await next;
      expect(
        view.webContents.debugger.sendCommand.mock.calls
          .map((call) => call[0])
          .filter((method) => method !== "Emulation.setFocusEmulationEnabled"),
      ).toEqual([
        "Page.captureScreenshot",
        "Page.captureScreenshot",
        "Input.dispatchMouseEvent",
      ]);
      page.detach();
    },
  );

  it("retries a failed render capture before dispatching later input", async () => {
    const { page, view } = createCdpAdapterFixture();
    page.attach();
    await Promise.resolve();
    const nativeSend = view.webContents.debugger.sendCommand;
    nativeSend.mockRejectedValueOnce(new Error("Temporary capture failure"));
    await expect(
      page.send("Input.dispatchMouseEvent", { type: "mousePressed" }),
    ).rejects.toThrow("Temporary capture failure");
    nativeSend.mockResolvedValueOnce({ data: "png" });
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved" });
    expect(
      nativeSend.mock.calls
        .map((call) => call[0])
        .filter((method) => method !== "Emulation.setFocusEmulationEnabled"),
    ).toEqual([
      "Page.captureScreenshot",
      "Page.captureScreenshot",
      "Input.dispatchMouseEvent",
    ]);
    page.detach();
  });

  it("cancels one session's buffered pointer without cancelling another session's input", async () => {
    const { page, view } = createCdpAdapterFixture();
    const completeCapture = holdCdpCaptures(view);
    page.attach();
    await Promise.resolve();
    const controller = new AbortController();
    const cancelled = page.send(
      "Input.dispatchMouseEvent",
      { type: "mousePressed" },
      "child",
      controller.signal,
    );
    const rejected = expect(cancelled).rejects.toThrow(/abort/i);
    const surviving = page.send(
      "Input.dispatchMouseEvent",
      { type: "mouseMoved" },
      "child",
      new AbortController().signal,
    );
    controller.abort();
    completeCapture();
    await rejected;
    await surviving;
    expect(view.webContents.debugger.sendCommand.mock.calls).toEqual([
      ["Emulation.setFocusEmulationEnabled", { enabled: true }],
      [
        "Page.captureScreenshot",
        { format: "png", captureBeyondViewport: false, optimizeForSpeed: true },
        undefined,
      ],
      ["Input.dispatchMouseEvent", { type: "mouseMoved" }, "child"],
    ]);
    page.detach();
  });

  it("routes lifecycle callbacks only for registered scoped tabs and forwards manager notifications", async () => {
    const { manager, adapter, scope, view, createTab, activateTab, closeTab } =
      createCdpAdapterFixture();
    const { signal } = new AbortController();
    await expect(
      adapter.createTab(scope, "https://example.com", signal),
    ).resolves.toBe("browser:a");
    expect(createTab).toHaveBeenCalledWith(
      scope,
      "https://example.com",
      signal,
    );
    createTab.mockResolvedValueOnce("outside");
    await expect(
      adapter.createTab(scope, "https://example.com", signal),
    ).rejects.toThrow("outside the requested scope");
    await expect(
      adapter.activateTab({ ...scope, threadId: "other" }, "browser:a", signal),
    ).rejects.toThrow("outside the requested scope");
    await expect(adapter.closeTab(scope, "outside", signal)).rejects.toThrow(
      "outside the requested scope",
    );
    expect(activateTab).not.toHaveBeenCalled();
    expect(closeTab).not.toHaveBeenCalled();
    await adapter.activateTab(scope, "browser:a", signal);
    await adapter.closeTab(scope, "browser:a", signal);
    expect(activateTab).toHaveBeenCalledExactlyOnceWith(
      scope,
      "browser:a",
      signal,
    );
    expect(closeTab).toHaveBeenCalledExactlyOnceWith(
      scope,
      "browser:a",
      signal,
    );

    const listener = vi.fn();
    const unsubscribe = adapter.subscribe(listener);
    view.webContents.emitDidNavigate("https://example.com/next");
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    manager.destroyAll();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("DesktopBrowserViewManager", () => {
  it("preserves same-server reconnect tabs but clears them before a different server registration", async () => {
    const { manager, hostWindow } = createRendererRecoveryFixture(91);
    const broker = createDesktopBrowserBroker({
      manager,
      product: "Chrome/test",
    });
    broker.registerWindow(
      Object.assign(hostWindow, {
        focus() {},
        show() {},
        restore() {},
        isMinimized: () => false,
      }),
    );
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const address = server.address();
    if (typeof address === "string" || address === null)
      throw new Error("Expected TCP address");
    const dataDir = await mkdtemp(join(tmpdir(), "bb-native-origin-"));
    const frameSchema = z.union([
      desktopBrowserRegistrationSchema,
      desktopBrowserChangedSchema,
    ]);
    const messages: Array<{
      peer: number;
      frame: z.infer<typeof frameSchema>;
    }> = [];
    let peers = 0;
    server.on("connection", (socket) => {
      const peer = ++peers;
      socket.on("message", (data) =>
        messages.push({
          peer,
          frame: frameSchema.parse(JSON.parse(data.toString())),
        }),
      );
    });
    let serverUrl = "https://first.example";
    const writeDescriptor = () =>
      writeFile(
        join(dataDir, DESKTOP_BROWSER_BROKER_DESCRIPTOR_FILE),
        JSON.stringify({
          version: 1,
          hostId: "host-1",
          serverUrl,
          url: `ws://127.0.0.1:${address.port}/desktop-browser`,
          token: "a".repeat(64),
        }),
        { mode: 0o600 },
      );
    await writeDescriptor();
    const client = createDesktopBrowserBrokerClient({
      broker,
      dataDir,
      getServerUrl: () => serverUrl,
    });
    const hasOriginalTab = (peer: number) =>
      messages.some(
        (message) =>
          message.peer === peer &&
          message.frame.type === "desktop-browser.changed" &&
          message.frame.tabs.some((tab) => tab.tabId === "browser:a"),
      );
    try {
      await vi.waitFor(() => expect(hasOriginalTab(1)).toBe(true));
      client.reconnect();
      await vi.waitFor(() => expect(hasOriginalTab(2)).toBe(true));
      expect(
        manager.listTabs({ hostWebContentsId: 91, threadId: "thread-1" }),
      ).toHaveLength(1);
      const target = broker.getTarget(91);
      if (!target) throw new Error("Expected connected desktop");
      await broker.execute({
        type: "desktop.browser.acquire_control",
        instanceId: target.instanceId,
        generation: target.generation,
        threadId: "thread-1",
        leaseId: "origin-lease",
        tabIds: ["browser:a"],
        controllerLabel: "Test",
        expiresAt: Date.now() + 60_000,
      });
      serverUrl = "https://second.example";
      await writeDescriptor();
      client.reconnect();
      expect(
        manager.listTabs({ hostWebContentsId: 91, threadId: null }),
      ).toEqual([]);
      expect(broker.getControl(91, "browser:a")).toBeNull();
      await vi.waitFor(() =>
        expect(
          messages.some(
            ({ peer, frame }) =>
              peer === 3 &&
              frame.type === "register" &&
              frame.serverUrl === serverUrl,
          ),
        ).toBe(true),
      );
      manager.attach({
        hostWindow,
        request: {
          tabId: "new-server-tab",
          threadId: "thread-new",
          url: "about:blank",
          bounds: { x: 0, y: 0, width: 640, height: 400 },
          visible: false,
        },
      });
      await vi.waitFor(() =>
        expect(
          messages.some(
            ({ peer, frame }) =>
              peer === 3 &&
              frame.type === "desktop-browser.changed" &&
              frame.threadId === "thread-new",
          ),
        ).toBe(true),
      );
      expect(
        messages
          .filter(({ peer }) => peer === 3)
          .every(
            ({ frame }) =>
              frame.type === "register" || frame.threadId === "thread-new",
          ),
      ).toBe(true);
      expect(hasOriginalTab(3)).toBe(false);
    } finally {
      client.stop();
      broker.dispose();
      manager.destroyAll();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("captures an unpainted hidden page without detaching another controller", async () => {
    const { manager, view } = createRendererRecoveryFixture(91);
    const [tab] = manager.getAutomationTabs({
      hostWebContentsId: 91,
      threadId: "thread-1",
    });
    if (!tab) throw new Error("Expected native tab");
    const capture = vi
      .spyOn(view.webContents, "capturePage")
      .mockRejectedValue(
        new Error("Current display surface not available for capture"),
      );
    const debuggerApi = view.webContents.debugger;
    debuggerApi.sendCommand.mockResolvedValue({
      data: Buffer.from("jpeg").toString("base64"),
    });
    try {
      await captureDesktopBrowserPage(tab.webContents);
      expect(debuggerApi.isAttached()).toBe(false);
      expect(debuggerApi.detachCalls).toBe(1);
      expect(view.webContents.getBackgroundThrottling()).toBe(true);
      debuggerApi.attach("1.3");
      await captureDesktopBrowserPage(tab.webContents);
      expect(debuggerApi.isAttached()).toBe(true);
      expect(debuggerApi.detachCalls).toBe(1);
      expect(debuggerApi.sendCommand).toHaveBeenCalledWith(
        "Page.captureScreenshot",
        { format: "jpeg", quality: 80, captureBeyondViewport: false },
        undefined,
      );
    } finally {
      capture.mockRestore();
      manager.destroyAll();
    }
  });

  it("reveals and focuses pages created through a controlled CDP connection", async () => {
    const { manager, hostWindow } = createRendererRecoveryFixture(91);
    const focus = vi.fn();
    const show = vi.fn();
    const restore = vi.fn();
    const broker = createDesktopBrowserBroker({
      manager,
      product: "Chrome/test",
    });
    broker.registerWindow(
      Object.assign(hostWindow, {
        focus,
        show,
        restore,
        isMinimized: () => true,
      }),
    );
    broker.setHostId("host-1");
    const instance = broker.listInstances()[0]!;
    const scope = {
      instanceId: instance.instanceId,
      generation: instance.generation,
      threadId: "thread-1",
    };
    let socket: WebSocket | null = null;
    try {
      await broker.execute({
        type: "desktop.browser.create_tab",
        ...scope,
        tabId: "automation",
        url: "about:blank",
        profile: { kind: "automation", id: "profile" },
        presentation: "hidden",
      });
      await broker.execute({
        type: "desktop.browser.acquire_control",
        ...scope,
        leaseId: "lease",
        tabIds: ["automation"],
        controllerLabel: "Agent",
        expiresAt: Date.now() + 60000,
      });
      const connection = await broker.execute({
        type: "desktop.browser.open_connection",
        ...scope,
        leaseId: "lease",
        tabIds: ["automation"],
      });
      if (!("wsEndpoint" in connection)) throw new Error("Expected connection");
      socket = new WebSocket(connection.wsEndpoint);
      await once(socket, "open");
      socket.send(
        JSON.stringify({
          id: 1,
          method: "Target.createTarget",
          params: { url: "https://example.com/new" },
        }),
      );
      await vi.waitFor(() => expect(focus).toHaveBeenCalledOnce());
      expect(show).toHaveBeenCalledOnce();
      expect(restore).toHaveBeenCalledOnce();
      const created = manager
        .listTabs({ hostWebContentsId: 91, threadId: "thread-1" })
        .find((tab) => tab.url === "https://example.com/new");
      expect(created).toBeDefined();
      expect(hostWindow.webContents.sentPayloads).toContainEqual({
        tabId: created!.tabId,
        threadId: "thread-1",
        desktopTarget: {
          hostId: "host-1",
          instanceId: scope.instanceId,
          generation: scope.generation,
        },
      });
      expect(broker.getControl(91, created!.tabId)?.control?.leaseId).toBe(
        "lease",
      );
    } finally {
      socket?.terminate();
      broker.dispose();
      manager.destroyAll();
    }
  });

  it("revokes native debugger control synchronously on takeover and fences reconnect generations", async () => {
    const { manager, hostWindow, view } = createRendererRecoveryFixture(91);
    const broker = createDesktopBrowserBroker({
      manager,
      product: "Chrome/test",
    });
    broker.registerWindow(
      Object.assign(hostWindow, {
        focus() {},
        show() {},
        restore() {},
        isMinimized: () => false,
      }),
    );
    broker.setHostId("host-1");
    const instance = broker.listInstances()[0];
    if (!instance) throw new Error("Expected registered instance");
    const scope = {
      instanceId: instance.instanceId,
      generation: instance.generation,
      threadId: "thread-1",
    };
    const acquire = (leaseId: string) =>
      broker.execute({
        type: "desktop.browser.acquire_control",
        ...scope,
        leaseId,
        tabIds: ["browser:a"],
        controllerLabel: "Test",
        expiresAt: Date.now() + 60_000,
      });
    let socket: WebSocket | null = null;
    try {
      await acquire("first");
      await expect(acquire("conflict")).rejects.toThrow(
        "already has a controller",
      );
      const connection = await broker.execute({
        type: "desktop.browser.open_connection",
        ...scope,
        leaseId: "first",
        tabIds: ["browser:a"],
      });
      if (!("wsEndpoint" in connection)) throw new Error("Expected connection");
      socket = new WebSocket(connection.wsEndpoint);
      await once(socket, "open");
      socket.send(
        JSON.stringify({
          id: 1,
          method: "Target.setAutoAttach",
          params: {
            autoAttach: true,
            flatten: true,
            waitForDebuggerOnStart: false,
          },
        }),
      );
      await vi.waitFor(() =>
        expect(view.webContents.debugger.isAttached()).toBe(true),
      );
      const closed = once(socket, "close");
      broker.takeOver(91, "browser:a");
      expect(view.webContents.debugger.isAttached()).toBe(false);
      expect(broker.getControl(91, "browser:a")?.control).toBeNull();
      await acquire("replacement");
      expect(broker.getControl(91, "browser:a")?.control?.leaseId).toBe(
        "replacement",
      );
      await closed;
      broker.setHostId(null);
      expect(broker.getControl(91, "browser:a")?.control).toBeNull();
      broker.setHostId("host-1");
      await expect(
        broker.execute({ type: "desktop.browser.list_tabs", ...scope }),
      ).rejects.toThrow("reconnected");
      expect(
        manager.listTabs({ hostWebContentsId: 91, threadId: "thread-1" }),
      ).toHaveLength(1);
    } finally {
      socket?.terminate();
      broker.dispose();
      manager.destroyAll();
    }
  });

  it("creates hidden automation tabs in isolated hardened profiles and preserves them on presentation attach", () => {
    const { manager, hostWindow } = createRendererRecoveryFixture(91);
    const create = (tabId: string, profileId: string) =>
      manager.createTab({
        hostWindow,
        tabId,
        threadId: "thread-1",
        url: "about:blank",
        profile: { kind: "automation", id: profileId },
        viewport: { width: 640, height: 400 },
      });
    const first = create("automation:first", "profile-1");
    create("automation:same", "profile-1");
    create("automation:other", "profile-2");
    const personal = requireFakeView(0);
    const automated = requireFakeView(1);
    expect(automated.visible).toBe(false);
    expect(automated.webContents.focusCalls).toBe(0);
    expect(automated.options.webPreferences.partition).not.toBe(
      personal.options.webPreferences.partition,
    );
    expect(requireFakeView(2).options.webPreferences.partition).toBe(
      automated.options.webPreferences.partition,
    );
    expect(requireFakeView(3).options.webPreferences.partition).not.toBe(
      automated.options.webPreferences.partition,
    );
    expect(electronMock.fakeSessions).toHaveLength(3);
    expect(
      electronMock.fakeSessions.every(
        (session) => session.permissionCheckHandler !== null,
      ),
    ).toBe(true);
    attachBrowserTab({
      manager,
      hostWindow,
      tabId: first.tabId,
      url: "https://stale.example",
    });
    expect(
      manager
        .listTabs({ hostWebContentsId: 91, threadId: "thread-1" })
        .find((tab) => tab.tabId === first.tabId)?.profile,
    ).toEqual(first.profile);
    expect(automated.webContents.loadURLCalls).toEqual(["about:blank"]);
    manager.closeTab({
      hostWebContentsId: 91,
      threadId: "thread-1",
      tabId: first.tabId,
      generation: first.generation,
    });
    const replacement = create(first.tabId, "profile-1");
    expect(replacement.generation).not.toBe(first.generation);
    expect(() =>
      manager.closeTab({
        hostWebContentsId: 91,
        threadId: "thread-1",
        tabId: first.tabId,
        generation: first.generation,
      }),
    ).toThrow("replaced");
    manager.closeTab({
      hostWebContentsId: 91,
      threadId: "thread-1",
      tabId: replacement.tabId,
      generation: replacement.generation,
    });
    manager.attach({
      hostWindow,
      request: {
        tabId: first.tabId,
        threadId: "thread-1",
        url: "https://stale.example",
        bounds: { x: 0, y: 0, width: 640, height: 400 },
        visible: true,
        existingOnly: true,
      },
    });
    expect(
      manager
        .listTabs({ hostWebContentsId: 91, threadId: "thread-1" })
        .some((tab) => tab.tabId === first.tabId),
    ).toBe(false);
  });

  it("captures bounded hidden pages without focus and rejects a removed target during capture", async () => {
    const { manager, hostWindow, view } = createRendererRecoveryFixture(91);
    manager.setVisible({
      hostWindow,
      request: { tabId: "browser:a", visible: false },
    });
    const tab = manager.listTabs({
      hostWebContentsId: 91,
      threadId: "thread-1",
    })[0];
    if (tab === undefined) throw new Error("Expected native tab");
    const request = {
      hostWebContentsId: 91,
      threadId: tab.threadId,
      tabId: tab.tabId,
      generation: tab.generation,
      maxWidth: 640,
      maxHeight: 640,
      quality: 70,
    };
    const focusCalls = view.webContents.focusCalls;
    const capture = manager.captureTab(request);
    await settlePendingCaptures(view);
    await expect(capture).resolves.toEqual({
      data: Buffer.from("jpeg-bytes"),
      width: 640,
      height: 360,
    });
    expect(view.visible).toBe(false);
    expect(view.webContents.focusCalls).toBe(focusCalls);
    const staleCapture = manager.captureTab(request);
    const rejected = expect(staleCapture).rejects.toThrow("unavailable");
    manager.closeTab(request);
    await settlePendingCaptures(view);
    await rejected;
  });

  it("initiates a new blank page load before announcing the automation target", () => {
    const manager = createDesktopBrowserViewManager();
    const hostWindow = new FakeHostWindow({
      contentBounds: { width: 700, height: 450 },
      webContentsId: 91,
    });
    const observedLoads: string[][] = [];
    manager.subscribeAutomationTabs(() => {
      expect(
        manager.getAutomationTabs({
          hostWebContentsId: 91,
          threadId: "thread-1",
        }),
      ).toHaveLength(1);
      observedLoads.push([...requireFakeView(0).webContents.loadURLCalls]);
    });
    attachBrowserTab({
      manager,
      hostWindow,
      tabId: "browser:blank",
      url: "about:blank",
    });
    expect(observedLoads).toEqual([["about:blank"]]);
  });

  it("preserves background navigation when revealing a tab with a stale persisted URL", () => {
    const { manager, hostWindow, view } = createRendererRecoveryFixture(91);
    manager.setVisible({
      hostWindow,
      request: { tabId: "browser:a", visible: false },
    });
    view.webContents.emitDidNavigate("https://example.com/agent-navigation");

    attachBrowserTab({
      manager,
      hostWindow,
      tabId: "browser:a",
      url: "https://example.com/original",
    });

    expect(electronMock.fakeViews).toHaveLength(1);
    expect(view.visible).toBe(true);
    expect(view.webContents.loadURLCalls).toEqual([
      "https://example.com/original",
    ]);
    expect(view.webContents.getURL()).toBe(
      "https://example.com/agent-navigation",
    );
    expect(hostWindow.webContents.sentPayloads.at(-1)).toMatchObject({
      tabId: "browser:a",
      url: "https://example.com/agent-navigation",
    });

    manager.navigate({
      hostWindow,
      request: { tabId: "browser:a", url: "https://example.com/explicit" },
    });
    expect(view.webContents.loadURLCalls).toEqual([
      "https://example.com/original",
      "https://example.com/explicit",
    ]);
  });

  it("rejects a different thread reattaching the same native tab without mutating it", () => {
    const { manager, hostWindow, view } = createRendererRecoveryFixture(91);
    const listener = vi.fn();
    manager.subscribeAutomationTabs(listener);
    const originalBounds = [...view.boundsCalls];
    const originalFocusCalls = view.webContents.focusCalls;

    manager.attach({
      hostWindow,
      request: {
        tabId: "browser:a",
        threadId: "thread-other",
        url: "https://example.com/replaced",
        bounds: { x: 0, y: 0, width: 100, height: 100 },
        visible: false,
      },
    });

    expect(view.boundsCalls).toEqual(originalBounds);
    expect(view.visible).toBe(true);
    expect(view.webContents.focusCalls).toBe(originalFocusCalls);
    expect(view.webContents.loadURLCalls).toEqual([
      "https://example.com/original",
    ]);
    expect(electronMock.fakeViews).toHaveLength(1);
    expect(
      manager.getAutomationTabs({
        hostWebContentsId: 91,
        threadId: "thread-other",
      }),
    ).toEqual([]);
    expect(
      manager.getAutomationTabs({
        hostWebContentsId: 91,
        threadId: "thread-1",
      }),
    ).toEqual([{ tabId: "browser:a", webContents: view.webContents }]);
    expect(listener).not.toHaveBeenCalled();
  });

  it("discovers hidden live tabs only in the requested window and thread", () => {
    const { manager, hostWindow, view } = createRendererRecoveryFixture(91);
    manager.setVisible({
      hostWindow,
      request: { tabId: "browser:a", visible: false },
    });
    manager.attach({
      hostWindow,
      request: {
        tabId: "browser:other-thread",
        threadId: "thread-other",
        url: "https://example.com/other",
        bounds: { x: 0, y: 0, width: 100, height: 100 },
        visible: false,
      },
    });
    const otherWindow = new FakeHostWindow({
      contentBounds: { width: 700, height: 450 },
      webContentsId: 910,
    });
    attachBrowserTab({
      manager,
      hostWindow: otherWindow,
      tabId: "browser:a",
      url: "https://example.com",
    });

    expect(
      manager.getAutomationTabs({
        hostWebContentsId: 91,
        threadId: "thread-1",
      }),
    ).toEqual([{ tabId: "browser:a", webContents: view.webContents }]);
    expect(
      manager.getAutomationTabs({
        hostWebContentsId: 910,
        threadId: "thread-1",
      }),
    ).toEqual([
      { tabId: "browser:a", webContents: requireFakeView(2).webContents },
    ]);
    view.webContents.destroyed = true;
    expect(
      manager.getAutomationTabs({
        hostWebContentsId: 91,
        threadId: "thread-1",
      }),
    ).toEqual([]);
  });

  it("notifies subscribers of native creation and hidden navigation until unsubscribed", () => {
    const manager = createDesktopBrowserViewManager();
    const hostWindow = new FakeHostWindow({
      contentBounds: { width: 700, height: 450 },
      webContentsId: 91,
    });
    const snapshots: Array<
      Array<{ tabId: string; url: string; title: string }>
    > = [];
    const unsubscribe = manager.subscribeAutomationTabs(() => {
      snapshots.push(
        manager
          .getAutomationTabs({ hostWebContentsId: 91, threadId: "thread-1" })
          .map(({ tabId, webContents }) => ({
            tabId,
            url: webContents.getURL(),
            title: webContents.getTitle(),
          })),
      );
    });
    attachBrowserTab({
      manager,
      hostWindow,
      tabId: "browser:a",
      url: "https://example.com",
    });
    expect(snapshots).toEqual([
      [{ tabId: "browser:a", url: "https://example.com", title: "" }],
    ]);
    manager.setVisible({
      hostWindow,
      request: { tabId: "browser:a", visible: false },
    });
    const view = requireFakeView(0);
    view.webContents.emitDidNavigate("https://example.com/next");
    view.webContents.emitDidNavigateInPage("https://example.com/next#section");
    view.webContents.emitPageTitleUpdated("Next");
    expect(snapshots.slice(1)).toEqual([
      [{ tabId: "browser:a", url: "https://example.com/next", title: "" }],
      [
        {
          tabId: "browser:a",
          url: "https://example.com/next#section",
          title: "",
        },
      ],
      [
        {
          tabId: "browser:a",
          url: "https://example.com/next#section",
          title: "Next",
        },
      ],
    ]);
    unsubscribe();
    view.webContents.emitDidNavigate("https://example.com/ignored");
    expect(snapshots).toHaveLength(4);
  });

  it.each(["detach", "releaseWindow", "destroyAll", "destroyed"] as const)(
    "notifies once after removing a native target through %s",
    (operation) => {
      const { manager, hostWindow, view } = createRendererRecoveryFixture(91);
      const snapshots: number[] = [];
      manager.subscribeAutomationTabs(() => {
        snapshots.push(
          manager.getAutomationTabs({
            hostWebContentsId: 91,
            threadId: "thread-1",
          }).length,
        );
      });
      if (operation === "detach")
        manager.detach({ hostWindow, tabId: "browser:a" });
      if (operation === "releaseWindow") manager.releaseWindow(91);
      if (operation === "destroyAll") manager.destroyAll();
      if (operation === "destroyed") view.webContents.close();
      expect(snapshots).toEqual([0]);
      expect(view.webContents.isDestroyed()).toBe(true);
      manager.destroyAll();
      expect(snapshots).toEqual([0]);
    },
  );

  it("forwards resolved browser shortcuts and suppresses the untrusted page", () => {
    const dispatchAppCommand = vi.fn();
    const focusHostWebContents = vi.fn();
    const resolveAppCommand = vi.fn(
      (input: { key: string; metaKey: boolean }) =>
        input.key === "l" && input.metaKey
          ? ("browser.focusLocation" as const)
          : null,
    );
    const manager = createDesktopBrowserViewManager({
      dispatchAppCommand,
      focusHostWebContents,
      partition: "persist:test",
      resolveAppCommand,
    });
    const hostWindow = new FakeHostWindow({
      contentBounds: { width: 700, height: 450 },
      webContentsId: 50,
    });

    attachBrowserTab({
      manager,
      hostWindow,
      tabId: "browser:a",
      url: "https://example.com",
    });
    const webContents = requireFakeView(0).webContents;

    expect(webContents.emitBeforeInput({ key: "l", meta: true })).toBe(true);
    expect(focusHostWebContents).toHaveBeenCalledWith(50);
    expect(dispatchAppCommand).toHaveBeenCalledWith({
      command: "browser.focusLocation",
      hostWebContentsId: 50,
    });
    expect(
      webContents.emitBeforeInput({
        isAutoRepeat: true,
        key: "l",
        meta: true,
      }),
    ).toBe(false);
    expect(dispatchAppCommand).toHaveBeenCalledTimes(1);
  });

  it("takes host focus for the find command so the find bar can receive typing", () => {
    const dispatchAppCommand = vi.fn();
    const focusHostWebContents = vi.fn();
    const manager = createDesktopBrowserViewManager({
      dispatchAppCommand,
      focusHostWebContents,
      partition: "persist:test",
      resolveAppCommand: (input) =>
        input.key === "f" && input.metaKey ? "browser.find" : null,
    });
    const hostWindow = new FakeHostWindow({
      contentBounds: { width: 700, height: 450 },
      webContentsId: 51,
    });

    attachBrowserTab({
      manager,
      hostWindow,
      tabId: "browser:a",
      url: "https://example.com",
    });
    const webContents = requireFakeView(0).webContents;

    expect(webContents.emitBeforeInput({ key: "f", meta: true })).toBe(true);
    expect(focusHostWebContents).toHaveBeenCalledWith(51);
    expect(dispatchAppCommand).toHaveBeenCalledWith({
      command: "browser.find",
      hostWebContentsId: 51,
    });
  });

  it("drives webContents find-in-page and relays results to the host renderer", () => {
    const manager = createDesktopBrowserViewManager({
      partition: "persist:test",
    });
    const hostWindow = new FakeHostWindow({
      contentBounds: { width: 700, height: 450 },
      webContentsId: 52,
    });
    attachBrowserTab({
      manager,
      hostWindow,
      tabId: "browser:a",
      url: "https://example.com",
    });
    const webContents = requireFakeView(0).webContents;

    manager.findInPage({
      hostWindow,
      request: {
        tabId: "browser:a",
        text: "needle",
        forward: true,
        newSession: true,
      },
    });
    manager.findInPage({
      hostWindow,
      request: {
        tabId: "browser:a",
        text: "needle",
        forward: false,
        newSession: false,
      },
    });
    manager.findInPage({
      hostWindow,
      request: {
        tabId: "browser:missing",
        text: "needle",
        forward: true,
        newSession: true,
      },
    });
    manager.stopFindInPage({
      hostWindow,
      request: { tabId: "browser:a", action: "clearSelection" },
    });

    expect(webContents.findInPageCalls).toEqual([
      { text: "needle", options: { forward: true, findNext: true } },
      { text: "needle", options: { forward: false, findNext: false } },
    ]);
    expect(webContents.stopFindInPageCalls).toEqual(["clearSelection"]);

    webContents.emitFoundInPage({
      requestId: 7,
      activeMatchOrdinal: 2,
      matches: 9,
      finalUpdate: true,
      selectionArea: { x: 0, y: 0, width: 10, height: 10 },
    });
    expect(findResultPushesOf(hostWindow)).toEqual([]);
  });

  it("relays only results of the latest find request and none after stop", () => {
    const manager = createDesktopBrowserViewManager({
      partition: "persist:test",
    });
    const hostWindow = new FakeHostWindow({
      contentBounds: { width: 700, height: 450 },
      webContentsId: 53,
    });
    attachBrowserTab({
      manager,
      hostWindow,
      tabId: "browser:a",
      url: "https://example.com",
    });
    const webContents = requireFakeView(0).webContents;
    const findRequest = {
      tabId: "browser:a",
      text: "needle",
      forward: true,
      newSession: true,
    };
    const resultArea = { x: 0, y: 0, width: 10, height: 10 };

    manager.findInPage({ hostWindow, request: findRequest });
    manager.findInPage({
      hostWindow,
      request: { ...findRequest, text: "nee" },
    });
    webContents.emitFoundInPage({
      requestId: 1,
      activeMatchOrdinal: 1,
      matches: 3,
      finalUpdate: true,
      selectionArea: resultArea,
    });
    webContents.emitFoundInPage({
      requestId: 2,
      activeMatchOrdinal: 1,
      matches: 12,
      finalUpdate: false,
      selectionArea: resultArea,
    });
    expect(findResultPushesOf(hostWindow)).toEqual([
      {
        tabId: "browser:a",
        requestId: 2,
        activeMatchOrdinal: 1,
        matches: 12,
        finalUpdate: false,
      },
    ]);

    manager.stopFindInPage({
      hostWindow,
      request: { tabId: "browser:a", action: "clearSelection" },
    });
    webContents.emitFoundInPage({
      requestId: 2,
      activeMatchOrdinal: 1,
      matches: 12,
      finalUpdate: true,
      selectionArea: resultArea,
    });
    expect(findResultPushesOf(hostWindow)).toHaveLength(1);
  });

  it("surfaces a loopback popup as an in-panel tab, never a native window", () => {
    const manager = createDesktopBrowserViewManager({
      partition: "persist:test",
    });
    const hostWindow = new FakeHostWindow({
      contentBounds: { width: 700, height: 450 },
      webContentsId: 58,
    });

    attachBrowserTab({
      manager,
      hostWindow,
      tabId: "browser:a",
      url: "http://localhost:5173/",
    });
    const view = requireFakeView(0);

    expect(
      view.webContents.emitWindowOpen("http://localhost:38886/", {
        frameName: "_blank",
      }),
    ).toEqual({
      action: "deny",
    });
    expect(openTabPushesOf(hostWindow)).toEqual(["http://localhost:38886/"]);
    expect(scopedOpenTabPushesOf(hostWindow)).toEqual([
      { tabId: "browser:a", url: "http://localhost:38886/" },
    ]);
  });

  it("surfaces public popups with their source browser tab id", () => {
    const manager = createDesktopBrowserViewManager({
      partition: "persist:test",
    });
    const hostWindow = new FakeHostWindow({
      contentBounds: { width: 700, height: 450 },
      webContentsId: 61,
    });

    attachBrowserTab({
      manager,
      hostWindow,
      tabId: "browser:a",
      url: "https://example.com/",
    });
    const view = requireFakeView(0);

    expect(
      view.webContents.emitWindowOpen("https://example.com/docs", {
        frameName: "_blank",
      }),
    ).toEqual({
      action: "deny",
    });
    expect(openTabPushesOf(hostWindow)).toEqual(["https://example.com/docs"]);
    expect(scopedOpenTabPushesOf(hostWindow)).toEqual([
      {
        tabId: "browser:a",
        url: "https://example.com/docs",
      },
    ]);
  });

  it("keeps noopener blank links in the browser panel", () => {
    const manager = createDesktopBrowserViewManager({
      partition: "persist:test",
    });
    const hostWindow = new FakeHostWindow({
      contentBounds: { width: 700, height: 450 },
      webContentsId: 63,
    });

    attachBrowserTab({
      manager,
      hostWindow,
      tabId: "browser:a",
      url: "https://example.com/",
    });
    const view = requireFakeView(0);

    expect(
      view.webContents.emitWindowOpen("https://example.com/docs", {
        disposition: "foreground-tab",
        features: "noopener,noreferrer",
        frameName: "_blank",
      }),
    ).toEqual({ action: "deny" });
    expect(electronMock.fakeWindows).toEqual([]);
    expect(openTabPushesOf(hostWindow)).toEqual(["https://example.com/docs"]);
    expect(scopedOpenTabPushesOf(hostWindow)).toEqual([
      {
        tabId: "browser:a",
        url: "https://example.com/docs",
      },
    ]);
  });

  it("opens popup dispositions in a hardened native window", () => {
    const manager = createDesktopBrowserViewManager({
      partition: "persist:test",
    });
    const hostWindow = new FakeHostWindow({
      contentBounds: { width: 700, height: 450 },
      webContentsId: 62,
    });

    attachBrowserTab({
      manager,
      hostWindow,
      tabId: "browser:a",
      url: "https://www.notion.so/",
    });
    const view = requireFakeView(0);
    const decision = view.webContents.emitWindowOpen(
      "https://accounts.google.com/o/oauth2/auth",
      {
        disposition: "new-window",
        features: "width=520,height=700",
        frameName: "oauth",
      },
    );

    expect(decision.action).toBe("allow");
    expect(openTabPushesOf(hostWindow)).toEqual([]);
    expect(scopedOpenTabPushesOf(hostWindow)).toEqual([]);
    if (decision.createWindow === undefined) {
      throw new Error("Expected the popup decision to create a window.");
    }

    const childContents = electronMock.createFakeWebContents();
    const popupContents = decision.createWindow({
      alwaysOnTop: true,
      frame: false,
      height: 4_000,
      show: false,
      title: "bb sign in",
      transparent: true,
      width: 10,
      webContents: childContents,
      x: 0,
      y: 0,
      webPreferences: {
        contextIsolation: false,
        nodeIntegration: true,
        partition: "persist:untrusted",
        sandbox: false,
        webSecurity: false,
      },
    });
    const popupWindow = electronMock.fakeWindows[0];
    if (popupWindow === undefined) {
      throw new Error("Expected a popup window to be created.");
    }

    expect(popupContents).toBe(childContents);
    expect(popupWindow.loadURLCalls).toEqual([]);
    expect(popupWindow.options).toEqual({
      center: true,
      frame: true,
      height: 900,
      show: true,
      transparent: false,
      width: 320,
      webContents: childContents,
      webPreferences: {
        allowRunningInsecureContent: false,
        contextIsolation: true,
        nodeIntegration: false,
        partition: "persist:test",
        sandbox: true,
        webSecurity: true,
      },
    });
    expect(popupWindow.titleCalls).toEqual(["bb browser popup"]);
    childContents.emitDidNavigate("https://accounts.google.com/oauth2/auth");
    expect(popupWindow.titleCalls.at(-1)).toBe(
      "bb browser — https://accounts.google.com",
    );
    expect(childContents.emitPageTitleUpdated("Google Sign In")).toBe(true);
    expect(popupWindow.titleCalls.at(-1)).toBe(
      "bb browser — https://accounts.google.com",
    );
    expect(popupContents.emitWindowOpen("https://example.com/nested")).toEqual({
      action: "deny",
    });
    manager.destroyAll();
    expect(popupWindow.closeCalls).toBe(0);
    expect(popupWindow.destroyCalls).toBe(1);
  });

  it("loads the URL itself when Electron supplies no child webContents", () => {
    const manager = createDesktopBrowserViewManager({
      partition: "persist:test",
    });
    const hostWindow = new FakeHostWindow({
      contentBounds: { width: 700, height: 450 },
      webContentsId: 66,
    });

    attachBrowserTab({
      manager,
      hostWindow,
      tabId: "browser:a",
      url: "https://example.com/",
    });
    const view = requireFakeView(0);
    const decision = view.webContents.emitWindowOpen(
      "https://example.com/docs",
      { disposition: "new-window" },
    );

    expect(decision.action).toBe("allow");
    if (decision.createWindow === undefined) {
      throw new Error("Expected the popup decision to create a window.");
    }
    decision.createWindow({});
    expect(electronMock.fakeWindows[0]?.loadURLCalls).toEqual([
      "https://example.com/docs",
    ]);
  });

  it("supports blank-first OAuth navigation with secure remote URLs", () => {
    const manager = createDesktopBrowserViewManager({
      partition: "persist:test",
    });
    const hostWindow = new FakeHostWindow({
      contentBounds: { width: 700, height: 450 },
      webContentsId: 64,
    });

    attachBrowserTab({
      manager,
      hostWindow,
      tabId: "browser:a",
      url: "https://example.com/",
    });
    const view = requireFakeView(0);
    const decision = view.webContents.emitWindowOpen("about:blank", {
      disposition: "new-window",
      features: "width=520,height=700",
      frameName: "oauth",
    });

    expect(decision.action).toBe("allow");
    if (decision.createWindow === undefined) {
      throw new Error("Expected the blank OAuth popup to create a window.");
    }
    const childContents = electronMock.createFakeWebContents();
    decision.createWindow({ webContents: childContents });

    expect(
      childContents.emitWillFrameNavigate(
        "https://accounts.google.com/o/oauth2/auth",
        true,
      ),
    ).toBe(false);
    expect(
      childContents.emitWillFrameNavigate(
        "http://accounts.google.com/oauth2/auth",
        true,
      ),
    ).toBe(true);
    expect(
      childContents.emitWillRedirect("http://evil.example/steal", true),
    ).toBe(true);
    expect(
      childContents.emitWillFrameNavigate(
        "http://127.0.0.1:38886/callback",
        true,
      ),
    ).toBe(false);
  });

  it("caps live native popups across successive rate windows", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T12:00:00Z"));
    const manager = createDesktopBrowserViewManager({
      partition: "persist:test",
    });
    const hostWindow = new FakeHostWindow({
      contentBounds: { width: 700, height: 450 },
      webContentsId: 65,
    });

    attachBrowserTab({
      manager,
      hostWindow,
      tabId: "browser:a",
      url: "https://example.com/",
    });
    const view = requireFakeView(0);
    const openPopup = (): FakeWindowOpenDecision => {
      const decision = view.webContents.emitWindowOpen(
        "https://accounts.google.com/o/oauth2/auth",
        {
          disposition: "new-window",
          features: "width=520,height=700",
          frameName: "oauth",
        },
      );
      if (decision.createWindow !== undefined) {
        decision.createWindow({
          webContents: electronMock.createFakeWebContents(),
        });
      }
      return decision;
    };

    expect(openPopup().action).toBe("allow");
    expect(openPopup().action).toBe("allow");
    expect(openPopup().action).toBe("allow");
    vi.advanceTimersByTime(10_001);
    expect(openPopup()).toEqual({ action: "deny" });

    electronMock.fakeWindows[0]?.destroy();
    expect(openPopup().action).toBe("allow");
    manager.destroyAll();
  });

  it("snapshots then hides visible views on resize, revealing them clamped to the shrunken window", async () => {
    const manager = createDesktopBrowserViewManager({
      partition: "persist:test",
    });
    const hostWindow = new FakeHostWindow({
      contentBounds: { width: 700, height: 450 },
      webContentsId: 41,
    });

    manager.attach({
      hostWindow,
      request: {
        threadId: "thread-1",
        tabId: "browser:a",
        url: "",
        bounds: { x: 100, y: 50, width: 500, height: 350 },
        visible: true,
      },
    });

    const view = electronMock.fakeViews[0];
    expect(view).toBeDefined();
    if (view === undefined) {
      throw new Error("Expected the browser view to be created.");
    }
    expect(view.boundsCalls[0]).toEqual({
      x: 100,
      y: 50,
      width: 500,
      height: 350,
    });
    expect(view.visible).toBe(true);

    manager.beginWindowResize(hostWindow);
    await settlePendingCaptures(view);
    expect(view.visible).toBe(false);
    expect(snapshotPushesOf(hostWindow)).toEqual([
      {
        tabId: "browser:a",
        dataUrl: `data:image/jpeg;base64,${Buffer.from("jpeg-bytes").toString("base64")}`,
      },
    ]);

    hostWindow.contentBounds = { width: 400, height: 300 };
    manager.endWindowResize(hostWindow);

    expect(view.boundsCalls[1]).toEqual({
      x: 100,
      y: 50,
      width: 300,
      height: 250,
    });
    expect(view.visible).toBe(true);
    expect(snapshotPushesOf(hostWindow).at(-1)).toEqual({
      tabId: "browser:a",
      dataUrl: null,
    });

    manager.beginWindowResize(hostWindow);
    await settlePendingCaptures(view);
    hostWindow.contentBounds = { width: 700, height: 450 };
    manager.endWindowResize(hostWindow);

    expect(view.boundsCalls[2]).toEqual({
      x: 100,
      y: 50,
      width: 500,
      height: 350,
    });
    expect(view.visible).toBe(true);
  });

  it("drops a capture that resolves after the resize burst already ended", async () => {
    const manager = createDesktopBrowserViewManager({
      partition: "persist:test",
    });
    const hostWindow = new FakeHostWindow({
      contentBounds: { width: 700, height: 450 },
      webContentsId: 46,
    });

    manager.attach({
      hostWindow,
      request: {
        threadId: "thread-1",
        tabId: "browser:a",
        url: "",
        bounds: { x: 100, y: 50, width: 500, height: 350 },
        visible: true,
      },
    });

    const view = electronMock.fakeViews[0];
    expect(view).toBeDefined();
    if (view === undefined) {
      throw new Error("Expected the browser view to be created.");
    }

    manager.beginWindowResize(hostWindow);
    manager.endWindowResize(hostWindow);
    await settlePendingCaptures(view);

    const bitmapPushes = snapshotPushesOf(hostWindow).filter(
      (push) => push.dataUrl !== null,
    );
    expect(bitmapPushes).toHaveLength(0);
    expect(view.visible).toBe(true);
  });

  it("never grows a view past its renderer-desired rect on a native window grow", async () => {
    const manager = createDesktopBrowserViewManager({
      partition: "persist:test",
    });
    const hostWindow = new FakeHostWindow({
      contentBounds: { width: 700, height: 450 },
      webContentsId: 43,
    });

    manager.attach({
      hostWindow,
      request: {
        threadId: "thread-1",
        tabId: "browser:a",
        url: "",
        bounds: { x: 100, y: 50, width: 500, height: 350 },
        visible: true,
      },
    });

    const view = electronMock.fakeViews[0];
    expect(view).toBeDefined();
    if (view === undefined) {
      throw new Error("Expected the browser view to be created.");
    }

    manager.beginWindowResize(hostWindow);
    await settlePendingCaptures(view);
    hostWindow.contentBounds = { width: 900, height: 640 };
    manager.endWindowResize(hostWindow);

    expect(view.boundsCalls[1]).toEqual({
      x: 100,
      y: 50,
      width: 500,
      height: 350,
    });
  });

  it("applies renderer pushes that land mid-resize on the reveal", async () => {
    const manager = createDesktopBrowserViewManager({
      partition: "persist:test",
    });
    const hostWindow = new FakeHostWindow({
      contentBounds: { width: 700, height: 450 },
      webContentsId: 44,
    });

    manager.attach({
      hostWindow,
      request: {
        threadId: "thread-1",
        tabId: "browser:a",
        url: "",
        bounds: { x: 100, y: 50, width: 500, height: 350 },
        visible: true,
      },
    });

    const view = electronMock.fakeViews[0];
    expect(view).toBeDefined();
    if (view === undefined) {
      throw new Error("Expected the browser view to be created.");
    }

    manager.beginWindowResize(hostWindow);
    await settlePendingCaptures(view);
    hostWindow.contentBounds = { width: 500, height: 300 };
    manager.setBounds({
      hostWindow,
      request: {
        tabId: "browser:a",
        bounds: { x: 200, y: 90, width: 400, height: 300 },
      },
    });
    manager.endWindowResize(hostWindow);

    expect(view.boundsCalls.at(-1)).toEqual({
      x: 200,
      y: 90,
      width: 300,
      height: 210,
    });
    expect(view.visible).toBe(true);
  });

  it("defers renderer visibility changes made during a resize burst to the reveal", () => {
    const manager = createDesktopBrowserViewManager({
      partition: "persist:test",
    });
    const hostWindow = new FakeHostWindow({
      contentBounds: { width: 700, height: 450 },
      webContentsId: 45,
    });

    manager.attach({
      hostWindow,
      request: {
        threadId: "thread-1",
        tabId: "browser:a",
        url: "",
        bounds: { x: 100, y: 50, width: 500, height: 350 },
        visible: false,
      },
    });

    const view = electronMock.fakeViews[0];
    expect(view).toBeDefined();
    if (view === undefined) {
      throw new Error("Expected the browser view to be created.");
    }

    manager.beginWindowResize(hostWindow);
    manager.setVisible({
      hostWindow,
      request: { tabId: "browser:a", visible: true },
    });
    expect(view.visible).toBe(false);

    manager.endWindowResize(hostWindow);
    expect(view.visible).toBe(true);
  });

  it("keeps hidden views hidden and untouched across a resize burst", () => {
    const manager = createDesktopBrowserViewManager({
      partition: "persist:test",
    });
    const hostWindow = new FakeHostWindow({
      contentBounds: { width: 700, height: 450 },
      webContentsId: 42,
    });

    manager.attach({
      hostWindow,
      request: {
        threadId: "thread-1",
        tabId: "browser:a",
        url: "",
        bounds: { x: 100, y: 50, width: 500, height: 350 },
        visible: false,
      },
    });

    const view = electronMock.fakeViews[0];
    expect(view).toBeDefined();
    if (view === undefined) {
      throw new Error("Expected the browser view to be created.");
    }

    manager.beginWindowResize(hostWindow);
    hostWindow.contentBounds = { width: 400, height: 300 };
    manager.endWindowResize(hostWindow);

    expect(view.boundsCalls).toHaveLength(1);
    expect(view.visible).toBe(false);
  });

  it("focuses a freshly-attached active tab so Cmd+C targets its webContents", () => {
    const manager = createDesktopBrowserViewManager({
      partition: "persist:test",
    });
    const hostWindow = new FakeHostWindow({
      contentBounds: { width: 700, height: 450 },
      webContentsId: 70,
    });

    manager.attach({
      hostWindow,
      request: {
        threadId: "thread-1",
        tabId: "browser:a",
        url: "",
        bounds: { x: 100, y: 50, width: 500, height: 350 },
        visible: true,
      },
    });

    const view = requireFakeView(0);
    expect(view.webContents.focusCalls).toBe(1);
  });

  it("reports user focus but suppresses programmatic focus used for restoration", () => {
    const manager = createDesktopBrowserViewManager({
      partition: "persist:test",
    });
    const hostWindow = new FakeHostWindow({
      contentBounds: { width: 700, height: 450 },
      webContentsId: 79,
    });

    manager.attach({
      hostWindow,
      request: {
        threadId: "thread-1",
        tabId: "browser:a",
        url: "https://example.com",
        bounds: { x: 100, y: 50, width: 500, height: 350 },
        visible: true,
      },
    });
    const view = requireFakeView(0);
    expect(hostWindow.webContents.sentChannels).not.toContain(
      "bb-desktop:browser:focused",
    );

    manager.focus({ hostWindow, tabId: "browser:a" });
    expect(hostWindow.webContents.sentChannels).not.toContain(
      "bb-desktop:browser:focused",
    );

    view.webContents.emitFocus();
    expect(hostWindow.webContents.sentChannels).toContain(
      "bb-desktop:browser:focused",
    );
    expect(hostWindow.webContents.sentPayloads.at(-1)).toEqual({
      tabId: "browser:a",
    });
  });

  it("defers hidden memory-eviction recovery until the panel shows the current page", () => {
    vi.useFakeTimers();
    const { hostWindow, manager, view } = createRendererRecoveryFixture(75);
    view.webContents.emitDidNavigate("https://example.com/current");
    manager.setVisible({
      hostWindow,
      request: { tabId: "browser:a", visible: false },
    });

    view.webContents.emitRenderProcessGone({
      exitCode: 0,
      reason: "memory-eviction",
    });

    expect(view.webContents.reloadCalls).toBe(0);
    expect(view.visible).toBe(false);

    manager.setVisible({
      hostWindow,
      request: { tabId: "browser:a", visible: true },
    });
    expect(view.visible).toBe(false);
    vi.runOnlyPendingTimers();

    expect(view.webContents.reloadCalls).toBe(1);
    expect(view.webContents.getURL()).toBe("https://example.com/current");
    expect(electronMock.fakeViews).toHaveLength(1);
    expect(view.visible).toBe(true);
  });

  it("stops automatic recovery after two repeated renderer crashes", () => {
    vi.useFakeTimers();
    const { hostWindow, view } = createRendererRecoveryFixture(76);

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      view.webContents.emitRenderProcessGone({
        exitCode: 1,
        reason: "crashed",
      });
      expect(view.visible).toBe(false);
      vi.runOnlyPendingTimers();
      expect(view.webContents.reloadCalls).toBe(attempt);
      expect(view.visible).toBe(true);
    }

    view.webContents.emitRenderProcessGone({
      exitCode: 1,
      reason: "crashed",
    });
    vi.runOnlyPendingTimers();

    expect(view.webContents.reloadCalls).toBe(2);
    expect(view.visible).toBe(false);
    expect(hostWindow.webContents.sentPayloads.at(-1)).toMatchObject({
      tabId: "browser:a",
      errorText: "The page renderer stopped repeatedly",
    });
  });

  it.each(["launch-failed", "integrity-failure"] as const)(
    "does not automatically retry a %s renderer failure",
    (reason) => {
      vi.useFakeTimers();
      const { hostWindow, view } = createRendererRecoveryFixture(77);

      view.webContents.emitRenderProcessGone({ exitCode: 1, reason });
      vi.runOnlyPendingTimers();

      expect(view.webContents.reloadCalls).toBe(0);
      expect(view.visible).toBe(false);
      expect(hostWindow.webContents.sentPayloads.at(-1)).toMatchObject({
        tabId: "browser:a",
        errorText: "The page renderer could not start",
      });
    },
  );

  it("resets the renderer recovery limit after a page finishes loading", () => {
    vi.useFakeTimers();
    const { view } = createRendererRecoveryFixture(78);

    view.webContents.emitRenderProcessGone({
      exitCode: 1,
      reason: "crashed",
    });
    vi.runOnlyPendingTimers();
    view.webContents.emitDidFinishLoad();
    view.webContents.emitRenderProcessGone({
      exitCode: 1,
      reason: "crashed",
    });
    vi.runOnlyPendingTimers();

    expect(view.webContents.reloadCalls).toBe(2);
    expect(view.visible).toBe(true);
  });

  it("does not focus a freshly-attached inactive tab", () => {
    const manager = createDesktopBrowserViewManager({
      partition: "persist:test",
    });
    const hostWindow = new FakeHostWindow({
      contentBounds: { width: 700, height: 450 },
      webContentsId: 71,
    });

    manager.attach({
      hostWindow,
      request: {
        threadId: "thread-1",
        tabId: "browser:a",
        url: "",
        bounds: { x: 100, y: 50, width: 500, height: 350 },
        visible: false,
      },
    });

    const view = requireFakeView(0);
    expect(view.webContents.focusCalls).toBe(0);
  });

  it("focuses on a real hidden → visible setVisible transition only once", () => {
    const manager = createDesktopBrowserViewManager({
      partition: "persist:test",
    });
    const hostWindow = new FakeHostWindow({
      contentBounds: { width: 700, height: 450 },
      webContentsId: 72,
    });

    manager.attach({
      hostWindow,
      request: {
        threadId: "thread-1",
        tabId: "browser:a",
        url: "",
        bounds: { x: 100, y: 50, width: 500, height: 350 },
        visible: false,
      },
    });

    const view = requireFakeView(0);
    expect(view.webContents.focusCalls).toBe(0);

    manager.setVisible({
      hostWindow,
      request: { tabId: "browser:a", visible: true },
    });
    expect(view.webContents.focusCalls).toBe(1);

    manager.setVisible({
      hostWindow,
      request: { tabId: "browser:a", visible: true },
    });
    expect(view.webContents.focusCalls).toBe(1);
  });

  it("re-focuses after a hide → show cycle", () => {
    const manager = createDesktopBrowserViewManager({
      partition: "persist:test",
    });
    const hostWindow = new FakeHostWindow({
      contentBounds: { width: 700, height: 450 },
      webContentsId: 73,
    });

    manager.attach({
      hostWindow,
      request: {
        threadId: "thread-1",
        tabId: "browser:a",
        url: "",
        bounds: { x: 100, y: 50, width: 500, height: 350 },
        visible: true,
      },
    });

    const view = requireFakeView(0);
    expect(view.webContents.focusCalls).toBe(1);

    manager.setVisible({
      hostWindow,
      request: { tabId: "browser:a", visible: false },
    });
    expect(view.webContents.focusCalls).toBe(1);

    manager.setVisible({
      hostWindow,
      request: { tabId: "browser:a", visible: true },
    });
    expect(view.webContents.focusCalls).toBe(2);
  });

  it("does not let an unfocused split view steal focus on mount or restore", () => {
    const manager = createDesktopBrowserViewManager({
      partition: "persist:test",
    });
    const hostWindow = new FakeHostWindow({
      contentBounds: { width: 900, height: 600 },
      webContentsId: 80,
    });

    for (const [tabId, x] of [
      ["browser:focused", 0],
      ["browser:sibling", 450],
    ] as const) {
      manager.attach({
        hostWindow,
        request: {
          threadId: "thread-1",
          tabId,
          url: `https://example.com/${tabId}`,
          bounds: { x, y: 0, width: 450, height: 600 },
          visible: true,
        },
      });
    }
    const focusedView = requireFakeView(0);
    const siblingView = requireFakeView(1);
    expect(focusedView.webContents.focusCalls).toBe(1);
    expect(siblingView.webContents.focusCalls).toBe(0);

    manager.setVisible({
      hostWindow,
      request: { tabId: "browser:sibling", visible: false },
    });
    manager.setVisible({
      hostWindow,
      request: { tabId: "browser:sibling", visible: true },
    });

    expect(focusedView.webContents.focusCalls).toBe(1);
    expect(siblingView.webContents.focusCalls).toBe(0);
  });

  it("shows a browser beside a focused non-browser pane without stealing focus", () => {
    const manager = createDesktopBrowserViewManager({
      partition: "persist:test",
    });
    const hostWindow = new FakeHostWindow({
      contentBounds: { width: 900, height: 600 },
      webContentsId: 82,
    });

    manager.attach({
      hostWindow,
      request: {
        threadId: "thread-1",
        tabId: "browser:sibling",
        url: "https://example.com/browser",
        bounds: { x: 450, y: 0, width: 450, height: 600 },
        visible: false,
      },
    });
    const browserView = requireFakeView(0);

    manager.setVisibleWithoutFocus({
      hostWindow,
      request: { tabId: "browser:sibling", visible: true },
    });
    expect(browserView.visible).toBe(true);
    expect(browserView.webContents.focusCalls).toBe(0);

    manager.setVisibleWithoutFocus({
      hostWindow,
      request: { tabId: "browser:sibling", visible: false },
    });
    manager.setVisibleWithoutFocus({
      hostWindow,
      request: { tabId: "browser:sibling", visible: true },
    });
    expect(browserView.visible).toBe(true);
    expect(browserView.webContents.focusCalls).toBe(0);
  });

  it("lets logical focus override first-visible mount order", () => {
    const manager = createDesktopBrowserViewManager({
      partition: "persist:test",
    });
    const hostWindow = new FakeHostWindow({
      contentBounds: { width: 900, height: 600 },
      webContentsId: 81,
    });

    for (const [tabId, x] of [
      ["browser:sibling", 0],
      ["browser:focused", 450],
    ] as const) {
      manager.attach({
        hostWindow,
        request: {
          threadId: "thread-1",
          tabId,
          url: `https://example.com/${tabId}`,
          bounds: { x, y: 0, width: 450, height: 600 },
          visible: true,
        },
      });
    }
    const siblingView = requireFakeView(0);
    const focusedView = requireFakeView(1);
    expect(siblingView.webContents.focusCalls).toBe(1);
    expect(focusedView.webContents.focusCalls).toBe(0);

    manager.focus({ hostWindow, tabId: "browser:focused" });

    expect(focusedView.webContents.focusCalls).toBe(1);
  });

  it("hides only the reloading window's browser views until they reattach", () => {
    const manager = createDesktopBrowserViewManager({
      partition: "persist:test",
    });
    const reloadingWindow = new FakeHostWindow({
      contentBounds: { width: 900, height: 600 },
      webContentsId: 83,
    });
    const otherWindow = new FakeHostWindow({
      contentBounds: { width: 900, height: 600 },
      webContentsId: 84,
    });
    attachBrowserTab({
      manager,
      hostWindow: reloadingWindow,
      tabId: "browser:reloading",
      url: "https://example.com/reloading",
    });
    attachBrowserTab({
      manager,
      hostWindow: otherWindow,
      tabId: "browser:other",
      url: "https://example.com/other",
    });
    const reloadingView = requireFakeView(0);
    const otherView = requireFakeView(1);

    manager.prepareWindowReload(reloadingWindow);

    expect(reloadingView.visible).toBe(false);
    expect(otherView.visible).toBe(true);
    manager.attach({
      hostWindow: reloadingWindow,
      request: {
        threadId: "thread-1",
        tabId: "browser:reloading",
        url: "https://example.com/reloading",
        bounds: { x: 100, y: 50, width: 500, height: 350 },
        visible: true,
      },
    });
    expect(electronMock.fakeViews).toHaveLength(2);
    expect(reloadingView.visible).toBe(true);
  });

  it("allows clipboard-sanitized-write but denies clipboard-read and device permissions", () => {
    expect(isAllowedBrowserPermission("clipboard-sanitized-write")).toBe(true);
    expect(isAllowedBrowserPermission("clipboard-read")).toBe(false);
    expect(isAllowedBrowserPermission("media")).toBe(false);
    expect(isAllowedBrowserPermission("notifications")).toBe(false);
    expect(isAllowedBrowserPermission("geolocation")).toBe(false);

    const manager = createDesktopBrowserViewManager({
      partition: "persist:test",
    });
    const hostWindow = new FakeHostWindow({
      contentBounds: { width: 700, height: 450 },
      webContentsId: 74,
    });
    attachBrowserTab({
      manager,
      hostWindow,
      tabId: "browser:a",
      url: "https://example.com/",
    });

    const fakeSession = electronMock.fakeSessions.at(-1);
    expect(fakeSession).toBeDefined();
    if (fakeSession === undefined) {
      throw new Error("Expected a browser session to be created.");
    }
    const checkHandler = fakeSession.permissionCheckHandler;
    const requestHandler = fakeSession.permissionRequestHandler;
    expect(checkHandler).not.toBeNull();
    expect(requestHandler).not.toBeNull();
    if (checkHandler === null || requestHandler === null) {
      throw new Error("Expected permission handlers to be registered.");
    }

    expect(checkHandler(null, "clipboard-sanitized-write")).toBe(true);
    expect(checkHandler(null, "clipboard-read")).toBe(false);
    expect(checkHandler(null, "media")).toBe(false);

    const requestGrants: boolean[] = [];
    requestHandler(null, "clipboard-sanitized-write", (granted) => {
      requestGrants.push(granted);
    });
    requestHandler(null, "clipboard-read", (granted) => {
      requestGrants.push(granted);
    });
    requestHandler(null, "media", (granted) => {
      requestGrants.push(granted);
    });
    expect(requestGrants).toEqual([true, false, false]);
  });
});
