import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserWindowConstructorOptions } from "electron";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDesktopWindowFactory,
  type DesktopBrowserWindow,
  type DesktopBrowserWindowCreator,
  type DesktopWindowOpenHandler,
  type DesktopWindowOpenDevToolsOptions,
  type DesktopWindowWebContents,
} from "../src/desktop-window-factory.js";
import type { DesktopContextMenuWebContents } from "../src/desktop-context-menu.js";
import { readPersistedWindowStateEntries } from "../src/window-state.js";
import {
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  type WindowBounds,
  type WindowStateKey,
} from "../src/types.js";

interface TempDir {
  path: string;
}

interface FakeDesktopWindowArgs {
  options: BrowserWindowConstructorOptions;
}

const tempDirs: TempDir[] = [];

async function createTempDir(): Promise<TempDir> {
  const path = await mkdtemp(join(tmpdir(), "bb-desktop-window-factory-"));
  const tempDir = { path };
  tempDirs.push(tempDir);
  return tempDir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (tempDir !== undefined) {
      await rm(tempDir.path, { force: true, recursive: true });
    }
  }
});

class FakeDesktopWindowWebContents implements DesktopWindowWebContents {
  public devToolsOpenCount = 0;
  public id: number;
  public readonly addedDictionaryWords: string[] = [];
  public readonly sentMessages: Array<{ channel: string; payload: unknown }> =
    [];
  public readonly spellCheckerEnabledValues: boolean[] = [];
  public readonly session: DesktopContextMenuWebContents["session"] = {
    addWordToSpellCheckerDictionary: (word) => {
      this.addedDictionaryWords.push(word);
      return true;
    },
    setSpellCheckerEnabled: (enabled) => {
      this.spellCheckerEnabledValues.push(enabled);
    },
  };
  public readonly contextMenuListeners: Parameters<
    DesktopContextMenuWebContents["on"]
  >[1][] = [];
  public readonly replacedMisspellings: string[] = [];
  public windowOpenHandler: DesktopWindowOpenHandler | null = null;
  public readonly zoomFactors: number[] = [];

  constructor(id: number) {
    this.id = id;
  }

  openDevTools(options: DesktopWindowOpenDevToolsOptions): void {
    if (options.mode === "detach") {
      this.devToolsOpenCount += 1;
    }
  }

  send(channel: string, payload: unknown): void {
    this.sentMessages.push({ channel, payload });
  }

  on(...args: Parameters<DesktopContextMenuWebContents["on"]>): void {
    const [eventName, listener] = args;
    if (eventName === "context-menu") {
      this.contextMenuListeners.push(listener);
    }
  }

  replaceMisspelling(text: string): void {
    this.replacedMisspellings.push(text);
  }

  setWindowOpenHandler(handler: DesktopWindowOpenHandler): void {
    this.windowOpenHandler = handler;
  }

  setZoomFactor(factor: number): void {
    this.zoomFactors.push(factor);
  }
}

class FakeDesktopWindow implements DesktopBrowserWindow {
  public readonly id: number;
  public readonly loadedUrls: string[] = [];
  public readonly options: BrowserWindowConstructorOptions;
  public readonly webContents: FakeDesktopWindowWebContents;
  public focused = false;
  public fullScreen = false;
  public maximized = false;
  public minimized = false;
  public shown = false;
  private destroyed = false;
  private readonly bounds: WindowBounds;
  private readonly closedListeners: Array<() => void> = [];
  private readyToShowListener: (() => void) | null = null;

  constructor(args: FakeDesktopWindowArgs) {
    this.options = args.options;
    this.id = FakeDesktopWindow.nextWindowId;
    FakeDesktopWindow.nextWindowId += 1;
    this.webContents = new FakeDesktopWindowWebContents(
      FakeDesktopWindow.nextWebContentsId,
    );
    FakeDesktopWindow.nextWebContentsId += 1;
    this.bounds = {
      height: args.options.height ?? 0,
      width: args.options.width ?? 0,
      x: args.options.x ?? 0,
      y: args.options.y ?? 0,
    };
  }

  private static nextWindowId = 1;
  private static nextWebContentsId = 1;

  emitClosed(): void {
    this.destroyed = true;
    for (const listener of this.closedListeners) {
      listener();
    }
  }

