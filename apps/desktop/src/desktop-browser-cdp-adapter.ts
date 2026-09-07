import type { Event, WebContents } from "electron";
import { z } from "zod";
import { captureDesktopBrowserCdpScreenshot } from "./desktop-browser-capture.js";
import type {
  DesktopBrowserCdpAdapter,
  DesktopBrowserCdpPage,
  DesktopBrowserCdpScope,
} from "./desktop-browser-cdp.js";
import type { DesktopBrowserViewManager } from "./desktop-browser-view.js";

const cdpObjectSchema = z.record(z.string(), z.json());
const cdpMessageSchema = z.object({
  method: z.string().min(1),
  params: cdpObjectSchema,
  sessionId: z.string(),
});

interface CreateDesktopBrowserCdpAdapterArgs {
  manager: DesktopBrowserViewManager;
  createTab: DesktopBrowserCdpAdapter["createTab"];
  activateTab: DesktopBrowserCdpAdapter["activateTab"];
  closeTab: DesktopBrowserCdpAdapter["closeTab"];
}

function createPage(
  tabId: string,
  webContents: WebContents,
  isCurrent: () => boolean,
): DesktopBrowserCdpPage {
  let ownsAttachment = false;
  let generation = 0;
  let attachmentReady: Promise<void> | null = null;
  let previousBackgroundThrottling: boolean | null = null;
  let inputReady: Promise<void> | undefined;
  let inputGeneration = 0;

  function invalidateInputReadiness(): void {
    inputReady = undefined;
    inputGeneration += 1;
  }
  const nativeDebugger = webContents.debugger;

  function releaseOwnership(): void {
    ownsAttachment = false;
    generation += 1;
    attachmentReady = null;
    if (previousBackgroundThrottling !== null && !webContents.isDestroyed())
      webContents.setBackgroundThrottling(previousBackgroundThrottling);
    previousBackgroundThrottling = null;
    invalidateInputReadiness();
    webContents.off("did-start-navigation", invalidateInputReadiness);
    nativeDebugger.off("detach", releaseOwnership);
  }

  function requireCurrent(): void {
    if (webContents.isDestroyed() || !isCurrent()) {
      throw new Error("Native browser tab is no longer available");
    }
  }

  function requireAttached(): void {
    requireCurrent();
    if (!ownsAttachment || !nativeDebugger.isAttached()) {
      throw new Error("Native browser debugger is not attached");
    }
  }

  return {
    tabId,
    get url() {
      requireCurrent();
      return webContents.getURL();
    },
    get title() {
      requireCurrent();
      return webContents.getTitle();
    },
    attach() {
      requireCurrent();
      if (ownsAttachment && nativeDebugger.isAttached()) return;
      if (nativeDebugger.isAttached()) {
        throw new Error("Native browser debugger already has a controller");
      }
      nativeDebugger.attach("1.3");
      ownsAttachment = true;
      previousBackgroundThrottling = webContents.getBackgroundThrottling();
      webContents.setBackgroundThrottling(false);
      generation += 1;
      nativeDebugger.on("detach", releaseOwnership);
      webContents.on("did-start-navigation", invalidateInputReadiness);
      const attachmentGeneration = generation;
      const ready = nativeDebugger
        .sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true })
        .then((result) => {
          cdpObjectSchema.parse(result);
          if (generation === attachmentGeneration) attachmentReady = null;
        });
      attachmentReady = ready;
      void ready.catch(() => undefined);
    },
    detach() {
      if (!ownsAttachment) return;
      releaseOwnership();
      if (!webContents.isDestroyed() && nativeDebugger.isAttached()) {
        nativeDebugger.detach();
      }
    },
    async send(method, params, sessionId, signal) {
      signal?.throwIfAborted();
      requireAttached();
      const commandGeneration = generation;
      if (attachmentReady !== null) {
        await attachmentReady;
        signal?.throwIfAborted();
        requireAttached();
        if (commandGeneration !== generation)
          throw new Error("Native browser debugger attachment changed");
      }
      if (
        method === "Input.dispatchMouseEvent" ||
        method === "Input.dispatchTouchEvent"
      ) {
        const commandInputGeneration = inputGeneration;
        if (inputReady === undefined) {
          const capture = captureDesktopBrowserCdpScreenshot(webContents, {
            format: "png",
            captureBeyondViewport: false,
            optimizeForSpeed: true,
          }).then((result) => {
            z.object({ data: z.string().min(1) }).parse(result);
          });
          inputReady = capture;
          void capture.catch(() => {
            if (inputReady === capture) inputReady = undefined;
          });
        }
        await inputReady;
        signal?.throwIfAborted();
        requireAttached();
        if (
          commandGeneration !== generation ||
          commandInputGeneration !== inputGeneration
        ) {
          throw new Error("Browser view changed before input was dispatched");
        }
      }
      signal?.throwIfAborted();
      const result = cdpObjectSchema.parse(
        await (method === "Page.captureScreenshot"
          ? captureDesktopBrowserCdpScreenshot(webContents, params, sessionId)
          : nativeDebugger.sendCommand(method, params, sessionId)),
      );
      signal?.throwIfAborted();
      requireAttached();
      if (commandGeneration !== generation) {
        throw new Error("Native browser debugger attachment changed");
      }
      return result;
    },
    onMessage(listener) {
      const onMessage = (
        _event: Event,
        method: string,
        params: unknown,
        sessionId: string,
      ): void => {
        const message = cdpMessageSchema.safeParse({
          method,
          params,
          sessionId,
        });
        if (!message.success || !ownsAttachment || !isCurrent()) return;
        listener(
          message.data.method,
          message.data.params,
          message.data.sessionId,
        );
      };
      nativeDebugger.on("message", onMessage);
      return () => {
        nativeDebugger.off("message", onMessage);
      };
    },
    onDetach(listener) {
      nativeDebugger.on("detach", listener);
      return () => {
        nativeDebugger.off("detach", listener);
      };
    },
  };
}

