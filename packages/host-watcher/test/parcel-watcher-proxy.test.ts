import { describe, expect, it, vi } from "vitest";
import type {
  ChildToParentMessage,
  ParentToChildMessage,
} from "../src/parcel-subprocess/messages.js";
import { createParcelChildHandler } from "../src/parcel-subprocess/parcel-child-handler.js";
import {
  createParcelWatcherProxy,
  type ChildChannel,
} from "../src/parcel-subprocess/parcel-watcher-proxy.js";
import type {
  ParcelWatcherBackend,
  ParcelWatcherError,
  ParcelWatcherEventBatch,
} from "../src/parcel-watcher-backend.js";
import { RESCAN_REQUIRED_MESSAGE } from "../src/watch-recovery.js";

async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

interface FakeSubscription {
  dir: string;
  callback: (
    error: ParcelWatcherError,
    events: ParcelWatcherEventBatch,
  ) => unknown;
  unsubscribed: boolean;
}

class FakeParcel implements ParcelWatcherBackend {
  readonly subscriptions: FakeSubscription[] = [];
  failNextSubscribe = false;

  subscribe(
    dir: string,
    callback: (
      error: ParcelWatcherError,
      events: ParcelWatcherEventBatch,
    ) => unknown,
  ): Promise<{ unsubscribe(): Promise<void> }> {
    if (this.failNextSubscribe) {
      this.failNextSubscribe = false;
      return Promise.reject(new Error(`cannot watch ${dir}`));
    }
    const subscription: FakeSubscription = {
      dir,
      callback,
      unsubscribed: false,
    };
    this.subscriptions.push(subscription);
    return Promise.resolve({
      unsubscribe: () => {
        subscription.unsubscribed = true;
        return Promise.resolve();
      },
    });
  }

  emit(dir: string, events: ParcelWatcherEventBatch): void {
    for (const subscription of this.subscriptions) {
      if (subscription.dir === dir && !subscription.unsubscribed) {
        subscription.callback(null, events);
      }
    }
  }

  emitError(dir: string, message: string): void {
    for (const subscription of this.subscriptions) {
      if (subscription.dir === dir && !subscription.unsubscribed) {
        subscription.callback(new Error(message), []);
      }
    }
  }

  activeDirs(): string[] {
    return this.subscriptions
      .filter((subscription) => !subscription.unsubscribed)
      .map((subscription) => subscription.dir);
  }
}

class FakeChild {
  readonly parcel = new FakeParcel();
  readonly channel: ChildChannel;
  exited = false;
  responsive = true;
  dieOnSend = false;

  private readonly handler;
  private parentListener: ((message: ChildToParentMessage) => void) | null =
    null;
  private exitListener: (() => void) | null = null;

  constructor(listEntries: (dir: string) => Promise<string[]>) {
    this.handler = createParcelChildHandler({
      parcel: this.parcel,
      send: (message) => this.parentListener?.(message),
      listEntries,
    });
    this.channel = {
      send: (message: ParentToChildMessage) => {
        if (this.exited || !this.responsive) {
          return;
        }
        if (this.dieOnSend) {
          this.exit();
          return;
        }
        this.handler.handleMessage(message);
      },
      onMessage: (listener) => {
        this.parentListener = listener;
      },
      onExit: (listener) => {
        this.exitListener = listener;
      },
      kill: () => this.exit(),
    };
    queueMicrotask(() => {
      if (!this.exited) {
        this.parentListener?.({ kind: "ready" });
      }
    });
  }

  exit(): void {
    if (this.exited) {
      return;
    }
    this.exited = true;
    this.exitListener?.();
  }
}

function createHarness(options?: {
  pingIntervalMs?: number;
  pingTimeoutMs?: number;
  baseRestartDelayMs?: number;
  maxRestartDelayMs?: number;
  listEntries?: (dir: string) => Promise<string[]>;
}) {
  const children: FakeChild[] = [];
  const listEntries = options?.listEntries ?? (() => Promise.resolve([]));
  const proxy = createParcelWatcherProxy({
    spawnChannel: () => {
      const child = new FakeChild(listEntries);
      children.push(child);
      return child.channel;
    },
    pingIntervalMs: options?.pingIntervalMs ?? 1_000,
    pingTimeoutMs: options?.pingTimeoutMs ?? 2_500,
    baseRestartDelayMs: options?.baseRestartDelayMs ?? 1_000,
    maxRestartDelayMs: options?.maxRestartDelayMs ?? 30_000,
  });
  const current = (): FakeChild => {
    const child = children.at(-1);
    if (!child) {
      throw new Error("no child spawned yet");
    }
    return child;
  };
  return { proxy, children, current };
}

