import path from "node:path";
import { describe, expect, it } from "vitest";
import { deriveDevAutoPortTuple } from "../src/lib/dev-auto-ports.js";
import {
  createDevAutoTurboCommand,
  runDevAutoWithRuntime,
  type DevAutoChildProcess,
  type DevAutoCommandRuntime,
  type DevAutoSignalHandler,
  type DevAutoSignalHandlerCleanup,
  type DevAutoSpawnProcessRequest,
} from "../src/commands/run-dev-auto.js";
import type {
  DevAutoReservation,
  RemoveDevAutoReservationArgs,
  ReserveDevAutoStackArgs,
  WriteDevAutoEnvFileArgs,
} from "../src/lib/dev-auto-registry.js";
import type {
  ForwardedSignal,
  ProcessExitResult,
} from "../src/lib/process-helpers.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

interface CreateReservationArgs {
  dataDir?: string;
  ownerPid?: number;
  repoRoot?: string;
  slot: number;
}

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

function createReservation(args: CreateReservationArgs): DevAutoReservation {
  const slot = args.slot;
  return {
    createdAt: "2026-05-14T00:00:00.000Z",
    dataDir: args.dataDir ?? `/tmp/bb-dev-auto/slot-${slot}`,
    ownerPid: args.ownerPid ?? 2468,
    ports: deriveDevAutoPortTuple(slot),
    repoRoot: args.repoRoot ?? "/repo",
    slot,
    stackId: `bb-dev-auto-${slot}`,
    updatedAt: "2026-05-14T00:00:00.000Z",
  };
}

class FakeDevAutoChildProcess implements DevAutoChildProcess {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly killedSignals: NodeJS.Signals[] = [];
  private readonly exit = createDeferred<ProcessExitResult>();

  kill(signal: NodeJS.Signals): void {
    this.killedSignals.push(signal);
    this.signalCode = signal;
    this.exit.resolve({
      code: 1,
      signal,
    });
  }

  resolveExit(result: ProcessExitResult): void {
    this.exitCode = result.signal ? null : result.code;
    this.signalCode = result.signal;
    this.exit.resolve(result);
  }

  waitForExit(): Promise<ProcessExitResult> {
    return this.exit.promise;
  }
}

class FakeDevAutoRuntime implements DevAutoCommandRuntime {
  readonly currentPid = 2468;
  readonly child = new FakeDevAutoChildProcess();
  readonly releaseRequests: RemoveDevAutoReservationArgs[] = [];
  readonly reserveRequests: ReserveDevAutoStackArgs[] = [];
  readonly spawnRequests: DevAutoSpawnProcessRequest[] = [];
  readonly writeEnvRequests: WriteDevAutoEnvFileArgs[] = [];
  exitCode: number | null = null;
  stdout = "";
  private signalHandler: DevAutoSignalHandler | null = null;
  private readonly spawned = createDeferred<void>();

  constructor(
    private readonly reservation: DevAutoReservation,
    private readonly parentEnv: NodeJS.ProcessEnv,
  ) {}

  cwd(): string {
    return this.reservation.repoRoot;
  }

  env(): NodeJS.ProcessEnv {
    return this.parentEnv;
  }

  hostname(): string {
    return "dev-machine";
  }

  installTerminationSignalForwarding(
    handler: DevAutoSignalHandler,
  ): DevAutoSignalHandlerCleanup {
    this.signalHandler = handler;
    return () => {
      this.signalHandler = null;
    };
  }

  releaseStackReservation(args: RemoveDevAutoReservationArgs): Promise<void> {
    this.releaseRequests.push(args);
    return Promise.resolve();
  }

  reserveStack(args: ReserveDevAutoStackArgs): Promise<DevAutoReservation> {
    this.reserveRequests.push(args);
    return Promise.resolve(this.reservation);
  }

  setExitCode(code: number): void {
    this.exitCode = code;
  }

  spawnDevProcess(request: DevAutoSpawnProcessRequest): DevAutoChildProcess {
    this.spawnRequests.push(request);
    this.spawned.resolve();
    return this.child;
  }

  writeStackEnvFile(args: WriteDevAutoEnvFileArgs): Promise<void> {
    this.writeEnvRequests.push(args);
    return Promise.resolve();
  }

