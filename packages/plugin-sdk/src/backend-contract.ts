import type Database from "better-sqlite3";
import type { Context } from "hono";
import type * as z from "zod";
import type {
  Environment,
  Host,
  PermissionMode,
  PendingInteraction,
  Project,
  PromptInput,
  ProviderErrorInfo,
  ProviderNativeRootInput,
  ProviderNativeRootsInputLike,
  ProviderRateLimitState,
  ReasoningLevel,
  ServiceTier,
  ThreadQueuedMessage,
} from "@bb/domain";
import type { ProviderFork } from "@bb/domain/provider-fork";
import type { BbSdk } from "@bb/sdk";
import type {
  ExecutionInputFieldSource,
  StartedOnBehalfOf,
  ThreadCreateOrigin,
  ThreadResponse,
} from "@bb/server-contract";
import type { JsonValue } from "./json-value.js";
import type {
  PluginRpcContract,
  PluginRpcHandlers,
  StandardSchemaV1,
} from "./rpc-contract.js";
import type {
  ExperimentalHostClient,
  ExperimentalHostSignals,
} from "./host-contract.js";

/**
 * The backend plugin API contract — the `bb` object handed to a plugin's
 * `server.ts` factory (`export default function plugin(bb: BbPluginApi)`).
 *
 * Types only: the implementation lives in the BB server
 * (apps/server/src/services/plugins/plugin-api.ts), which imports these
 * shapes so the contract and the implementation cannot drift. Plugin authors
 * import them type-only (`import type { BbPluginApi } from
 * "@get-bb/plugin-sdk"`); the import is erased when BB loads the file.
 *
 * Runtime classes stay host-side. NeedsConfigurationError in particular is
 * matched by NAME, so plugin code needs no runtime import:
 * `throw Object.assign(new Error(msg), { name: "NeedsConfigurationError" })`.
 */

export interface PluginLogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

// ---------------------------------------------------------------------------
// Settings (design §4.2).
// ---------------------------------------------------------------------------

export type PluginSettingDescriptor =
  | {
      type: "string";
      label: string;
      description?: string;
      /** Stored in a 0600 file under <dataDir>/plugins/<id>/secrets/, never in the db or sent to the frontend. */
      secret?: true;
      /**
       * Render as a multi-line text field; for JSON or lists. Secrets cannot
       * be multi-line.
       */
      experimental_multiline?: boolean;
      /** Synchronously validate without transforming a proposed value. */
      experimental_schema?: StandardSchemaV1<string, string>;
      default?: string;
    }
  | {
      type: "boolean";
      label: string;
      description?: string;
      /** Synchronously validate without transforming a proposed value. */
      experimental_schema?: StandardSchemaV1<boolean, boolean>;
      default?: boolean;
    }
  | {
      type: "number";
      label: string;
      description?: string;
      experimental_schema?: StandardSchemaV1<number, number>;
      default?: number;
    }
  | {
      type: "select";
      label: string;
      description?: string;
      options: string[];
      /** Synchronously validate without transforming a proposed value. */
      experimental_schema?: StandardSchemaV1<string, string>;
      default?: string;
    }
  | {
      type: "project";
      label: string;
      description?: string;
      /** Synchronously validate without transforming a proposed value. */
      experimental_schema?: StandardSchemaV1<string, string>;
      default?: string;
    };

export type PluginSettingDescriptors = Record<string, PluginSettingDescriptor>;

export type PluginSettingValue = string | number | boolean;

/** `default` present → non-optional value; absent → `T | undefined`. */
export type PluginSettingsValues<
  Ds extends Record<string, PluginSettingDescriptor>,
> = {
  [K in keyof Ds]: Ds[K] extends { default: string | number | boolean }
    ? PluginSettingValueOf<Ds[K]>
    : PluginSettingValueOf<Ds[K]> | undefined;
};

type PluginSettingValueOf<D extends PluginSettingDescriptor> = D extends {
  type: "boolean";
}
  ? boolean
  : D extends { type: "number" }
    ? number
    : string;

export interface PluginSettingsHandle<
  Ds extends Record<string, PluginSettingDescriptor>,
> {
  /** Load-safe: callable inside the factory. */
  get(): Promise<PluginSettingsValues<Ds>>;
  /** Validate and persist this handle's fields; `null` unsets a stored value. */
  experimental_set(
    values: Partial<{
      [K in keyof Ds]: PluginSettingValueOf<Ds[K]> | null;
    }>,
  ): Promise<PluginSettingsValues<Ds>>;
  /** Fires after effective values change through any settings write. */
  onChange(
    listener: (
      next: PluginSettingsValues<Ds>,
      prev: PluginSettingsValues<Ds>,
    ) => void,
  ): void;
}

export interface PluginSettings {
  define<Ds extends Record<string, PluginSettingDescriptor>>(
    descriptors: Ds,
  ): PluginSettingsHandle<Ds>;
}

// ---------------------------------------------------------------------------
// Storage (design §4.3).
// ---------------------------------------------------------------------------

export interface PluginKvStorage {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}

export interface PluginStorage {
  /** Namespaced JSON key-value rows in bb.db; values ≤256KB each. */
  kv: PluginKvStorage;
  /**
   * The plugin's own SQLite database at <dataDir>/plugins/<id>/data.db — the
   * server's better-sqlite3, WAL mode, busy_timeout 5000. Returns the same
   * open handle for the whole plugin load, so calling it per request is
   * cheap; a new handle is opened only on the first call or after the
   * plugin closed the previous one. The host closes handles on
   * dispose/reload; a closed handle throws on use.
   */
  database(): Database.Database;
  /**
   * Ordered-statement migration helper: statement index = migration id in a
   * `_bb_migrations` table; unapplied statements run in one transaction. The
   * host records each statement hash and rejects changed or reused indexes.
   * Append-only — never reorder or edit shipped statements.
   */
  migrate(db: Database.Database, statements: string[]): void;
}

// ---------------------------------------------------------------------------
// Thread lifecycle events (design §4.5).
// ---------------------------------------------------------------------------

/**
 * Why a turn failed, assembled by core from the failed turn's own records so a
 * listener never has to replay the event log to find out.
 *
 * Ids and failure facts only. There is no thread DTO and no copy of the
 * message that failed: a retry re-submits the turn BY REFERENCE
 * (`bb.sdk.threads.retry`), so the id is the whole of what a policy needs, and
 * anything else about the thread is one `bb.sdk.threads.get` away and fresher
 * for being read when it is used.
 */
export interface PluginTurnFailedEvent {
  /** The thread the failed turn ran on. */
  threadId: string;
  /**
   * The failed turn's `client/turn/requested` id — what
   * `bb.sdk.threads.retry` takes as `turnRequestId`. On a retry's failure this
   * is the RETRY's id; core walks back to the request the chain started from
   * when it queues the next attempt.
   */
  requestId: string;
  /** The provider turn, when the failure happened inside one. */
  turnId: string | null;
  /**
   * The failure's structured classification: the provider's own report when
   * the failure happened inside a turn, or the typed rejection code (a rate
   * limit, an auth failure) when the provider refused the request at the
   * door. Null when neither carried one, so a retry policy must handle null
   * rather than assume.
   */
  errorInfo: ProviderErrorInfo | null;
  /**
   * Whether the provider accepted the turn's input before failing. True is a
   * mid-stream failure — the input is already part of the provider's
   * conversation, so core's retry continues it instead of re-sending the
   * blocks. False is a request the provider never took, which a retry
   * re-sends verbatim.
   */
  inputAccepted: boolean;
  /**
   * The most recent rate-limit snapshot this thread's provider reported, or
   * null when the provider reports no windows.
   */
  rateLimits: ProviderRateLimitState | null;
  /**
   * Which attempt just failed: 1 is the original dispatch, 2 the first retry.
   * A policy caps its own retries by comparing against this.
   */
  attemptNumber: number;
}