interface RecoveryBenchmarkCounts {
  subscriptions: number;
  affectedSubscriptions: number;
  unaffectedSubscriptions: number;
  childRestarts: number;
  proxyResubscriptions: number;
  listEntriesCalls: number;
  affectedSubscriptionsReceivingErrors: number;
  affectedSubscriptionsReceivingEvents: number;
  unaffectedSubscriptionsReceivingErrors: number;
  unaffectedSubscriptionsReceivingEvents: number;
}

async function runRecoveryCountSample(
  subscriptionCount: number,
): Promise<RecoveryBenchmarkCounts> {
  let listEntriesCalls = 0;
  const { proxy, children, current } = createHarness({
    listEntries: () => {
      listEntriesCalls += 1;
      return Promise.resolve(["current-entry"]);
    },
  });
  let affectedErrors = 0;
  let affectedEvents = 0;
  const unaffectedSubscriptionsReceivingErrors = new Set<number>();
  const unaffectedSubscriptionsReceivingEvents = new Set<number>();

  for (let index = 0; index < subscriptionCount; index += 1) {
    await proxy.subscribe(`/root-${index}`, (error, events) => {
      if (index === 0) {
        if (error) {
          affectedErrors += 1;
        } else {
          affectedEvents += events.length;
        }
        return;
      }
      if (error) {
        unaffectedSubscriptionsReceivingErrors.add(index);
      } else if (events.length > 0) {
        unaffectedSubscriptionsReceivingEvents.add(index);
      }
    });
  }
  await flush();

  current().parcel.emitError(
    "/root-0",
    `Events were dropped by the FSEvents client. ${RESCAN_REQUIRED_MESSAGE}.`,
  );
  await flush();
  const totalSubscribeCalls = children.reduce(
    (total, child) => total + child.parcel.subscriptions.length,
    0,
  );
  const counts: RecoveryBenchmarkCounts = {
    subscriptions: subscriptionCount,
    affectedSubscriptions: 1,
    unaffectedSubscriptions: subscriptionCount - 1,
    childRestarts: children.length - 1,
    proxyResubscriptions: totalSubscribeCalls - subscriptionCount,
    listEntriesCalls,
    affectedSubscriptionsReceivingErrors: affectedErrors > 0 ? 1 : 0,
    affectedSubscriptionsReceivingEvents: affectedEvents > 0 ? 1 : 0,
    unaffectedSubscriptionsReceivingErrors:
      unaffectedSubscriptionsReceivingErrors.size,
    unaffectedSubscriptionsReceivingEvents:
      unaffectedSubscriptionsReceivingEvents.size,
  };
  proxy.dispose();
  return counts;
}

