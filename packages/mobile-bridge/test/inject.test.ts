import { describe, expect, it, vi } from "vitest";
import {
  buildBridgeEventScript,
  buildBridgeInjectionScript,
  parsePageToShellMessage,
  type NativeShellApi,
  type NativeShellHandshake,
} from "../src/index.js";

const handshake: NativeShellHandshake = {
  bridgeVersion: 2,
  appVersion: "0.39.0",
  platform: "ios",
  profileMode: "connect",
  secureContext: true,
  safeArea: { top: 59, right: 0, bottom: 34, left: 0 },
  capabilities: [
    "haptic",
    "badge",
    "share",
    "open-external",
    "safe-area",
    "open-native",
  ],
};

interface FakeWindow {
  ReactNativeWebView: { postMessage(raw: string): void };
  bb?: { native?: NativeShellApi };
}

function installBridge(overrides: Partial<NativeShellHandshake> = {}) {
  const posted: string[] = [];
  const fakeWindow: FakeWindow = {
    ReactNativeWebView: {
      postMessage: (raw: string) => {
        posted.push(raw);
      },
    },
  };
  const run = (script: string) => {
    // eslint-disable-next-line no-new-func
    new Function("window", script)(fakeWindow);
  };
  run(buildBridgeInjectionScript({ ...handshake, ...overrides }));
  const native = fakeWindow.bb?.native;
  if (native === undefined) throw new Error("bridge did not install");
  return { native, posted, run, fakeWindow };
}

describe("buildBridgeInjectionScript", () => {
  it("installs the handshake the page reads at boot", () => {
    const { native } = installBridge();
    expect(native.bridgeVersion).toBe(2);
    expect(native.platform).toBe("ios");
    expect(native.profileMode).toBe("connect");
    expect(native.safeArea).toEqual({ top: 59, right: 0, bottom: 34, left: 0 });
    expect(native.capabilities).toContain("share");
  });

  it("posts a request the shell can parse, and resolves it on the reply", async () => {
    const { native, posted, run } = installBridge();
    const promise = native.request("share", {
      url: "https://bee.getbb.app/threads/thr_1",
    });
    const parsed = parsePageToShellMessage(posted[0]);
    if (!parsed.ok) throw new Error(`shell could not parse: ${parsed.reason}`);
    if (parsed.message.type !== "request") throw new Error("wrong type");
    const { id } = parsed.message;
    run(
      buildBridgeEventScript({
        type: "response",
        id,
        response: { ok: true, result: { shared: true } },
      }),
    );
    await expect(promise).resolves.toEqual({ shared: true });
  });

  it("rejects a request the shell could not perform", async () => {
    const { native, posted, run } = installBridge();
    const promise = native.request("share", { text: "hello" });
    const parsed = parsePageToShellMessage(posted[0]);
    if (!parsed.ok || parsed.message.type !== "request") {
      throw new Error("unexpected message");
    }
    run(
      buildBridgeEventScript({
        type: "response",
        id: parsed.message.id,
        response: { ok: false, error: "share sheet unavailable" },
      }),
    );
    await expect(promise).rejects.toThrow("share sheet unavailable");
  });

  it("times out a request the shell never answers", async () => {
    vi.useFakeTimers();
    try {
      const { native } = installBridge();
      const promise = native.request("share", { text: "hello" });
      const assertion = expect(promise).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(10_001);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("updates the safe area and notifies subscribers on rotation", () => {
    const { native, run } = installBridge();
    const seen: unknown[] = [];
    const unsubscribe = native.subscribe((event: unknown) => seen.push(event));
    run(
      buildBridgeEventScript({
        type: "safe-area",
        safeArea: { top: 0, right: 59, bottom: 21, left: 59 },
      }),
    );
    expect(native.safeArea).toEqual({
      top: 0,
      right: 59,
      bottom: 21,
      left: 59,
    });
    expect(seen).toHaveLength(1);
    unsubscribe();
    run(buildBridgeEventScript({ type: "resume" }));
    expect(seen).toHaveLength(1);
  });

  it("re-applies the handshake instead of installing twice", () => {
    const { native, run, fakeWindow } = installBridge();
    const seen: unknown[] = [];
    native.subscribe((event: unknown) => seen.push(event));
    run(
      buildBridgeInjectionScript({
        ...handshake,
        appVersion: "0.40.0",
        safeArea: { top: 10, right: 0, bottom: 0, left: 0 },
      }),
    );
    expect(fakeWindow.bb?.native).toBe(native);
    expect(native.appVersion).toBe("0.40.0");
    run(buildBridgeEventScript({ type: "resume" }));
    expect(seen).toHaveLength(1);
  });

  it("escapes a handshake value that would close the script tag", () => {
    const script = buildBridgeInjectionScript({
      ...handshake,
      appVersion: "</script><script>alert(1)</script>",
    });
    expect(script).not.toContain("</script>");
  });

  it("survives a page with no ReactNativeWebView", () => {
    const fakeWindow: Record<string, unknown> = {};
    // eslint-disable-next-line no-new-func
    new Function("window", buildBridgeInjectionScript(handshake))(fakeWindow);
    const native = (fakeWindow.bb as { native: NativeShellApi }).native;
    expect(() => native.post({ type: "ready", path: "/" })).not.toThrow();
  });
});
