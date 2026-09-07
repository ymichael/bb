import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

const HOST_WORKER_PROTOCOL_VERSION = 2;
const RESULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_DISPOSE_TIMEOUT_MS = 5_000;

interface StandardSchema {
  readonly "~standard": {
    readonly validate: (
      value: unknown,
    ) =>
      | { readonly value: unknown; readonly issues?: undefined }
      | { readonly issues: readonly { readonly message: string }[] }
      | Promise<
          | { readonly value: unknown; readonly issues?: undefined }
          | { readonly issues: readonly { readonly message: string }[] }
        >;
  };
}

interface HostMethod {
  readonly input: StandardSchema;
  readonly output: StandardSchema;
}

interface HostSignal {
  readonly payload: StandardSchema;
}

interface HostWatchOptions {
  readonly rootPath: string;
  readonly ignoredPaths?: readonly string[];
  readonly debounceMs?: number;
  readonly maxWaitMs?: number;
}

interface ResolvedHostWatchOptions {
  readonly rootPath: string;
  readonly ignoredPaths: readonly string[];
  readonly debounceMs: number;
  readonly maxWaitMs: number;
}

type HostWatchEvent =
  | {
      readonly kind: "changed";
      readonly changes: readonly {
        readonly path: string;
        readonly type: "create" | "update" | "delete";
      }[];
    }
  | { readonly kind: "rescan-required" }
  | { readonly kind: "watch-error"; readonly message: string };

type HostWatchListener = (event: HostWatchEvent) => void | Promise<void>;

interface HostWatchSubscription {
  dispose(): Promise<void>;
}

interface HostWorkerLease {
  dispose(): Promise<void>;
}

interface WorkerWatchState {
  readonly listener: HostWatchListener;
  readonly subscription: HostWatchSubscription;
  resolve: (subscription: HostWatchSubscription) => void;
  reject: (error: Error) => void;
  ready: boolean;
  disposed: boolean;
}

interface HostContext {
  readonly signal: AbortSignal;
  readonly lifecycle: { readonly signal: AbortSignal };
  readonly experimental_paths: {
    readonly dataDir: string;
    readonly tempDir: string;
  };
  experimental_emitSignal(signal: string, payload: unknown): Promise<void>;
  experimental_watch(
    options: HostWatchOptions,
    listener: HostWatchListener,
  ): Promise<HostWatchSubscription>;
  experimental_retainWorker(): HostWorkerLease;
}

interface HostEntry {
  readonly experimental_apiVersion: 1;
  readonly contract: Readonly<Record<string, HostMethod>>;
  readonly experimental_signals?: Readonly<Record<string, HostSignal>>;
  readonly handlers: Readonly<
    Record<string, (input: unknown, context: HostContext) => unknown>
  >;
  readonly dispose?: () => void | Promise<void>;
}

type ParentMessage =
  | {
      readonly type: "call";
      readonly callId: string;
      readonly method: string;
      readonly input: unknown;
    }
  | { readonly type: "cancel"; readonly callId: string }
  | { readonly type: "dispose" }
  | { readonly type: "watch-ready"; readonly watchId: string }
  | {
      readonly type: "watch-start-error";
      readonly watchId: string;
      readonly error: string;
    }
  | {
      readonly type: "watch-event";
      readonly watchId: string;
      readonly sequence: number;
      readonly event: HostWatchEvent;
    };

const MAX_WATCH_IGNORE_ENTRIES = 4_096;
const MAX_WATCH_PATH_BYTES = 16 * 1024;
const MIN_WATCH_DEBOUNCE_MS = 10;
const MAX_WATCH_DEBOUNCE_MS = 5_000;
const MAX_WATCH_WAIT_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSchema(value: unknown): value is StandardSchema {
  return (
    isRecord(value) &&
    isRecord(value["~standard"]) &&
    typeof value["~standard"].validate === "function"
  );
}

