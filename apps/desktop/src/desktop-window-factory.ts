import type { BrowserWindowConstructorOptions } from "electron";
import {
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  PRIMARY_WINDOW_STATE_KEY,
  type DisplayWorkArea,
  type WindowBounds,
  type WindowStateKey,
} from "./types.js";
import {
  persistBrowserWindowStates,
  readPersistedWindowStateEntries,
  removePersistedWindowState,
  restoreBrowserWindowState,
  type PersistBrowserWindowStateSnapshot,
  type StatefulBrowserWindow,
} from "./window-state.js";
import type { DesktopContextMenuWebContents } from "./desktop-context-menu.js";

type DesktopWindowIcon = BrowserWindowConstructorOptions["icon"];

const MACOS_TRAFFIC_LIGHT_DIAGONAL_INSET = 18;
const MACOS_TRAFFIC_LIGHT_POSITION = {
  x: MACOS_TRAFFIC_LIGHT_DIAGONAL_INSET,
  y: MACOS_TRAFFIC_LIGHT_DIAGONAL_INSET,
};

interface DesktopWindowOpenDetails {
  url: string;
}

interface DesktopWindowOpenHandlerResult {
  action: "deny";
}

export type DesktopWindowOpenHandler = (
  details: DesktopWindowOpenDetails,
) => DesktopWindowOpenHandlerResult;

export interface DesktopWindowOpenDevToolsOptions {
  mode: "detach";
}

export interface DesktopWindowWebContents extends DesktopContextMenuWebContents {
  id: number;
  openDevTools(options: DesktopWindowOpenDevToolsOptions): void;
  send(channel: string, payload: unknown): void;
  setWindowOpenHandler(handler: DesktopWindowOpenHandler): void;
  setZoomFactor(factor: number): void;
}

export interface DesktopBrowserWindow extends StatefulBrowserWindow {
  readonly id: number;
  focus(): void;
  isFocused(): boolean;
  isMinimized(): boolean;
  loadURL(url: string): Promise<void>;
  maximize(): void;
  on(
    eventName: "close" | "closed" | "enter-full-screen" | "leave-full-screen",
    listener: () => void,
  ): void;
  once(eventName: "ready-to-show", listener: () => void): void;
  restore(): void;
  setFullScreen(isFullScreen: boolean): void;
  show(): void;
  webContents: DesktopWindowWebContents;
}

export interface DesktopBrowserWindowCreator {
  create(options: BrowserWindowConstructorOptions): DesktopBrowserWindow;
}

interface OpenExternalUrlArgs {
  url: string;
}

interface CreateDesktopWindowFactoryArgs {
  browserWindowCreator: DesktopBrowserWindowCreator;
  createWindowStateKey(): WindowStateKey;
  displayWorkAreas: DisplayWorkArea[] | null;
  icon: DesktopWindowIcon;
  isLinuxTransparent: boolean;
  isMac: boolean;
  isLinuxFrameless: boolean;
  isQuitting(): boolean;
  openExternalUrl(args: OpenExternalUrlArgs): void;
  preloadPath: string;
  userDataPath: string;
}

interface CreateDesktopWindowArgs {
  initialUrl: string | null;
  stateKey: WindowStateKey | null;
}

interface RestoreDesktopWindowsArgs {
  initialUrl: string | null;
}

interface LoadDesktopWindowsUrlArgs {
  url: string;
}

export interface DesktopWindowFactory {
  createWindow(args: CreateDesktopWindowArgs): Promise<DesktopBrowserWindow>;
  focusFirstWindow(): boolean;
  hasOpenWindows(): boolean;
  sendToFocusedWindow(channel: string, payload: unknown): boolean;
  sendToFirstWindow(channel: string, payload: unknown): boolean;
  loadUrlInFirstWindow(args: LoadDesktopWindowsUrlArgs): Promise<boolean>;
  loadUrl(args: LoadDesktopWindowsUrlArgs): Promise<void>;
  openDevTools(): void;
  persistOpenWindows(): Promise<void>;
  restoreSavedWindows(
    args: RestoreDesktopWindowsArgs,
  ): Promise<DesktopBrowserWindow[]>;
}

