import { describe, expect, it, vi } from "vitest";
import {
  createConnectSessionRenewal,
  type ConnectSessionAuthenticateResult,
} from "../src/connect-session-renewal.js";

const HOUR_MS = 60 * 60 * 1000;
const LEAD_MS = 5 * 60 * 1000;

function createGate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function createHarness(
  authenticate: (
    remoteServerUrl: string,
    isCurrent: () => boolean,
  ) => Promise<ConnectSessionAuthenticateResult>,
) {
  let now = 1_000_000;
  let nextHandle = 1;
  const timers = new Map<number, { at: number; handler: () => void }>();
  const logs: string[] = [];

  const renewal = createConnectSessionRenewal({
    authenticate,
    log: (message) => {
      logs.push(message);
    },
    now: () => now,
    setTimeoutFn(handler, timeout) {
      const handle = nextHandle;
      nextHandle += 1;
      timers.set(handle, { at: now + timeout, handler });
      return handle;
    },
    clearTimeoutFn(handle) {
      timers.delete(handle as number);
    },
  });

  return {
    logs,
    renewal,
    get pendingDelays(): number[] {
      return [...timers.values()].map((timer) => timer.at - now);
    },
    advanceTo(target: number): void {
      now = target;
    },
    runDueTimers(): void {
      for (const [handle, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(handle);
          timer.handler();
        }
      }
    },
  };
}

describe("createConnectSessionRenewal", () => {
  it("renews ahead of expiry and reschedules from the new cookie", async () => {
    const authenticate = vi.fn(
      async (): Promise<ConnectSessionAuthenticateResult> => ({
        expiresAt: 1_000_000 + 2 * HOUR_MS,
        ok: true,
      }),
    );
    const harness = createHarness(authenticate);

    harness.renewal.start({
      expiresAt: 1_000_000 + HOUR_MS,
      remoteServerUrl: "https://laptop.getbb.app",
    });
    expect(harness.pendingDelays).toEqual([HOUR_MS - LEAD_MS]);

    harness.advanceTo(1_000_000 + HOUR_MS - LEAD_MS);
    harness.runDueTimers();
    await harness.renewal.renewNow();

    expect(authenticate).toHaveBeenCalledWith(
      "https://laptop.getbb.app",
      expect.any(Function),
    );
    expect(harness.pendingDelays).toEqual([HOUR_MS]);
  });

  it("does not reschedule when the target changed during a successful renewal", async () => {
    const gate = createGate();
    const authenticate = vi.fn(
      async (): Promise<ConnectSessionAuthenticateResult> => {
        await gate.promise;
        return { expiresAt: 1_000_000 + 2 * HOUR_MS, ok: true };
      },
    );
    const harness = createHarness(authenticate);

    harness.renewal.start({
      expiresAt: 1_000_000 + HOUR_MS,
      remoteServerUrl: "https://laptop.getbb.app",
    });
    const renewing = harness.renewal.renewNow();

    harness.renewal.stop();
    gate.release();
    await renewing;

    expect(harness.pendingDelays).toEqual([]);
  });

  it("does not retry when the target changed during a failed renewal", async () => {
    const gate = createGate();
    const authenticate = vi.fn(
      async (): Promise<ConnectSessionAuthenticateResult> => {
        await gate.promise;
        return { detail: "network: offline", ok: false };
      },
    );
    const harness = createHarness(authenticate);

    harness.renewal.start({
      expiresAt: 1_000_000 + HOUR_MS,
      remoteServerUrl: "https://laptop.getbb.app",
    });
    const renewing = harness.renewal.renewNow();

    harness.renewal.stop();
    gate.release();
    await renewing;

    expect(harness.pendingDelays).toEqual([]);
    expect(harness.logs).toEqual([]);
  });

  it("tells the authenticate call when its target is gone", async () => {
    const seen: boolean[] = [];
    const gate = createGate();
    const harness = createHarness(async (_serverUrl, isCurrent) => {
      seen.push(isCurrent());
      await gate.promise;
      seen.push(isCurrent());
      return { expiresAt: 1_000_000 + 2 * HOUR_MS, ok: true };
    });

    harness.renewal.start({
      expiresAt: 1_000_000 + HOUR_MS,
      remoteServerUrl: "https://laptop.getbb.app",
    });
    const renewing = harness.renewal.renewNow();
    harness.renewal.stop();
    gate.release();
    await renewing;

    expect(seen).toEqual([true, false]);
  });

  it("retries on the lead interval after a failure", async () => {
    const authenticate = vi.fn(
      async (): Promise<ConnectSessionAuthenticateResult> => ({
        detail: "network: offline",
        ok: false,
      }),
    );
    const harness = createHarness(authenticate);

    harness.renewal.start({
      expiresAt: 1_000_000 + HOUR_MS,
      remoteServerUrl: "https://laptop.getbb.app",
    });
    await harness.renewal.renewNow();

    expect(harness.pendingDelays).toEqual([30_000]);
    expect(harness.logs).toHaveLength(1);
  });

  it("renews on demand only when the session is nearly spent", async () => {
    const authenticate = vi.fn(
      async (): Promise<ConnectSessionAuthenticateResult> => ({
        expiresAt: 1_000_000 + 2 * HOUR_MS,
        ok: true,
      }),
    );
    const harness = createHarness(authenticate);

    harness.renewal.start({
      expiresAt: 1_000_000 + HOUR_MS,
      remoteServerUrl: "https://laptop.getbb.app",
    });
    harness.renewal.renewIfDue();
    expect(authenticate).not.toHaveBeenCalled();

    harness.advanceTo(1_000_000 + HOUR_MS - 60_000);
    harness.renewal.renewIfDue();
    await harness.renewal.renewNow();
    expect(authenticate).toHaveBeenCalledTimes(1);
  });

  it("stays idle after stop, and starts a new generation cleanly", async () => {
    const authenticate = vi.fn(
      async (): Promise<ConnectSessionAuthenticateResult> => ({
        expiresAt: 1_000_000 + 2 * HOUR_MS,
        ok: true,
      }),
    );
    const harness = createHarness(authenticate);

    harness.renewal.start({
      expiresAt: 1_000_000 + HOUR_MS,
      remoteServerUrl: "https://laptop.getbb.app",
    });
    harness.renewal.stop();
    expect(harness.pendingDelays).toEqual([]);

    harness.renewal.renewIfDue();
    await harness.renewal.renewNow();
    expect(authenticate).not.toHaveBeenCalled();

    harness.renewal.start({
      expiresAt: 1_000_000 + HOUR_MS,
      remoteServerUrl: "https://phone.getbb.app",
    });
    await harness.renewal.renewNow();
    expect(authenticate).toHaveBeenCalledWith(
      "https://phone.getbb.app",
      expect.any(Function),
    );
  });

  it("retires an in-flight renewal when a new session starts", async () => {
    const gate = createGate();
    const harness = createHarness(async (_serverUrl, isCurrent) => {
      await gate.promise;
      expect(isCurrent()).toBe(false);
      return { expiresAt: 1_000_000 + 2 * HOUR_MS, ok: true };
    });

    harness.renewal.start({
      expiresAt: 1_000_000 + HOUR_MS,
      remoteServerUrl: "https://laptop.getbb.app",
    });
    const renewing = harness.renewal.renewNow();

    harness.renewal.start({
      expiresAt: 1_000_000 + 3 * HOUR_MS,
      remoteServerUrl: "https://phone.getbb.app",
    });
    gate.release();
    await renewing;

    expect(harness.pendingDelays).toEqual([3 * HOUR_MS - LEAD_MS]);
  });
});