describe("createParcelWatcherProxy", () => {
  it("delivers parcel events from the child to the subscriber", async () => {
    const { proxy, current } = createHarness();
    const received: ParcelWatcherEventBatch[] = [];
    await proxy.subscribe("/root", (error, events) => {
      if (!error) {
        received.push(events);
      }
    });
    await flush();

    current().parcel.emit("/root", [{ path: "/root/a.ts", type: "update" }]);

    expect(received).toEqual([[{ path: "/root/a.ts", type: "update" }]]);
    proxy.dispose();
  });

  it("propagates unsubscribe through to the child", async () => {
    const { proxy, current } = createHarness();
    const received: ParcelWatcherEventBatch[] = [];
    const subscription = await proxy.subscribe("/root", (error, events) => {
      if (!error) {
        received.push(events);
      }
    });
    await flush();

    await subscription.unsubscribe();
    await flush();
    expect(current().parcel.activeDirs()).toEqual([]);

    current().parcel.emit("/root", [{ path: "/root/a.ts", type: "create" }]);
    expect(received).toEqual([]);
    proxy.dispose();
  });

  it("respawns the child and replays subscriptions transparently on crash", async () => {
    const { proxy, children, current } = createHarness();
    const received: string[] = [];
    let errorCount = 0;
    const subscription = await proxy.subscribe("/root", (error, events) => {
      if (error) {
        errorCount += 1;
        return;
      }
      for (const event of events) {
        received.push(event.path);
      }
    });
    await flush();
    expect(children).toHaveLength(1);

    current().exit();
    await flush();

    expect(children).toHaveLength(2);
    expect(current().parcel.activeDirs()).toEqual(["/root"]);

    current().parcel.emit("/root", [
      { path: "/root/after.ts", type: "update" },
    ]);
    expect(received).toEqual(["/root/after.ts"]);
    expect(errorCount).toBe(0);

    await subscription.unsubscribe();
    await flush();
    expect(current().parcel.activeDirs()).toEqual([]);
    proxy.dispose();
  });

  it("recycles the child and replays when it reports a backend error (EINTR)", async () => {
    const { proxy, children, current } = createHarness();
    const received: string[] = [];
    let errorCount = 0;
    await proxy.subscribe("/root", (error, events) => {
      if (error) {
        errorCount += 1;
        return;
      }
      for (const event of events) {
        received.push(event.path);
      }
    });
    await flush();
    expect(children).toHaveLength(1);

    current().parcel.emitError(
      "/root",
      "Unable to poll: Interrupted system call",
    );
    await flush();

    expect(children[0]?.exited).toBe(true);
    expect(children).toHaveLength(2);
    expect(current().parcel.activeDirs()).toEqual(["/root"]);
    expect(errorCount).toBe(0);

    current().parcel.emit("/root", [
      { path: "/root/healed.ts", type: "update" },
    ]);
    expect(received).toEqual(["/root/healed.ts"]);
    proxy.dispose();
  });

  it("routes rescan-required errors only to the affected subscription", async () => {
    const listEntries = vi.fn(() => Promise.resolve(["current-entry"]));
    const { proxy, children, current } = createHarness({ listEntries });
    const affectedErrors: string[] = [];
    const affectedEvents: string[] = [];
    const unaffectedErrors: string[] = [];
    const unaffectedEvents: string[] = [];

    await proxy.subscribe("/affected", (error, events) => {
      if (error) {
        affectedErrors.push(error.message);
        return;
      }
      affectedEvents.push(...events.map((event) => event.path));
    });
    await proxy.subscribe("/unaffected", (error, events) => {
      if (error) {
        unaffectedErrors.push(error.message);
        return;
      }
      unaffectedEvents.push(...events.map((event) => event.path));
    });
    await flush();
    expect(children).toHaveLength(1);

    current().parcel.emitError(
      "/affected",
      `Events were dropped by the FSEvents client. ${RESCAN_REQUIRED_MESSAGE}.`,
    );
    await flush();

    expect(children).toHaveLength(1);
    expect(affectedErrors).toEqual([
      `Events were dropped by the FSEvents client. ${RESCAN_REQUIRED_MESSAGE}.`,
    ]);
    expect(affectedEvents).toEqual([]);
    expect(unaffectedErrors).toEqual([]);
    expect(unaffectedEvents).toEqual([]);
    expect(listEntries).not.toHaveBeenCalled();
    expect(current().parcel.activeDirs().sort()).toEqual([
      "/affected",
      "/unaffected",
    ]);
    proxy.dispose();
  });

  it("re-emits current entries on replay to close the restart gap", async () => {
    const { proxy, current } = createHarness({
      listEntries: () => Promise.resolve(["thread-1", "thread-2"]),
    });
    const received: string[] = [];
    await proxy.subscribe("/storage", (error, events) => {
      if (!error) {
        for (const event of events) {
          received.push(event.path);
        }
      }
    });
    await flush();
    expect(received).toEqual([]);

    current().exit();
    await flush();
    expect([...received].sort()).toEqual([
      "/storage/thread-1",
      "/storage/thread-2",
    ]);
    proxy.dispose();
  });

  it("kills and respawns a child that stops answering pings", async () => {
    vi.useFakeTimers();
    try {
      const { proxy, children, current } = createHarness({
        pingIntervalMs: 1_000,
        pingTimeoutMs: 2_500,
      });
      const received: string[] = [];
      await proxy.subscribe("/root", (error, events) => {
        if (!error) {
          for (const event of events) {
            received.push(event.path);
          }
        }
      });
      await flush();
      expect(children).toHaveLength(1);

      current().responsive = false;
      await vi.advanceTimersByTimeAsync(3_500);

      expect(children[0]?.exited).toBe(true);
      expect(children).toHaveLength(2);
      expect(current().parcel.activeDirs()).toEqual(["/root"]);

      current().parcel.emit("/root", [{ path: "/root/x.ts", type: "create" }]);
      expect(received).toEqual(["/root/x.ts"]);
      proxy.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("probes instead of killing when the parent ping timer resumes late", async () => {
    vi.useFakeTimers();
    const nowSpy = vi.spyOn(Date, "now");
    try {
      nowSpy.mockReturnValue(0);
      const { proxy, children, current } = createHarness({
        pingIntervalMs: 1_000,
        pingTimeoutMs: 2_500,
      });
      await proxy.subscribe("/root", () => {});
      await flush();
      expect(children).toHaveLength(1);

      nowSpy.mockReturnValue(4_000);
      await vi.advanceTimersByTimeAsync(1_000);
      await flush();

      expect(children[0]?.exited).toBe(false);
      expect(children).toHaveLength(1);
      expect(current().parcel.activeDirs()).toEqual(["/root"]);
      proxy.dispose();
    } finally {
      nowSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("backs off a rapid respawn but never permanently gives up", async () => {
    vi.useFakeTimers();
    try {
      const { proxy, children, current } = createHarness({
        baseRestartDelayMs: 1_000,
        maxRestartDelayMs: 8_000,
        pingIntervalMs: 100_000,
      });
      let terminalError: Error | null = null;
      await proxy.subscribe("/root", (error) => {
        if (error) {
          terminalError = error;
        }
      });
      await flush();
      expect(children).toHaveLength(1);

      current().exit();
      await flush();
      expect(children).toHaveLength(2);

      current().exit();
      await flush();
      expect(children).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(children).toHaveLength(3);

      expect(terminalError).toBeNull();
      proxy.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers when a replacement child's pipe breaks mid-replay", async () => {
    vi.useFakeTimers();
    try {
      const { proxy, children, current } = createHarness({
        baseRestartDelayMs: 1_000,
        pingIntervalMs: 100_000,
      });
      await proxy.subscribe("/root", () => {});
      await proxy.subscribe("/other", () => {});
      await flush();
      expect(children).toHaveLength(1);

      current().exit();
      expect(children).toHaveLength(2);

      current().dieOnSend = true;
      await flush();

      await vi.advanceTimersByTimeAsync(1_000);
      await flush();

      expect(children).toHaveLength(3);
      expect(current().parcel.activeDirs().sort()).toEqual(["/other", "/root"]);
      proxy.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces a replay subscribe failure as recoverable, not terminal", async () => {
    const { proxy, children } = createHarness();
    const errors: string[] = [];
    const pending = proxy.subscribe("/root", (error) => {
      if (error) {
        errors.push(error.message);
      }
    });
    const firstChild = children[0];
    if (firstChild) {
      firstChild.parcel.failNextSubscribe = true;
    }
    await pending;
    await flush();

    expect(errors).toContain(RESCAN_REQUIRED_MESSAGE);
    proxy.dispose();
  });

  it("does not double-subscribe a subscription added during the respawn window", async () => {
    const { proxy, children, current } = createHarness();
    await proxy.subscribe("/root", () => {});
    await flush();
    expect(children).toHaveLength(1);

    current().exit();
    await proxy.subscribe("/late", () => {});
    await flush();

    expect(children).toHaveLength(2);
    expect(
      current()
        .parcel.activeDirs()
        .filter((d) => d === "/late"),
    ).toEqual(["/late"]);
    expect(
      current()
        .parcel.activeDirs()
        .filter((d) => d === "/root"),
    ).toEqual(["/root"]);
    proxy.dispose();
  });
});

if (process.env.BB_WATCHER_RECOVERY_BENCHMARK === "1") {
  describe("watcher recovery count harness", () => {
    it("reports two-subscription and fan-out recovery work", async () => {
      const result = {
        twoSubscriptions: await runRecoveryCountSample(2),
        fanOut: await runRecoveryCountSample(100),
      };
      expect(result.twoSubscriptions.affectedSubscriptions).toBe(1);
      expect(result.twoSubscriptions.unaffectedSubscriptions).toBe(1);
      expect(result.fanOut.affectedSubscriptions).toBe(1);
      expect(result.fanOut.unaffectedSubscriptions).toBe(99);
      process.stdout.write(
        `WATCHER_RECOVERY_COUNTS ${JSON.stringify(result)}\n`,
      );
    }, 30_000);
  });
}
