import { contextBridge, ipcRenderer, webFrame } from "electron";
import { appCommandIdSchema } from "@bb/domain";
import {
  bbDesktopBrowserFindResultSchema,
  bbDesktopBrowserOpenTabRequestSchema,
  bbDesktopBrowserScopedOpenTabRequestSchema,
  bbDesktopBrowserTabRefSchema,
  bbDesktopBrowserSnapshotSchema,
  bbDesktopBrowserStateSchema,
  bbDesktopBrowserTargetSchema,
  bbDesktopBrowserControlStateSchema,
  bbDesktopBrowserRevealRequestSchema,
  type BbDesktopBrowserControlState,
  type BbDesktopBrowserRevealRequest,
  bbDesktopInfoSchema,
  bbDesktopWindowStateSchema,
  type BbDesktopApi,
  type BbDesktopAppCommandHandler,
  type BbDesktopBrowserApi,
  type BbDesktopBrowserFindResultHandler,
  type BbDesktopBrowserOpenTabHandler,
  type BbDesktopBrowserScopedOpenTabHandler,
  type BbDesktopBrowserFocusHandler,
  type BbDesktopBrowserSnapshotHandler,
  type BbDesktopBrowserStateHandler,
  type BbDesktopBrowserUnsubscribe,
  type BbDesktopBrowserViewBounds,
  type BbDesktopCloseWindowRequestHandler,
  type BbDesktopInfo,
  type BbDesktopInfoChangeHandler,
  type BbDesktopInfoUnsubscribe,
  type BbDesktopOpenNewTabHandler,
  type BbDesktopTheme,
  type BbDesktopWindowState,
  type BbDesktopWindowStateChangeHandler,
} from "@bb/desktop-contract";
import {
  BB_DESKTOP_CHECK_FOR_UPDATES_CHANNEL,
  BB_DESKTOP_GET_INFO_CHANNEL,
  BB_DESKTOP_INFO_CHANGED_CHANNEL,
  BB_DESKTOP_INSTALL_UPDATE_CHANNEL,
  BB_DESKTOP_OPEN_EXTERNAL_URL_CHANNEL,
  BB_DESKTOP_SET_THEME_CHANNEL,
} from "./desktop-update-ipc.js";
import {
  BB_DESKTOP_BROWSER_ATTACH_CHANNEL,
  BB_DESKTOP_BROWSER_TARGET_CHANNEL,
  BB_DESKTOP_BROWSER_GET_CONTROL_CHANNEL,
  BB_DESKTOP_BROWSER_CONTROL_CHANNEL,
  BB_DESKTOP_BROWSER_RELEASE_CONTROL_CHANNEL,
  BB_DESKTOP_BROWSER_REVEAL_CHANNEL,
  BB_DESKTOP_BROWSER_DETACH_CHANNEL,
  BB_DESKTOP_BROWSER_FOCUS_CHANNEL,
  BB_DESKTOP_BROWSER_FOCUSED_CHANNEL,
  BB_DESKTOP_BROWSER_FIND_IN_PAGE_CHANNEL,
  BB_DESKTOP_BROWSER_FIND_RESULT_CHANNEL,
  BB_DESKTOP_BROWSER_GO_BACK_CHANNEL,
  BB_DESKTOP_BROWSER_GO_FORWARD_CHANNEL,
  BB_DESKTOP_BROWSER_NAVIGATE_CHANNEL,
  BB_DESKTOP_BROWSER_OPEN_TAB_CHANNEL,
  BB_DESKTOP_BROWSER_RELOAD_CHANNEL,
  BB_DESKTOP_BROWSER_SCOPED_OPEN_TAB_CHANNEL,
  BB_DESKTOP_BROWSER_SET_BOUNDS_CHANNEL,
  BB_DESKTOP_BROWSER_SET_VISIBLE_CHANNEL,
  BB_DESKTOP_BROWSER_SET_VISIBLE_WITHOUT_FOCUS_CHANNEL,
  BB_DESKTOP_BROWSER_SNAPSHOT_CHANNEL,
  BB_DESKTOP_BROWSER_STATE_CHANNEL,
  BB_DESKTOP_BROWSER_STOP_CHANNEL,
  BB_DESKTOP_BROWSER_STOP_FIND_IN_PAGE_CHANNEL,
} from "./desktop-browser-ipc.js";
import {
  BB_DESKTOP_APP_COMMAND_CHANNEL,
  BB_DESKTOP_CLOSE_WINDOW_REQUEST_CHANNEL,
  BB_DESKTOP_CLOSE_WINDOW_RESPONSE_CHANNEL,
  BB_DESKTOP_GET_WINDOW_STATE_CHANNEL,
  BB_DESKTOP_OPEN_NEW_TAB_CHANNEL,
  BB_DESKTOP_OPEN_SERVER_DAEMON_LOGS_CHANNEL,
  BB_DESKTOP_WINDOW_STATE_CHANGED_CHANNEL,
} from "./desktop-window-command-ipc.js";
import { resolveBbDesktopPlatform } from "./desktop-platform.js";