/**
 * Lifecycle events a plugin can observe with `bb.events.on` (design §4.5).
 *
 * **Events are announcements core makes.** Something already happened; a
 * handler is told about it and whatever it returns is IGNORED. Handlers run
 * fire-and-forget after the change is applied and can never block or veto it.
 * The surface that *can* is `bb.experimental_hooks`, where core asks a
 * question and acts on the answer — the same split git draws between its
 * post-commit and pre-commit hooks.
 *
 * `thread` is the same public DTO GET /threads/:id serves and `entry` is the
 * queued row GET /threads/:id/queued-messages serves.
 */
export interface PluginThreadEventPayloads {
  /** Fired after a thread row is created. */
  "thread.created": { thread: ThreadResponse };
  /** Fired when a thread transitions into `active`. */
  "thread.active": { thread: ThreadResponse };
  /** Fired when a thread transitions into `idle`. `lastAssistantText` is
   * assembled the same way GET /threads/:id/output is. */
  "thread.idle": { thread: ThreadResponse; lastAssistantText: string | null };
  /** Fired when a thread transitions into `error`. `error` is the latest
   * system/error event message, when one exists. */
  "thread.failed": { thread: ThreadResponse; error: string | null };
  /** Fired after a thread is archived (including cascade archives). */
  "thread.archived": { thread: ThreadResponse };
  /** Fired after a thread is soft-deleted. */
  "thread.deleted": { thread: ThreadResponse };
  /** Fired after a pending interaction row is committed. */
  "interaction.pending": {
    thread: ThreadResponse;
    interaction: PendingInteraction;
  };
  /**
   * Fired after a dispatch attempt is queued as a row — by a `message.dispatch`
   * hook's `wait` decision, by a `sendAt` in the future, or by a core wait (the
   * thread is busy, its turn is still starting, provisioning, or awaiting an
   * interaction).
   *
   * Every listener sees every queued row, not just the ones it is holding: an
   * observer that only wants its own filters on
   * `entry.waitingOn?.kind === "plugin" && entry.waitingOn.pluginId === bb.pluginId`.
   *
   * A re-queue fires this again with the new wait, because a row that moved
   * from one wait to another is news to whoever was waiting on the old one.
   */
  "message.queued": { entry: ThreadQueuedMessage };
  /**
   * Fired after a queued row's waits all cleared and it dispatched. The turn
   * it carried runs after this, so a handler must not assume it has started.
   */
  "message.dispatched": { entry: ThreadQueuedMessage };
  /**
   * Fired after a turn failed and the thread has already landed in `error`.
   *
   * An announcement, not a question: the failure stands exactly as core
   * applied it, and a listener that wants another attempt asks for one with
   * `bb.sdk.threads.retry({ threadId, turnRequestId, sendAt })`. That retry is
   * an ordinary dispatch attempt, so it still passes the `message.dispatch`
   * hook — a retry coming back after a rate-limit window respects a limiter
   * that is at capacity instead of jumping the queue.
   */
  "turn.failed": PluginTurnFailedEvent;
}

export type PluginThreadEventName = keyof PluginThreadEventPayloads;

export type PluginThreadEventHandler<E extends PluginThreadEventName> = (
  payload: PluginThreadEventPayloads[E],
) => void | Promise<void>;

// ---------------------------------------------------------------------------
// Hooks: the questions core asks (plans/dispatch-queue-rework.md).
// ---------------------------------------------------------------------------

/**
 * What a `message.dispatch` hook answers.
 *
 * `proceed` lets the attempt continue. `wait` QUEUES the message as a row
 * whose `waitingOn` names this plugin and carries `reason` verbatim; the
 * row stays queued until `sendAt` comes due, capacity frees, the user sends
 * it now, or the orphan sweep clears it because this plugin is no longer
 * running. `sendAt` (epoch ms) sets the row's own `sendAt`, so core's due sweep
 * re-attempts at that instant without the plugin holding a timer of its own —
 * which is what a rate-limit window wants. `reject` refuses the attempt
 * outright: `message` is shown to the user verbatim.
 *
 * There is deliberately no "handled it myself" answer and no amendment arm —
 * a hook is a decision, never an owner or an author of the work.
 */
export type MessageDispatchHookDecision =
  | { action: "proceed" }
  | { action: "wait"; reason: string; sendAt?: number | null }
  | { action: "reject"; message: string };

/**
 * The execution tuple as core resolved it before this hook ran. `model` and
 * the three option fields are null only when no default has been resolved for
 * them yet; `providerId` is always resolved.
 */
export interface PluginDispatchExecution {
  providerId: string;
  model: string | null;
  reasoningLevel: ReasoningLevel | null;
  serviceTier: ServiceTier | null;
  permissionMode: PermissionMode | null;
}

/**
 * Where each execution value came from. `explicit` is a user choice,
 * `client-preference` a remembered client default, and null means core
 * resolved it from project/provider defaults. A hook that must not act against
 * a deliberate choice checks for `explicit` here.
 */
export interface PluginDispatchExecutionSources {
  providerId: ExecutionInputFieldSource | null;
  model: ExecutionInputFieldSource | null;
  reasoningLevel: ExecutionInputFieldSource | null;
  serviceTier: ExecutionInputFieldSource | null;
  permissionMode: ExecutionInputFieldSource | null;
}

/**
 * The prompt this dispatch carries. `blocks` is the message itself; `text` is
 * the concatenated text of its text blocks, which is what a rules-based hook
 * actually wants to match on.
 */
export interface PluginDispatchInput {
  blocks: readonly PromptInput[];
  text: string;
}

/**
 * How this attempt would reach the provider.
 *
 * `start-turn` is a dispatch that begins a turn: a thread's first message, a
 * plain send to an idle or `pending` thread, or a steer-mode message that
 * found no running turn to join. `join-turn` is an injection into a turn that
 * is already executing.
 *
 * Decision powers are identical for both — a steer is hooked exactly like a
 * send, uniformly. A hook that limits concurrency proceeds on `join-turn`: the
 * thread already holds its slot, so joining it asks for nothing new.
 */
export type PluginDispatchAttemptKind = "start-turn" | "join-turn";

/**
 * What core hands a `message.dispatch` hook: the one checkpoint, run before a
 * message reaches a provider. The exception is a user's explicit Send-now on a
 * queued row, which bypasses the pass by design — it is the user overriding
 * policy, and a policy that could veto its own override would not be one.
 *
 * It runs identically whether the attempt is inline (someone just sent) or
 * from a drain (a queued row became eligible again), and whether the message
 * is a thread's first, a follow-up, a steer, or a retry of a failed turn. A
 * handler must therefore be idempotent for one logical dispatch: passes re-run
 * on every drain, on restart, and on retry.
 */
export interface MessageDispatchHookContext {
  /**
   * The target thread. Never null: thread creation is unhooked — it is a cheap
   * row — so by the time the first message is decided about, the thread exists
   * in `pending`, with its provider resolved and nothing provisioned.
   */
  thread: ThreadResponse;
  project: Project;
  /** Null until an environment is chosen (a queued or not-yet-provisioned thread). */
  environment: Environment | null;
  /**
   * The machine the work will run on. Resolved from the environment when one
   * is attached, and before that from the start intent the thread was created
   * with — so a per-host policy counts a cold start against the pool it is
   * about to occupy. Null only when neither names a machine.
   */
  host: Host | null;
  input: PluginDispatchInput;
  requestedExecution: PluginDispatchExecution;
  /** Where each execution value came from. */
  executionSources: PluginDispatchExecutionSources;
  /** Whether this attempt starts a turn or joins a running one. */
  attempt: PluginDispatchAttemptKind;
  /**
   * The queued row this attempt is re-trying, or null when the attempt is
   * inline and no row has ever existed for it.
   *
   * This is how a hook tells a fresh send from a re-attempt of something it
   * already decided about — the replacement for the old
   * `isReleaseReevaluation`/`hold` pair. A hook that counts in-flight work
   * should treat the two identically; a hook that logs should not
   * double-count.
   */
  queuedMessage: ThreadQueuedMessage | null;
  /** How the dispatch was requested; null for internal/core-driven sends. */
  origin: ThreadCreateOrigin | null;
  originPluginId: string | null;
  startedOnBehalfOf: StartedOnBehalfOf | null;
  parentThreadId: string | null;
}