export function createDesktopBrowserCdpAdapter(
  args: CreateDesktopBrowserCdpAdapterArgs,
): DesktopBrowserCdpAdapter {
  const pages = new WeakMap<WebContents, DesktopBrowserCdpPage>();

  function requireTab(scope: DesktopBrowserCdpScope, tabId: string): void {
    if (
      !args.manager.getAutomationTabs(scope).some((tab) => tab.tabId === tabId)
    ) {
      throw new Error("Native browser tab is outside the requested scope");
    }
  }

  return {
    listTabs(scope) {
      return args.manager
        .getAutomationTabs(scope)
        .map(({ tabId, webContents }) => {
          let page = pages.get(webContents);
          if (page === undefined) {
            const owningScope = { ...scope };
            page = createPage(tabId, webContents, () =>
              args.manager
                .getAutomationTabs(owningScope)
                .some(
                  (tab) =>
                    tab.tabId === tabId && tab.webContents === webContents,
                ),
            );
            pages.set(webContents, page);
          }
          return page;
        });
    },
    async createTab(scope, url, signal) {
      signal.throwIfAborted();
      const tabId = await args.createTab(scope, url, signal);
      signal.throwIfAborted();
      requireTab(scope, tabId);
      return tabId;
    },
    async activateTab(scope, tabId, signal) {
      signal.throwIfAborted();
      requireTab(scope, tabId);
      await args.activateTab(scope, tabId, signal);
      signal.throwIfAborted();
    },
    async closeTab(scope, tabId, signal) {
      signal.throwIfAborted();
      requireTab(scope, tabId);
      await args.closeTab(scope, tabId, signal);
      signal.throwIfAborted();
    },
    subscribe(listener) {
      return args.manager.subscribeAutomationTabs(listener);
    },
  };
}