interface ResolveWindowStateKeyArgs {
  activeWindows: Map<WindowStateKey, DesktopBrowserWindow>;
  createWindowStateKey(): WindowStateKey;
  pendingStateKeys: Set<WindowStateKey>;
  requestedStateKey: WindowStateKey | null;
}

interface LoadUrlIntoWindowArgs {
  browserWindow: DesktopBrowserWindow;
  url: string;
}

interface CreateWindowOptionsArgs {
  bounds: WindowBounds;
  icon: DesktopWindowIcon;
  isLinuxTransparent: boolean;
  isMac: boolean;
  isLinuxFrameless: boolean;
  preloadPath: string;
}

function resolveWindowStateKey(
  args: ResolveWindowStateKeyArgs,
): WindowStateKey {
  if (args.requestedStateKey !== null) {
    return args.requestedStateKey;
  }
  if (
    !args.activeWindows.has(PRIMARY_WINDOW_STATE_KEY) &&
    !args.pendingStateKeys.has(PRIMARY_WINDOW_STATE_KEY)
  ) {
    return PRIMARY_WINDOW_STATE_KEY;
  }

  let stateKey = args.createWindowStateKey();
  while (
    args.activeWindows.has(stateKey) ||
    args.pendingStateKeys.has(stateKey)
  ) {
    stateKey = args.createWindowStateKey();
  }
  return stateKey;
}

function createWindowOptions(
  args: CreateWindowOptionsArgs,
): BrowserWindowConstructorOptions {
  return {
    ...(args.isLinuxFrameless ? { frame: false } : {}),
    ...(args.isLinuxTransparent
      ? { backgroundColor: "#00000000", transparent: true }
      : {}),
    ...(args.isMac
      ? {
          frame: false,
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: MACOS_TRAFFIC_LIGHT_POSITION,
        }
      : {}),
    height: args.bounds.height,
    icon: args.icon,
    minHeight: MIN_WINDOW_HEIGHT,
    minWidth: MIN_WINDOW_WIDTH,
    show: false,
    title: "bb",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: args.preloadPath,
      sandbox: true,
      spellcheck: true,
    },
    width: args.bounds.width,
    x: args.bounds.x,
    y: args.bounds.y,
  };
}

async function loadUrlIntoWindow(args: LoadUrlIntoWindowArgs): Promise<void> {
  args.browserWindow.webContents.setZoomFactor(1);
  try {
    await args.browserWindow.loadURL(args.url);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("ERR_ABORTED")) {
      return;
    }
    throw error;
  }
}