/**
 * The hooks a plugin can answer, each mapping its key to the context core
 * hands the handler and the decision core acts on. `on()` and the handler type
 * derive from this map — and so does the server's hook registry — so a
 * half-added hook does not compile.
 *
 * One hook today: `message.dispatch`, THE admission checkpoint, run identically
 * for a thread's first message, a follow-up, a steer, a retry, and every
 * re-attempt a drain makes. It replaced the earlier `thread.create` +
 * `turn.submit` pair, whose split was an accident of where the code happened to
 * branch rather than a difference a plugin needed to see — the attempt's own
 * `attempt` kind carries what actually differs.
 */
export interface PluginHookSignatures {
  "message.dispatch": {
    context: MessageDispatchHookContext;
    decision: MessageDispatchHookDecision;
  };
}

export type PluginHookName = keyof PluginHookSignatures;

export type PluginHookHandler<K extends PluginHookName> = (
  context: PluginHookSignatures[K]["context"],
) =>
  | PluginHookSignatures[K]["decision"]
  | Promise<PluginHookSignatures[K]["decision"]>;

export interface PluginHooks {
  /**
   * Answer a hook.
   *
   * **Hooks are questions core asks.** Core stops at a checkpoint, hands the
   * handler a context, and ACTS ON what it returns — the opposite of
   * `bb.events`, whose handlers are told what already happened and whose
   * return value is ignored. It is the same split git draws between its
   * pre-commit and post-commit hooks, and the reason the two live in separate
   * namespaces rather than behind one `on`.
   *
   * Handlers for a hook run as a deterministic chain in plugin install order,
   * a `reject` short-circuits the pass, and `wait` decisions are COLLECTED
   * across the whole pass rather than short-circuiting. The attempt proceeds
   * only when a pass yields no waits. When several plugins wait, the FIRST owns
   * the row's `waitingOn` and the rest have their reasons appended to it, so
   * one decision produces one card rather than one per plugin; each of them
   * answers again on the next attempt, so nothing is lost by not owning the
   * row.
   *
   * Fail-closed: a handler that throws or exceeds the 10 second decision box
   * FAILS THE ATTEMPT with this plugin named. Decide in milliseconds — if the
   * answer needs real work, return `wait` with a `sendAt` and answer again on
   * the re-attempt.
   *
   * The whole pass runs under one server-wide lock, so a counting handler never
   * races another attempt. It also means a handler that blocks delays every
   * other attempt, up to the box.
   *
   * Passes re-run on every drain, on restart and on retry. A handler must be
   * idempotent for one logical dispatch.
   *
   * At most one handler per hook per plugin; registering a second replaces
   * nothing and throws.
   */
  on<K extends PluginHookName>(hook: K, handler: PluginHookHandler<K>): void;

  /**
   * Ask core to re-attempt the messages queued behind plugin waits.
   *
   * **The pair to `on`.** `on` answers the question core asks; `recheck`
   * asks core to ask it again. Core owns the re-draining and the clock — the
   * `sendAt` due sweep is still core's — and a plugin owns every other
   * condition its own waits depend on. When that condition changes, say so
   * here and answer the hook again on the re-attempt; there is no way to
   * release a specific row, and there does not need to be.
   *
   * The walk re-attempts every plugin-queued row IN QUEUE ORDER, each one
   * claimed exactly once, running the full `message.dispatch` pass over it —
   * every plugin's handler, not just the caller's. A row that is still blocked
   * simply re-queues, which is what makes an unwarranted request safe: nobody
   * has to work out whether their own condition was the last one the message
   * was waiting on. The existing per-thread re-queue pacing bounds the churn,
   * so a plugin that stays full is not re-asked in a loop.
   *
   * Bursts coalesce: several calls before the walk starts produce one walk.
   *
   * **Resolves when the walk is SCHEDULED, not when it finishes.** The walk is
   * a background pass with no caller to report to — its failures land on the
   * rows, exactly as the due sweep's do. Awaiting completion would also mean
   * awaiting a full hook pass from inside whatever called this, which for a
   * handler holding the evaluation lock could not complete. Fire and forget.
   */
  recheck(hook: PluginHookName): Promise<void>;
}

// ---------------------------------------------------------------------------
// Wire surfaces: HTTP, rpc, realtime (design §4.6/§4.7).
// ---------------------------------------------------------------------------

export type PluginHttpAuthMode = "local" | "token" | "none";

export type PluginHttpHandler = (
  context: Context,
) => Response | Promise<Response>;

export interface ExperimentalPluginWebSocket {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
}

export interface ExperimentalPluginWebSocketContext {
  request: Request;
  url: URL;
  headers: Headers;
}

export interface ExperimentalPluginWebSocketHandlers {
  onOpen?(socket: ExperimentalPluginWebSocket): void | Promise<void>;
  onMessage?(
    socket: ExperimentalPluginWebSocket,
    data: string | Uint8Array,
  ): void | Promise<void>;
  onClose?(
    socket: ExperimentalPluginWebSocket,
    event: { code: number; reason: string },
  ): void | Promise<void>;
  onError?(socket: ExperimentalPluginWebSocket, error: Error): void;
}

export type ExperimentalPluginWebSocketHandler = (
  context: ExperimentalPluginWebSocketContext,
) => ExperimentalPluginWebSocketHandlers;

export interface PluginHttp {
  /**
   * Register an HTTP route, mounted at
   * `/api/v1/plugins/<id>/http/<path>`. Auth modes (default "local"):
   * - "local": Origin/Host must be a local BB app origin; non-GET requires
   *   content-type application/json (forces a CORS preflight).
   * - "token": requires the per-plugin token (`bb plugin token <id>`) via
   *   the x-bb-plugin-token header or ?token=.
   * - "none": no checks — only for signature-verified webhooks.
   */
  route(
    method: string,
    path: string,
    handler: PluginHttpHandler,
    opts?: { auth?: PluginHttpAuthMode },
  ): void;

  /**
   * Register a WebSocket route in the same `/http/` namespace as `route`.
   * A GET request upgrades only when it carries `Upgrade: websocket`.
   * Auth modes and exact-path matching are identical to HTTP routes.
   */
  experimental_websocket(
    path: string,
    handler: ExperimentalPluginWebSocketHandler,
    opts?: { auth?: PluginHttpAuthMode },
  ): void;
}

export interface PluginRpc {
  /**
   * Register a Standard Schema-driven rpc contract and its inferred handlers,
   * served at POST
   * `/api/v1/plugins/<id>/rpc/<method>` with "local" auth semantics. The
   * host validates input before invocation and output before strict JSON
   * serialization. The response is `{ ok: true, result }` or
   * `{ ok: false, error: { code, message, issues? } }`.
   */
  register<Contract extends PluginRpcContract>(
    contract: Contract,
    handlers: PluginRpcHandlers<Contract>,
  ): void;
}

export interface PluginRealtime {
  /**
   * Broadcast an ephemeral `plugin-signal` WS message
   * `{ pluginId, channel, payload }` to every connected client (V1 has no
   * per-channel subscriptions). `payload` must be JSON-serializable;
   * `undefined` is normalized to `null`. Nothing is persisted.
   */
  publish(channel: string, payload: unknown): void;
}

// ---------------------------------------------------------------------------
// Background services and schedules (design §4.8).
// ---------------------------------------------------------------------------

export interface PluginBackground {
  /**
   * Register a long-lived background service. `start` runs after the
   * factory completes and should resolve when `signal` aborts
   * (dispose/reload/disable/shutdown). A crash restarts it with capped
   * exponential backoff; throwing NeedsConfigurationError marks the plugin
   * `needs-configuration` and stops restarting until the next load. An
   * error raised outside the `start` promise (an unlistened EventEmitter
   * 'error', a throw in a timer callback, a detached rejection) counts as
   * a crash too: the run is aborted and restarted the same way.
   */
  service(
    name: string,
    service: { start(signal: AbortSignal): void | Promise<void> },
  ): void;
  /**
   * Register a cron schedule (5-field expression, server-local time). The
   * durable row keyed (pluginId, name) is upserted at load; the periodic
   * sweep claims due rows with a CAS on next_run_at, but only while this
   * plugin is loaded. Failures land in last_status/last_error, visible in
   * `bb plugin list`.
   */
  schedule(name: string, cron: string, fn: () => void | Promise<void>): void;
}