function parseEntry(value: unknown): HostEntry {
  if (
    !isRecord(value) ||
    value.experimental_apiVersion !== 1 ||
    !isRecord(value.contract) ||
    !isRecord(value.handlers) ||
    (value.dispose !== undefined && typeof value.dispose !== "function")
  ) {
    throw new Error("host artifact does not export a valid host entry");
  }
  for (const [name, method] of Object.entries(value.contract)) {
    if (
      !isRecord(method) ||
      !isSchema(method.input) ||
      !isSchema(method.output) ||
      typeof value.handlers[name] !== "function"
    ) {
      throw new Error(`host artifact has an invalid method "${name}"`);
    }
  }
  if (value.experimental_signals !== undefined) {
    if (!isRecord(value.experimental_signals)) {
      throw new Error("host artifact signals must be an object");
    }
    for (const [name, signal] of Object.entries(value.experimental_signals)) {
      if (!isRecord(signal) || !isSchema(signal.payload)) {
        throw new Error(`host artifact has an invalid signal "${name}"`);
      }
    }
  }
  return value as unknown as HostEntry;
}

function parseHostWatchEvent(value: unknown): HostWatchEvent | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  if (value.kind === "rescan-required") return { kind: value.kind };
  if (value.kind === "watch-error" && typeof value.message === "string") {
    return { kind: value.kind, message: value.message };
  }
  if (value.kind !== "changed" || !Array.isArray(value.changes)) return null;
  const changes: Array<{
    path: string;
    type: "create" | "update" | "delete";
  }> = [];
  for (const change of value.changes) {
    if (!isRecord(change) || typeof change.path !== "string") return null;
    if (
      change.type !== "create" &&
      change.type !== "update" &&
      change.type !== "delete"
    ) {
      return null;
    }
    changes.push({ path: change.path, type: change.type });
  }
  return { kind: value.kind, changes };
}

function parseParentMessage(value: unknown): ParentMessage | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  if (value.type === "dispose") return { type: "dispose" };
  if (value.type === "watch-ready" && typeof value.watchId === "string") {
    return { type: "watch-ready", watchId: value.watchId };
  }
  if (
    value.type === "watch-start-error" &&
    typeof value.watchId === "string" &&
    typeof value.error === "string"
  ) {
    return {
      type: "watch-start-error",
      watchId: value.watchId,
      error: value.error,
    };
  }
  if (
    value.type === "watch-event" &&
    typeof value.watchId === "string" &&
    typeof value.sequence === "number" &&
    Number.isSafeInteger(value.sequence)
  ) {
    const event = parseHostWatchEvent(value.event);
    if (event !== null) {
      return {
        type: "watch-event",
        watchId: value.watchId,
        sequence: value.sequence,
        event,
      };
    }
  }
  if (value.type === "cancel" && typeof value.callId === "string") {
    return { type: "cancel", callId: value.callId };
  }
  if (
    value.type === "call" &&
    typeof value.callId === "string" &&
    typeof value.method === "string"
  ) {
    return {
      type: "call",
      callId: value.callId,
      method: value.method,
      input: value.input,
    };
  }
  return null;
}

function validateWatchOptions(
  value: HostWatchOptions,
): ResolvedHostWatchOptions {
  if (!isRecord(value)) throw new Error("invalid host watch options");
  const ignoredPaths = value.ignoredPaths ?? [];
  const debounceMs = value.debounceMs ?? 75;
  const maxWaitMs = value.maxWaitMs ?? 500;
  if (
    typeof value.rootPath !== "string" ||
    !isAbsolute(value.rootPath) ||
    Buffer.byteLength(value.rootPath) > MAX_WATCH_PATH_BYTES ||
    !Array.isArray(ignoredPaths) ||
    ignoredPaths.length > MAX_WATCH_IGNORE_ENTRIES ||
    ignoredPaths.some(
      (entry) =>
        typeof entry !== "string" ||
        Buffer.byteLength(entry) > MAX_WATCH_PATH_BYTES,
    ) ||
    !Number.isInteger(debounceMs) ||
    debounceMs < MIN_WATCH_DEBOUNCE_MS ||
    debounceMs > MAX_WATCH_DEBOUNCE_MS ||
    !Number.isInteger(maxWaitMs) ||
    maxWaitMs < debounceMs ||
    maxWaitMs > MAX_WATCH_WAIT_MS
  ) {
    throw new Error("invalid host watch options");
  }
  return { rootPath: value.rootPath, ignoredPaths, debounceMs, maxWaitMs };
}

async function validate(
  schema: StandardSchema,
  value: unknown,
): Promise<unknown> {
  const result = await schema["~standard"].validate(value);
  if (result.issues !== undefined) {
    throw new Error(result.issues.map((issue) => issue.message).join("; "));
  }
  return result.value;
}

