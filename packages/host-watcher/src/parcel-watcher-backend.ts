import { createForkChannel } from "./parcel-subprocess/fork-channel.js";
import {
  createParcelWatcherProxy,
  type ParcelWatcherProxy,
} from "./parcel-subprocess/parcel-watcher-proxy.js";

type ParcelWatcherModule = typeof import("@parcel/watcher");
type ParcelWatcherSubscribe = ParcelWatcherModule["subscribe"];
type ParcelWatcherCallback = Parameters<ParcelWatcherSubscribe>[1];

export type ParcelWatcherEventBatch = Parameters<ParcelWatcherCallback>[1];
export type ParcelWatcherSubscribeOptions =
  Parameters<ParcelWatcherSubscribe>[2];
export type ParcelAsyncSubscription = Awaited<
  ReturnType<ParcelWatcherSubscribe>
>;
export type ParcelWatcherError = Parameters<ParcelWatcherCallback>[0];

export interface ParcelWatcherBackend {
  subscribe(
    dir: string,
    callback: (
      error: ParcelWatcherError,
      events: ParcelWatcherEventBatch,
    ) => unknown,
    opts?: ParcelWatcherSubscribeOptions,
  ): Promise<ParcelAsyncSubscription>;
}

function createInProcessBackend(): ParcelWatcherBackend {
  return {
    async subscribe(dir, callback, opts) {
      const { default: parcelWatcher } = await import("@parcel/watcher");
      return parcelWatcher.subscribe(dir, callback, opts);
    },
  };
}

type ParcelWatcherBackendLogLevel = "info" | "warn" | "error";
export type ParcelWatcherBackendLogger = (
  level: ParcelWatcherBackendLogLevel,
  message: string,
  fields?: Record<string, unknown>,
) => void;

export function createSubprocessParcelWatcherBackend(options?: {
  log?: ParcelWatcherBackendLogger;
}): ParcelWatcherProxy {
  return createParcelWatcherProxy({
    spawnChannel: createForkChannel,
    log: options?.log,
  });
}

let installedBackend: ParcelWatcherBackend | undefined;
let inProcessBackend: ParcelWatcherBackend | undefined;

export function setParcelWatcherBackend(backend: ParcelWatcherBackend): void {
  installedBackend = backend;
}

export function getParcelWatcherBackend(): ParcelWatcherBackend {
  if (installedBackend !== undefined) {
    return installedBackend;
  }
  if (inProcessBackend === undefined) {
    inProcessBackend = createInProcessBackend();
  }
  return inProcessBackend;
}

export function disposeParcelWatcherBackend(): void {
  const backend = installedBackend;
  installedBackend = undefined;
  if (
    backend !== undefined &&
    "dispose" in backend &&
    typeof backend.dispose === "function"
  ) {
    (backend as { dispose: () => void }).dispose();
  }
}