function getDesktopVersion(version: string | undefined): string {
  if (version === undefined || version.length === 0) {
    throw new Error("Desktop version must be injected at build time");
  }
  return version;
}

function createInitialDesktopInfo(): BbDesktopInfo {
  return {
    downloadState: "idle",
    lastCheckedAt: null,
    latestVersion: null,
    pendingVersion: null,
    platform: resolveBbDesktopPlatform(process.platform),
    updateAvailable: false,
    updateDownloaded: false,
    version: getDesktopVersion(process.env.BB_DESKTOP_VERSION),
  };
}

function createInitialDesktopWindowState(): BbDesktopWindowState {
  return {
    isFullScreen: false,
  };
}

const listeners = new Set<BbDesktopInfoChangeHandler>();
const appCommandListeners = new Set<BbDesktopAppCommandHandler>();
const windowStateListeners = new Set<BbDesktopWindowStateChangeHandler>();
let currentInfo = createInitialDesktopInfo();
let currentWindowState = createInitialDesktopWindowState();

function notifyListeners(): void {
  for (const listener of listeners) {
    listener(currentInfo);
  }
}

function notifyWindowStateListeners(): void {
  for (const listener of windowStateListeners) {
    listener(currentWindowState);
  }
}

function applyDesktopInfoPayload(payload: unknown): BbDesktopInfo | null {
  const parsed = bbDesktopInfoSchema.safeParse(payload);
  if (!parsed.success) {
    return null;
  }
  currentInfo = parsed.data;
  notifyListeners();
  return currentInfo;
}

function applyDesktopWindowStatePayload(
  payload: unknown,
): BbDesktopWindowState | null {
  const parsed = bbDesktopWindowStateSchema.safeParse(payload);
  if (!parsed.success) {
    return null;
  }
  currentWindowState = parsed.data;
  notifyWindowStateListeners();
  return currentWindowState;
}

async function invokeDesktopInfo(channel: string): Promise<BbDesktopInfo> {
  try {
    const payload: unknown = await ipcRenderer.invoke(channel);
    return applyDesktopInfoPayload(payload) ?? currentInfo;
  } catch {
    return currentInfo;
  }
}

async function invokeDesktopWindowState(): Promise<BbDesktopWindowState> {
  try {
    const payload: unknown = await ipcRenderer.invoke(
      BB_DESKTOP_GET_WINDOW_STATE_CHANNEL,
    );
    return applyDesktopWindowStatePayload(payload) ?? currentWindowState;
  } catch {
    return currentWindowState;
  }
}

async function invokeInstallUpdate(): Promise<void> {
  try {
    await ipcRenderer.invoke(BB_DESKTOP_INSTALL_UPDATE_CHANNEL);
  } catch {
    return;
  }
}

const browserStateListeners = new Set<BbDesktopBrowserStateHandler>();
const browserControlListeners = new Set<
  (state: BbDesktopBrowserControlState) => void
>();
const browserRevealListeners = new Set<
  (request: BbDesktopBrowserRevealRequest) => void
>();
const browserOpenTabListeners = new Set<BbDesktopBrowserOpenTabHandler>();
const browserScopedOpenTabListeners =
  new Set<BbDesktopBrowserScopedOpenTabHandler>();
