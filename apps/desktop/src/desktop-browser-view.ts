import { createHash, randomUUID } from "node:crypto";
import { captureDesktopBrowserPage } from "./desktop-browser-capture.js";
import {
  BrowserWindow,
  Menu,
  WebContentsView,
  session,
  type BrowserWindowConstructorOptions,
  type Session,
  type WebContents,
  type WebPreferences,
} from "electron";
import {
  BB_DESKTOP_BROWSER_MAX_TITLE_LENGTH,
  BB_DESKTOP_BROWSER_MAX_URL_LENGTH,
  clampBbDesktopBrowserViewBounds,
  type BbDesktopBrowserAttachRequest,
  type BbDesktopBrowserFindInPageRequest,
  type BbDesktopBrowserFindResult,
  type BbDesktopBrowserNavigateRequest,
  type BbDesktopBrowserOpenTabRequest,
  type BbDesktopBrowserScopedOpenTabRequest,
  type BbDesktopBrowserSetBoundsRequest,
  type BbDesktopBrowserSetVisibleRequest,
  type BbDesktopBrowserSnapshot,
  type BbDesktopBrowserState,
  type BbDesktopBrowserControlState,
  type BbDesktopBrowserRevealRequest,
  type BbDesktopBrowserTabRef,
  type BbDesktopBrowserStopFindInPageRequest,
  type BbDesktopBrowserViewportBounds,
  type BbDesktopBrowserViewBounds,
} from "@bb/desktop-contract";
import type { AppCommandId, AppShortcutInput } from "@bb/domain";
import {
  BB_DESKTOP_BROWSER_FIND_RESULT_CHANNEL,
  BB_DESKTOP_BROWSER_OPEN_TAB_CHANNEL,
  BB_DESKTOP_BROWSER_FOCUSED_CHANNEL,
  BB_DESKTOP_BROWSER_SCOPED_OPEN_TAB_CHANNEL,
  BB_DESKTOP_BROWSER_SNAPSHOT_CHANNEL,
  BB_DESKTOP_BROWSER_STATE_CHANNEL,
} from "./desktop-browser-ipc.js";
import {
  evaluatePopupRate,
  isAllowedBrowserUrl,
} from "./desktop-browser-policy.js";

const POPUP_RATE_WINDOW_MS = 10_000;
const POPUP_RATE_MAX_IN_WINDOW = 3;
const POPUP_MAX_OPEN_PER_TAB = 3;
const POPUP_MAX_OPEN_GLOBAL = 8;
const POPUP_DEFAULT_WIDTH = 520;
const POPUP_DEFAULT_HEIGHT = 700;
const POPUP_MIN_WIDTH = 320;
const POPUP_MIN_HEIGHT = 240;
const POPUP_MAX_WIDTH = 960;
const POPUP_MAX_HEIGHT = 900;

const RESIZE_SNAPSHOT_HIDE_CAP_MS = 80;
const RESIZE_SNAPSHOT_JPEG_QUALITY = 70;
const RENDERER_RECOVERY_DELAY_MS = 250;
const RENDERER_RECOVERY_MAX_ATTEMPTS = 2;

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function clampPopupDimension(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname)
  );
}

function isAllowedPopupNavigationUrl(url: string): boolean {
  if (url === "about:blank") {
    return true;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "https:" ||
    (parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname))
  );
}

function popupWindowTitle(url: string | null): string {
  if (url === null || url === "about:blank" || url.length === 0) {
    return "bb browser popup";
  }
  try {
    return `bb browser — ${new URL(url).origin}`;
  } catch {
    return "bb browser popup";
  }
}

type PopupCreateWindowOptions = BrowserWindowConstructorOptions & {
  webContents?: WebContents;
};

function guardMainFrameNavigation(
  webContents: WebContents,
  isAllowedUrl: (url: string) => boolean,
): void {
  webContents.on("will-frame-navigate", (event) => {
    if (event.isMainFrame && !isAllowedUrl(event.url)) {
      event.preventDefault();
    }
  });
  webContents.on("will-redirect", (event, url, _isInPlace, isMainFrame) => {
    if (isMainFrame && !isAllowedUrl(url)) {
      event.preventDefault();
    }
  });
}

const BB_BROWSER_PARTITION = "persist:bb-browser";

const ERR_ABORTED = -3;

export type DesktopBrowserTabProfile =
  | { kind: "personal" }
  | { kind: "automation"; id: string };

export interface DesktopBrowserNativeTab extends BbDesktopBrowserState {
  threadId: string;
  generation: string;
  profile: DesktopBrowserTabProfile;
  presentation: "hidden" | "reveal";
}

interface NativeTabScope {
  hostWebContentsId: number;
  threadId: string | null;
}

interface NativeTabRef extends NativeTabScope {
  threadId: string;
  tabId: string;
  generation: string;
}