export function createDesktopWindowFactory(
  args: CreateDesktopWindowFactoryArgs,
): DesktopWindowFactory {
  const activeWindows = new Map<WindowStateKey, DesktopBrowserWindow>();
  const pendingStateKeys = new Set<WindowStateKey>();

  async function createWindow(
    createArgs: CreateDesktopWindowArgs,
  ): Promise<DesktopBrowserWindow> {
    const stateKey = resolveWindowStateKey({
      activeWindows,
      createWindowStateKey: args.createWindowStateKey,
      pendingStateKeys,
      requestedStateKey: createArgs.stateKey,
    });
    pendingStateKeys.add(stateKey);

    try {
      const restoredState = await restoreBrowserWindowState({
        displayWorkAreas: args.displayWorkAreas,
        stateKey,
        userDataPath: args.userDataPath,
      });
      const browserWindow = args.browserWindowCreator.create(
        createWindowOptions({
          bounds: restoredState.bounds,
          icon: args.icon,
          isLinuxTransparent: args.isLinuxTransparent,
          isMac: args.isMac,
          isLinuxFrameless: args.isLinuxFrameless,
          preloadPath: args.preloadPath,
        }),
      );
      browserWindow.webContents.session.setSpellCheckerEnabled(true);

      activeWindows.set(stateKey, browserWindow);

      if (restoredState.isMaximized) {
        browserWindow.maximize();
      }
      if (restoredState.isFullScreen) {
        browserWindow.setFullScreen(true);
      }

      browserWindow.once("ready-to-show", () => {
        browserWindow.show();
      });
      browserWindow.on("closed", () => {
        activeWindows.delete(stateKey);
        if (!args.isQuitting()) {
          void removePersistedWindowState({
            stateKey,
            userDataPath: args.userDataPath,
          });
        }
      });
      browserWindow.webContents.setWindowOpenHandler((details) => {
        args.openExternalUrl({ url: details.url });
        return { action: "deny" };
      });

      if (createArgs.initialUrl !== null) {
        await loadUrlIntoWindow({
          browserWindow,
          url: createArgs.initialUrl,
        });
      }

      return browserWindow;
    } finally {
      pendingStateKeys.delete(stateKey);
    }
  }

  async function restoreSavedWindows(
    restoreArgs: RestoreDesktopWindowsArgs,
  ): Promise<DesktopBrowserWindow[]> {
    const entries = await readPersistedWindowStateEntries({
      userDataPath: args.userDataPath,
    });
    if (entries.length === 0) {
      return [
        await createWindow({
          initialUrl: restoreArgs.initialUrl,
          stateKey: PRIMARY_WINDOW_STATE_KEY,
        }),
      ];
    }

    const restoredWindows: DesktopBrowserWindow[] = [];
    for (const entry of entries) {
      restoredWindows.push(
        await createWindow({
          initialUrl: restoreArgs.initialUrl,
          stateKey: entry.stateKey,
        }),
      );
    }
    return restoredWindows;
  }

  async function loadUrl(args: LoadDesktopWindowsUrlArgs): Promise<void> {
    const loadPromises: Promise<void>[] = [];
    for (const browserWindow of activeWindows.values()) {
      loadPromises.push(
        loadUrlIntoWindow({
          browserWindow,
          url: args.url,
        }),
      );
    }
    await Promise.all(loadPromises);
  }

  function focusFirstWindow(): boolean {
    for (const browserWindow of activeWindows.values()) {
      if (browserWindow.isMinimized()) {
        browserWindow.restore();
      }
      browserWindow.focus();
      return true;
    }
    return false;
  }

  async function loadUrlInFirstWindow(
    loadArgs: LoadDesktopWindowsUrlArgs,
  ): Promise<boolean> {
    for (const browserWindow of activeWindows.values()) {
      if (browserWindow.isMinimized()) {
        browserWindow.restore();
      }
      await loadUrlIntoWindow({
        browserWindow,
        url: loadArgs.url,
      });
      browserWindow.focus();
      return true;
    }
    return false;
  }

  function sendToFirstWindow(channel: string, payload: unknown): boolean {
    for (const browserWindow of activeWindows.values()) {
      if (browserWindow.isMinimized()) {
        browserWindow.restore();
      }
      browserWindow.webContents.send(channel, payload);
      browserWindow.focus();
      return true;
    }
    return false;
  }

  function sendToFocusedWindow(channel: string, payload: unknown): boolean {
    for (const browserWindow of activeWindows.values()) {
      if (!browserWindow.isFocused()) {
        continue;
      }
      browserWindow.webContents.send(channel, payload);
      return true;
    }
    return sendToFirstWindow(channel, payload);
  }

  function openDevTools(): void {
    for (const browserWindow of activeWindows.values()) {
      browserWindow.webContents.openDevTools({ mode: "detach" });
    }
  }

  async function persistOpenWindows(): Promise<void> {
    const snapshots: PersistBrowserWindowStateSnapshot[] = [];
    for (const [stateKey, browserWindow] of activeWindows.entries()) {
      snapshots.push({ browserWindow, stateKey });
    }

    await persistBrowserWindowStates({
      snapshots,
      userDataPath: args.userDataPath,
    });
  }

  return {
    createWindow,
    focusFirstWindow,
    hasOpenWindows() {
      return activeWindows.size > 0;
    },
    sendToFocusedWindow,
    sendToFirstWindow,
    loadUrlInFirstWindow,
    loadUrl,
    openDevTools,
    persistOpenWindows,
    restoreSavedWindows,
  };
}