const browserFocusListeners = new Set<BbDesktopBrowserFocusHandler>();
const browserSnapshotListeners = new Set<BbDesktopBrowserSnapshotHandler>();
const browserFindResultListeners = new Set<BbDesktopBrowserFindResultHandler>();
const closeWindowRequestListeners =
  new Set<BbDesktopCloseWindowRequestHandler>();
const openNewTabListeners = new Set<BbDesktopOpenNewTabHandler>();

function browserViewBoundsAtWindowScale(
  bounds: BbDesktopBrowserViewBounds,
): BbDesktopBrowserViewBounds {
  const zoomFactor = webFrame.getZoomFactor();
  if (zoomFactor === 1) {
    return bounds;
  }
  const x = Math.round(bounds.x * zoomFactor);
  const y = Math.round(bounds.y * zoomFactor);
  return {
    x,
    y,
    width: Math.max(0, Math.round((bounds.x + bounds.width) * zoomFactor) - x),
    height: Math.max(
      0,
      Math.round((bounds.y + bounds.height) * zoomFactor) - y,
    ),
  };
}

const bbBrowserApi: BbDesktopBrowserApi = {
  async getTarget() {
    return bbDesktopBrowserTargetSchema
      .nullable()
      .parse(await ipcRenderer.invoke(BB_DESKTOP_BROWSER_TARGET_CHANNEL));
  },
  async getControl(tabId) {
    return bbDesktopBrowserControlStateSchema.nullable().parse(
      await ipcRenderer.invoke(BB_DESKTOP_BROWSER_GET_CONTROL_CHANNEL, {
        tabId,
      }),
    );
  },
  releaseControl(tabId) {
    ipcRenderer.send(BB_DESKTOP_BROWSER_RELEASE_CONTROL_CHANNEL, { tabId });
  },
  onControl(listener) {
    browserControlListeners.add(listener);
    return () => {
      browserControlListeners.delete(listener);
    };
  },
  onReveal(listener) {
    browserRevealListeners.add(listener);
    return () => {
      browserRevealListeners.delete(listener);
    };
  },
  attach(request): void {
    ipcRenderer.send(BB_DESKTOP_BROWSER_ATTACH_CHANNEL, {
      ...request,
      bounds: browserViewBoundsAtWindowScale(request.bounds),
    });
  },
  detach(tabId): void {
    ipcRenderer.send(BB_DESKTOP_BROWSER_DETACH_CHANNEL, { tabId });
  },
  navigate(request): void {
    ipcRenderer.send(BB_DESKTOP_BROWSER_NAVIGATE_CHANNEL, request);
  },
  goBack(tabId): void {
    ipcRenderer.send(BB_DESKTOP_BROWSER_GO_BACK_CHANNEL, { tabId });
  },
  goForward(tabId): void {
    ipcRenderer.send(BB_DESKTOP_BROWSER_GO_FORWARD_CHANNEL, { tabId });
  },
  reload(tabId): void {
    ipcRenderer.send(BB_DESKTOP_BROWSER_RELOAD_CHANNEL, { tabId });
  },
  stop(tabId): void {
    ipcRenderer.send(BB_DESKTOP_BROWSER_STOP_CHANNEL, { tabId });
  },
  focus(tabId): void {
    ipcRenderer.send(BB_DESKTOP_BROWSER_FOCUS_CHANNEL, { tabId });
  },
  setBounds(request): void {
    ipcRenderer.send(BB_DESKTOP_BROWSER_SET_BOUNDS_CHANNEL, {
      ...request,
      bounds: browserViewBoundsAtWindowScale(request.bounds),
    });
  },
  setVisible(request): void {
    ipcRenderer.send(BB_DESKTOP_BROWSER_SET_VISIBLE_CHANNEL, request);
  },
  setVisibleWithoutFocus(request): void {
    ipcRenderer.send(
      BB_DESKTOP_BROWSER_SET_VISIBLE_WITHOUT_FOCUS_CHANNEL,
      request,
    );
  },
  onState(listener): BbDesktopBrowserUnsubscribe {
    browserStateListeners.add(listener);
    return () => {
      browserStateListeners.delete(listener);
    };
  },
  onOpenTab(listener): BbDesktopBrowserUnsubscribe {
    browserOpenTabListeners.add(listener);
    return () => {
      browserOpenTabListeners.delete(listener);
    };
  },
  onScopedOpenTab(listener): BbDesktopBrowserUnsubscribe {
    browserScopedOpenTabListeners.add(listener);
    return () => {
      browserScopedOpenTabListeners.delete(listener);
    };
  },
  onFocus(listener): BbDesktopBrowserUnsubscribe {
    browserFocusListeners.add(listener);
    return () => {
      browserFocusListeners.delete(listener);
    };
  },
  onSnapshot(listener): BbDesktopBrowserUnsubscribe {
    browserSnapshotListeners.add(listener);
    return () => {
      browserSnapshotListeners.delete(listener);
    };
  },
  findInPage(request): void {
    ipcRenderer.send(BB_DESKTOP_BROWSER_FIND_IN_PAGE_CHANNEL, request);
  },
  stopFindInPage(request): void {
    ipcRenderer.send(BB_DESKTOP_BROWSER_STOP_FIND_IN_PAGE_CHANNEL, request);
  },
  onFindResult(listener): BbDesktopBrowserUnsubscribe {
    browserFindResultListeners.add(listener);
    return () => {
      browserFindResultListeners.delete(listener);
    };
  },
};