// ---------------------------------------------------------------------------
// Agent-facing CLI subcommands (design §4.4).
// ---------------------------------------------------------------------------

export interface PluginCliCommandInfo {
  name: string;
  summary: string;
  usage: string;
}

/** Context forwarded from the invoking CLI when known; all fields optional. */
export interface PluginCliContext {
  cwd?: string;
  threadId?: string;
  projectId?: string;
  /** Aborted when the invoking CLI HTTP request disconnects. */
  signal?: AbortSignal;
}

export type PluginInteractionCancelReason =
  | "user"
  | "request-aborted"
  | "thread-stopped"
  | "thread-deleted"
  | "plugin-disposed"
  | "server-restarted"
  | "timeout";

export type PluginInteractionResult =
  | { outcome: "submitted"; value: JsonValue }
  | { outcome: "cancelled"; reason: PluginInteractionCancelReason };

export interface PluginInteractionRequest {
  threadId: string;
  rendererId: string;
  title: string;
  payload: JsonValue;
  /** Defaults to ten minutes; capped at one hour. */
  timeoutMs?: number;
}

export interface PluginCliResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

/**
 * Maximum combined UTF-8 bytes accepted from plugin CLI stdout and stderr.
 * This is the shared source of truth for production and the testing harness.
 */
export const PLUGIN_CLI_OUTPUT_MAX_BYTES = 1024 * 1024;

export interface PluginCliOutputLimitError {
  code: "plugin_cli_output_too_large";
  message: string;
  maxBytes: number;
  stdoutBytes: number;
  stderrBytes: number;
  totalBytes: number;
}

/** Normalized host result returned by the plugin CLI HTTP/testing boundary. */
export interface PluginCliExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: PluginCliOutputLimitError;
}

export interface PluginCliRegistration {
  /** Preferred top-level command name (`bb <name> …`): lowercase [a-z0-9-]+.
   * A core collision logs an activation warning and remains available through
   * `bb plugin run <plugin-id>`. */
  name: string;
  summary: string;
  /** Subcommand metadata rendered in help and the plugin-commands skill
   * without executing plugin code. Parsing argv is plugin-owned. */
  commands?: PluginCliCommandInfo[];
  run(
    argv: string[],
    ctx: PluginCliContext,
  ): PluginCliResult | Promise<PluginCliResult>;
}

export interface PluginCli {
  /**
   * Register this plugin's `bb` subcommand. One registration per factory
   * execution; a repeated call is rejected. Core bb commands always win
   * name collisions; the plugin is warned and remains explicitly callable by id.
   */
  register(registration: PluginCliRegistration): void;
}

// ---------------------------------------------------------------------------
// Agent surfaces: per-turn context and native tools (design §4.4).
// ---------------------------------------------------------------------------

/** Per-turn context handed to bb.agents context providers (design §4.4). */
/** MCP-style content parts a native tool may return (design §4.4). */
export type PluginAgentToolContentPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export type PluginAgentToolResult =
  | string
  | { content: PluginAgentToolContentPart[]; isError?: boolean };

/** Per-call context handed to a native tool's execute (design §4.4). */
export interface PluginAgentToolContext {
  threadId: string;
  projectId: string;
  /** The tool-call request's abort signal (aborts if the daemon round-trip
   * is torn down mid-call). */
  signal: AbortSignal;
}

/**
 * The row title of a plugin tool call while it is pending and once it
 * settled. Each label is capped at 80 characters and rendered as plain text.
 */
export interface PluginAgentToolLabels {
  /** Label shown while the tool call is pending. */
  pending: string;
  /** Label shown after the tool call completes successfully. */
  completed: string;
}

/**
 * How calls to a native plugin tool read as a timeline row (grammar v3). Every
 * field is optional at registration: the server fills what the plugin leaves
 * out (a generic `Running <name>` / `Ran <name>` label; the plugin's branding
 * glyph, then `Toolbox`) and hands one complete presentation to the provider
 * bridge with the tool definition.
 */
export interface PluginAgentToolPresentation {
  /** Row title while the call is pending and once it settled. */
  label?: PluginAgentToolLabels;
  /**
   * A named host glyph (`{ glyph: "Workflow" }`), or one of this plugin's
   * own declared icons by its namespaced glyph (`{ glyph: "<pluginId>/<name>" }`,
   * an entry of the manifest's `bb.branding.experimental_icons` map). A
   * namespaced glyph that names another plugin or an undeclared name rejects
   * the tool registration.
   */
  icon?: { glyph: string };
  /** Low-value rows clients collapse by default (a question a dedicated
   * interaction row already shows, a bookkeeping call). */
  suppress?: boolean;
  /** Accent colour per theme; omitted rows use the neutral row tint. */
  tint?: { light: string; dark: string };
}

export interface PluginAgentToolRegistrationBase {
  /** Tool name shown to the model: [a-zA-Z0-9_-]+, unique across plugins,
   * and not a built-in dynamic tool (see RESERVED_AGENT_TOOL_NAMES in the
   * server). */
  name: string;
  description: string;
  /**
   * Optional usage snippet appended to the thread instructions whenever
   * this tool is in the session's tool set (mirrors the built-in
   * update_environment_directory guidance). Limited to 4096 characters.
   */
  instructions?: string;
  /**
   * How calls to this tool read as a timeline row (grammar v3). When omitted,
   * BB shows the standard tool name (`Running <name>` / `Ran <name>`) and the
   * plugin's branding glyph. Approval, error, and interruption states keep
   * BB's standard rendering. See docs/api_to_audit.md.
   */
  presentation?: PluginAgentToolPresentation;
}

/** Stable, plain-data context resolved by the server for one agent session. */
export interface PluginAgentConfigurationContext {
  thread: {
    id: string;
    title: string | null;
    parentThreadId: string | null;
    sourceThreadId: string | null;
  };
  project: {
    id: string;
    kind: "standard" | "personal";
    name: string;
    gitRemoteUrl: string | null;
  };
  environment: {
    id: string;
    name: string | null;
    path: string | null;
    workspaceProvisionType: "unmanaged" | "managed-worktree" | "personal";
    branchName: string | null;
  };
  host: {
    id: string;
    name: string;
  };
  provider: {
    id: string;
    model: string;
    /**
     * The provider's declared capabilities, so a plugin can decide what to
     * contribute from what the provider says it does rather than from its own
     * copy of a provider id list.
     */
    capabilities: {
      /**
       * The provider ships its own user-question affordance and bb routes it
       * into the pending-interaction path. A plugin offering the same thing
       * should withhold it here, or the model gets two ways to ask once.
       */
      supportsNativeUserQuestion: boolean;
    };
  };
  /** How the thread was spawned. A side chat is the builtin side-chat
   * plugin's fork: `{ kind: "fork", pluginId: "side-chat" }`. */
  origin: {
    kind: "fork" | null;
    pluginId: string | null;
  };
}

/** Object form of a {@link PluginAgentConfiguration} tools entry: selects a
 * registered tool and overrides the parameter schema advertised to the
 * provider for this resolution only. */
export interface PluginAgentToolSelection {
  /** Name of a tool registered by this plugin via `registerTool`. */
  name: string;
  /** JSON-schema object (root `type: "object"`, JSON-serializable, at most
   * 128 KiB serialized) sent to the provider in place of the registered
   * parameter schema. Execution-side validation still runs the registered
   * parameters, so the override must only narrow what the registered schema
   * already accepts. Recursive local `$ref` chains are rejected. */
  parameters: Record<string, unknown>;
}

