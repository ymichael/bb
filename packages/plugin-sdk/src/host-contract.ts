import type {
  PluginRpcContract,
  PluginRpcResult,
  StandardSchemaV1,
  StandardSchemaV1InferInput,
  StandardSchemaV1InferOutput,
} from "./rpc-contract.js";

export interface ExperimentalHostSignalContract<
  PayloadSchema extends StandardSchemaV1 = StandardSchemaV1,
> {
  readonly payload: PayloadSchema;
}

export type ExperimentalHostSignals = Readonly<
  Record<string, ExperimentalHostSignalContract>
>;

export interface ExperimentalHostCallOptions {
  readonly hostId: string;
  readonly signal?: AbortSignal;
  /**
   * How long the call may run before it fails, in milliseconds. Defaults to
   * 30 seconds; capped at 30 minutes. Work that legitimately runs longer —
   * a setup script, a clone — should either set this or be split into a
   * job the host entry runs in the background and reports on.
   */
  readonly timeoutMs?: number;
}

export interface ExperimentalHostClient<
  Contract extends PluginRpcContract,
  Signals extends ExperimentalHostSignals = {},
> {
  call<MethodName extends keyof Contract & string>(
    method: MethodName,
    input: StandardSchemaV1InferInput<Contract[MethodName]["input"]>,
    options: ExperimentalHostCallOptions,
  ): Promise<PluginRpcResult<Contract[MethodName]>>;
  /**
   * Subscribe to unexpected exits of this plugin's worker on a host daemon.
   * Graceful reload, disable, uninstall, and daemon shutdown do not emit this
   * event. A later call starts a fresh worker.
   */
  experimental_onWorkerExit(
    handler: (event: { readonly hostId: string }) => void | Promise<void>,
  ): () => void;
  /** Subscribe to a validated, ephemeral signal from this plugin's host entry. */
  experimental_onSignal<SignalName extends keyof Signals & string>(
    signal: SignalName,
    handler: (
      event: ExperimentalHostSignalEvent<Signals, SignalName>,
    ) => void | Promise<void>,
  ): () => void;
}

export interface ExperimentalHostSignalEvent<
  Signals extends ExperimentalHostSignals,
  SignalName extends keyof Signals & string,
> {
  readonly hostId: string;
  readonly payload: StandardSchemaV1InferOutput<Signals[SignalName]["payload"]>;
}

export interface ExperimentalHostPaths {
  /** Persistent directory scoped to this plugin on this daemon. */
  readonly dataDir: string;
  /** Temporary directory scoped to this worker process. */
  readonly tempDir: string;
}

export type ExperimentalHostWatchChangeType = "create" | "update" | "delete";

export interface ExperimentalHostWatchChange {
  readonly path: string;
  readonly type: ExperimentalHostWatchChangeType;
}

export type ExperimentalHostWatchEvent =
  | {
      readonly kind: "changed";
      readonly changes: readonly ExperimentalHostWatchChange[];
    }
  | { readonly kind: "rescan-required" }
  | { readonly kind: "watch-error"; readonly message: string };

export interface ExperimentalHostWatchOptions {
  /** Absolute directory observed by the daemon's native watcher service. */
  readonly rootPath: string;
  /** Root-relative ignore entries using the native watcher syntax. */
  readonly ignoredPaths?: readonly string[];
  /** Quiet period before one coalesced delivery. Defaults to 75 ms. */
  readonly debounceMs?: number;
  /** Maximum time changes may wait. Defaults to 500 ms. */
  readonly maxWaitMs?: number;
}

export interface ExperimentalHostWatchSubscription {
  dispose(): Promise<void>;
}

export interface ExperimentalHostWorkerLease {
  /** Release this worker-retention lease. Safe to call more than once. */
  dispose(): Promise<void>;
}

export type ExperimentalHostWatchListener = (
  event: ExperimentalHostWatchEvent,
) => void | Promise<void>;

export interface ExperimentalHostRpcContext<
  Signals extends ExperimentalHostSignals = {},
> {
  /** Aborted when this request is cancelled or its worker is disposed. */
  readonly signal: AbortSignal;
  /** Aborted once for the lifetime of this worker process. */
  readonly lifecycle: { readonly signal: AbortSignal };
  readonly experimental_paths: ExperimentalHostPaths;
  /** Publish a validated, ephemeral event to this plugin's server entry. */
  experimental_emitSignal<SignalName extends keyof Signals & string>(
    signal: SignalName,
    payload: StandardSchemaV1InferInput<Signals[SignalName]["payload"]>,
  ): Promise<void>;
  /** Observe raw filesystem changes through the daemon's native watcher. */
  experimental_watch(
    options: ExperimentalHostWatchOptions,
    listener: ExperimentalHostWatchListener,
  ): Promise<ExperimentalHostWatchSubscription>;
  /**
   * Keep this worker alive after the current call finishes. Active calls and
   * filesystem watches already retain it; use this only for other background
   * work. The daemon may stop an unretained worker after an idle period.
   */
  experimental_retainWorker(): ExperimentalHostWorkerLease;
}

export type ExperimentalHostRpcHandlers<
  Contract extends PluginRpcContract,
  Signals extends ExperimentalHostSignals = {},
> = {
  [MethodName in keyof Contract]: (
    input: StandardSchemaV1InferOutput<Contract[MethodName]["input"]>,
    context: ExperimentalHostRpcContext<Signals>,
  ) =>
    | StandardSchemaV1InferInput<Contract[MethodName]["output"]>
    | Promise<StandardSchemaV1InferInput<Contract[MethodName]["output"]>>;
};

export interface ExperimentalHostEntry<
  Contract extends PluginRpcContract = PluginRpcContract,
  Signals extends ExperimentalHostSignals = {},
> {
  readonly experimental_apiVersion: 1;
  readonly contract: Contract;
  readonly experimental_signals?: Signals;
  readonly handlers: ExperimentalHostRpcHandlers<Contract, Signals>;
  readonly dispose?: () => void | Promise<void>;
}

/** Define the single host executable exported by `bb.host`. */
export function experimental_defineHostEntry<
  const Contract extends PluginRpcContract,
  const Signals extends ExperimentalHostSignals = {},
>(args: {
  contract: Contract;
  experimental_signals?: Signals;
  handlers: ExperimentalHostRpcHandlers<Contract, Signals>;
  dispose?: () => void | Promise<void>;
}): ExperimentalHostEntry<Contract, Signals> {
  return {
    experimental_apiVersion: 1,
    contract: args.contract,
    handlers: args.handlers,
    ...(args.experimental_signals === undefined
      ? {}
      : { experimental_signals: args.experimental_signals }),
    ...(args.dispose === undefined ? {} : { dispose: args.dispose }),
  };
}