interface BrowserViewEntry {
  view: WebContentsView;
  hostWindow: DesktopBrowserHostWindow;
  threadId: string;
  generation: string;
  profile: DesktopBrowserTabProfile;
  partition: string;
  lastErrorText: string | null;
  desiredBounds: BbDesktopBrowserViewBounds;
  popupTimestamps: number[];
  popupWindows: Set<BrowserWindow>;
  rendererRecoveryAttempts: number;
  rendererRecoveryState: "healthy" | "pending" | "blocked";
  rendererRecoveryTimer: ReturnType<typeof setTimeout> | null;
  suppressNextFocusNotification: boolean;
  visible: boolean;
  activeFindRequestId: number | null;
}

export type DesktopBrowserHostWebContentsPayload =
  | BbDesktopBrowserControlState
  | BbDesktopBrowserRevealRequest
  | BbDesktopBrowserState
  | BbDesktopBrowserOpenTabRequest
  | BbDesktopBrowserScopedOpenTabRequest
  | BbDesktopBrowserSnapshot
  | BbDesktopBrowserTabRef
  | BbDesktopBrowserFindResult;

export interface DesktopBrowserHostContentBounds {
  height: number;
  width: number;
}

export interface DesktopBrowserHostContentView {
  addChildView(view: WebContentsView): void;
  removeChildView(view: WebContentsView): void;
}

export interface DesktopBrowserHostWebContents {
  id: number;
  isDestroyed(): boolean;
  send(channel: string, payload: DesktopBrowserHostWebContentsPayload): void;
}

export interface DesktopBrowserHostWindow {
  contentView: DesktopBrowserHostContentView;
  getContentBounds(): DesktopBrowserHostContentBounds;
  isDestroyed(): boolean;
  webContents: DesktopBrowserHostWebContents;
}

interface DispatchDesktopBrowserAppCommandArgs {
  command: AppCommandId;
  hostWebContentsId: number;
}

export interface CreateDesktopBrowserViewManagerArgs {
  dispatchAppCommand: (args: DispatchDesktopBrowserAppCommandArgs) => void;
  focusHostWebContents: (hostWebContentsId: number) => void;
  partition?: string;
  resolveAppCommand: (input: AppShortcutInput) => AppCommandId | null;
}

interface HostScopedRequestArgs<TRequest> {
  hostWindow: DesktopBrowserHostWindow;
  request: TRequest;
}

interface HostScopedTabArgs {
  hostWindow: DesktopBrowserHostWindow;
  tabId: string;
}

interface CreateEntryArgs {
  desiredBounds: BbDesktopBrowserViewBounds;
  hostWindow: DesktopBrowserHostWindow;
  tabId: string;
  threadId: string;
  profile: DesktopBrowserTabProfile;
}

interface HostWindowViewportBoundsArgs {
  hostWindow: DesktopBrowserHostWindow;
}

interface SetEntryDesiredBoundsArgs {
  bounds: BbDesktopBrowserViewBounds;
  entry: BrowserViewEntry;
  hostWindow: DesktopBrowserHostWindow;
}

export interface DesktopBrowserViewManager {
  createTab(args: {
    hostWindow: DesktopBrowserHostWindow;
    tabId: string;
    threadId: string;
    url: string;
    profile: DesktopBrowserTabProfile;
    viewport: BbDesktopBrowserViewportBounds;
  }): DesktopBrowserNativeTab;
  listTabs(args: NativeTabScope): DesktopBrowserNativeTab[];
  closeTab(args: NativeTabRef): void;
  captureTab(
    args: NativeTabRef & {
      maxWidth: number;
      maxHeight: number;
      quality: number;
    },
  ): Promise<{ data: Buffer; width: number; height: number }>;
  getAutomationTabs(args: {
    hostWebContentsId: number;
    threadId: string;
  }): Array<{ tabId: string; webContents: WebContents }>;
  subscribeAutomationTabs(listener: () => void): () => void;
  attach(args: HostScopedRequestArgs<BbDesktopBrowserAttachRequest>): void;
  detach(args: HostScopedTabArgs): void;
  focus(args: HostScopedTabArgs): void;
  navigate(args: HostScopedRequestArgs<BbDesktopBrowserNavigateRequest>): void;
  goBack(args: HostScopedTabArgs): void;
  goForward(args: HostScopedTabArgs): void;
  reload(args: HostScopedTabArgs): void;
  stop(args: HostScopedTabArgs): void;
  setBounds(
    args: HostScopedRequestArgs<BbDesktopBrowserSetBoundsRequest>,
  ): void;
  setVisible(
    args: HostScopedRequestArgs<BbDesktopBrowserSetVisibleRequest>,
  ): void;
  setVisibleWithoutFocus(
    args: HostScopedRequestArgs<BbDesktopBrowserSetVisibleRequest>,
  ): void;
  findInPage(
    args: HostScopedRequestArgs<BbDesktopBrowserFindInPageRequest>,
  ): void;
  stopFindInPage(
    args: HostScopedRequestArgs<BbDesktopBrowserStopFindInPageRequest>,
  ): void;
  beginWindowResize(hostWindow: DesktopBrowserHostWindow): void;
  endWindowResize(hostWindow: DesktopBrowserHostWindow): void;
  prepareWindowReload(hostWindow: DesktopBrowserHostWindow): void;
  releaseWindow(hostWebContentsId: number): void;
  destroyAll(): void;
}

