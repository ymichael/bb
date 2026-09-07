// @vitest-environment jsdom

import {
  buildBridgeInjectionScript,
  parsePageToShellMessage,
  type NativeShellHandshake,
} from "@bb/mobile-bridge";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getNativeShell,
  isInsideNativeShell,
  resetNativeShellForTests,
  shellHaptic,
  shellOpenExternal,
  shellSetBadge,
  shellShare,
} from "./native-shell";

const handshake: NativeShellHandshake = {
  bridgeVersion: 1,
  appVersion: "0.39.0",
  platform: "ios",
  profileMode: "connect",
  secureContext: true,
  safeArea: { top: 59, right: 0, bottom: 34, left: 0 },
  capabilities: ["haptic", "badge", "share", "open-external", "safe-area"],
};

const posted: string[] = [];

function installShell(overrides: Partial<NativeShellHandshake> = {}): void {
  Object.defineProperty(window, "ReactNativeWebView", {
    configurable: true,
    value: {
      postMessage: (raw: string) => {
        posted.push(raw);
      },
    },
  });
  // eslint-disable-next-line no-new-func
  new Function(
    "window",
    buildBridgeInjectionScript({ ...handshake, ...overrides }),
  )(window);
  resetNativeShellForTests();
}

function lastMessage(): unknown {
  const raw = posted.at(-1);
  const parsed = parsePageToShellMessage(raw);
  if (!parsed.ok) throw new Error(`shell could not parse: ${parsed.reason}`);
  return parsed.message;
}

beforeEach(() => {
  posted.length = 0;
  resetNativeShellForTests();
});

afterEach(() => {
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, "bb");
  Reflect.deleteProperty(
    window as unknown as Record<string, unknown>,
    "ReactNativeWebView",
  );
  resetNativeShellForTests();
  vi.restoreAllMocks();
});

describe("getNativeShell", () => {
  it("reads the handshake the shell installed", () => {
    installShell();
    const shell = getNativeShell();
    expect(shell).not.toBeNull();
    expect(shell?.handshake.profileMode).toBe("connect");
    expect(shell?.safeArea()).toEqual({
      top: 59,
      right: 0,
      bottom: 34,
      left: 0,
    });
    expect(isInsideNativeShell()).toBe(true);
  });

  it("reports no shell in a plain browser", () => {
    expect(getNativeShell()).toBeNull();
    expect(isInsideNativeShell()).toBe(false);
  });

  it("ignores a global that is not a usable bridge", () => {
    Object.defineProperty(window, "bb", {
      configurable: true,
      value: { native: { post: "not a function" } },
    });
    expect(getNativeShell()).toBeNull();
  });

  it("treats a nonsense bridge version as no bridge", () => {
    installShell({ bridgeVersion: 0 });
    expect(getNativeShell()).toBeNull();
  });

  it("keeps working with a shell newer than this page", () => {
    installShell({ bridgeVersion: 99 });
    expect(getNativeShell()).not.toBeNull();
  });
});

describe("shellHaptic", () => {
  it("posts the semantic kind, leaving the mapping to the shell", () => {
    installShell();
    shellHaptic("impact-medium");
    expect(lastMessage()).toEqual({ type: "haptic", kind: "impact-medium" });
  });

  it("does nothing without the capability or the shell", () => {
    installShell({ capabilities: ["badge"] });
    shellHaptic("success");
    expect(posted).toHaveLength(0);
  });
});

describe("shellSetBadge", () => {
  it("posts a normalized count", () => {
    installShell();
    shellSetBadge(3.7);
    expect(lastMessage()).toEqual({ type: "badge", count: 3 });
    shellSetBadge(-2);
    expect(lastMessage()).toEqual({ type: "badge", count: 0 });
  });

  it("falls back to the browser Badging API", () => {
    const setAppBadge = vi.fn().mockResolvedValue(undefined);
    const clearAppBadge = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { setAppBadge, clearAppBadge });
    shellSetBadge(4);
    expect(setAppBadge).toHaveBeenCalledWith(4);
    shellSetBadge(0);
    expect(clearAppBadge).toHaveBeenCalled();
  });
});

describe("shellOpenExternal", () => {
  it("hands the link to the shell and says it took it", () => {
    installShell();
    expect(shellOpenExternal("https://example.com/docs")).toBe(true);
    expect(lastMessage()).toEqual({
      type: "open-external",
      url: "https://example.com/docs",
    });
  });

  it("declines in a plain browser so the caller can use window.open", () => {
    expect(shellOpenExternal("https://example.com/docs")).toBe(false);
  });
});

describe("shellShare", () => {
  it("resolves with the shell's answer", async () => {
    installShell();
    const promise = shellShare({ url: "https://bee.getbb.app/threads/thr_1" });
    const message = lastMessage() as { type: string; id: string };
    expect(message.type).toBe("request");
    const bridge = (
      window as unknown as {
        bb: { native: { __receive(event: unknown): void } };
      }
    ).bb.native;
    bridge.__receive({
      type: "response",
      id: message.id,
      response: { ok: true, result: { shared: true } },
    });
    await expect(promise).resolves.toBe(true);
  });

  it("returns null when the shell refuses, so the caller can copy instead", async () => {
    installShell();
    const promise = shellShare({ text: "hello" });
    const message = lastMessage() as { id: string };
    const bridge = (
      window as unknown as {
        bb: { native: { __receive(event: unknown): void } };
      }
    ).bb.native;
    bridge.__receive({
      type: "response",
      id: message.id,
      response: { ok: false, error: "no share sheet" },
    });
    await expect(promise).resolves.toBeNull();
  });

  it("uses the Web Share API when there is no shell", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { share });
    await expect(shellShare({ text: "hello" })).resolves.toBe(true);
    expect(share).toHaveBeenCalledWith({ text: "hello" });
  });

  it("reads a dismissed Web Share sheet as not shared, not as a failure", async () => {
    const share = vi
      .fn()
      .mockRejectedValue(new DOMException("cancelled", "AbortError"));
    Object.assign(navigator, { share });
    await expect(shellShare({ text: "hello" })).resolves.toBe(false);
  });

  it("returns null when nothing can share", async () => {
    Reflect.deleteProperty(
      navigator as unknown as Record<string, unknown>,
      "share",
    );
    await expect(shellShare({ text: "hello" })).resolves.toBeNull();
  });
});
