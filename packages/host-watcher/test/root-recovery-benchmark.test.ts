import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  disposeParcelWatcherBackend,
  setParcelWatcherBackend,
} from "../src/parcel-watcher-backend.js";
import { createParcelHostWatcher } from "../src/parcel-host-watcher.js";
import { createChildChannel } from "../src/parcel-subprocess/fork-channel.js";
import type {
  ChildToParentMessage,
  ParentToChildMessage,
} from "../src/parcel-subprocess/messages.js";
import {
  createParcelWatcherProxy,
  type ChildChannel,
} from "../src/parcel-subprocess/parcel-watcher-proxy.js";
import { createDebouncedCallbackScheduler } from "../src/watch-callback-scheduler.js";

const BENCHMARK_ENABLED =
  process.env.BB_WATCHER_ROOT_RECOVERY_BENCHMARK === "1";
const ROOT_COUNTS: readonly number[] = [57, 100];
const DIRECTORY_COUNT_PER_ROOT = 8;
const FILE_COUNT_PER_DIRECTORY = 16;
const FILE_SIZE_BYTES = 4 * 1024;
const FILE_COUNT_PER_ROOT =
  DIRECTORY_COUNT_PER_ROOT * FILE_COUNT_PER_DIRECTORY + 1;
const BYTE_COUNT_PER_ROOT = FILE_COUNT_PER_ROOT * FILE_SIZE_BYTES;
const TOP_LEVEL_ENTRY_COUNT_PER_ROOT = DIRECTORY_COUNT_PER_ROOT + 1;
const TREE_ENTRY_COUNT_PER_ROOT =
  TOP_LEVEL_ENTRY_COUNT_PER_ROOT +
  DIRECTORY_COUNT_PER_ROOT * FILE_COUNT_PER_DIRECTORY;
const DOWNSTREAM_DEBOUNCE_MS = 75;
const DOWNSTREAM_MAX_WAIT_MS = 500;
const LOAD_BURST_MS = 8;
const LOAD_YIELD_MS = 8;
const DEFAULT_ITERATIONS = 20;
const DEFAULT_WARMUP_ITERATIONS = 2;
const RECOVERY_TIMEOUT_MS = 30_000;
const QUIESCENCE_MS = 100;
const benchmarkChildPath = fileURLToPath(
  new URL("./fixtures/parcel-recovery-benchmark-child.ts", import.meta.url),
);

type LoadMode = "controlled-cpu" | "idle";
type RecoveryKind = "global-restart" | "targeted-subscription";

interface BenchmarkTelemetryMessage {
  kind: "benchmark-telemetry";
  event:
    | "fault-injected"
    | "list-entries-complete"
    | "native-subscribe-ready"
    | "native-subscribe-start"
    | "native-unsubscribe-ready"
    | "native-unsubscribe-start";
  rootPath: string;
  entryCount?: number;
}

interface Fixture {
  baseDir: string;
  roots: string[];
  triggerPath: string;
  rootCount: number;
  filesPerRoot: number;
  bytesPerRoot: number;
  topLevelEntriesPerRoot: number;
  treeEntriesPerRoot: number;
  totalFiles: number;
  totalBytes: number;
}

interface TreeScanResult {
  bytes: number;
  entries: number;
  files: number;
}

interface RecoveryCounters {
  affectedDownstreamScans: number;
  childEventBatches: number;
  childEvents: number;
  childRestarts: number;
  downstreamBytesRead: number;
  downstreamEntriesProcessed: number;
  downstreamFilesRead: number;
  downstreamScans: number;
  faultInjections: number;
  hostEventBatches: number;
  hostEvents: number;
  listEntriesCalls: number;
  listEntriesProcessed: number;
  nativeSubscribeReady: number;
  nativeSubscribeStarts: number;
  nativeUnsubscribeReady: number;
  nativeUnsubscribeStarts: number;
  proxyReplaySubscriptions: number;
  proxySubscribeMessages: number;
  proxyUnsubscribeMessages: number;
  rescanNotifications: number;
  unaffectedDownstreamScans: number;
  watchErrors: number;
}