function browserViewKey(
  hostWindow: DesktopBrowserHostWindow,
  tabId: string,
): string {
  return `${hostWindow.webContents.id}:${tabId}`;
}

function send(
  hostWindow: DesktopBrowserHostWindow,
  channel: string,
  payload: DesktopBrowserHostWebContentsPayload,
): void {
  if (hostWindow.isDestroyed() || hostWindow.webContents.isDestroyed()) {
    return;
  }
  hostWindow.webContents.send(channel, payload);
}

function hostWindowViewportBounds(
  args: HostWindowViewportBoundsArgs,
): BbDesktopBrowserViewportBounds {
  const contentBounds = args.hostWindow.getContentBounds();
  return {
    width: contentBounds.width,
    height: contentBounds.height,
  };
}

function applyEntryDesiredBounds(
  entry: BrowserViewEntry,
  hostWindow: DesktopBrowserHostWindow,
): void {
  entry.view.setBounds(
    clampBbDesktopBrowserViewBounds({
      bounds: entry.desiredBounds,
      viewport: hostWindowViewportBounds({ hostWindow }),
    }),
  );
}

function setEntryDesiredBounds(args: SetEntryDesiredBoundsArgs): void {
  args.entry.desiredBounds = args.bounds;
  applyEntryDesiredBounds(args.entry, args.hostWindow);
}

function buildBrowserState(
  tabId: string,
  entry: BrowserViewEntry,
): BbDesktopBrowserState {
  const webContents = entry.view.webContents;
  const url = webContents.getURL();
  const rawTitle = webContents.getTitle();
  const title = rawTitle.length > 0 && rawTitle !== url ? rawTitle : null;
  return {
    tabId,
    url: truncate(url, BB_DESKTOP_BROWSER_MAX_URL_LENGTH),
    title:
      title === null
        ? null
        : truncate(title, BB_DESKTOP_BROWSER_MAX_TITLE_LENGTH),
    isLoading: webContents.isLoadingMainFrame(),
    canGoBack: webContents.navigationHistory.canGoBack(),
    canGoForward: webContents.navigationHistory.canGoForward(),
    errorText:
      entry.lastErrorText === null
        ? null
        : truncate(entry.lastErrorText, BB_DESKTOP_BROWSER_MAX_TITLE_LENGTH),
  };
}

export function isAllowedBrowserPermission(permission: string): boolean {
  return permission === "clipboard-sanitized-write";
}