  emitReadyToShow(): void {
    this.readyToShowListener?.();
  }

  focus(): void {
    this.focused = true;
  }

  getBounds(): WindowBounds {
    return this.bounds;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  isFullScreen(): boolean {
    return this.fullScreen;
  }

  isFocused(): boolean {
    return this.focused;
  }

  isMaximized(): boolean {
    return this.maximized;
  }

  isMinimized(): boolean {
    return this.minimized;
  }

  async loadURL(url: string): Promise<void> {
    this.loadedUrls.push(url);
  }

  maximize(): void {
    this.maximized = true;
  }

  on(
    eventName: "close" | "closed" | "enter-full-screen" | "leave-full-screen",
    listener: () => void,
  ): void {
    if (eventName === "closed") {
      this.closedListeners.push(listener);
    }
  }

  once(eventName: "ready-to-show", listener: () => void): void {
    if (eventName === "ready-to-show") {
      this.readyToShowListener = listener;
    }
  }

  restore(): void {
    this.minimized = false;
  }

  setFullScreen(isFullScreen: boolean): void {
    this.fullScreen = isFullScreen;
  }

  show(): void {
    this.shown = true;
  }
}

describe("desktop window factory", () => {
  it("creates distinct windows against the existing runtime URL", async () => {
    const tempDir = await createTempDir();
    const createdWindows: FakeDesktopWindow[] = [];
    const generatedStateKeys: WindowStateKey[] = ["window-second"];
    let runtimeSupervisorInvocations = 0;
    const browserWindowCreator: DesktopBrowserWindowCreator = {
      create(options) {
        const browserWindow = new FakeDesktopWindow({ options });
        createdWindows.push(browserWindow);
        return browserWindow;
      },
    };
    const factory = createDesktopWindowFactory({
      browserWindowCreator,
      createWindowStateKey() {
        return generatedStateKeys.shift() ?? "window-fallback";
      },
      displayWorkAreas: [
        {
          height: 900,
          width: 1440,
          x: 0,
          y: 0,
        },
      ],
      icon: undefined,
      isMac: true,
      isLinuxTransparent: false,
      isLinuxFrameless: false,
      isQuitting() {
        return false;
      },
      openExternalUrl() {},
      preloadPath: "/tmp/preload.cjs",
      userDataPath: tempDir.path,
    });

    runtimeSupervisorInvocations += 1;
    const firstWindow = await factory.createWindow({
      initialUrl: "http://127.0.0.1:38886",
      stateKey: null,
    });
    const secondWindow = await factory.createWindow({
      initialUrl: "http://127.0.0.1:38886",
      stateKey: null,
    });

    expect(firstWindow).not.toBe(secondWindow);
    expect(createdWindows).toHaveLength(2);
    expect(createdWindows[0]?.options.frame).toBe(false);
    expect(createdWindows[0]?.options.minHeight).toBe(MIN_WINDOW_HEIGHT);
    expect(createdWindows[0]?.options.minWidth).toBe(MIN_WINDOW_WIDTH);
    expect(createdWindows[0]?.options.titleBarStyle).toBe("hiddenInset");
    expect(createdWindows[0]?.options.webPreferences?.spellcheck).toBe(true);
    expect(createdWindows[0]?.webContents.spellCheckerEnabledValues).toEqual([
      true,
    ]);
    expect(createdWindows[0]?.options.trafficLightPosition).toEqual({
      x: 18,
      y: 18,
    });
    expect(createdWindows[0]?.loadedUrls).toEqual(["http://127.0.0.1:38886"]);
    expect(createdWindows[1]?.loadedUrls).toEqual(["http://127.0.0.1:38886"]);
    expect(createdWindows[0]?.webContents.zoomFactors).toEqual([1]);
    expect(createdWindows[1]?.webContents.zoomFactors).toEqual([1]);
    expect(runtimeSupervisorInvocations).toBe(1);

    await factory.persistOpenWindows();
    await expect(
      readPersistedWindowStateEntries({ userDataPath: tempDir.path }),
    ).resolves.toEqual([
      {
        bounds: {
          height: 900,
          width: 1280,
          x: 80,
          y: 80,
        },
        isFullScreen: false,
        isMaximized: false,
        stateKey: "main",
      },
      {
        bounds: {
          height: 900,
          width: 1280,
          x: 80,
          y: 80,
        },
        isFullScreen: false,
        isMaximized: false,
        stateKey: "window-second",
      },
    ]);
  });

  it("allocates distinct state keys for concurrent implicit windows", async () => {
    const tempDir = await createTempDir();
    const createdWindows: FakeDesktopWindow[] = [];
    const generatedStateKeys: WindowStateKey[] = ["window-concurrent"];
    const browserWindowCreator: DesktopBrowserWindowCreator = {
      create(options) {
        const browserWindow = new FakeDesktopWindow({ options });
        createdWindows.push(browserWindow);
        return browserWindow;
      },
    };
    const factory = createDesktopWindowFactory({
      browserWindowCreator,
      createWindowStateKey() {
        return generatedStateKeys.shift() ?? "window-fallback";
      },
      displayWorkAreas: [
        {
          height: 900,
          width: 1440,
          x: 0,
          y: 0,
        },
      ],
      icon: undefined,
      isMac: true,
      isLinuxTransparent: false,
      isLinuxFrameless: false,
      isQuitting() {
        return false;
      },
      openExternalUrl() {},
      preloadPath: "/tmp/preload.cjs",
      userDataPath: tempDir.path,
    });

    const [firstWindow, secondWindow] = await Promise.all([
      factory.createWindow({
        initialUrl: "http://127.0.0.1:38886",
        stateKey: null,
      }),
      factory.createWindow({
        initialUrl: "http://127.0.0.1:38886",
        stateKey: null,
      }),
    ]);

    expect(firstWindow).not.toBe(secondWindow);
    expect(createdWindows).toHaveLength(2);

    await factory.persistOpenWindows();
    const persistedEntries = await readPersistedWindowStateEntries({
      userDataPath: tempDir.path,
    });
    const stateKeys = persistedEntries.map((entry) => entry.stateKey);

    expect(new Set(stateKeys)).toEqual(new Set(["main", "window-concurrent"]));
    expect(new Set(stateKeys).size).toBe(2);
  });

  it("opens renderer blank-target links externally and denies the popup", async () => {
    const tempDir = await createTempDir();
    const createdWindows: FakeDesktopWindow[] = [];
    const openedExternalUrls: string[] = [];
    const browserWindowCreator: DesktopBrowserWindowCreator = {
      create(options) {
        const browserWindow = new FakeDesktopWindow({ options });
        createdWindows.push(browserWindow);
        return browserWindow;
      },
    };
    const factory = createDesktopWindowFactory({
      browserWindowCreator,
      createWindowStateKey() {
        return "window-link-test";
      },
      displayWorkAreas: [
        {
          height: 900,
          width: 1440,
          x: 0,
          y: 0,
        },
      ],
      icon: undefined,
      isMac: true,
      isLinuxTransparent: false,
      isLinuxFrameless: false,
      isQuitting() {
        return false;
      },
      openExternalUrl({ url }) {
        openedExternalUrls.push(url);
      },
      preloadPath: "/tmp/preload.cjs",
      userDataPath: tempDir.path,
    });

    await factory.createWindow({
      initialUrl: "http://127.0.0.1:38886",
      stateKey: null,
    });
    const browserWindow = createdWindows[0];
    if (!browserWindow) {
      throw new Error("Expected desktop window");
    }
    const handler = browserWindow.webContents.windowOpenHandler;
    if (!handler) {
      throw new Error("Expected window open handler");
    }

    const result = handler({ url: "https://example.com/from-markdown" });

    expect(createdWindows).toHaveLength(1);
    expect(openedExternalUrls).toEqual(["https://example.com/from-markdown"]);
    expect(result).toEqual({ action: "deny" });
  });

  it("loads and focuses an existing first window when navigating by URL", async () => {
    const tempDir = await createTempDir();
    const createdWindows: FakeDesktopWindow[] = [];
    const browserWindowCreator: DesktopBrowserWindowCreator = {
      create(options) {
        const browserWindow = new FakeDesktopWindow({ options });
        createdWindows.push(browserWindow);
        return browserWindow;
      },
    };
    const factory = createDesktopWindowFactory({
      browserWindowCreator,
      createWindowStateKey() {
        return "window-navigation-test";
      },
      displayWorkAreas: [
        {
          height: 900,
          width: 1440,
          x: 0,
          y: 0,
        },
      ],
      icon: undefined,
      isMac: true,
      isLinuxTransparent: false,
      isLinuxFrameless: false,
      isQuitting() {
        return false;
      },
      openExternalUrl() {},
      preloadPath: "/tmp/preload.cjs",
      userDataPath: tempDir.path,
    });
    const initialUrl = "http://127.0.0.1:38886";
    const threadUrl = "http://127.0.0.1:38886/projects/proj_a/threads/thr_a";

    expect(await factory.loadUrlInFirstWindow({ url: threadUrl })).toBe(false);

    await factory.createWindow({
      initialUrl,
      stateKey: null,
    });
    const browserWindow = createdWindows[0];
    if (browserWindow === undefined) {
      throw new Error("Expected desktop window");
    }
    browserWindow.minimized = true;

    await expect(
      factory.loadUrlInFirstWindow({ url: threadUrl }),
    ).resolves.toBe(true);

    expect(browserWindow.loadedUrls).toEqual([initialUrl, threadUrl]);
    expect(browserWindow.minimized).toBe(false);
    expect(browserWindow.focused).toBe(true);
    expect(createdWindows).toHaveLength(1);
  });

  it("sends a renderer message to the first open window without reloading it", async () => {
    const tempDir = await createTempDir();
    const createdWindows: FakeDesktopWindow[] = [];
    const browserWindowCreator: DesktopBrowserWindowCreator = {
      create(options) {
        const browserWindow = new FakeDesktopWindow({ options });
        createdWindows.push(browserWindow);
        return browserWindow;
      },
    };
    const factory = createDesktopWindowFactory({
      browserWindowCreator,
      createWindowStateKey() {
        return "window-send-test";
      },
      displayWorkAreas: [
        {
          height: 900,
          width: 1440,
          x: 0,
          y: 0,
        },
      ],
      icon: undefined,
      isMac: true,
      isLinuxTransparent: false,
      isLinuxFrameless: false,
      isQuitting() {
        return false;
      },
      openExternalUrl() {},
      preloadPath: "/tmp/preload.cjs",
      userDataPath: tempDir.path,
    });

    expect(
      factory.sendToFirstWindow("bb:test", { path: "/threads/thr_a" }),
    ).toBe(false);

    await factory.createWindow({
      initialUrl: "http://127.0.0.1:38886",
      stateKey: null,
    });
    const browserWindow = createdWindows[0];
    if (browserWindow === undefined) {
      throw new Error("Expected desktop window");
    }

    expect(
      factory.sendToFirstWindow("bb:test", { path: "/threads/thr_a" }),
    ).toBe(true);
    expect(browserWindow.webContents.sentMessages).toEqual([
      { channel: "bb:test", payload: { path: "/threads/thr_a" } },
    ]);
    expect(browserWindow.loadedUrls).toEqual(["http://127.0.0.1:38886"]);
    expect(browserWindow.focused).toBe(true);
  });

  it("sends a renderer message to the focused window when available", async () => {
    const tempDir = await createTempDir();
    const createdWindows: FakeDesktopWindow[] = [];
    const generatedStateKeys: WindowStateKey[] = [
      "focused-window-first",
      "focused-window-second",
    ];
    const browserWindowCreator: DesktopBrowserWindowCreator = {
      create(options) {
        const browserWindow = new FakeDesktopWindow({ options });
        createdWindows.push(browserWindow);
        return browserWindow;
      },
    };
    const factory = createDesktopWindowFactory({
      browserWindowCreator,
      createWindowStateKey() {
        return generatedStateKeys.shift() ?? "focused-window-fallback";
      },
      displayWorkAreas: [
        {
          height: 900,
          width: 1440,
          x: 0,
          y: 0,
        },
      ],
      icon: undefined,
      isMac: true,
      isLinuxTransparent: false,
      isLinuxFrameless: false,
      isQuitting() {
        return false;
      },
      openExternalUrl() {},
      preloadPath: "/tmp/preload.cjs",
      userDataPath: tempDir.path,
    });

    await factory.createWindow({
      initialUrl: "http://127.0.0.1:38886",
      stateKey: null,
    });
    await factory.createWindow({
      initialUrl: "http://127.0.0.1:38886",
      stateKey: null,
    });
    const firstWindow = createdWindows[0];
    const secondWindow = createdWindows[1];
    if (firstWindow === undefined || secondWindow === undefined) {
      throw new Error("Expected desktop windows");
    }
    secondWindow.focused = true;

    expect(factory.sendToFocusedWindow("bb:test", { action: "new-tab" })).toBe(
      true,
    );

    expect(firstWindow.webContents.sentMessages).toEqual([]);
    expect(secondWindow.webContents.sentMessages).toEqual([
      { channel: "bb:test", payload: { action: "new-tab" } },
    ]);
  });

  it("uses the native window frame on Linux", async () => {
    const tempDir = await createTempDir();
    const createdWindows: FakeDesktopWindow[] = [];
    const browserWindowCreator: DesktopBrowserWindowCreator = {
      create(options) {
        const browserWindow = new FakeDesktopWindow({ options });
        createdWindows.push(browserWindow);
        return browserWindow;
      },
    };
    const factory = createDesktopWindowFactory({
      browserWindowCreator,
      createWindowStateKey() {
        return "linux-window";
      },
      displayWorkAreas: [
        {
          height: 900,
          width: 1440,
          x: 0,
          y: 0,
        },
      ],
      icon: undefined,
      isMac: false,
      isLinuxTransparent: false,
      isLinuxFrameless: false,
      isQuitting() {
        return false;
      },
      openExternalUrl() {},
      preloadPath: "/tmp/preload.cjs",
      userDataPath: tempDir.path,
    });

    await factory.createWindow({ initialUrl: null, stateKey: null });

    expect(createdWindows[0]?.options).not.toHaveProperty("frame");
    expect(createdWindows[0]?.options).not.toHaveProperty("titleBarStyle");
    expect(createdWindows[0]?.options).not.toHaveProperty(
      "trafficLightPosition",
    );
  });

  it("enables transparent Linux windows when requested", async () => {
    const tempDir = await createTempDir();
    const createdWindows: FakeDesktopWindow[] = [];
    const browserWindowCreator: DesktopBrowserWindowCreator = {
      create(options) {
        const browserWindow = new FakeDesktopWindow({ options });
        createdWindows.push(browserWindow);
        return browserWindow;
      },
    };
    const factory = createDesktopWindowFactory({
      browserWindowCreator,
      createWindowStateKey() {
        return "transparent-linux-window";
      },
      displayWorkAreas: [{ height: 900, width: 1440, x: 0, y: 0 }],
      icon: undefined,
      isLinuxTransparent: true,
      isMac: false,
      isLinuxFrameless: false,
      isQuitting() {
        return false;
      },
      openExternalUrl() {},
      preloadPath: "/tmp/preload.cjs",
      userDataPath: tempDir.path,
    });

    await factory.createWindow({ initialUrl: null, stateKey: null });

    expect(createdWindows[0]?.options.transparent).toBe(true);
    expect(createdWindows[0]?.options.backgroundColor).toBe("#00000000");
    expect(createdWindows[0]?.options).not.toHaveProperty("frame");
  });

  it("removes the native window frame when requested on Linux", async () => {
    const tempDir = await createTempDir();
    const createdWindows: FakeDesktopWindow[] = [];
    const browserWindowCreator: DesktopBrowserWindowCreator = {
      create(options) {
        const browserWindow = new FakeDesktopWindow({ options });
        createdWindows.push(browserWindow);
        return browserWindow;
      },
    };
    const factory = createDesktopWindowFactory({
      browserWindowCreator,
      createWindowStateKey() {
        return "frameless-linux-window";
      },
      displayWorkAreas: [
        {
          height: 900,
          width: 1440,
          x: 0,
          y: 0,
        },
      ],
      icon: undefined,
      isMac: false,
      isLinuxTransparent: false,
      isLinuxFrameless: true,
      isQuitting() {
        return false;
      },
      openExternalUrl() {},
      preloadPath: "/tmp/preload.cjs",
      userDataPath: tempDir.path,
    });

    await factory.createWindow({ initialUrl: null, stateKey: null });

    expect(createdWindows[0]?.options.frame).toBe(false);
    expect(createdWindows[0]?.options).not.toHaveProperty("titleBarStyle");
    expect(createdWindows[0]?.options).not.toHaveProperty(
      "trafficLightPosition",
    );
  });
});