/** Per-resolution selection returned by {@link PluginAgents.configure}. */
export interface PluginAgentConfiguration {
  /** Tool names registered by this plugin, or {@link PluginAgentToolSelection}
   * entries to also override a tool's advertised parameter schema for this
   * resolution. Duplicate or unknown names, or an invalid override, reject
   * this plugin's complete selection for the resolution. */
  tools: Array<string | PluginAgentToolSelection>;
  /** Skill frontmatter names from this plugin's manifest skill roots.
   * Duplicate or unknown names reject this plugin's complete selection. */
  skills: string[];
  /** Optional dynamic instructions. Output is truncated to 4096 characters. */
  instructions?: string;
}

// ---------------------------------------------------------------------------
// Agent provider declarations.
// ---------------------------------------------------------------------------

/**
 * Permission modes a provider can run a session in — BB's own permission
 * vocabulary, ordered least ("accept-edits") to most ("full") privileged.
 */
export type PluginProviderPermissionMode = "accept-edits" | "auto" | "full";

/**
 * Coarse reasoning-effort ladder entries, ordered lowest to highest. The
 * declared ladder is a fallback only: precise per-model reasoning sets come
 * from the provider's model list at runtime.
 */
export type PluginProviderReasoningLevel =
  | "none"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "ultracode"
  | "max"
  | "ultra";

/**
 * Composer actions a provider supports, by name only. The skills
 * slash-command typeahead is universal — BB injects skills into every
 * provider — so it is implicit and never declared, and the composer owns the
 * trigger syntax (`/plan `, `/goal `) rather than each declaration repeating
 * it.
 */
export type PluginProviderComposerAction = "plan" | "goal";

/**
 * Pre-session capability facts about a provider. A capability earns a field
 * here only when it passes BOTH tests: (1) a consumer outside the provider's
 * own plugin needs the fact, and (2) the fact is needed before / without a
 * live session (picker rendering, route gating, cross-plugin tool
 * composition — including with the host offline). Every boolean is a
 * provider-native fact — the provider implements the feature; the flag only
 * tells external consumers it exists. Session-behavior facts remain handshake
 * capabilities reported by the running bridge. Sessionless maintenance
 * methods are declared here so callers can decide whether to probe without
 * starting the bridge first.
 */
export interface PluginProviderCapabilities {
  /** The provider accepts a fast/priority service-tier choice — shows the
   * service-tier toggle in the picker. */
  supportsServiceTier: boolean;
  /** The provider ships its own native ask-user-question tool — the
   * ask-user-question plugin skips registering its duplicate. */
  supportsNativeUserQuestion: boolean;
  /**
   * How completely the provider can clone a session: `"none"` (not at all),
   * `"tip"` (only the current end, so thread fork works but edit-past-message
   * rewind cannot), or `"checkpoint"` (recreate the session at an earlier
   * point, which rewind needs). Gates the fork and edit-past-message
   * affordances. The bridge reports the same fact at `initialize`, where it
   * may narrow this declaration but never widen it.
   */
  fork: ProviderFork;
  /** The provider accepts an explicit context-compaction request — gates the
   * compact affordance. */
  supportsManualCompaction: boolean;
  /** The provider keeps its own thread archive, so BB mirrors archive and
   * unarchive onto it instead of tracking the state only in bb's own rows. */
  supportsThreadArchive: boolean;
  /** The provider stores a thread name of its own, so BB forwards renames to
   * it. */
  supportsThreadRename: boolean;
  /** Permission modes the provider can actually run in. Non-empty, no
   * duplicates. */
  permissionModes: readonly PluginProviderPermissionMode[];
  /** The provider's coarse fallback reasoning ladder (see
   * {@link PluginProviderReasoningLevel}). Non-empty, no duplicates. */
  reasoningLevels: readonly PluginProviderReasoningLevel[];
}

/**
 * Provider copy core surfaces render from per-provider tables today (usage
 * banners, sign-in hints, the mobile picker, the agent guide). Declared once
 * here so no core surface keys copy on a provider id. Mirrors
 * `ProviderStrings` in `@bb/domain`, which is the client projection.
 */
export interface PluginProviderStrings {
  /** How to sign in on the host ("Run `claude` on the machine to sign in."). */
  signInHint: string;
  /** Shown when a session's credentials expired. */
  expiredHint: string;
  /** Where to install the agent. */
  installUrl: string;
  /** Brand prefix stripped from model display names ("Claude "). */
  brandPrefix?: string;
  /** Plan-mode banner copy for providers that declare the `plan` action. */
  planModeCopy?: string;
  /** Per-theme tint for the provider icon. */
  iconTint?: { light: string; dark: string };
}

/**
 * One selectable option for a picker — a service tier or a reasoning level.
 * `id` is the wire value the bridge receives; `label` is what the picker
 * shows. Declared lists are the cold-cache fallback; `model/list` is precise
 * per model.
 */
export interface PluginProviderOptionDescriptor {
  id: string;
  label: string;
  description?: string;
}

/**
 * Payload schemas for one extension kind this provider emits, keyed by the
 * kind's local name (the server prefixes the plugin id to form the
 * namespaced `"<pluginId>/<name>"`). `item` validates `item.open` payloads
 * with `type: "extension"`, `state` validates `extension.state` payloads;
 * each is optional so a kind can be item-only or state-only. Schemas are
 * Standard Schema v1 validators (zod 4 schemas qualify).
 */
export interface PluginProviderExtensionKindDeclaration {
  item?: StandardSchemaV1;
  state?: StandardSchemaV1;
}

/**
 * Per-command context handed to
 * {@link PluginProviderDeclaration.deriveProviderOptions}. The
 * server builds one for every session and turn command it dispatches on a
 * thread of this provider.
 */
export interface PluginProviderOptionsContext {
  threadId: string;
  projectId: string;
  /** The resolved model id for this command. */
  model: string;
  /** BB's permission mode for this command (already clamped to the host). */
  permissionMode: PluginProviderPermissionMode;
  /**
   * `"plan"` when the prompt entered plan mode through this provider's
   * declared `plan` composer action. Absent for an ordinary prompt — plan
   * mode is a BB prompt mode, so the bridge maps it onto whatever the agent
   * calls it natively.
   */
  promptMode?: "plan";
  /**
   * This plugin's own settings values (`bb.settings.define`), read at call
   * time. Secret settings are omitted — provider options ride the daemon
   * wire and are persisted with the session, so a secret must never be
   * derived into them.
   */
  settings: Readonly<Record<string, PluginSettingValue | undefined>>;
}

/** See {@link PluginProviderDeclaration.models}. */
export type PluginProviderModelCatalogScope = "host" | "workspace";

/**
 * One cold-cache fallback model. The provider's live `model/list` result is
 * the only real model source; this list stands in only while no probe has
 * completed, or when a probe fails transiently, so the picker is not empty.
 * `id` is the wire model id the bridge receives.
 */
export interface PluginProviderFallbackModel {
  id: string;
  /** Picker display name ("Opus 5 (1M)"). */
  displayName: string;
  description: string;
  /** Reasoning levels this model supports, lowest to highest. Non-empty. */
  supportedReasoningEfforts: readonly {
    reasoningEffort: PluginProviderReasoningLevel;
    description: string;
  }[];
  /** Must be one of `supportedReasoningEfforts`. */
  defaultReasoningEffort: PluginProviderReasoningLevel;
  /** Exactly one entry in the list is the default. */
  isDefault: boolean;
}

/**
 * Which sessionless maintenance requests a provider bridge implements. The
 * server skips the requests a provider does not declare, and clients omit
 * the matching surfaces, without starting the bridge first.
 */
export interface PluginProviderMaintenance {
  /** `provider/health`: host-local readiness, never a network health check. */
  health?: boolean;
  /** `provider/usage`: subscription usage windows. False means usage settings
   * omit the provider. A shared bridge that declares true may still report
   * usage unavailable for one provider id or return no windows. */
  usage?: boolean;
  /** `provider/installation/status` and `provider/installation/run`:
   * host-local installation management. */
  installation?: boolean;
}

/** One provider-native root as a plugin declares it: a path, or a path with options. */
export type PluginProviderNativeRootEntry = ProviderNativeRootInput;

