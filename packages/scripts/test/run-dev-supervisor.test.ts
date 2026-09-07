import { describe, expect, it } from "vitest";
import {
  calculateUnexpectedRestartDelay,
  runDevSupervisorWithRuntime,
  type DevSupervisorChildProcess,
  type DevSupervisorChildSpawnRequest,
  type DevSupervisorExitHandler,
  type DevSupervisorOptions,
  type DevSupervisorRuntime,
  type DevSupervisorRestartSignalHandler,
  type DevSupervisorSignalHandlerCleanup,
  type DevSupervisorTerminationSignalHandler,
  type DevSupervisorTimer,
  type DevSupervisorTimerCallback,
} from "../src/lib/run-dev-supervisor.js";
import type {
  ForwardedSignal,
  ProcessExitResult,
} from "../src/lib/process-helpers.js";
import type { WritePidFileRequest } from "../src/lib/pid-file.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

interface FakeRuntimeWaiter {
  predicate(): boolean;
  resolve(): void;
}

interface FakeTimerOptions {
  callback: DevSupervisorTimerCallback;
  delayMs: number;
  runtime: FakeDevSupervisorRuntime;
}

interface ExitingFakeChildPlan {
  mode: "exit";
  result: ProcessExitResult;
  runtimeMs: number;
}

interface HoldingFakeChildPlan {
  mode: "hold";
}

type FakeChildPlan = ExitingFakeChildPlan | HoldingFakeChildPlan;
type FakeRuntimePredicate = () => boolean;

interface CreateSupervisorOptionsArgs {
  initialDelayMs: number;
  maxDelayMs: number;
  stableChildRuntimeMs: number;
}

const SERVICE_NAME = "scripts-test-dev-supervisor";

function createDeferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });

  return {
    promise,
    resolve(value: T): void {
      if (!resolvePromise) {
        throw new Error("Deferred promise was not initialized");
      }
      resolvePromise(value);
    },
  };
}

function createUnexpectedExitPlan(runtimeMs: number): ExitingFakeChildPlan {
  return {
    mode: "exit",
    result: {
      code: 42,
      signal: null,
    },
    runtimeMs,
  };
}

function createSupervisorOptions(
  args: CreateSupervisorOptionsArgs,
): DevSupervisorOptions {
  return {
    childArgs: ["child.js"],
    childCommand: "node",
    childCwd: "/tmp/bb-supervisor-test",
    serviceName: SERVICE_NAME,
    unexpectedRestartBackoff: args,
  };
}

function countOccurrences(text: string, searchValue: string): number {
  return text.split(searchValue).length - 1;
}

class FakeTimer implements DevSupervisorTimer {
  private cleared = false;

  constructor(private readonly options: FakeTimerOptions) {}

  get delayMs(): number {
    return this.options.delayMs;
  }

  get active(): boolean {
    return !this.cleared;
  }

  clear(): void {
    this.cleared = true;
  }

  unref(): void {}

  run(): void {
    if (this.cleared) {
      return;
    }

    this.cleared = true;
    this.options.runtime.advanceTime(this.options.delayMs);
    this.options.callback();
  }
}

class FakeChildProcess implements DevSupervisorChildProcess {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  private readonly exitDeferred = createDeferred<ProcessExitResult>();

  constructor(
    private readonly runtime: FakeDevSupervisorRuntime,
    private readonly plan: FakeChildPlan,
  ) {}

  kill(signal: NodeJS.Signals): void {
    if (this.exitCode !== null || this.signalCode !== null) {
      return;
    }

    this.signalCode = signal;
    this.exitDeferred.resolve({
      code: 1,
      signal,
    });
  }

  waitForExit(): Promise<ProcessExitResult> {
    if (this.plan.mode === "hold") {
      return this.exitDeferred.promise;
    }

    this.runtime.advanceTime(this.plan.runtimeMs);
    this.exitCode = this.plan.result.signal ? null : this.plan.result.code;
    this.signalCode = this.plan.result.signal;
    return Promise.resolve(this.plan.result);
  }
}

class FakeDevSupervisorRuntime implements DevSupervisorRuntime {
  readonly currentPid = 12345;
  exitCode: number | null = null;
  stdout = "";
  stderr = "";

