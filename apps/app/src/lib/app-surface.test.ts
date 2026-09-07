import { APP_SURFACE_HEADER_NAME } from "@bb/config/app-surface";
import {
  buildBridgeInjectionScript,
  type NativeShellHandshake,
} from "@bb/mobile-bridge";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBbDesktopApi } from "@/test/bb-desktop-test-utils";
import { resetNativeShellForTests } from "@/lib/native-shell";
import { appSurfaceRequestInit, getAppSurface } from "./app-surface";

const mobileHandshake: NativeShellHandshake = {
  bridgeVersion: 1,
  appVersion: "0.39.0",
  platform: "ios",
  profileMode: "connect",
  secureContext: true,
  safeArea: { top: 59, right: 0, bottom: 34, left: 0 },
  capabilities: ["haptic", "badge", "share", "open-external", "safe-area"],
};

const desktopInfo = {
  lastCheckedAt: null,
  latestVersion: null,
  pendingVersion: null,
  platform: "macos",
  updateAvailable: false,
  updateDownloaded: false,
  version: "0.0.0-test",
} as const;

describe("app surface request metadata", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetNativeShellForTests();
  });

  it("defaults browser requests to the web app surface", () => {
    const init = appSurfaceRequestInit({
      headers: { "x-existing": "kept" },
    });

    const headers = new Headers(init.headers);
    expect(getAppSurface()).toBe("web");
    expect(headers.get(APP_SURFACE_HEADER_NAME)).toBe("web");
    expect(headers.get("x-existing")).toBe("kept");
  });

  it("marks Electron preload requests as desktop", () => {
    vi.stubGlobal("window", {
      bbDesktop: createBbDesktopApi(desktopInfo),
    });

    const init = appSurfaceRequestInit();

    expect(getAppSurface()).toBe("desktop");
    expect(new Headers(init.headers).get(APP_SURFACE_HEADER_NAME)).toBe(
      "desktop",
    );
  });

  it("marks requests from the bb mobile shell as mobile", () => {
    const fakeWindow: Record<string, unknown> = {
      ReactNativeWebView: { postMessage: () => {} },
    };
    // eslint-disable-next-line no-new-func
    new Function("window", buildBridgeInjectionScript(mobileHandshake))(
      fakeWindow,
    );
    vi.stubGlobal("window", fakeWindow);
    resetNativeShellForTests();

    const init = appSurfaceRequestInit();

    expect(getAppSurface()).toBe("mobile");
    expect(new Headers(init.headers).get(APP_SURFACE_HEADER_NAME)).toBe(
      "mobile",
    );
  });
});