/** Provider-native roots as a plugin declares them, one list per side. */
export type PluginProviderNativeRoots = ProviderNativeRootsInputLike;

/**
 * One provider this plugin contributes to BB's provider registry.
 *
 * Ids are stable public identifiers — thread rows and routes reference them —
 * and are collision-rejected: a declaration whose id matches another plugin's
 * live registration is refused; the first registration wins and no id is
 * reserved ahead of time. Registrations are replaced wholesale on plugin
 * reload, like every other plugin surface.
 *
 * A declaration owns the provider's static metadata and bridge options. The
 * executable implementation is the plugin's own provider bridge: the
 * `experimental_providerBridge` export of the `bb.host` artifact the manifest
 * names (`PROVIDER_BRIDGE_EXPORT_NAME` in the bridge kit), built into the
 * artifact BB ships to hosts. Declaring a provider in a plugin with no
 * `bb.host` entry is refused, because the picker entry would exist and no
 * turn on it could ever run; a `bb.host` entry whose artifact failed to
 * build still stages the declaration so the provider is listed as
 * unavailable.
 */
export interface PluginProviderDeclaration {
  /** Stable provider id: 2–64 characters of lowercase letters, digits, and
   * "-", starting with a letter or digit. Existing ids must never change —
   * threads persist them. */
  id: string;
  /** Picker display name: 1–80 characters, non-blank. */
  displayName: string;
  /**
   * Optional grouping key (same grammar as `id`) for providers that share a
   * family — the ACP agents, for example — so clients can group them without
   * parsing a prefix out of the id. Grouping only: no policy keys on it.
   */
  family?: string;
  /**
   * Optional picker icon: a named host glyph (`"Zap"`) or a plugin-relative
   * path starting with `"./"` (`"./icons/agent.svg"`) — the two forms
   * `bb.branding.icon` takes — or, unlike `bb.branding.icon`, one of this
   * plugin's declared icons by its namespaced glyph (`"<pluginId>/<name>"`,
   * an entry of the manifest's `bb.branding.experimental_icons` map; the
   * plugin id must be this plugin's and the name must be declared, else the
   * plugin fails to load). Paths follow the manifest entry-path escape rules
   * — no leading "/", no ".." segments, no backslashes.
   */
  icon?: string;
  /**
   * Provider-owned static options passed opaquely to this plugin's bridge on
   * every sessionless and session request. Core validates that the value is
   * JSON, but does not interpret its keys. This is intended for immutable
   * launch metadata shared by every host (for example an ACP command spec),
   * not user or machine configuration.
   */
  experimental_bridgeOptions?: Readonly<Record<string, JsonValue>>;
  /**
   * Whether the provider is always listed or only listed on hosts where its
   * bridge reports it installed. Defaults to `"always"`.
   */
  experimental_visibility?: "always" | "installed";
  /**
   * The sessionless maintenance requests the provider's bridge implements
   * (docs/provider-plugin-api.md §1). Each defaults to false when omitted.
   */
  maintenance?: PluginProviderMaintenance;
  /** Pre-session capability facts (see the declaration tests on
   * {@link PluginProviderCapabilities}). */
  capabilities: PluginProviderCapabilities;
  /** Composer actions this provider supports. No duplicates; may be empty
   * (the universal skills typeahead is implicit). */
  composerActions: readonly PluginProviderComposerAction[];
  // -------------------------------------------------------------------------
  // Target-state declaration fields (docs/provider-plugin-api.md §1). Each is
  // validated and carried on the normalized declaration; WS2a projects them
  // onto `ProviderInfo` and the surfaces that read per-provider tables today.
  // See docs/api_to_audit.md for what to audit before stabilizing.
  // -------------------------------------------------------------------------
  /** Provider copy for core surfaces ({@link PluginProviderStrings}). */
  strings?: PluginProviderStrings;
  /** Service tiers this provider accepts, as picker options. Non-empty when
   * present, unique ids. The coarse `capabilities.supportsServiceTier` stays
   * until WS2a stabilizes. */
  serviceTiers?: readonly PluginProviderOptionDescriptor[];
  /** Reasoning levels as picker options with labels, beside the coarse
   * `capabilities.reasoningLevels` ladder (ids only). Non-empty when present,
   * unique ids. WS2a merges the two. */
  reasoningLevels?: readonly PluginProviderOptionDescriptor[];
  /** Extension kinds this provider's bridge may emit, keyed by local name
   * (`[a-z0-9-]+`). The server validates extension payloads against these
   * schemas at ingest and persists a `provider/unhandled` on a miss. */
  extensionKinds?: Readonly<
    Record<string, PluginProviderExtensionKindDeclaration>
  >;
  /**
   * Cold-cache fallback models ({@link PluginProviderFallbackModel}). The
   * server offers them only while a model probe has not completed or failed
   * transiently; the live `model/list` result always replaces them. Ids must
   * be unique and exactly one entry must be the default.
   */
  models?: {
    /**
     * Optional: a provider that only declares a catalog `scope` needs no
     * fallback list, and an omitted list reads as no fallbacks at all.
     */
    fallback?: readonly PluginProviderFallbackModel[];
    /**
     * How far one `model/list` answer travels. `"host"` means the catalog is
     * the same everywhere on a machine — the bridge answers from account or
     * agent state and ignores the workspace path — so bb probes once per host
     * and reuses the answer for every environment on it. `"workspace"` (the
     * default) means project configuration can change the answer, so bb
     * probes per workspace and sends the path.
     *
     * Declaring `"host"` wrongly is a stale catalog in a workspace that
     * configured its own models; declaring `"workspace"` wrongly costs a
     * redundant probe. The default is therefore the safe one.
     */
    scope?: PluginProviderModelCatalogScope;
  };
  /**
   * Daemon environment variables this provider's bridge may read. Provider
   * processes are spawned with every inherited `BB_*` variable stripped, so a
   * bridge that honors an operator override (a CLI path, say) names it here
   * and the daemon forwards exactly those variables. Names are
   * `[A-Z_][A-Z0-9_]*`, at most 32.
   */
  env?: {
    passthrough: readonly string[];
  };
  /**
   * Directories this provider's agent reads its own skills from, relative to
   * the target host's home directory (`user`) or to the workspace
   * (`project`). An agent with skills of its own — an ACP agent pointed at
   * `.cursor/skills`, say — names them here so bb can list them beside its
   * own; core never guesses a provider's skill layout. Paths are relative
   * and may not contain dot segments; each side holds at most 32 roots. One
   * declaration is global, so a directory only one host can name (an agent's
   * settings-configured skills directory, say) is not declared here but
   * resolved on that host (`experimental_resolvesNativeRoots`).
   */
  experimental_nativeSkillRoots?: PluginProviderNativeRoots;
  /**
   * Directories this provider's agent reads its own slash commands from —
   * flat directories of `*.md` prompt files (`.claude/commands`, say) — in
   * the same two-sided shape as `experimental_nativeSkillRoots`. bb offers
   * them in the composer beside the agent's skills.
   */
  experimental_nativeCommandRoots?: PluginProviderNativeRoots;
  /**
   * This plugin's `bb.host` entry implements
   * `experimental_nativeRootsHostContract` (`@get-bb/plugin-sdk/host`): core
   * calls `resolveNativeRoots({ cwd })` on the workspace host when it lists
   * commands or skills, and scans what comes back beside the declared roots.
   * This is where a provider's host-only knowledge goes — a config-moved
   * directory, an installed vendor plugin, a config-file entry — including
   * project-scoped entries, which a global declaration cannot carry.
   */
  experimental_resolvesNativeRoots?: boolean;
  /**
   * Derive this provider's opaque per-command options. Called synchronously
   * by the server for every session and turn command on a thread of this
   * provider, with the command's {@link PluginProviderOptionsContext}; the
   * returned JSON object reaches this plugin's bridge as
   * `options.providerOptions`, merged over `experimental_bridgeOptions`. Core
   * never interprets its keys — this is where a provider's own knobs (memory,
   * native subagents, a native plan flag) travel instead of on the shared
   * execution contract. A throw fails the command with the plugin named, so
   * a buggy hook cannot silently run a turn with default knobs. Must be fast:
   * it sits on the turn-submit path.
   */
  deriveProviderOptions?: (
    context: PluginProviderOptionsContext,
  ) => Readonly<Record<string, JsonValue>>;
}