const bbDesktopApi: BbDesktopApi = {
  browser: bbBrowserApi,
  get lastCheckedAt() {
    return currentInfo.lastCheckedAt;
  },
  get latestVersion() {
    return currentInfo.latestVersion;
  },
  get pendingVersion() {
    return currentInfo.pendingVersion;
  },
  platform: resolveBbDesktopPlatform(process.platform),
  get serverDaemonLogsAvailable() {
    return currentInfo.serverDaemonLogsAvailable;
  },
  get updateAvailable() {
    return currentInfo.updateAvailable;
  },
  get updateDownloaded() {
    return currentInfo.updateDownloaded;
  },
  version: currentInfo.version,
  checkForUpdates() {
    return invokeDesktopInfo(BB_DESKTOP_CHECK_FOR_UPDATES_CHANNEL);
  },
  getInfo() {
    return invokeDesktopInfo(BB_DESKTOP_GET_INFO_CHANNEL);
  },
  getWindowState() {
    return invokeDesktopWindowState();
  },
  installUpdate() {
    return invokeInstallUpdate();
  },
  onChange(listener: BbDesktopInfoChangeHandler): BbDesktopInfoUnsubscribe {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  onWindowStateChange(
    listener: BbDesktopWindowStateChangeHandler,
  ): BbDesktopInfoUnsubscribe {
    windowStateListeners.add(listener);
    return () => {
      windowStateListeners.delete(listener);
    };
  },
  onOpenNewTab(listener): BbDesktopInfoUnsubscribe {
    openNewTabListeners.add(listener);
    return () => {
      openNewTabListeners.delete(listener);
    };
  },
  onAppCommand(listener): BbDesktopInfoUnsubscribe {
    appCommandListeners.add(listener);
    return () => {
      appCommandListeners.delete(listener);
    };
  },
  onCloseWindowRequest(listener): BbDesktopInfoUnsubscribe {
    closeWindowRequestListeners.add(listener);
    return () => {
      closeWindowRequestListeners.delete(listener);
    };
  },
  openExternalUrl(url: string): void {
    ipcRenderer.send(BB_DESKTOP_OPEN_EXTERNAL_URL_CHANNEL, url);
  },
  async openServerDaemonLogs(): Promise<void> {
    await ipcRenderer.invoke(BB_DESKTOP_OPEN_SERVER_DAEMON_LOGS_CHANNEL);
  },
  setTheme(theme: BbDesktopTheme): void {
    ipcRenderer.send(BB_DESKTOP_SET_THEME_CHANNEL, theme);
  },
};

ipcRenderer.on(BB_DESKTOP_INFO_CHANGED_CHANNEL, (_event, payload: unknown) => {
  applyDesktopInfoPayload(payload);
});

ipcRenderer.on(
  BB_DESKTOP_WINDOW_STATE_CHANGED_CHANNEL,
  (_event, payload: unknown) => {
    applyDesktopWindowStatePayload(payload);
  },
);

ipcRenderer.on(BB_DESKTOP_OPEN_NEW_TAB_CHANNEL, () => {
  for (const listener of openNewTabListeners) {
    listener();
  }
});

ipcRenderer.on(BB_DESKTOP_APP_COMMAND_CHANNEL, (_event, payload: unknown) => {
  const parsed = appCommandIdSchema.safeParse(payload);
  if (!parsed.success) return;
  for (const listener of appCommandListeners) {
    listener(parsed.data);
  }
});

ipcRenderer.on(BB_DESKTOP_CLOSE_WINDOW_REQUEST_CHANNEL, () => {
  let handled = false;
  for (const listener of closeWindowRequestListeners) {
    handled = listener() || handled;
  }
  ipcRenderer.send(BB_DESKTOP_CLOSE_WINDOW_RESPONSE_CHANNEL, handled);
});

ipcRenderer.on(BB_DESKTOP_BROWSER_STATE_CHANNEL, (_event, payload: unknown) => {
  const parsed = bbDesktopBrowserStateSchema.safeParse(payload);
  if (!parsed.success) {
    return;
  }
  for (const listener of browserStateListeners) {
    listener(parsed.data);
  }
});

ipcRenderer.on(
  BB_DESKTOP_BROWSER_CONTROL_CHANNEL,
  (_event, payload: unknown) => {
    const state = bbDesktopBrowserControlStateSchema.safeParse(payload);
    if (!state.success) return;
    for (const listener of browserControlListeners) listener(state.data);
  },
);

ipcRenderer.on(
  BB_DESKTOP_BROWSER_REVEAL_CHANNEL,
  (_event, payload: unknown) => {
    const request = bbDesktopBrowserRevealRequestSchema.safeParse(payload);
    if (!request.success) return;
    for (const listener of browserRevealListeners) listener(request.data);
  },
);

ipcRenderer.on(
  BB_DESKTOP_BROWSER_FOCUSED_CHANNEL,
  (_event, payload: unknown) => {
    const parsed = bbDesktopBrowserTabRefSchema.safeParse(payload);
    if (!parsed.success) {
      return;
    }
    for (const listener of browserFocusListeners) {
      listener(parsed.data.tabId);
    }
  },
);

ipcRenderer.on(
  BB_DESKTOP_BROWSER_OPEN_TAB_CHANNEL,
  (_event, payload: unknown) => {
    const parsed = bbDesktopBrowserOpenTabRequestSchema.safeParse(payload);
    if (!parsed.success) {
      return;
    }
    for (const listener of browserOpenTabListeners) {
      listener(parsed.data);
    }
  },
);

ipcRenderer.on(
  BB_DESKTOP_BROWSER_SCOPED_OPEN_TAB_CHANNEL,
  (_event, payload: unknown) => {
    const parsed =
      bbDesktopBrowserScopedOpenTabRequestSchema.safeParse(payload);
    if (!parsed.success) {
      return;
    }
    for (const listener of browserScopedOpenTabListeners) {
      listener(parsed.data);
    }
  },
);

ipcRenderer.on(
  BB_DESKTOP_BROWSER_SNAPSHOT_CHANNEL,
  (_event, payload: unknown) => {
    const parsed = bbDesktopBrowserSnapshotSchema.safeParse(payload);
    if (!parsed.success) {
      return;
    }
    for (const listener of browserSnapshotListeners) {
      listener(parsed.data);
    }
  },
);

ipcRenderer.on(
  BB_DESKTOP_BROWSER_FIND_RESULT_CHANNEL,
  (_event, payload: unknown) => {
    const parsed = bbDesktopBrowserFindResultSchema.safeParse(payload);
    if (!parsed.success) {
      return;
    }
    for (const listener of browserFindResultListeners) {
      listener(parsed.data);
    }
  },
);

void invokeDesktopInfo(BB_DESKTOP_GET_INFO_CHANNEL);
void invokeDesktopWindowState();

contextBridge.exposeInMainWorld("bbDesktop", bbDesktopApi);
