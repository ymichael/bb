import { ConnectListError, type DesktopSession } from "@bb/connect-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectServerProfile } from "../profiles/profile";
import type { CookieStoreLike, SessionCookieSpec } from "./cookie-store";
import { createSessionScheduler, type SessionState } from "./session-scheduler";

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

const profile: ConnectServerProfile = {
  id: "p1",
  mode: "connect",
  serverUrl: "https://bee.getbb.app",
  label: "bee",
  handle: "bee",
  credential: "bbcm_secret",
  createdAt: 0,
};

function session(expiresAt: number, value = "sess"): DesktopSession {
  return {
    cookie: {
      name: "bb_desktop_session",
      value,
      domain: ".getbb.app",
      expiresAt,
    },
  };
}

function setup() {
  const cookies: {
    url: string;
    cookie: SessionCookieSpec;
    useWebKit: boolean;
  }[] = [];
  const cookieStore: CookieStoreLike = {
    set: async (url, cookie, useWebKit) => {
      cookies.push({ url, cookie, useWebKit });
      return true;
    },
  };
  const fetchSession =
    vi.fn<(c: { credential: string }) => Promise<DesktopSession>>();
  const states: SessionState["status"][] = [];
  const scheduler = createSessionScheduler({ cookieStore, fetchSession });
  scheduler.onStateChange((s) => states.push(s.status));
  return { cookies, fetchSession, scheduler, states };
}