export interface PluginAgents {
  /**
   * Select this plugin's statically registered tools and manifest skills for
   * each thread/session resolution, with optional dynamic instructions. The
   * callback is synchronous and runs at `thread.start` / `turn.submit`; it
   * never rebuilds registrations. Exactly one callback may be registered per
   * factory execution. A throw, malformed result, duplicate id, unknown id,
   * or more than 256 tool/skill ids fails closed for this plugin only.
   *
   * Tools take effect when the provider session is next started or resumed;
   * an already-running session is not hot-mutated. Instructions follow the
   * same boundary: a live provider session keeps the instructions it was
   * constructed with, and a changed selection applies when the session is
   * next constructed. Skill changes follow BB's environment runtime policy:
   * a busy runtime keeps its current catalog until a safe relaunch. Side chats
   * are ordinary plugin-owned forks here — read `origin` to detect them — and
   * their returned tool, skill, and dynamic-instruction selections apply at the
   * same boundaries.
   */
  configure(
    provider: (
      context: PluginAgentConfigurationContext,
    ) => PluginAgentConfiguration,
  ): void;
  /**
   * Register a native dynamic tool (design §4.4). `parameters` is either a
   * zod schema (validated per call; execute receives the parsed value) or a
   * plain JSON-schema object (no validation; execute receives the raw
   * arguments as `unknown`). Tool-set changes apply on the NEXT session
   * start — a tool registered mid-session is not hot-added to running
   * provider sessions. A second registration of the same name within this
   * plugin is rejected; a name already registered by another plugin is
   * rejected and surfaced as this plugin's status detail. Recursive local
   * JSON Schema `$ref` chains are rejected because some model providers reject
   * the complete tool list when any one tool contains them.
   */
  registerTool<Schema extends z.ZodType>(
    tool: PluginAgentToolRegistrationBase & {
      parameters: Schema;
      execute(
        params: z.output<Schema>,
        ctx: PluginAgentToolContext,
      ): PluginAgentToolResult | Promise<PluginAgentToolResult>;
    },
  ): void;
  registerTool(
    tool: PluginAgentToolRegistrationBase & {
      /** Raw JSON-schema escape hatch; params arrive unvalidated. */
      parameters: Record<string, unknown>;
      execute(
        params: unknown,
        ctx: PluginAgentToolContext,
      ): PluginAgentToolResult | Promise<PluginAgentToolResult>;
    },
  ): void;
  /**
   * Contribute a dynamic section appended to thread instructions. The
   * provider runs when a thread's runtime command config is resolved
   * (thread.start / turn.submit); return null to contribute nothing for
   * that resolution. A live provider session keeps the instructions it was
   * constructed with — a changed contribution takes effect when the
   * provider session is next constructed (thread start or resume after a
   * daemon restart, environment switch, or provider restart), never
   * mid-session. Must be synchronous and fast — it sits on the
   * thread-start path. Output longer than 4096 characters is truncated; a
   * throwing provider is logged against the plugin and contributes nothing.
   * A repeated registration within one factory execution is rejected.
   */
  contributeInstructions(
    provider: (ctx: { threadId: string; projectId: string }) => string | null,
  ): void;
}

/**
 * Provider registration (docs/provider-plugin-api.md §1). Owns only
 * registration; `bb.agents` keeps `configure`, `registerTool`, and
 * `contributeInstructions`.
 */
export interface PluginProviders {
  /**
   * Register an agent provider this plugin contributes (see
   * docs/api_to_audit.md before relying on it). The declaration is validated
   * at call time; the provider joins the server's provider registry when the
   * plugin load commits and then appears in provider listings as exactly one
   * client shape, `ProviderInfo`. Ids are flat and collision-rejected: the
   * first live registration of an id wins, a later one from another plugin
   * fails that plugin's load, and no id is reserved ahead of time. A plugin
   * may register several providers and may re-register after `dispose()` (a
   * settings-driven re-declaration); registrations are replaced wholesale on
   * plugin reload, like every other surface. The disposer removes the
   * registration.
   */
  register(declaration: PluginProviderDeclaration): {
    dispose(): void;
  };
  experimental_contributeEnv(
    providerId: string,
    resolve: (
      context: ExperimentalPluginProviderEnvContext,
    ) =>
      | readonly ExperimentalPluginProviderEnvEntry[]
      | Promise<readonly ExperimentalPluginProviderEnvEntry[]>,
  ): void;
  experimental_contributeEnvHealth(
    providerId: string,
    resolve: (
      context: ExperimentalPluginProviderEnvHealthContext,
    ) =>
      | ExperimentalPluginProviderEnvHealth
      | null
      | Promise<ExperimentalPluginProviderEnvHealth | null>,
  ): void;
}

export interface ExperimentalPluginProviderEnvContext {
  threadId: string;
  projectId: string;
  hostId: string;
}

export interface ExperimentalPluginProviderEnvEntry {
  name: string;
  value: string | { serverPath: string };
  reason: string;
  secret: boolean;
}

export interface ExperimentalPluginProviderEnvHealthContext {
  hostId: string;
}

export interface ExperimentalPluginProviderEnvHealth {
  label: string;
  statusMessage: string;
}

// ---------------------------------------------------------------------------
// Host-rendered UI contributions (design §4.9).
// ---------------------------------------------------------------------------

export type PluginMentionTrigger = "@" | "#" | "$" | "!" | "~";

/** Search context handed to a mention provider (design §4.9). `projectId`/
 * `threadId` are null when the composer has not committed one yet. */
export interface PluginMentionSearchContext {
  trigger: PluginMentionTrigger;
  query: string;
  projectId: string | null;
  threadId: string | null;
}

/** One row a mention provider returns from `search`. `id` is the provider's
 * own item id — the host namespaces it before it reaches the wire. */
export interface PluginMentionItem {
  id: string;
  title: string;
  subtitle?: string;
  icon?: string;
}

export interface PluginMentionProviderRegistration {
  /** Unique within this plugin: [a-zA-Z0-9_-]+ (no ":" — the host composes
   * wire item ids as "<providerId>:<itemId>"). */
  id: string;
  /** Section label shown above this provider's rows in the mention menu. */
  label: string;
  /**
   * Composer trigger characters this provider should answer. Omit to use the
   * default `@` mention trigger. Valid triggers are `@`, `#`, `$`, `!`, and `~`.
   */
  triggers?: readonly PluginMentionTrigger[];
  /**
   * Runs server-side as the user types after one of this provider's triggers
   * in the composer. Each call is time-boxed (2s) and failure-isolated: a slow
   * or throwing provider contributes an empty list — it can never break the
   * mention menu.
   */
  search(
    ctx: PluginMentionSearchContext,
  ): PluginMentionItem[] | Promise<PluginMentionItem[]>;
  /**
   * Resolves one picked item into agent context, called once per unique
   * item at message send time. The returned `context` is attached to the
   * message as an agent-visible (user-hidden) prompt input. Throwing blocks
   * the send with a visible error.
   */
  resolve(itemId: string): { context: string } | Promise<{ context: string }>;
}

export interface PluginUi {
  /** Block until the app submits or cancels a plugin-owned composer form. */
  requestInput(
    request: PluginInteractionRequest,
    options?: { signal?: AbortSignal },
  ): Promise<PluginInteractionResult>;
  /**
   * Register a mention provider for the shipped app's composer (design §4.9).
   * Providers default to the `@` trigger and may opt into `#`, `$`, `!`, or
   * `~` with `triggers`. Items group under `label` in the mention menu; a
   * picked item becomes a `{ kind: "plugin" }` mention resource whose context
   * is resolved once at send time. Multiple providers per plugin; ids must be
   * unique within the plugin.
   */
  registerMentionProvider(provider: PluginMentionProviderRegistration): void;
}