export function createDesktopBrowserViewManager(
  args: CreateDesktopBrowserViewManagerArgs,
): DesktopBrowserViewManager {
  const partition = args.partition ?? BB_BROWSER_PARTITION;
  const entries = new Map<string, BrowserViewEntry>();
  const entriesByWebContentsId = new Map<number, BrowserViewEntry>();
  const automationTabListeners = new Set<() => void>();
  const popupWindows = new Set<BrowserWindow>();
  const resizingHostIds = new Set<number>();
  const hardenedSessions = new Map<string, Session>();

  function notifyAutomationTabs(): void {
    for (const listener of automationTabListeners) {
      listener();
    }
  }

  function isHostResizing(hostWindow: DesktopBrowserHostWindow): boolean {
    return resizingHostIds.has(hostWindow.webContents.id);
  }

  function applyEntryVisibility(
    entry: BrowserViewEntry,
    hostWindow: DesktopBrowserHostWindow,
  ): void {
    if (entry.view.webContents.isDestroyed()) {
      return;
    }
    entry.view.setVisible(
      entry.visible &&
        entry.rendererRecoveryState === "healthy" &&
        !isHostResizing(hostWindow),
    );
  }

  function clearEntryRendererRecoveryTimer(entry: BrowserViewEntry): void {
    if (entry.rendererRecoveryTimer !== null) {
      clearTimeout(entry.rendererRecoveryTimer);
      entry.rendererRecoveryTimer = null;
    }
  }

  function resetEntryRendererRecovery(entry: BrowserViewEntry): void {
    clearEntryRendererRecoveryTimer(entry);
    entry.rendererRecoveryAttempts = 0;
    entry.rendererRecoveryState = "healthy";
  }

  function scheduleEntryRendererRecovery(
    entry: BrowserViewEntry,
    hostWindow: DesktopBrowserHostWindow,
    tabId: string,
  ): void {
    if (
      entry.rendererRecoveryState !== "pending" ||
      !entry.visible ||
      entry.rendererRecoveryTimer !== null
    ) {
      return;
    }
    if (entry.rendererRecoveryAttempts >= RENDERER_RECOVERY_MAX_ATTEMPTS) {
      entry.rendererRecoveryState = "blocked";
      entry.lastErrorText = "The page renderer stopped repeatedly";
      pushState(hostWindow, tabId);
      return;
    }
    entry.rendererRecoveryTimer = setTimeout(() => {
      entry.rendererRecoveryTimer = null;
      const webContents = entry.view.webContents;
      if (
        webContents.isDestroyed() ||
        entry.rendererRecoveryState !== "pending" ||
        !entry.visible
      ) {
        return;
      }
      entry.rendererRecoveryAttempts += 1;
      entry.rendererRecoveryState = "healthy";
      entry.lastErrorText = null;
      webContents.reload();
      applyEntryVisibility(entry, hostWindow);
    }, RENDERER_RECOVERY_DELAY_MS);
  }

  function startResizeSnapshot(
    hostWindow: DesktopBrowserHostWindow,
    tabId: string,
    entry: BrowserViewEntry,
  ): void {
    const hideCap = setTimeout(() => {
      applyEntryVisibility(entry, hostWindow);
    }, RESIZE_SNAPSHOT_HIDE_CAP_MS);
    entry.view.webContents
      .capturePage()
      .then((image) => {
        if (!isHostResizing(hostWindow) || image.isEmpty()) {
          return;
        }
        const dataUrl = `data:image/jpeg;base64,${image
          .toJPEG(RESIZE_SNAPSHOT_JPEG_QUALITY)
          .toString("base64")}`;
        send(hostWindow, BB_DESKTOP_BROWSER_SNAPSHOT_CHANNEL, {
          tabId,
          dataUrl,
        });
      })
      .catch(() => {})
      .finally(() => {
        clearTimeout(hideCap);
        applyEntryVisibility(entry, hostWindow);
      });
  }

  function ensureHardenedSession(tabPartition: string): Session {
    const existing = hardenedSessions.get(tabPartition);
    if (existing !== undefined) {
      return existing;
    }
    const browserSession = session.fromPartition(tabPartition);
    browserSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(isAllowedBrowserPermission(permission));
    });
    browserSession.setPermissionCheckHandler((_wc, permission) =>
      isAllowedBrowserPermission(permission),
    );
    browserSession.on("will-download", (event) => {
      event.preventDefault();
    });
    hardenedSessions.set(tabPartition, browserSession);
    return browserSession;
  }

  function pushState(
    hostWindow: DesktopBrowserHostWindow,
    tabId: string,
  ): void {
    const entry = entries.get(browserViewKey(hostWindow, tabId));
    if (!entry || entry.view.webContents.isDestroyed()) {
      return;
    }
    send(
      hostWindow,
      BB_DESKTOP_BROWSER_STATE_CHANNEL,
      buildBrowserState(tabId, entry),
    );
  }

  function hardenedWebPreferences(tabPartition: string): WebPreferences {
    return {
      partition: tabPartition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    };
  }

  function createPopupWindow(
    options: PopupCreateWindowOptions,
    url: string,
    entry: BrowserViewEntry,
  ): WebContents {
    const popupOptions: PopupCreateWindowOptions = {
      center: true,
      frame: true,
      height: clampPopupDimension(
        options.height,
        POPUP_DEFAULT_HEIGHT,
        POPUP_MIN_HEIGHT,
        POPUP_MAX_HEIGHT,
      ),
      show: true,
      transparent: false,
      webContents: options.webContents,
      webPreferences: hardenedWebPreferences(entry.partition),
      width: clampPopupDimension(
        options.width,
        POPUP_DEFAULT_WIDTH,
        POPUP_MIN_WIDTH,
        POPUP_MAX_WIDTH,
      ),
    };
    const popupWindow = new BrowserWindow(popupOptions);
    popupWindows.add(popupWindow);
    entry.popupWindows.add(popupWindow);
    popupWindow.once("closed", () => {
      popupWindows.delete(popupWindow);
      entry.popupWindows.delete(popupWindow);
    });
    const popupContents = popupWindow.webContents;
    const updatePopupTitle = (currentUrl: string | null): void => {
      if (!popupWindow.isDestroyed()) {
        popupWindow.setTitle(popupWindowTitle(currentUrl));
      }
    };
    updatePopupTitle(popupContents.getURL());
    guardMainFrameNavigation(popupContents, isAllowedPopupNavigationUrl);
    popupContents.on("did-navigate", (_event, currentUrl) => {
      updatePopupTitle(currentUrl);
    });
    popupContents.on("page-title-updated", (event) => {
      event.preventDefault();
      updatePopupTitle(popupContents.getURL());
    });
    popupContents.setWindowOpenHandler(() => ({ action: "deny" }));
    if (options.webContents === undefined) {
      void popupWindow.loadURL(url);
    }
    return popupContents;
  }

  function wireWebContents(
    hostWindow: DesktopBrowserHostWindow,
    tabId: string,
    entry: BrowserViewEntry,
  ): void {
    const webContents = entry.view.webContents;

    webContents.on("destroyed", () => {
      const key = browserViewKey(hostWindow, tabId);
      if (entries.get(key) === entry) {
        destroyEntry(hostWindow, key);
      }
    });
    webContents.on("did-navigate", notifyAutomationTabs);
    webContents.on("did-navigate-in-page", notifyAutomationTabs);
    webContents.on("page-title-updated", notifyAutomationTabs);

    webContents.on("focus", () => {
      if (entry.suppressNextFocusNotification) {
        entry.suppressNextFocusNotification = false;
        return;
      }
      send(hostWindow, BB_DESKTOP_BROWSER_FOCUSED_CHANNEL, { tabId });
    });

    webContents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown" || input.isAutoRepeat || input.isComposing) {
        return;
      }
      const command = args.resolveAppCommand({
        altKey: input.alt,
        code: input.code,
        ctrlKey: input.control,
        key: input.key,
        metaKey: input.meta,
        shiftKey: input.shift,
      });
      if (command === null) return;
      event.preventDefault();
      if (command === "browser.focusLocation" || command === "browser.find") {
        args.focusHostWebContents(hostWindow.webContents.id);
      }
      args.dispatchAppCommand({
        command,
        hostWebContentsId: hostWindow.webContents.id,
      });
    });

    guardMainFrameNavigation(webContents, isAllowedBrowserUrl);

    webContents.setWindowOpenHandler((details) => {
      const opensPopup = details.disposition === "new-window";
      const allowedUrl = opensPopup
        ? isAllowedPopupNavigationUrl(details.url)
        : isAllowedBrowserUrl(details.url);
      const popupCapReached =
        opensPopup &&
        (entry.popupWindows.size >= POPUP_MAX_OPEN_PER_TAB ||
          popupWindows.size >= POPUP_MAX_OPEN_GLOBAL);
      if (!allowedUrl || popupCapReached) {
        return { action: "deny" };
      }
      const decision = evaluatePopupRate({
        timestamps: entry.popupTimestamps,
        now: Date.now(),
        windowMs: POPUP_RATE_WINDOW_MS,
        maxInWindow: POPUP_RATE_MAX_IN_WINDOW,
      });
      entry.popupTimestamps = decision.timestamps;
      if (!decision.allowed) {
        return { action: "deny" };
      }
      if (opensPopup) {
        return {
          action: "allow",
          createWindow: (options) =>
            createPopupWindow(options, details.url, entry),
        };
      }
      send(hostWindow, BB_DESKTOP_BROWSER_OPEN_TAB_CHANNEL, {
        url: details.url,
      });
      send(hostWindow, BB_DESKTOP_BROWSER_SCOPED_OPEN_TAB_CHANNEL, {
        tabId,
        url: details.url,
      });
      return { action: "deny" };
    });

    webContents.on("context-menu", (_event, params) => {
      if (webContents.isDestroyed()) {
        return;
      }
      const { editFlags } = params;
      const menu = Menu.buildFromTemplate([
        {
          role: "cut",
          enabled: editFlags.canCut,
        },
        {
          role: "copy",
          enabled: editFlags.canCopy && params.selectionText.length > 0,
        },
        {
          role: "paste",
          enabled: editFlags.canPaste,
        },
        { type: "separator" },
        {
          role: "selectAll",
          enabled: editFlags.canSelectAll,
        },
      ]);
      menu.popup();
    });

    webContents.on("found-in-page", (_event, result) => {
      if (result.requestId !== entry.activeFindRequestId) {
        return;
      }
      send(hostWindow, BB_DESKTOP_BROWSER_FIND_RESULT_CHANNEL, {
        tabId,
        requestId: result.requestId,
        activeMatchOrdinal: result.activeMatchOrdinal,
        matches: result.matches,
        finalUpdate: result.finalUpdate,
      });
    });

    webContents.on("render-process-gone", (_event, details) => {
      if (webContents.isDestroyed() || webContents.getURL().length === 0) {
        return;
      }
      clearEntryRendererRecoveryTimer(entry);
      entry.rendererRecoveryState = "blocked";
      if (
        details.reason === "launch-failed" ||
        details.reason === "integrity-failure"
      ) {
        entry.lastErrorText = "The page renderer could not start";
        applyEntryVisibility(entry, hostWindow);
        pushState(hostWindow, tabId);
        return;
      }
      entry.rendererRecoveryState = "pending";
      entry.lastErrorText = null;
      applyEntryVisibility(entry, hostWindow);
      scheduleEntryRendererRecovery(entry, hostWindow, tabId);
    });

    const refresh = () => pushState(hostWindow, tabId);
    webContents.on("did-finish-load", () => {
      resetEntryRendererRecovery(entry);
      applyEntryVisibility(entry, hostWindow);
      refresh();
    });
    webContents.on("did-start-loading", refresh);
    webContents.on("did-stop-loading", refresh);
    webContents.on("did-navigate", () => {
      entry.lastErrorText = null;
      refresh();
    });
    webContents.on("did-navigate-in-page", () => {
      refresh();
    });
    webContents.on("did-start-navigation", () => {
      entry.lastErrorText = null;
      refresh();
    });
    webContents.on("page-title-updated", refresh);
    webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame || errorCode === ERR_ABORTED) {
          return;
        }
        entry.lastErrorText =
          errorDescription.length > 0
            ? errorDescription
            : "Failed to load page";
        refresh();
      },
    );
  }

  function createEntry(args: CreateEntryArgs): BrowserViewEntry {
    const tabPartition =
      args.profile.kind === "personal"
        ? partition
        : `persist:bb-browser-automation-${createHash("sha256").update(args.profile.id).digest("hex")}`;
    ensureHardenedSession(tabPartition);
    const view = new WebContentsView({
      webPreferences: {
        ...hardenedWebPreferences(tabPartition),
        backgroundThrottling: args.profile.kind === "personal",
      },
    });
    const entry: BrowserViewEntry = {
      view,
      hostWindow: args.hostWindow,
      threadId: args.threadId,
      generation: randomUUID(),
      profile: { ...args.profile },
      partition: tabPartition,
      lastErrorText: null,
      desiredBounds: args.desiredBounds,
      popupTimestamps: [],
      popupWindows: new Set(),
      rendererRecoveryAttempts: 0,
      rendererRecoveryState: "healthy",
      rendererRecoveryTimer: null,
      suppressNextFocusNotification: false,
      visible: false,
      activeFindRequestId: null,
    };
    wireWebContents(args.hostWindow, args.tabId, entry);
    args.hostWindow.contentView.addChildView(view);
    entries.set(browserViewKey(args.hostWindow, args.tabId), entry);
    entriesByWebContentsId.set(view.webContents.id, entry);
    return entry;
  }

  function loadIfNeeded(entry: BrowserViewEntry, url: string): void {
    if (url.length === 0) {
      return;
    }
    if (entry.view.webContents.getURL() === url) {
      return;
    }
    if (!isAllowedBrowserUrl(url)) {
      return;
    }
    entry.lastErrorText = null;
    entry.view.webContents.loadURL(url).catch(() => {});
  }

  function destroyEntry(
    hostWindow: DesktopBrowserHostWindow,
    key: string,
  ): void {
    const entry = entries.get(key);
    if (!entry) {
      return;
    }
    entries.delete(key);
    entriesByWebContentsId.delete(entry.view.webContents.id);
    clearEntryRendererRecoveryTimer(entry);
    for (const popupWindow of [...entry.popupWindows]) {
      if (!popupWindow.isDestroyed()) popupWindow.destroy();
    }
    entry.popupWindows.clear();
    if (!hostWindow.isDestroyed()) {
      hostWindow.contentView.removeChildView(entry.view);
    }
    if (!entry.view.webContents.isDestroyed()) {
      entry.view.webContents.close();
    }
    notifyAutomationTabs();
  }

  function withEntry(
    args: HostScopedTabArgs,
    fn: (entry: BrowserViewEntry) => void,
  ): void {
    const entry = entries.get(browserViewKey(args.hostWindow, args.tabId));
    if (!entry || entry.view.webContents.isDestroyed()) {
      return;
    }
    fn(entry);
  }

  function requireNativeEntry(ref: NativeTabRef): BrowserViewEntry {
    const entry = entries.get(`${ref.hostWebContentsId}:${ref.tabId}`);
    if (
      entry === undefined ||
      entry.threadId !== ref.threadId ||
      entry.generation !== ref.generation ||
      entry.view.webContents.isDestroyed()
    ) {
      throw new Error("Native browser tab is unavailable or has been replaced");
    }
    return entry;
  }

  function nativeTab(
    tabId: string,
    entry: BrowserViewEntry,
  ): DesktopBrowserNativeTab {
    return {
      ...buildBrowserState(tabId, entry),
      threadId: entry.threadId,
      generation: entry.generation,
      profile: { ...entry.profile },
      presentation: entry.visible ? "reveal" : "hidden",
    };
  }

  function hasOtherVisibleEntry(
    hostWindow: DesktopBrowserHostWindow,
    tabId: string,
  ): boolean {
    const hostPrefix = `${hostWindow.webContents.id}:`;
    const currentKey = browserViewKey(hostWindow, tabId);
    for (const [key, entry] of entries) {
      if (key !== currentKey && key.startsWith(hostPrefix) && entry.visible) {
        return true;
      }
    }
    return false;
  }

  function focusEntryWithoutNotifying(entry: BrowserViewEntry): void {
    entry.suppressNextFocusNotification = true;
    entry.view.webContents.focus();
    setTimeout(() => {
      entry.suppressNextFocusNotification = false;
    }, 0);
  }

  function setEntryVisibility(
    {
      hostWindow,
      request,
    }: HostScopedRequestArgs<BbDesktopBrowserSetVisibleRequest>,
    focusOnShow: boolean,
  ): void {
    withEntry({ hostWindow, tabId: request.tabId }, (entry) => {
      const wasVisible = entry.visible;
      entry.visible = request.visible;
      applyEntryVisibility(entry, hostWindow);
      scheduleEntryRendererRecovery(entry, hostWindow, request.tabId);
      if (
        focusOnShow &&
        request.visible &&
        !wasVisible &&
        !hasOtherVisibleEntry(hostWindow, request.tabId) &&
        !entry.view.webContents.isDestroyed()
      ) {
        focusEntryWithoutNotifying(entry);
      }
    });
  }

  return {
    createTab(request) {
      if (!isAllowedBrowserUrl(request.url))
        throw new Error("Unsupported browser URL");
      if (
        request.hostWindow.isDestroyed() ||
        request.hostWindow.webContents.isDestroyed()
      ) {
        throw new Error("Desktop window is unavailable");
      }
      const key = browserViewKey(request.hostWindow, request.tabId);
      if (entries.has(key))
        throw new Error("Native browser tab already exists");
      const entry = createEntry({
        ...request,
        desiredBounds: { x: 0, y: 0, ...request.viewport },
      });
      applyEntryDesiredBounds(entry, request.hostWindow);
      applyEntryVisibility(entry, request.hostWindow);
      loadIfNeeded(entry, request.url);
      notifyAutomationTabs();
      pushState(request.hostWindow, request.tabId);
      return nativeTab(request.tabId, entry);
    },
    listTabs({ hostWebContentsId, threadId }) {
      const prefix = `${hostWebContentsId}:`;
      const tabs: DesktopBrowserNativeTab[] = [];
      for (const [key, entry] of entries) {
        if (
          key.startsWith(prefix) &&
          (threadId === null || entry.threadId === threadId) &&
          !entry.view.webContents.isDestroyed()
        ) {
          tabs.push(nativeTab(key.slice(prefix.length), entry));
        }
      }
      return tabs;
    },
    closeTab(ref) {
      const entry = requireNativeEntry(ref);
      destroyEntry(
        entry.hostWindow,
        browserViewKey(entry.hostWindow, ref.tabId),
      );
    },
    async captureTab(request) {
      const entry = requireNativeEntry(request);
      if (
        ![request.maxWidth, request.maxHeight].every(
          (size) => Number.isInteger(size) && size > 0 && size <= 4096,
        ) ||
        !Number.isInteger(request.quality) ||
        request.quality < 1 ||
        request.quality > 100
      ) {
        throw new Error("Invalid browser capture dimensions or quality");
      }
      const image = await captureDesktopBrowserPage(entry.view.webContents);
      requireNativeEntry(request);
      if (image.isEmpty()) throw new Error("Native browser capture is empty");
      const size = image.getSize();
      const scale = Math.min(
        1,
        request.maxWidth / size.width,
        request.maxHeight / size.height,
      );
      const resized =
        scale < 1
          ? image.resize({
              width: Math.max(1, Math.round(size.width * scale)),
              height: Math.max(1, Math.round(size.height * scale)),
            })
          : image;
      const data = resized.toJPEG(request.quality);
      if (data.byteLength > 8 * 1024 * 1024)
        throw new Error("Native browser capture exceeds the size limit");
      return { data, ...resized.getSize() };
    },
    getAutomationTabs({ hostWebContentsId, threadId }) {
      const prefix = `${hostWebContentsId}:`;
      const tabs: Array<{ tabId: string; webContents: WebContents }> = [];
      for (const [key, entry] of entries) {
        if (
          key.startsWith(prefix) &&
          entry.threadId === threadId &&
          !entry.view.webContents.isDestroyed()
        ) {
          tabs.push({
            tabId: key.slice(prefix.length),
            webContents: entry.view.webContents,
          });
        }
      }
      return tabs;
    },
    subscribeAutomationTabs(listener) {
      automationTabListeners.add(listener);
      return () => {
        automationTabListeners.delete(listener);
      };
    },
    attach({ hostWindow, request }) {
      const key = browserViewKey(hostWindow, request.tabId);
      const existing = entries.get(key) ?? null;
      if (existing === null && request.existingOnly === true) return;
      if (existing !== null && existing.threadId !== request.threadId) {
        return;
      }
      const wasVisible = existing?.visible ?? false;
      const entry =
        existing ??
        createEntry({
          desiredBounds: request.bounds,
          hostWindow,
          tabId: request.tabId,
          threadId: request.threadId,
          profile: { kind: "personal" },
        });
      setEntryDesiredBounds({ bounds: request.bounds, entry, hostWindow });
      entry.visible = request.visible;
      applyEntryVisibility(entry, hostWindow);
      if (
        request.visible &&
        !wasVisible &&
        !hasOtherVisibleEntry(hostWindow, request.tabId) &&
        !entry.view.webContents.isDestroyed()
      ) {
        focusEntryWithoutNotifying(entry);
      }
      if (existing === null) {
        loadIfNeeded(entry, request.url);
        notifyAutomationTabs();
      }
      pushState(hostWindow, request.tabId);
    },
    detach({ hostWindow, tabId }) {
      destroyEntry(hostWindow, browserViewKey(hostWindow, tabId));
    },
    focus({ hostWindow, tabId }) {
      withEntry({ hostWindow, tabId }, focusEntryWithoutNotifying);
    },
    navigate({ hostWindow, request }) {
      withEntry({ hostWindow, tabId: request.tabId }, (entry) => {
        resetEntryRendererRecovery(entry);
        applyEntryVisibility(entry, hostWindow);
        loadIfNeeded(entry, request.url);
      });
    },
    goBack({ hostWindow, tabId }) {
      withEntry({ hostWindow, tabId }, (entry) => {
        if (entry.view.webContents.navigationHistory.canGoBack()) {
          resetEntryRendererRecovery(entry);
          applyEntryVisibility(entry, hostWindow);
          entry.view.webContents.navigationHistory.goBack();
        }
      });
    },
    goForward({ hostWindow, tabId }) {
      withEntry({ hostWindow, tabId }, (entry) => {
        if (entry.view.webContents.navigationHistory.canGoForward()) {
          resetEntryRendererRecovery(entry);
          applyEntryVisibility(entry, hostWindow);
          entry.view.webContents.navigationHistory.goForward();
        }
      });
    },
    reload({ hostWindow, tabId }) {
      withEntry({ hostWindow, tabId }, (entry) => {
        resetEntryRendererRecovery(entry);
        entry.view.webContents.reload();
        applyEntryVisibility(entry, hostWindow);
      });
    },
    stop({ hostWindow, tabId }) {
      withEntry({ hostWindow, tabId }, (entry) => {
        entry.view.webContents.stop();
      });
    },
    setBounds({ hostWindow, request }) {
      withEntry({ hostWindow, tabId: request.tabId }, (entry) => {
        setEntryDesiredBounds({ bounds: request.bounds, entry, hostWindow });
      });
    },
    findInPage({ hostWindow, request }) {
      withEntry({ hostWindow, tabId: request.tabId }, (entry) => {
        entry.activeFindRequestId = entry.view.webContents.findInPage(
          request.text,
          {
            forward: request.forward,
            findNext: request.newSession,
          },
        );
      });
    },
    stopFindInPage({ hostWindow, request }) {
      withEntry({ hostWindow, tabId: request.tabId }, (entry) => {
        entry.activeFindRequestId = null;
        entry.view.webContents.stopFindInPage(request.action);
      });
    },
    setVisible({ hostWindow, request }) {
      setEntryVisibility({ hostWindow, request }, true);
    },
    setVisibleWithoutFocus({ hostWindow, request }) {
      setEntryVisibility({ hostWindow, request }, false);
    },
    beginWindowResize(hostWindow) {
      if (isHostResizing(hostWindow)) {
        return;
      }
      resizingHostIds.add(hostWindow.webContents.id);
      const prefix = `${hostWindow.webContents.id}:`;
      for (const [key, entry] of entries.entries()) {
        if (!key.startsWith(prefix) || entry.view.webContents.isDestroyed()) {
          continue;
        }
        if (entry.visible) {
          startResizeSnapshot(hostWindow, key.slice(prefix.length), entry);
        }
      }
    },
    endWindowResize(hostWindow) {
      if (!isHostResizing(hostWindow)) {
        return;
      }
      resizingHostIds.delete(hostWindow.webContents.id);
      const prefix = `${hostWindow.webContents.id}:`;
      for (const [key, entry] of entries.entries()) {
        if (!key.startsWith(prefix) || entry.view.webContents.isDestroyed()) {
          continue;
        }
        if (entry.visible) {
          applyEntryDesiredBounds(entry, hostWindow);
        }
        applyEntryVisibility(entry, hostWindow);
        send(hostWindow, BB_DESKTOP_BROWSER_SNAPSHOT_CHANNEL, {
          tabId: key.slice(prefix.length),
          dataUrl: null,
        });
      }
    },
    prepareWindowReload(hostWindow) {
      resizingHostIds.delete(hostWindow.webContents.id);
      const prefix = `${hostWindow.webContents.id}:`;
      for (const [key, entry] of entries.entries()) {
        if (!key.startsWith(prefix) || entry.view.webContents.isDestroyed()) {
          continue;
        }
        entry.visible = false;
        applyEntryVisibility(entry, hostWindow);
      }
    },
    releaseWindow(hostWebContentsId) {
      resizingHostIds.delete(hostWebContentsId);
      const prefix = `${hostWebContentsId}:`;
      for (const [key, entry] of [...entries.entries()]) {
        if (!key.startsWith(prefix)) {
          continue;
        }
        entries.delete(key);
        entriesByWebContentsId.delete(entry.view.webContents.id);
        clearEntryRendererRecoveryTimer(entry);
        for (const popupWindow of [...entry.popupWindows]) {
          if (!popupWindow.isDestroyed()) {
            popupWindow.destroy();
          }
        }
        entry.popupWindows.clear();
        if (!entry.view.webContents.isDestroyed()) {
          entry.view.webContents.close();
        }
        notifyAutomationTabs();
      }
    },
    destroyAll() {
      resizingHostIds.clear();
      for (const popupWindow of [...popupWindows]) {
        if (!popupWindow.isDestroyed()) {
          popupWindow.destroy();
        }
      }
      popupWindows.clear();
      for (const [key, entry] of [...entries.entries()]) {
        entries.delete(key);
        entriesByWebContentsId.delete(entry.view.webContents.id);
        clearEntryRendererRecoveryTimer(entry);
        if (!entry.view.webContents.isDestroyed()) {
          entry.view.webContents.close();
        }
        notifyAutomationTabs();
      }
    },
  };
}