  private currentTimeMs = 0;
  private restartSignalHandler: DevSupervisorRestartSignalHandler | null = null;
  private stopSignalHandler: DevSupervisorTerminationSignalHandler | null =
    null;
  private readonly children: FakeChildProcess[] = [];
  private readonly timers: FakeTimer[] = [];
  private readonly waiters: FakeRuntimeWaiter[] = [];

  constructor(private readonly childPlans: FakeChildPlan[]) {}

  get spawnCount(): number {
    return this.children.length;
  }

  now(): number {
    return this.currentTimeMs;
  }

  advanceTime(delayMs: number): void {
    this.currentTimeMs += delayMs;
  }

  setTimeout(
    callback: DevSupervisorTimerCallback,
    delayMs: number,
  ): DevSupervisorTimer {
    const timer = new FakeTimer({
      callback,
      delayMs,
      runtime: this,
    });
    this.timers.push(timer);
    this.notifyWaiters();
    return timer;
  }

  spawnChildProcess(
    _request: DevSupervisorChildSpawnRequest,
  ): DevSupervisorChildProcess {
    const plan = this.childPlans.shift();
    if (!plan) {
      throw new Error("No fake child plan was queued");
    }

    const child = new FakeChildProcess(this, plan);
    this.children.push(child);
    this.notifyWaiters();
    return child;
  }

  installTerminationSignalForwarding(
    handler: DevSupervisorTerminationSignalHandler,
  ): DevSupervisorSignalHandlerCleanup {
    this.stopSignalHandler = handler;
    return () => {
      this.stopSignalHandler = null;
    };
  }

  installRestartSignalHandler(
    handler: DevSupervisorRestartSignalHandler,
  ): DevSupervisorSignalHandlerCleanup {
    this.restartSignalHandler = handler;
    return () => {
      this.restartSignalHandler = null;
    };
  }

  registerExitHandler(_handler: DevSupervisorExitHandler): void {}

  resolvePidPath(serviceName: string): string {
    return `/tmp/${serviceName}.pid`;
  }

  writePidFile(_request: WritePidFileRequest): Promise<void> {
    return Promise.resolve();
  }

  removePidFileSync(_pidPath: string): void {}

  writeStdout(message: string): void {
    this.stdout += message;
  }

  writeStderr(message: string): void {
    this.stderr += message;
  }

  setExitCode(code: number): void {
    this.exitCode = code;
  }

  emitRestartSignal(): void {
    if (!this.restartSignalHandler) {
      throw new Error("Restart signal handler is not installed");
    }
    this.restartSignalHandler();
    this.notifyWaiters();
  }

  emitStopSignal(signal: ForwardedSignal): void {
    if (!this.stopSignalHandler) {
      throw new Error("Stop signal handler is not installed");
    }
    this.stopSignalHandler(signal);
    this.notifyWaiters();
  }

  activeTimerDelays(): number[] {
    return this.timers
      .filter((timer) => timer.active)
      .map((timer) => timer.delayMs);
  }

  runNextTimer(delayMs: number): void {
    const timer = this.timers.find(
      (candidate) => candidate.active && candidate.delayMs === delayMs,
    );
    if (!timer) {
      throw new Error(`No active ${delayMs}ms timer was scheduled`);
    }

    timer.run();
    this.notifyWaiters();
  }

  waitForSpawnCount(count: number): Promise<void> {
    return this.waitFor(() => this.spawnCount >= count);
  }

  waitForActiveTimerDelay(delayMs: number): Promise<void> {
    return this.waitFor(() => this.activeTimerDelays().includes(delayMs));
  }

  private waitFor(predicate: FakeRuntimePredicate): Promise<void> {
    if (predicate()) {
      return Promise.resolve();
    }

    const deferred = createDeferred<void>();
    this.waiters.push({
      predicate,
      resolve: () => {
        deferred.resolve(undefined);
      },
    });
    return deferred.promise;
  }

