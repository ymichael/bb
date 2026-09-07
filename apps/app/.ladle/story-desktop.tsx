import { useEffect, type ReactNode } from "react";
import type {
  BbDesktopApi,
  BbDesktopBrowserApi,
  BbDesktopBrowserState,
  BbDesktopInfo,
} from "@bb/desktop-contract";

const STORY_DESKTOP_INFO: BbDesktopInfo = {
  lastCheckedAt: null,
  latestVersion: null,
  pendingVersion: null,
  platform: "macos",
  updateAvailable: false,
  updateDownloaded: false,
  version: "0.0.0-story",
};

function createStoryDesktopBrowserApi(
  initialState: BbDesktopBrowserState | null,
): BbDesktopBrowserApi {
  return {
    attach() {},
    detach() {},
    navigate() {},
    goBack() {},
    goForward() {},
    reload() {},
    stop() {},
    setBounds() {},
    setVisible() {},
    onState(listener) {
      let subscribed = true;
      if (initialState !== null) {
        queueMicrotask(() => {
          if (subscribed) listener(initialState);
        });
      }
      return () => {
        subscribed = false;
      };
    },
    onOpenTab() {
      return () => {};
    },
  };
}

function createStoryDesktopApi(
  browserState: BbDesktopBrowserState | null,
): BbDesktopApi {
  return {
    ...STORY_DESKTOP_INFO,
    browser: createStoryDesktopBrowserApi(browserState),
    async checkForUpdates() {
      return STORY_DESKTOP_INFO;
    },
    async getInfo() {
      return STORY_DESKTOP_INFO;
    },
    async installUpdate() {},
    onChange() {
      return () => {};
    },
    setTheme() {},
    openExternalUrl() {},
  };
}

interface WithDesktopBrowserProps {
  browserState?: BbDesktopBrowserState | null;
  children: ReactNode;
}

export function WithDesktopBrowser({
  browserState = null,
  children,
}: WithDesktopBrowserProps) {
  if (typeof window !== "undefined" && window.bbDesktop === undefined) {
    window.bbDesktop = createStoryDesktopApi(browserState);
  }
  useEffect(() => {
    return () => {
      if (typeof window !== "undefined") {
        delete window.bbDesktop;
      }
    };
  }, []);
  return <>{children}</>;
}