interface IterationResult {
  counters: RecoveryCounters;
  eventLoopDelayMaxMs: number;
  eventLoopDelayP50Ms: number;
  eventLoopDelayP95Ms: number;
  eventLoopUtilization: number;
  initialReadyMs: number;
  loadCycles: number;
  loadMode: LoadMode;
  recoveryKind: RecoveryKind;
  recoveryLatencyMs: number;
  rootCount: number;
}

interface Distribution {
  max: number;
  p50: number;
  p95: number;
}

interface ScenarioSummary {
  counts: RecoveryCounters;
  countsDeterministic: boolean;
  eventLoopDelayMaxMs: Distribution;
  eventLoopUtilization: Distribution;
  initialReadyMs: Distribution;
  iterations: number;
  loadMode: LoadMode;
  recoveryKind: RecoveryKind;
  recoveryLatencyMs: Distribution;
  rootCount: number;
}

interface BenchmarkDocument {
  fixture: {
    bytesPerRoot: number;
    directoriesPerRoot: number;
    fileSizeBytes: number;
    filesPerDirectory: number;
    filesPerRoot: number;
    topLevelEntriesPerRoot: number;
    treeEntriesPerRoot: number;
  };
  host: {
    arch: string;
    node: string;
    platform: string;
    release: string;
  };
  iterations: number;
  raw: IterationResult[];
  summary: ScenarioSummary[];
  warmupIterations: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBenchmarkTelemetryMessage(
  value: unknown,
): value is BenchmarkTelemetryMessage {
  if (
    !isRecord(value) ||
    value.kind !== "benchmark-telemetry" ||
    typeof value.event !== "string" ||
    typeof value.rootPath !== "string"
  ) {
    return false;
  }
  return [
    "fault-injected",
    "list-entries-complete",
    "native-subscribe-ready",
    "native-subscribe-start",
    "native-unsubscribe-ready",
    "native-unsubscribe-start",
  ].includes(value.event);
}

function createCounters(): RecoveryCounters {
  return {
    affectedDownstreamScans: 0,
    childEventBatches: 0,
    childEvents: 0,
    childRestarts: 0,
    downstreamBytesRead: 0,
    downstreamEntriesProcessed: 0,
    downstreamFilesRead: 0,
    downstreamScans: 0,
    faultInjections: 0,
    hostEventBatches: 0,
    hostEvents: 0,
    listEntriesCalls: 0,
    listEntriesProcessed: 0,
    nativeSubscribeReady: 0,
    nativeSubscribeStarts: 0,
    nativeUnsubscribeReady: 0,
    nativeUnsubscribeStarts: 0,
    proxyReplaySubscriptions: 0,
    proxySubscribeMessages: 0,
    proxyUnsubscribeMessages: 0,
    rescanNotifications: 0,
    unaffectedDownstreamScans: 0,
    watchErrors: 0,
  };
}

class RecoveryObserver {
  readonly counters = createCounters();
  readonly hostReadyRoots = new Set<number>();
  readonly initialNativeReadyRoots = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private failure: Error | null = null;
  private measuring = false;

  startMeasuring(): void {
    this.measuring = true;
    this.signal();
  }

  stopMeasuring(): void {
    this.measuring = false;
  }

  fail(error: unknown): void {
    this.failure =
      error instanceof Error ? error : new Error("Benchmark callback failed");
    this.signal();
  }

  recordChildSpawn(): void {
    if (this.measuring) {
      this.counters.childRestarts += 1;
      this.signal();
    }
  }

  recordParentMessage(message: ParentToChildMessage): void {
    if (!this.measuring) {
      return;
    }
    if (message.kind === "subscribe") {
      this.counters.proxySubscribeMessages += 1;
      if (message.rescan === true) {
        this.counters.proxyReplaySubscriptions += 1;
      }
    } else if (message.kind === "unsubscribe") {
      this.counters.proxyUnsubscribeMessages += 1;
    }
    this.signal();
  }

  recordChildMessage(message: ChildToParentMessage): void {
    if (!this.measuring) {
      return;
    }
    if (message.kind === "events") {
      this.counters.childEventBatches += 1;
      this.counters.childEvents += message.events.length;
    }
    this.signal();
  }