  writeStdout(message: string): void {
    this.stdout += message;
  }

  emitSignal(signal: ForwardedSignal): void {
    if (!this.signalHandler) {
      throw new Error("Signal handler was not installed");
    }
    this.signalHandler(signal);
  }

  waitForSpawn(): Promise<void> {
    return this.spawned.promise;
  }
}

describe("run-dev-auto", () => {
  it("spawns the existing Turbo dev pipeline", () => {
    expect(createDevAutoTurboCommand()).toEqual({
      args: [
        "exec",
        "turbo",
        "run",
        "dev",
        "--filter",
        "@bb/app",
        "--filter",
        "@bb/server",
        "--filter",
        "@bb/host-daemon",
        "--filter",
        "@bb/dev-env",
        "--ui",
        "tui",
        "--concurrency",
        "20",
        "--no-update-notifier",
      ],
      command: "pnpm",
    });
  });

  it("injects the selected stack environment and scrubs leaked host bootstrap values", async () => {
    const reservation = createReservation({ slot: 1 });
    const runtime = new FakeDevAutoRuntime(reservation, {
      BB_HOST_ENROLL_KEY: "leaked-key",
      BB_HOST_ID: "host_leaked",
      PATH: "/bin",
    });

    const runPromise = runDevAutoWithRuntime(runtime);
    await runtime.waitForSpawn();
    const spawnRequest = runtime.spawnRequests[0];

    expect(spawnRequest?.env.BB_DATA_DIR).toBe(reservation.dataDir);
    expect(spawnRequest?.env.BB_DATABASE_URL).toBe(
      path.join(reservation.dataDir, "bb.db"),
    );
    expect(spawnRequest?.env.BB_SERVER_URL).toBe("http://127.0.0.1:3344");
    expect(spawnRequest?.env.BB_SERVER_PORT).toBe("3344");
    expect(spawnRequest?.env.BB_HOST_DAEMON_PORT).toBe("3012");
    expect(spawnRequest?.env.BB_DEV_APP_PORT).toBe("5183");
    expect(spawnRequest?.env.BB_DEV_ENV_PORT).toBe("9122");
    expect(spawnRequest?.env.BB_DEV_AUTO_STACK_ID).toBe("bb-dev-auto-1");
    expect(spawnRequest?.env.BB_DEV_AUTO_SLOT).toBe("1");
    expect(spawnRequest?.env.BB_HOST_ID).toBeUndefined();
    expect(spawnRequest?.env.BB_HOST_ENROLL_KEY).toBeUndefined();
    expect(spawnRequest?.env.BB_HOST_NAME).toBe("dev-machine dev:auto slot 1");
    expect(runtime.writeEnvRequests[0]?.envFilePath).toBe(
      path.join(reservation.dataDir, "dev-auto.env"),
    );
    expect(runtime.stdout).toContain("BB_SERVER_URL=http://127.0.0.1:3344");

    runtime.child.resolveExit({ code: 0, signal: null });
    await runPromise;
    expect(runtime.exitCode).toBe(0);
    expect(runtime.releaseRequests).toHaveLength(1);
  });

  it("preserves an explicit host name", async () => {
    const reservation = createReservation({ slot: 2 });
    const runtime = new FakeDevAutoRuntime(reservation, {
      BB_HOST_NAME: "custom host",
    });

    const runPromise = runDevAutoWithRuntime(runtime);
    await runtime.waitForSpawn();

    expect(runtime.spawnRequests[0]?.env.BB_HOST_NAME).toBe("custom host");

    runtime.child.resolveExit({ code: 0, signal: null });
    await runPromise;
  });

  it("forwards shutdown signals and releases the reservation", async () => {
    const reservation = createReservation({ slot: 0 });
    const runtime = new FakeDevAutoRuntime(reservation, {});

    const runPromise = runDevAutoWithRuntime(runtime);
    await runtime.waitForSpawn();

    runtime.emitSignal("SIGTERM");
    await runPromise;

    expect(runtime.child.killedSignals).toEqual(["SIGTERM"]);
    expect(runtime.exitCode).toBe(1);
    expect(runtime.releaseRequests).toEqual([
      {
        env: {},
        reservation,
      },
    ]);
  });
});