function normalizeJson(value: unknown, label: string): unknown {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = undefined;
  }
  if (serialized === undefined) {
    throw new Error(`${label} is not JSON-serializable`);
  }
  if (Buffer.byteLength(serialized) > RESULT_MAX_BYTES) {
    throw new Error(`${label} exceeds ${RESULT_MAX_BYTES} bytes`);
  }
  return JSON.parse(serialized);
}

function send(message: object): void {
  if (!process.connected) return;
  try {
    process.send?.(message);
  } catch {}
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const [
  artifactPath,
  pluginId,
  generation,
  dataDir,
  tempDir,
  disposeTimeoutArg,
] = process.argv.slice(2);
const disposeTimeoutMs =
  disposeTimeoutArg === undefined
    ? DEFAULT_DISPOSE_TIMEOUT_MS
    : Number(disposeTimeoutArg);
if (
  artifactPath === undefined ||
  !isAbsolute(artifactPath) ||
  pluginId === undefined ||
  generation === undefined ||
  dataDir === undefined ||
  !isAbsolute(dataDir) ||
  tempDir === undefined ||
  !isAbsolute(tempDir) ||
  !Number.isSafeInteger(disposeTimeoutMs) ||
  disposeTimeoutMs <= 0
) {
  throw new Error("invalid host worker arguments");
}

const lifecycleController = new AbortController();
const activeCalls = new Map<string, AbortController>();
const watches = new Map<string, WorkerWatchState>();
let nextWatchId = 1;
let nextLeaseId = 1;
let entry: HostEntry | null = null;
let disposing = false;

function startWatch(
  options: HostWatchOptions,
  listener: HostWatchListener,
  requestSignal: AbortSignal,
): Promise<HostWatchSubscription> {
  const validated = validateWatchOptions(options);
  if (typeof listener !== "function") {
    throw new Error("host watch listener must be a function");
  }
  if (disposing || lifecycleController.signal.aborted) {
    throw new Error("host worker is disposing");
  }
  const watchId = String(nextWatchId++);
  let resolve!: (subscription: HostWatchSubscription) => void;
  let reject!: (error: Error) => void;
  const pending = new Promise<HostWatchSubscription>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const subscription: HostWatchSubscription = {
    async dispose() {
      const state = watches.get(watchId);
      if (state === undefined || state.disposed) return;
      state.disposed = true;
      watches.delete(watchId);
      send({ type: "watch-stop", watchId });
      if (!state.ready) state.reject(new Error("host watch was disposed"));
    },
  };
  const state: WorkerWatchState = {
    listener,
    subscription,
    resolve,
    reject,
    ready: false,
    disposed: false,
  };
  watches.set(watchId, state);
  const abort = (): void => void subscription.dispose();
  requestSignal.addEventListener("abort", abort, { once: true });
  lifecycleController.signal.addEventListener("abort", abort, { once: true });
  const cleanup = (): void => {
    requestSignal.removeEventListener("abort", abort);
    lifecycleController.signal.removeEventListener("abort", abort);
  };
  void pending.then(cleanup, cleanup);
  if (requestSignal.aborted || lifecycleController.signal.aborted) {
    void subscription.dispose();
    return pending;
  }
  send({
    type: "watch-start",
    watchId,
    rootPath: validated.rootPath,
    ignoredPaths: [...validated.ignoredPaths],
    debounceMs: validated.debounceMs,
    maxWaitMs: validated.maxWaitMs,
  });
  return pending;
}

function handleWatchReady(watchId: string): void {
  const state = watches.get(watchId);
  if (state === undefined || state.disposed || state.ready) return;
  state.ready = true;
  state.resolve(state.subscription);
}

function handleWatchStartError(watchId: string, error: string): void {
  const state = watches.get(watchId);
  if (state === undefined || state.disposed || state.ready) return;
  state.disposed = true;
  watches.delete(watchId);
  state.reject(new Error(error));
}

function handleWatchEvent(
  watchId: string,
  sequence: number,
  event: HostWatchEvent,
): void {
  const state = watches.get(watchId);
  if (state === undefined || state.disposed) {
    send({ type: "watch-ack", watchId, sequence });
    return;
  }
  void Promise.resolve()
    .then(() => state.listener(event))
    .catch((error) => {
      process.stderr.write(
        `Host watch listener failed: ${errorMessage(error)}\n`,
      );
    })
    .finally(() => send({ type: "watch-ack", watchId, sequence }));
}

async function dispose(): Promise<void> {
  if (disposing) return;
  disposing = true;
  setTimeout(() => process.exit(1), disposeTimeoutMs);
  lifecycleController.abort();
  for (const controller of activeCalls.values()) controller.abort();
  activeCalls.clear();
  try {
    await Promise.all(
      [...watches.values()].map((watch) => watch.subscription.dispose()),
    );
    await entry?.dispose?.();
  } finally {
    if (process.connected) process.disconnect?.();
    process.exit(0);
  }
}

async function handleCall(
  message: Extract<ParentMessage, { type: "call" }>,
): Promise<void> {
  if (disposing) return;
  const currentEntry = entry;
  if (currentEntry === null) return;
  if (activeCalls.has(message.callId)) {
    send({
      type: "result",
      callId: message.callId,
      ok: false,
      error: `duplicate host plugin call ${message.callId}`,
    });
    return;
  }
  const method = currentEntry.contract[message.method];
  const handler = currentEntry.handlers[message.method];
  if (method === undefined || handler === undefined) {
    send({
      type: "result",
      callId: message.callId,
      ok: false,
      error: `unknown host method "${message.method}"`,
    });
    return;
  }
  const controller = new AbortController();
  activeCalls.set(message.callId, controller);
  let contextOpen = true;
  try {
    const input = await validate(method.input, message.input);
    const result = await handler(input, {
      signal: controller.signal,
      lifecycle: { signal: lifecycleController.signal },
      experimental_paths: { dataDir, tempDir },
      async experimental_emitSignal(signalName, payload) {
        const signal = currentEntry.experimental_signals?.[signalName];
        if (signal === undefined) {
          throw new Error(`unknown host signal "${signalName}"`);
        }
        const validated = await validate(signal.payload, payload);
        send({
          type: "signal",
          signal: signalName,
          payload: normalizeJson(validated, `host signal ${signalName}`),
        });
      },
      experimental_watch: (options, listener) =>
        startWatch(options, listener, controller.signal),
      experimental_retainWorker() {
        if (
          !contextOpen ||
          disposing ||
          controller.signal.aborted ||
          lifecycleController.signal.aborted
        ) {
          throw new Error("host call context is no longer active");
        }
        const leaseId = String(nextLeaseId++);
        let released = false;
        send({ type: "lease-acquire", leaseId });
        return {
          async dispose() {
            if (released) return;
            released = true;
            send({ type: "lease-release", leaseId });
          },
        };
      },
    });
    const output = normalizeJson(
      await validate(method.output, result),
      `host output for ${message.method}`,
    );
    send({ type: "result", callId: message.callId, ok: true, output });
  } catch (error) {
    send({
      type: "result",
      callId: message.callId,
      ok: false,
      error: errorMessage(error),
    });
  } finally {
    contextOpen = false;
    activeCalls.delete(message.callId);
  }
}

process.once("disconnect", () => void dispose());
if (!process.connected) void dispose();

try {
  const imported = await import(pathToFileURL(artifactPath).href);
  if (disposing) process.exit(0);
  entry = parseEntry(imported.default);
  process.on("message", (raw: unknown) => {
    const message = parseParentMessage(raw);
    if (message === null) return;
    if (message.type === "call") {
      void handleCall(message);
    } else if (message.type === "cancel") {
      activeCalls.get(message.callId)?.abort();
    } else if (message.type === "watch-ready") {
      handleWatchReady(message.watchId);
    } else if (message.type === "watch-start-error") {
      handleWatchStartError(message.watchId, message.error);
    } else if (message.type === "watch-event") {
      handleWatchEvent(message.watchId, message.sequence, message.event);
    } else {
      void dispose();
    }
  });
  send({
    type: "ready",
    protocolVersion: HOST_WORKER_PROTOCOL_VERSION,
    pluginId,
    generation,
  });
} catch (error) {
  if (disposing) process.exit(1);
  send({ type: "startup-error", error: errorMessage(error) });
  process.exit(1);
}