  private notifyWaiters(): void {
    const pendingWaiters: FakeRuntimeWaiter[] = [];
    const readyWaiters: FakeRuntimeWaiter[] = [];

    for (const waiter of this.waiters) {
      if (waiter.predicate()) {
        readyWaiters.push(waiter);
      } else {
        pendingWaiters.push(waiter);
      }
    }

    this.waiters.length = 0;
    this.waiters.push(...pendingWaiters);
    for (const waiter of readyWaiters) {
      waiter.resolve();
    }
  }
}

describe("runDevSupervisor", () => {
  it("calculates capped exponential restart delays", () => {
    const baseArgs = {
      initialDelayMs: 1_000,
      maxDelayMs: 10_000,
    };

    expect(calculateUnexpectedRestartDelay({ ...baseArgs, attempt: 1 })).toBe(
      1_000,
    );
    expect(calculateUnexpectedRestartDelay({ ...baseArgs, attempt: 2 })).toBe(
      2_000,
    );
    expect(calculateUnexpectedRestartDelay({ ...baseArgs, attempt: 5 })).toBe(
      10_000,
    );
  });

  it("keeps running and respawns after an unexpected child exit", async () => {
    const runtime = new FakeDevSupervisorRuntime([
      createUnexpectedExitPlan(0),
      { mode: "hold" },
    ]);
    const supervisorPromise = runDevSupervisorWithRuntime({
      options: createSupervisorOptions({
        initialDelayMs: 20,
        maxDelayMs: 20,
        stableChildRuntimeMs: 30_000,
      }),
      runtime,
    });

    await runtime.waitForActiveTimerDelay(20);
    expect(runtime.stderr).toContain(
      "Child exited unexpectedly with exit code 42. Restarting in 20ms.",
    );

    runtime.runNextTimer(20);
    await runtime.waitForSpawnCount(2);
    expect(runtime.spawnCount).toBe(2);

    runtime.emitStopSignal("SIGTERM");
    await supervisorPromise;
    expect(runtime.exitCode).toBe(0);
  });

  it("lets explicit restart requests interrupt an armed crash backoff", async () => {
    const runtime = new FakeDevSupervisorRuntime([
      createUnexpectedExitPlan(0),
      createUnexpectedExitPlan(0),
    ]);
    const supervisorPromise = runDevSupervisorWithRuntime({
      options: createSupervisorOptions({
        initialDelayMs: 5_000,
        maxDelayMs: 10_000,
        stableChildRuntimeMs: 30_000,
      }),
      runtime,
    });

    await runtime.waitForActiveTimerDelay(5_000);
    expect(runtime.activeTimerDelays()).toEqual([5_000]);

    runtime.emitRestartSignal();

    expect(runtime.activeTimerDelays()).toEqual([]);

    await runtime.waitForSpawnCount(2);
    await runtime.waitForActiveTimerDelay(5_000);
    expect(countOccurrences(runtime.stderr, "Restarting in 5s.")).toBe(2);
    expect(runtime.stdout).toContain("Restart requested.");

    runtime.emitStopSignal("SIGTERM");
    await supervisorPromise;
    expect(runtime.exitCode).toBe(0);
  });

  it("resets unexpected restart backoff after a stable child runtime", async () => {
    const runtime = new FakeDevSupervisorRuntime([
      createUnexpectedExitPlan(0),
      createUnexpectedExitPlan(0),
      createUnexpectedExitPlan(31),
    ]);
    const supervisorPromise = runDevSupervisorWithRuntime({
      options: createSupervisorOptions({
        initialDelayMs: 1_000,
        maxDelayMs: 10_000,
        stableChildRuntimeMs: 30,
      }),
      runtime,
    });

    await runtime.waitForActiveTimerDelay(1_000);
    runtime.runNextTimer(1_000);
    await runtime.waitForActiveTimerDelay(2_000);
    runtime.runNextTimer(2_000);
    await runtime.waitForActiveTimerDelay(1_000);

    expect(runtime.stderr).toContain(
      "Child exited unexpectedly with exit code 42. Restarting in 1s.",
    );
    expect(runtime.stderr).toContain(
      "Child exited unexpectedly with exit code 42. Restarting in 2s.",
    );
    expect(countOccurrences(runtime.stderr, "Restarting in 1s.")).toBe(2);

    runtime.emitStopSignal("SIGTERM");
    await supervisorPromise;
    expect(runtime.exitCode).toBe(0);
  });
});