  recordTelemetry(message: BenchmarkTelemetryMessage): void {
    if (message.event === "native-subscribe-ready") {
      this.initialNativeReadyRoots.add(path.resolve(message.rootPath));
    }
    if (!this.measuring) {
      this.signal();
      return;
    }
    switch (message.event) {
      case "fault-injected":
        this.counters.faultInjections += 1;
        break;
      case "list-entries-complete":
        this.counters.listEntriesCalls += 1;
        this.counters.listEntriesProcessed += message.entryCount ?? 0;
        break;
      case "native-subscribe-ready":
        this.counters.nativeSubscribeReady += 1;
        break;
      case "native-subscribe-start":
        this.counters.nativeSubscribeStarts += 1;
        break;
      case "native-unsubscribe-ready":
        this.counters.nativeUnsubscribeReady += 1;
        break;
      case "native-unsubscribe-start":
        this.counters.nativeUnsubscribeStarts += 1;
        break;
    }
    this.signal();
  }

  recordHostReady(rootIndex: number): void {
    this.hostReadyRoots.add(rootIndex);
    this.signal();
  }

  recordHostEvents(eventCount: number): void {
    if (!this.measuring) {
      return;
    }
    this.counters.hostEventBatches += 1;
    this.counters.hostEvents += eventCount;
    this.signal();
  }

  recordRescanNotification(): void {
    if (!this.measuring) {
      return;
    }
    this.counters.rescanNotifications += 1;
    this.signal();
  }

  recordWatchError(error: Error): void {
    if (!this.measuring) {
      return;
    }
    this.counters.watchErrors += 1;
    this.fail(error);
  }

  recordDownstreamScan(rootIndex: number, result: TreeScanResult): void {
    if (!this.measuring) {
      return;
    }
    this.counters.downstreamScans += 1;
    this.counters.downstreamBytesRead += result.bytes;
    this.counters.downstreamEntriesProcessed += result.entries;
    this.counters.downstreamFilesRead += result.files;
    if (rootIndex === 0) {
      this.counters.affectedDownstreamScans += 1;
    } else {
      this.counters.unaffectedDownstreamScans += 1;
    }
    this.signal();
  }

