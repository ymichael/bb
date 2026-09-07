import { describe, expect, it } from "vitest";
import type { SessionState } from "../session/session-scheduler";
import {
  resolveShellScreenState,
  shouldReloadForSession,
  type ShellLoadPhase,
} from "./shell-state";

const READY: ShellLoadPhase = { kind: "ready" };
const IDLE: SessionState = { status: "idle" };
const AUTHENTICATED: SessionState = {
  status: "authenticated",
  expiresAt: 1_000,
};

const BASE = { storeReady: true, hasAnyProfile: true };

describe("resolveShellScreenState", () => {
  it("sends a phone with no server to the add-server screen", () => {
    expect(
      resolveShellScreenState({
        storeReady: true,
        hasAnyProfile: false,
        hasProfile: false,
        session: IDLE,
        load: { kind: "loading" },
      }),
    ).toEqual({ kind: "no-profile" });
  });

  it("waits for the profile store before deciding anything", () => {
    expect(
      resolveShellScreenState({
        storeReady: false,
        hasAnyProfile: false,
        hasProfile: false,
        session: IDLE,
        load: { kind: "loading" },
      }).kind,
    ).toBe("loading");
  });
  it("shows the page once a Direct profile is loaded", () => {
    expect(
      resolveShellScreenState({
        ...BASE,
        hasProfile: true,
        session: IDLE,
        load: READY,
      }),
    ).toEqual({ kind: "webview" });
  });

  it("asks for re-pairing when the gate rejected the credential", () => {
    const state = resolveShellScreenState({
      ...BASE,
      hasProfile: true,
      session: { status: "auth-required", detail: "credential revoked" },
      load: READY,
    });
    expect(state).toEqual({
      kind: "error",
      title: "This server needs pairing again",
      detail: "credential revoked",
      action: "re-pair",
    });
  });

  it("puts the session error ahead of any load result", () => {
    const state = resolveShellScreenState({
      ...BASE,
      hasProfile: true,
      session: { status: "error", detail: "offline", retryAt: 0 },
      load: READY,
    });
    expect(state.kind).toBe("error");
    if (state.kind !== "error") throw new Error("unreachable");
    expect(state.action).toBe("retry");
  });

  it("reports a failed load with a retry", () => {
    const state = resolveShellScreenState({
      ...BASE,
      hasProfile: true,
      session: AUTHENTICATED,
      load: { kind: "failed", detail: "The network connection was lost." },
    });
    expect(state).toEqual({
      kind: "error",
      title: "The page did not load",
      detail: "The network connection was lost.",
      action: "retry",
    });
  });

  it("reports an error status from the server", () => {
    const state = resolveShellScreenState({
      ...BASE,
      hasProfile: true,
      session: AUTHENTICATED,
      load: { kind: "http-error", status: 502 },
    });
    expect(state.kind).toBe("error");
    if (state.kind !== "error") throw new Error("unreachable");
    expect(state.detail).toBe("HTTP 502");
  });

  it("keeps the WebView mounted while a load is in flight", () => {
    expect(
      resolveShellScreenState({
        ...BASE,
        hasProfile: true,
        session: AUTHENTICATED,
        load: { kind: "loading" },
      }),
    ).toEqual({ kind: "webview" });
  });

  it("waits for the profile and for the first session mint", () => {
    expect(
      resolveShellScreenState({
        ...BASE,
        hasProfile: false,
        session: IDLE,
        load: { kind: "loading" },
      }).kind,
    ).toBe("loading");
    expect(
      resolveShellScreenState({
        ...BASE,
        hasProfile: true,
        session: { status: "authenticating" },
        load: { kind: "loading" },
      }).kind,
    ).toBe("loading");
  });
});

describe("shouldReloadForSession", () => {
  it("reloads when a fresh cookie replaces the one the page loaded with", () => {
    expect(
      shouldReloadForSession(AUTHENTICATED, {
        status: "authenticated",
        expiresAt: 2_000,
      }),
    ).toBe(true);
  });

  it("reloads on the first successful mint", () => {
    expect(
      shouldReloadForSession({ status: "authenticating" }, AUTHENTICATED),
    ).toBe(true);
  });

  it("does not reload on an unchanged session or a failure", () => {
    expect(shouldReloadForSession(AUTHENTICATED, AUTHENTICATED)).toBe(false);
    expect(
      shouldReloadForSession(AUTHENTICATED, {
        status: "error",
        detail: "offline",
        retryAt: 0,
      }),
    ).toBe(false);
    expect(shouldReloadForSession(IDLE, IDLE)).toBe(false);
  });
});