describe("createSessionScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T10:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("mints, installs the cookie in both stores, and renews 5 minutes before expiry", async () => {
    const { cookies, fetchSession, scheduler, states } = setup();
    fetchSession.mockResolvedValueOnce(session(Date.now() + HOUR, "one"));
    const state = await scheduler.start(profile);
    expect(state).toEqual({
      status: "authenticated",
      expiresAt: Date.now() + HOUR,
    });
    expect(fetchSession).toHaveBeenCalledWith({
      serverUrl: profile.serverUrl,
      handle: "bee",
      credential: "bbcm_secret",
    });
    expect(cookies.map((c) => c.useWebKit)).toEqual([false, true]);
    expect(cookies[0]).toMatchObject({
      url: "https://bee.getbb.app",
      cookie: {
        name: "bb_desktop_session",
        value: "one",
        domain: ".getbb.app",
        path: "/",
        secure: true,
        httpOnly: true,
        expires: new Date(Date.now() + HOUR).toISOString(),
      },
    });

    fetchSession.mockResolvedValueOnce(
      session(Date.now() + 55 * MINUTE + HOUR, "two"),
    );
    await vi.advanceTimersByTimeAsync(55 * MINUTE - 1);
    expect(fetchSession).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchSession).toHaveBeenCalledTimes(2);
    expect(cookies.at(-1)?.cookie.value).toBe("two");
    expect(states).toEqual([
      "idle",
      "authenticating",
      "authenticated",
      "authenticating",
      "authenticated",
    ]);
  });

  it("verifySession re-mints on an auth failure: fresh cookie, or auth-required when the gate refuses", async () => {
    const { cookies, fetchSession, scheduler, states } = setup();
    fetchSession.mockResolvedValueOnce(session(Date.now() + HOUR, "one"));
    await scheduler.start(profile);

    vi.setSystemTime(Date.now() + 10 * MINUTE);
    fetchSession.mockResolvedValueOnce(session(Date.now() + HOUR, "two"));
    expect(await scheduler.verifySession()).toEqual({
      status: "authenticated",
      expiresAt: Date.now() + HOUR,
    });
    expect(cookies.slice(-2).map((c) => c.cookie.value)).toEqual([
      "two",
      "two",
    ]);
    expect(states).toEqual([
      "idle",
      "authenticating",
      "authenticated",
      "authenticated",
    ]);

    fetchSession.mockRejectedValueOnce(new TypeError("Network request failed"));
    expect(await scheduler.verifySession()).toEqual({
      status: "authenticated",
      expiresAt: Date.now() + HOUR,
    });
    expect(scheduler.getState().status).toBe("authenticated");
    fetchSession.mockResolvedValueOnce(session(Date.now() + 2 * HOUR, "three"));
    await vi.advanceTimersByTimeAsync(55 * MINUTE);
    expect(cookies.at(-1)?.cookie.value).toBe("three");

    fetchSession.mockRejectedValueOnce(
      new ConnectListError("unauthorized", "revoked"),
    );
    expect(await scheduler.verifySession()).toEqual({
      status: "auth-required",
      detail: "revoked",
    });
    const calls = fetchSession.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3 * HOUR);
    expect(fetchSession).toHaveBeenCalledTimes(calls);
    expect(await scheduler.verifySession()).toEqual({
      status: "auth-required",
      detail: "revoked",
    });
    expect(fetchSession).toHaveBeenCalledTimes(calls);
  });

  it("verifySession coalesces with a renewal in flight and is a no-op before start()", async () => {
    const { fetchSession, scheduler } = setup();
    expect(await scheduler.verifySession()).toEqual({ status: "idle" });
    expect(fetchSession).not.toHaveBeenCalled();
    let resolve!: (s: DesktopSession) => void;
    fetchSession.mockReturnValueOnce(
      new Promise<DesktopSession>((r) => (resolve = r)),
    );
    const started = scheduler.start(profile);
    const verified = scheduler.verifySession();
    expect(verified).toBe(started);
    resolve(session(Date.now() + HOUR));
    await started;
    expect(fetchSession).toHaveBeenCalledTimes(1);
  });

  it("stops retrying when the credential is revoked (auth-required)", async () => {
    const { fetchSession, scheduler } = setup();
    fetchSession.mockRejectedValueOnce(
      new ConnectListError("unauthorized", "revoked"),
    );
    expect(await scheduler.start(profile)).toEqual({
      status: "auth-required",
      detail: "revoked",
    });
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(fetchSession).toHaveBeenCalledTimes(1);
    scheduler.renewIfDue();
    expect(fetchSession).toHaveBeenCalledTimes(1);
  });

  it("retries transient failures after 30s and on renewIfDue", async () => {
    const { fetchSession, scheduler } = setup();
    fetchSession.mockRejectedValueOnce(
      new ConnectListError("network", "offline"),
    );
    const state = await scheduler.start(profile);
    expect(state).toEqual({
      status: "error",
      detail: "offline",
      retryAt: Date.now() + 30_000,
    });

    fetchSession.mockRejectedValueOnce(new TypeError("Network request failed"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchSession).toHaveBeenCalledTimes(2);

    fetchSession.mockResolvedValueOnce(session(Date.now() + HOUR));
    scheduler.renewIfDue();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSession).toHaveBeenCalledTimes(3);
    expect(scheduler.getState().status).toBe("authenticated");
  });

  it("renewIfDue renews only when the session is within the lead window", async () => {
    const { fetchSession, scheduler } = setup();
    fetchSession.mockResolvedValueOnce(session(Date.now() + HOUR));
    await scheduler.start(profile);
    scheduler.renewIfDue();
    expect(fetchSession).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 57 * MINUTE);
    fetchSession.mockResolvedValueOnce(session(Date.now() + HOUR));
    scheduler.renewIfDue();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSession).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent renewals and ignores results after stop()", async () => {
    const { cookies, fetchSession, scheduler } = setup();
    let resolve!: (s: DesktopSession) => void;
    fetchSession.mockReturnValueOnce(
      new Promise<DesktopSession>((r) => (resolve = r)),
    );
    const first = scheduler.start(profile);
    const second = scheduler.renewNow();
    expect(second).toBe(first);
    expect(fetchSession).toHaveBeenCalledTimes(1);

    scheduler.stop();
    resolve(session(Date.now() + HOUR));
    await first;
    expect(cookies).toEqual([]);
    expect(scheduler.getState()).toEqual({ status: "idle" });
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(fetchSession).toHaveBeenCalledTimes(1);
  });

  it("start() for another profile while the first mint is in flight mints for the new profile", async () => {
    const { cookies, fetchSession, scheduler } = setup();
    let resolveFirst!: (s: DesktopSession) => void;
    fetchSession.mockReturnValueOnce(
      new Promise<DesktopSession>((r) => (resolveFirst = r)),
    );
    const first = scheduler.start(profile);
    const secondProfile = {
      ...profile,
      id: "p2",
      handle: "other",
      credential: "bbcm_2",
    };
    fetchSession.mockResolvedValueOnce(session(Date.now() + HOUR, "two"));
    const second = scheduler.start(secondProfile);
    expect(second).not.toBe(first);
    expect(fetchSession).toHaveBeenCalledTimes(2);
    expect(fetchSession.mock.calls[1]?.[0]).toMatchObject({
      credential: "bbcm_2",
    });
    expect(await second).toEqual({
      status: "authenticated",
      expiresAt: Date.now() + HOUR,
    });
    resolveFirst(session(Date.now() + HOUR, "one"));
    await first;
    expect(cookies.map((c) => c.cookie.value)).toEqual(["two", "two"]);
    expect(scheduler.getState().status).toBe("authenticated");
    fetchSession.mockResolvedValueOnce(session(Date.now() + 2 * HOUR, "three"));
    await scheduler.renewNow();
    expect(cookies.at(-1)?.cookie.value).toBe("three");
  });

  it("start() for another profile retires the previous session's timer", async () => {
    const { fetchSession, scheduler } = setup();
    fetchSession.mockResolvedValueOnce(session(Date.now() + HOUR));
    await scheduler.start(profile);
    fetchSession.mockResolvedValueOnce(session(Date.now() + 2 * HOUR));
    await scheduler.start({
      ...profile,
      id: "p2",
      handle: "other",
      credential: "bbcm_2",
    });
    await vi.advanceTimersByTimeAsync(56 * MINUTE);
    expect(fetchSession).toHaveBeenCalledTimes(2);
    fetchSession.mockResolvedValueOnce(session(Date.now() + 3 * HOUR));
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(fetchSession).toHaveBeenCalledTimes(3);
    expect(fetchSession.mock.calls[2]?.[0]).toMatchObject({
      credential: "bbcm_2",
    });
  });
});