  waitFor(
    label: string,
    predicate: () => boolean,
    timeoutMs: number = RECOVERY_TIMEOUT_MS,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.listeners.delete(check);
        reject(
          new Error(`${label} timed out: ${JSON.stringify(this.counters)}`),
        );
      }, timeoutMs);
      const check = () => {
        if (this.failure) {
          clearTimeout(timeout);
          this.listeners.delete(check);
          reject(this.failure);
          return;
        }
        if (predicate()) {
          clearTimeout(timeout);
          this.listeners.delete(check);
          resolve();
        }
      };
      this.listeners.add(check);
      check();
    });
  }

  private signal(): void {
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

class ControlledCpuLoad {
  private readonly payload = Buffer.alloc(64 * 1024, 0x5a);
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  cycles = 0;

  start(): void {
    this.timer = setTimeout(() => this.runBurst(), 0);
  }

  async warm(): Promise<void> {
    await new Promise<void>((resolve) =>
      setTimeout(resolve, 4 * LOAD_BURST_MS),
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  private runBurst(): void {
    if (this.stopped) {
      return;
    }
    const deadline = performance.now() + LOAD_BURST_MS;
    while (performance.now() < deadline) {
      createHash("sha256").update(this.payload).digest();
      this.cycles += 1;
    }
    this.timer = setTimeout(() => this.runBurst(), LOAD_YIELD_MS);
  }
}

function parsePositiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

async function createFixture(rootCount: number): Promise<Fixture> {
  const baseDir = await fs.mkdtemp(
    path.join(os.tmpdir(), `bb-watcher-root-recovery-${rootCount}-`),
  );
  const roots: string[] = [];
  for (let rootIndex = 0; rootIndex < rootCount; rootIndex += 1) {
    const rootPath = path.join(baseDir, `root-${rootIndex}`);
    roots.push(rootPath);
    await fs.mkdir(rootPath);
    for (
      let directoryIndex = 0;
      directoryIndex < DIRECTORY_COUNT_PER_ROOT;
      directoryIndex += 1
    ) {
      const directoryPath = path.join(rootPath, `dir-${directoryIndex}`);
      await fs.mkdir(directoryPath);
      const writes: Promise<void>[] = [];
      for (
        let fileIndex = 0;
        fileIndex < FILE_COUNT_PER_DIRECTORY;
        fileIndex += 1
      ) {
        const fill = (rootIndex + directoryIndex + fileIndex) % 251;
        writes.push(
          fs.writeFile(
            path.join(directoryPath, `file-${fileIndex}.bin`),
            Buffer.alloc(FILE_SIZE_BYTES, fill),
          ),
        );
      }
      await Promise.all(writes);
    }
    await fs.writeFile(
      path.join(rootPath, "fault-trigger.bin"),
      Buffer.alloc(FILE_SIZE_BYTES, rootIndex % 251),
    );
  }
  return {
    baseDir,
    roots,
    triggerPath: path.join(roots[0] ?? baseDir, "fault-trigger.bin"),
    rootCount,
    filesPerRoot: FILE_COUNT_PER_ROOT,
    bytesPerRoot: BYTE_COUNT_PER_ROOT,
    topLevelEntriesPerRoot: TOP_LEVEL_ENTRY_COUNT_PER_ROOT,
    treeEntriesPerRoot: TREE_ENTRY_COUNT_PER_ROOT,
    totalFiles: FILE_COUNT_PER_ROOT * rootCount,
    totalBytes: BYTE_COUNT_PER_ROOT * rootCount,
  };
}

async function scanTree(rootPath: string): Promise<TreeScanResult> {
  const hash = createHash("sha256");
  const directories = [rootPath];
  let bytes = 0;
  let entries = 0;
  let files = 0;
  while (directories.length > 0) {
    const directory = directories.pop();
    if (!directory) {
      break;
    }
    const children = (
      await fs.readdir(directory, { withFileTypes: true })
    ).sort((left, right) => left.name.localeCompare(right.name));
    entries += children.length;
    for (const child of children) {
      const childPath = path.join(directory, child.name);
      if (child.isDirectory()) {
        directories.push(childPath);
        continue;
      }
      if (!child.isFile()) {
        continue;
      }
      const data = await fs.readFile(childPath);
      hash.update(childPath);
      hash.update(data);
      bytes += data.byteLength;
      files += 1;
    }
  }
  hash.digest();
  return { bytes, entries, files };
}

function createInstrumentedChannel(
  observer: RecoveryObserver,
  faultRoot: string,
  triggerPath: string,
): ChildChannel {
  observer.recordChildSpawn();
  const child = fork(benchmarkChildPath, [], {
    env: {
      ...process.env,
      BB_WATCHER_BENCHMARK_FAULT_ROOT: faultRoot,
      BB_WATCHER_BENCHMARK_TRIGGER_PATH: triggerPath,
    },
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  const channel = createChildChannel(child);
  return {
    send(message) {
      observer.recordParentMessage(message);
      channel.send(message);
    },
    onMessage(listener) {
      channel.onMessage((message) => {
        const boundaryMessage: unknown = message;
        if (isBenchmarkTelemetryMessage(boundaryMessage)) {
          observer.recordTelemetry(boundaryMessage);
          return;
        }
        observer.recordChildMessage(message);
        listener(message);
      });
    },
    onExit(listener) {
      channel.onExit(listener);
    },
    kill() {
      channel.kill();
    },
  };
}

function triggerPayload(sequence: number): Buffer {
  const payload = Buffer.alloc(FILE_SIZE_BYTES, sequence % 251);
  payload.writeUInt32BE(sequence, 0);
  return payload;
}

function expectedGlobalRecovery(
  observer: RecoveryObserver,
  fixture: Fixture,
): boolean {
  const counters = observer.counters;
  return (
    counters.childRestarts === 1 &&
    counters.proxySubscribeMessages === fixture.rootCount &&
    counters.proxyReplaySubscriptions === fixture.rootCount &&
    counters.nativeSubscribeReady === fixture.rootCount &&
    counters.listEntriesCalls === fixture.rootCount &&
    counters.listEntriesProcessed ===
      fixture.rootCount * fixture.topLevelEntriesPerRoot &&
    counters.childEventBatches === fixture.rootCount &&
    counters.childEvents ===
      fixture.rootCount * fixture.topLevelEntriesPerRoot &&
    counters.hostEventBatches === fixture.rootCount &&
    counters.hostEvents ===
      fixture.rootCount * fixture.topLevelEntriesPerRoot &&
    counters.downstreamScans === fixture.rootCount &&
    counters.downstreamFilesRead === fixture.totalFiles &&
    counters.downstreamBytesRead === fixture.totalBytes &&
    counters.downstreamEntriesProcessed ===
      fixture.rootCount * fixture.treeEntriesPerRoot
  );
}

function expectedTargetedRecovery(
  observer: RecoveryObserver,
  fixture: Fixture,
): boolean {
  const counters = observer.counters;
  return (
    counters.childRestarts === 0 &&
    counters.proxySubscribeMessages === 1 &&
    counters.proxyReplaySubscriptions === 0 &&
    counters.proxyUnsubscribeMessages === 1 &&
    counters.nativeSubscribeReady === 1 &&
    counters.nativeUnsubscribeReady === 1 &&
    counters.listEntriesCalls === 0 &&
    counters.childEventBatches === 0 &&
    counters.hostEventBatches === 0 &&
    counters.rescanNotifications === 2 &&
    counters.downstreamScans === 2 &&
    counters.downstreamFilesRead === 2 * fixture.filesPerRoot &&
    counters.downstreamBytesRead === 2 * fixture.bytesPerRoot &&
    counters.downstreamEntriesProcessed === 2 * fixture.treeEntriesPerRoot
  );
}

function cloneCounters(counters: RecoveryCounters): RecoveryCounters {
  return { ...counters };
}

async function runIteration(args: {
  fixture: Fixture;
  loadMode: LoadMode;
  sequence: number;
}): Promise<IterationResult> {
  const { fixture, loadMode, sequence } = args;
  const observer = new RecoveryObserver();
  const proxy = createParcelWatcherProxy({
    spawnChannel: () =>
      createInstrumentedChannel(
        observer,
        fixture.roots[0] ?? fixture.baseDir,
        fixture.triggerPath,
      ),
  });
  setParcelWatcherBackend(proxy);
  const hostWatcher = createParcelHostWatcher();
  const watchPathRoot = hostWatcher.watchPathRoot;
  if (!watchPathRoot) {
    throw new Error("Host watcher path-root support is required");
  }
  const schedulers: ReturnType<typeof createDebouncedCallbackScheduler>[] = [];
  const stops: Array<() => void | Promise<void>> = [];
  const setupStartedAt = performance.now();
  let cpuLoad: ControlledCpuLoad | null = null;
  const eventLoopDelay = monitorEventLoopDelay({ resolution: 1 });

  try {
    for (let rootIndex = 0; rootIndex < fixture.roots.length; rootIndex += 1) {
      const rootPath = fixture.roots[rootIndex];
      if (!rootPath) {
        throw new Error(`Missing fixture root ${rootIndex}`);
      }
      const scheduler = createDebouncedCallbackScheduler({
        debounceMs: DOWNSTREAM_DEBOUNCE_MS,
        maxWaitMs: DOWNSTREAM_MAX_WAIT_MS,
        onFlush: () => {
          void scanTree(rootPath)
            .then((result) => {
              if (
                result.files !== fixture.filesPerRoot ||
                result.bytes !== fixture.bytesPerRoot ||
                result.entries !== fixture.treeEntriesPerRoot
              ) {
                throw new Error(
                  `Unexpected tree scan for ${rootPath}: ${JSON.stringify(result)}`,
                );
              }
              observer.recordDownstreamScan(rootIndex, result);
            })
            .catch((error: unknown) => observer.fail(error));
        },
      });
      schedulers.push(scheduler);
      stops.push(
        watchPathRoot({
          rootPath,
          ignoredPaths: [],
          onChange: (changes) => {
            observer.recordHostEvents(changes.length);
            scheduler.schedule();
          },
          onReady: () => observer.recordHostReady(rootIndex),
          onRescanRequired: () => {
            observer.recordRescanNotification();
            scheduler.schedule();
          },
          onWatchError: (error) => {
            observer.recordWatchError(new Error(error.message));
          },
        }),
      );
    }

    await observer.waitFor(
      "initial watcher readiness",
      () =>
        observer.hostReadyRoots.size === fixture.rootCount &&
        observer.initialNativeReadyRoots.size === fixture.rootCount,
    );
    const initialReadyMs = performance.now() - setupStartedAt;

    if (loadMode === "controlled-cpu") {
      cpuLoad = new ControlledCpuLoad();
      cpuLoad.start();
      await cpuLoad.warm();
    }

    eventLoopDelay.enable();
    eventLoopDelay.reset();
    const eventLoopUtilizationStart = performance.eventLoopUtilization();
    observer.startMeasuring();
    const recoveryStartedAt = performance.now();
    await fs.writeFile(fixture.triggerPath, triggerPayload(sequence));

    await observer.waitFor(
      "fault injection",
      () => observer.counters.faultInjections === 1,
    );
    await observer.waitFor(
      "recovery classification",
      () =>
        observer.counters.childRestarts === 1 ||
        observer.counters.nativeUnsubscribeStarts === 1,
    );

    const recoveryKind: RecoveryKind =
      observer.counters.childRestarts === 1
        ? "global-restart"
        : "targeted-subscription";
    await observer.waitFor("settled watcher recovery", () =>
      recoveryKind === "global-restart"
        ? expectedGlobalRecovery(observer, fixture)
        : expectedTargetedRecovery(observer, fixture),
    );
    const recoveryLatencyMs = performance.now() - recoveryStartedAt;
    eventLoopDelay.disable();
    const eventLoopUtilization = performance.eventLoopUtilization(
      eventLoopUtilizationStart,
    );
    if (cpuLoad) {
      await cpuLoad.stop();
    }
    const countersAtSettlement = JSON.stringify(observer.counters);
    await new Promise<void>((resolve) => setTimeout(resolve, QUIESCENCE_MS));
    expect(JSON.stringify(observer.counters)).toBe(countersAtSettlement);
    expect(observer.counters.faultInjections).toBe(1);
    expect(observer.counters.watchErrors).toBe(0);
    expect(observer.counters.nativeSubscribeStarts).toBe(
      observer.counters.nativeSubscribeReady,
    );
    expect(observer.counters.nativeUnsubscribeStarts).toBe(
      observer.counters.nativeUnsubscribeReady,
    );
    if (recoveryKind === "global-restart") {
      expect(expectedGlobalRecovery(observer, fixture)).toBe(true);
      expect(observer.counters.rescanNotifications).toBe(0);
      expect(observer.counters.affectedDownstreamScans).toBe(1);
      expect(observer.counters.unaffectedDownstreamScans).toBe(
        fixture.rootCount - 1,
      );
    } else {
      expect(expectedTargetedRecovery(observer, fixture)).toBe(true);
      expect(observer.counters.affectedDownstreamScans).toBe(2);
      expect(observer.counters.unaffectedDownstreamScans).toBe(0);
    }
    observer.stopMeasuring();

    return {
      counters: cloneCounters(observer.counters),
      eventLoopDelayMaxMs: eventLoopDelay.max / 1_000_000,
      eventLoopDelayP50Ms: eventLoopDelay.percentile(50) / 1_000_000,
      eventLoopDelayP95Ms: eventLoopDelay.percentile(95) / 1_000_000,
      eventLoopUtilization: eventLoopUtilization.utilization,
      initialReadyMs,
      loadCycles: cpuLoad?.cycles ?? 0,
      loadMode,
      recoveryKind,
      recoveryLatencyMs,
      rootCount: fixture.rootCount,
    };
  } finally {
    eventLoopDelay.disable();
    if (cpuLoad) {
      await cpuLoad.stop();
    }
    for (const scheduler of schedulers) {
      scheduler.dispose();
    }
    await Promise.all(stops.map(async (stop) => stop()));
    disposeParcelWatcherBackend();
  }
}

function percentile(values: readonly number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * quantile) - 1),
  );
  const value = sorted[index];
  if (value === undefined) {
    throw new Error("Benchmark distribution requires samples");
  }
  return value;
}

function distribution(values: readonly number[]): Distribution {
  return {
    max: Math.max(...values),
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
  };
}

function summarize(
  rootCount: number,
  loadMode: LoadMode,
  samples: readonly IterationResult[],
): ScenarioSummary {
  const first = samples[0];
  if (!first) {
    throw new Error("Benchmark summary requires samples");
  }
  const counts = JSON.stringify(first.counters);
  return {
    counts: first.counters,
    countsDeterministic: samples.every(
      (sample) => JSON.stringify(sample.counters) === counts,
    ),
    eventLoopDelayMaxMs: distribution(
      samples.map((sample) => sample.eventLoopDelayMaxMs),
    ),
    eventLoopUtilization: distribution(
      samples.map((sample) => sample.eventLoopUtilization),
    ),
    initialReadyMs: distribution(
      samples.map((sample) => sample.initialReadyMs),
    ),
    iterations: samples.length,
    loadMode,
    recoveryKind: first.recoveryKind,
    recoveryLatencyMs: distribution(
      samples.map((sample) => sample.recoveryLatencyMs),
    ),
    rootCount,
  };
}

describe.runIf(BENCHMARK_ENABLED)("root watcher recovery benchmark", () => {
  it(
    "measures settled recovery through real subprocess and filesystem work",
    async () => {
      const iterations = parsePositiveInteger(
        "BB_WATCHER_BENCHMARK_ITERATIONS",
        DEFAULT_ITERATIONS,
      );
      const warmupIterations = parsePositiveInteger(
        "BB_WATCHER_BENCHMARK_WARMUPS",
        DEFAULT_WARMUP_ITERATIONS,
      );
      const raw: IterationResult[] = [];
      const summary: ScenarioSummary[] = [];
      let sequence = 1;

      for (const rootCount of ROOT_COUNTS) {
        const fixture = await createFixture(rootCount);
        try {
          for (const loadMode of [
            "idle",
            "controlled-cpu",
          ] satisfies readonly LoadMode[]) {
            for (let index = 0; index < warmupIterations; index += 1) {
              await runIteration({ fixture, loadMode, sequence });
              sequence += 1;
            }
            const samples: IterationResult[] = [];
            for (let index = 0; index < iterations; index += 1) {
              const sample = await runIteration({
                fixture,
                loadMode,
                sequence,
              });
              sequence += 1;
              samples.push(sample);
              raw.push(sample);
            }
            const scenario = summarize(rootCount, loadMode, samples);
            expect(scenario.countsDeterministic).toBe(true);
            expect(
              samples.every(
                (sample) => sample.recoveryKind === scenario.recoveryKind,
              ),
            ).toBe(true);
            summary.push(scenario);
          }
        } finally {
          await fs.rm(fixture.baseDir, { force: true, recursive: true });
        }
      }

      const document: BenchmarkDocument = {
        fixture: {
          bytesPerRoot: BYTE_COUNT_PER_ROOT,
          directoriesPerRoot: DIRECTORY_COUNT_PER_ROOT,
          fileSizeBytes: FILE_SIZE_BYTES,
          filesPerDirectory: FILE_COUNT_PER_DIRECTORY,
          filesPerRoot: FILE_COUNT_PER_ROOT,
          topLevelEntriesPerRoot: TOP_LEVEL_ENTRY_COUNT_PER_ROOT,
          treeEntriesPerRoot: TREE_ENTRY_COUNT_PER_ROOT,
        },
        host: {
          arch: os.arch(),
          node: process.version,
          platform: os.platform(),
          release: os.release(),
        },
        iterations,
        raw,
        summary,
        warmupIterations,
      };
      const outputPath = process.env.BB_WATCHER_BENCHMARK_OUTPUT;
      if (outputPath) {
        await fs.writeFile(
          outputPath,
          `${JSON.stringify(document, null, 2)}\n`,
        );
      }
      process.stdout.write(
        `WATCHER_ROOT_RECOVERY_BENCHMARK ${JSON.stringify({
          fixture: document.fixture,
          host: document.host,
          iterations,
          summary,
          warmupIterations,
          ...(outputPath ? { outputPath } : {}),
        })}\n`,
      );
    },
    30 * 60_000,
  );
});