export interface PluginEvents {
  /**
   * Add a thread lifecycle listener. Multiple listeners for the same event are
   * additive and run independently in registration order.
   */
  on<E extends PluginThreadEventName>(
    event: E,
    handler: PluginThreadEventHandler<E>,
  ): void;
}

// ---------------------------------------------------------------------------
// Server info.
// ---------------------------------------------------------------------------

export interface PluginServerApi {
  /**
   * The operator-configured public app URL from `BB_APP_URL`, or `null` when
   * the operator has not configured one. This value is not bind-gated.
   */
  readonly experimental_appUrl: string | null;

  /**
   * This BB server's own loopback base URL (e.g. "http://127.0.0.1:38886"),
   * which serves the SPA + /api + /ws. For plugins that proxy or relay
   * traffic back to the server itself (e.g. a tunnel). Bind-gated like
   * `bb.sdk`: reading it before the server is listening throws, so prefer
   * reading it from handlers, services, and timers.
   */
  readonly loopbackBaseUrl: string;

  /**
   * This server's data directory — the one holding `config.json`, `bb.db` and
   * `plugins/<id>/`. A plugin cannot compute it: a dev server derives it from
   * its repo root and instance id, so a plugin that guesses `~/.bb` reads the
   * production file while the dev server reads another one.
   *
   * For reading bb-managed files a plugin is migrating away from. A plugin's
   * OWN storage is `bb.storage`, which is scoped for it; this is deliberately
   * not a place to write.
   */
  readonly experimental_dataDir: string;
}

// ---------------------------------------------------------------------------
// AI services.
// ---------------------------------------------------------------------------

/**
 * What a plugin's AI service does. `inference` answers bb's server-side helper
 * completions (thread titles, commit messages: a prompt and a JSON Schema in,
 * a structured value out); `voice` transcribes recorded speech.
 */
export type PluginAiServiceKind = "inference" | "voice";

/**
 * An AI service a plugin offers from its `bb.host` entry, which implements
 * `experimental_aiServicesHostContract` (`@get-bb/plugin-sdk/ai-services`).
 * The user selects it with `BB_INFERENCE` / `BB_TRANSCRIPTION` set to
 * `<id>/<model>`; core calls the plugin's host entry on the primary host with
 * the `id` on every request, so one entry can serve several services.
 */
export interface PluginAiServiceDeclaration {
  /** The `<serviceId>` segment of the user's setting; stable, lowercase. */
  readonly id: string;
  /** Shown beside the id wherever the setting's options are listed. */
  readonly displayName: string;
  /** Which kinds this service answers; a kind it lacks is not offered. */
  readonly kinds: readonly PluginAiServiceKind[];
}

export interface PluginAiServices {
  /**
   * Register an AI service. Call during the factory; the registration lands
   * when the plugin load commits and is removed on reload or disable. The
   * plugin must declare a `bb.host` entry; registering without one fails the
   * load. A declared entry that fails to build fails the load on the build
   * error after the factory, with any provider the factory declared listed
   * as unavailable. Throws on an id another live plugin already serves.
   */
  register(declaration: PluginAiServiceDeclaration): { dispose(): void };
}

// ---------------------------------------------------------------------------
// Host control plane.
// ---------------------------------------------------------------------------

export interface PluginSharedPortTunnelIdentity {
  /** Gate routing label assigned to this machine. */
  label: string;
  /** Gate apex without a scheme, e.g. "getbb.app". */
  baseDomain: string;
}

export interface PluginHosts {
  /** Create the owning plugin's typed client for its singular `bb.host` entry. */
  experimental_client<
    Contract extends PluginRpcContract,
    Signals extends ExperimentalHostSignals = {},
  >(args: {
    contract: Contract;
    experimental_signals?: Signals;
  }): ExperimentalHostClient<Contract, Signals>;

  /**
   * Ensure this enrolled host has a gate label and return its read-only public
   * identity. The daemon chooses the trusted gate and desired label; plugins
   * cannot influence either credential-bearing destination.
   */
  ensureSharedPortTunnel(
    hostId: string,
  ): Promise<PluginSharedPortTunnelIdentity>;

  /**
   * Replace this plugin's desired shared-loopback ports for one host. The
   * server aggregates declarations, owns generations, and delivers the
   * resulting set to that host's daemon. When an enrolled host is offline,
   * the server retains the declaration and delivers it on the next
   * credentialed daemon session. A connected daemon that reports no machine
   * credential is rejected. Tunnel identity is deliberately not accepted
   * here: it is owned by the daemon's trusted enrollment.
   */
  declareSharedPorts(hostId: string, ports: readonly number[]): void;
}

// ---------------------------------------------------------------------------
// Status + the API root.
// ---------------------------------------------------------------------------

export interface PluginStatusApi {
  /**
   * Mark this plugin `needs-configuration` (with a message shown in
   * `bb plugin list` and the UI) instead of failing — e.g. a factory or
   * service that finds no API key configured. Cleared on the next load;
   * saving settings does not auto-reload in V1, so ask the user to
   * `bb plugin reload <id>` after configuring.
   */
  needsConfiguration(message: string): void;
}

/**
 * The API object handed to a plugin's factory (design §4). Implemented by
 * the BB server; this contract is what plugin `server.ts` files compile
 * against.
 */
export interface BbPluginApi {
  /** The plugin's own id (namespaces storage, routes, commands). */
  readonly pluginId: string;
  /** Leveled, plugin-scoped logger. */
  readonly log: PluginLogger;
  /** Declarative settings (design §4.2). */
  readonly settings: PluginSettings;
  /** Namespaced KV + per-plugin database (design §4.3). */
  readonly storage: PluginStorage;
  /** HTTP routes under /api/v1/plugins/<id>/http/* (design §4.6). */
  readonly http: PluginHttp;
  /** RPC methods under /api/v1/plugins/<id>/rpc/<method> (design §4.6). */
  readonly rpc: PluginRpc;
  /** Ephemeral push to connected frontends (design §4.7). */
  readonly realtime: PluginRealtime;
  /** Long-lived services + cron schedules (design §4.8). */
  readonly background: PluginBackground;
  /** Agent-facing `bb` CLI subcommand (design §4.4). */
  readonly cli: PluginCli;
  /** Per-turn agent context contributions (design §4.4). */
  readonly agents: PluginAgents;
  /** Agent provider registration (docs/provider-plugin-api.md §1). */
  readonly providers: PluginProviders;
  /** Host-rendered UI contributions (design §4.9). */
  readonly ui: PluginUi;
  /**
   * Additive plugin lifecycle listeners (design §4.5). Announcements core
   * makes: a handler's return value is ignored.
   */
  readonly events: PluginEvents;
  /**
   * Questions core asks and acts on the answer to. Today: the dispatch
   * checkpoint messages pass through on their way to a provider (a user's
   * Send-now bypasses it by design), which a handler may let go, queue with a
   * reason, or refuse.
   */
  readonly experimental_hooks: PluginHooks;
  /** Plugin-reported status (needs-configuration). */
  readonly status: PluginStatusApi;
  /** Read-only facts about the running server (loopback base URL). */
  readonly server: PluginServerApi;
  /** Server-to-daemon host control-plane declarations. */
  readonly hosts: PluginHosts;
  /**
   * AI services this plugin serves from its `bb.host` entry (helper
   * inference, voice transcription). See `@get-bb/plugin-sdk/ai-services`.
   */
  readonly experimental_aiServices: PluginAiServices;
  /**
   * The full BB SDK, bound to this server over loopback (design §4.1).
   * Bind-gated: reading this before the host binds the SDK throws. The real
   * server binds it before loading plugins, so it is available from the
   * moment factories run there — but isolated harnesses may not, so prefer
   * using it from handlers, services, and timers for portability.
   * `threads.spawn` defaults `origin` to "plugin" and `originPluginId` to
   * this plugin's id so spawned threads are attributed automatically.
   */
  readonly sdk: BbSdk;
  /**
   * Register cleanup to run on reload/disable/shutdown. Hooks run LIFO.
   * The sanctioned place to clear timers and close connections.
   */
  onDispose(hook: () => void | Promise<void>): void;
}
