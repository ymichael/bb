import { getEnvironment } from "@bb/db";
import {
  QUEUED_MESSAGE_WAIT_REASON_MAX_LENGTH,
  type Environment,
  type Host,
  type Project,
  type PromptInput,
  type Thread,
  type ThreadQueuedMessage,
} from "@bb/domain";
import type {
  ExecutionInputFieldSource,
  StartedOnBehalfOf,
  ThreadCreateOrigin,
  ThreadResponse,
} from "@bb/server-contract";
import type {
  MessageDispatchHookContext,
  PluginDispatchAttemptKind,
  PluginDispatchExecution,
  PluginDispatchExecutionSources,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";
import { getNonDestroyedHostWithStatus } from "../lib/entity-lookup.js";
import { pluginHookProvider } from "../plugins/plugin-hook-registry.js";

type DispatchHookDeps = Pick<AppDeps, "db" | "hub">;

/**
 * Whether an attempt starts a turn or joins one that is already running. The
 * decision powers are identical either way — a steer is hooked exactly like a
 * send.
 */
export type DispatchAttemptKind = PluginDispatchAttemptKind;

/**
 * A hook handler's answer, re-parsed at the boundary. Plugin sources are
 * untyped at runtime, so the contract's TypeScript shape is a promise, not a
 * guarantee: everything a handler returns is validated here and a malformed
 * decision fails the attempt with the plugin named, exactly like a throw.
 */
const messageDispatchHookDecisionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("proceed") }),
  z.object({
    action: z.literal("wait"),
    reason: z.string().min(1).max(QUEUED_MESSAGE_WAIT_REASON_MAX_LENGTH),
    sendAt: z.number().int().nonnegative().nullable().optional(),
  }),
  z.object({ action: z.literal("reject"), message: z.string().min(1) }),
]);

export interface MessageDispatchWaitDecision {
  pluginId: string;
  reason: string;
  /** Becomes the queued row's `sendAt`, so core's due sweep re-attempts then. */
  sendAt: number | null;
}

export type MessageDispatchHookPassOutcome =
  | { kind: "proceed" }
  | {
      kind: "wait";
      /**
       * The pass queues ONE row, owned by the FIRST plugin that voted to wait.
       * Several rows would multiply the user's Send-now/Cancel affordances for
       * one decision and make "send this message" ambiguous, while one row
       * keeps a single card whose reason line names every waiter. The losers'
       * reasons are appended to that reason; each of them votes again on the
       * next attempt, so nothing is lost by not owning the row.
       */
      waiter: MessageDispatchWaitDecision;
      additionalWaiters: readonly MessageDispatchWaitDecision[];
    };

export interface MessageDispatchHookPassRequest {
  /** The target thread; a `pending` row for a first message. */
  thread: Thread;
  /** The thread's public DTO, as the hook context carries it. */
  threadResponse: ThreadResponse;
  project: Project;
  environmentId: string | null;
  /**
   * The machine the start intent names, for a thread with no environment yet.
   * It becomes the context's `host` so a per-host policy sees a cold start's
   * pool; null when an environment answers instead, or nothing names one.
   */
  intendedHostId: string | null;
  input: PromptInput[];
  requestedExecution: PluginDispatchExecution;
  executionSources: PluginDispatchExecutionSources;
  attempt: DispatchAttemptKind;
  origin: ThreadCreateOrigin | null;
  originPluginId: string | null;
  startedOnBehalfOf: StartedOnBehalfOf | null;
  parentThreadId: string | null;
  /** The queued row being re-attempted; null for an inline first attempt. */
  queuedMessage: ThreadQueuedMessage | null;
  /**
   * Commits this admission BEFORE the evaluation lock releases.
   *
   * This is what makes `sdk.threads.listRunning()` exact inside a handler. The
   * lock already serializes evaluation, but serializing the *questions* is
   * worthless if the answers land later: five creates arriving together would
   * each ask "how many are running", each be told the same stale number, and
   * each be admitted against a limit of two. Committing the thread's
   * `pending → starting` flip here means attempt N+1 reads a database that
   * already contains attempt N's admission.
   *
   * Run only when the pass yields no waits, and only for an attempt that has a
   * transition to commit — a warm follow-up's `idle → active` flip lives inside
   * the send transaction, which needs a prepared host command and therefore
   * cannot run under this lock. See the exactness note on `listRunning`.
   */
  commitAdmission?: () => Promise<void>;
}

/**
 * Minimum gap between a re-attempt that re-queued and the next drain attempt
 * on that thread.
 *
 * Clearing a wait re-runs the hook pass, and a pass that votes to wait again
 * queues the row afresh — so a plugin that clears the moment it sees
 * `message.queued` would spin clear → re-queue → clear at whatever rate its
 * event handler fires. Core owns the pacing rather than trusting plugins, the same
 * way `STALE_QUEUED_MESSAGE_CLAIM_MS` in the queue owns claim recovery rather
 * than trusting senders.
 *
 * Only a re-queue starts the clock. An attempt that dispatched is not a loop
 * and must never be delayed — a due scheduled send that re-queues for a busy
 * thread and then dispatches the moment the turn ends is one normal sequence
 * of two attempts milliseconds apart. And the window is per thread, not per
 * row, because a re-queue can land on a different row entirely.
 */
const DISPATCH_REQUEUE_MIN_INTERVAL_MS = 1_000;

/**
 * When each thread last had a drain attempt turn straight back into a queue.
 * In-memory on purpose: this paces a live spin, and a restart is already a
 * hard stop for one. Entries are dropped as they age out, so a long-lived
 * server does not accumulate one per thread ever drained.
 */
const lastRequeuedAtByThreadId = new Map<string, number>();

export function noteDispatchRequeued(threadId: string): void {
  const now = Date.now();
  for (const [id, at] of lastRequeuedAtByThreadId) {
    if (now - at >= DISPATCH_REQUEUE_MIN_INTERVAL_MS) {
      lastRequeuedAtByThreadId.delete(id);
    }
  }
  lastRequeuedAtByThreadId.set(threadId, now);
}

/**
 * True when this thread re-queued moments ago and the next drain attempt
 * should wait. The caller does nothing, so the row stays queued and the next
 * sweep tick, drain or user action tries again.
 */
export function isDispatchRequeuedRecently(threadId: string): boolean {
  const at = lastRequeuedAtByThreadId.get(threadId);
  return at !== undefined && Date.now() - at < DISPATCH_REQUEUE_MIN_INTERVAL_MS;
}

/**
 * True when at least one plugin answers `message.dispatch`. Every wiring site
 * checks this first: with no handler the dispatch path must be byte-for-byte
 * what it was before hooks existed — no lock, no context assembly, no queued
 * row.
 */
export function hasMessageDispatchHooks(): boolean {
  const provider = pluginHookProvider();
  return (
    provider !== undefined && provider.listHooks("message.dispatch").length > 0
  );
}

/**
 * Server-wide evaluation lock.
 *
 * A handler that limits concurrency is only correct if no two passes
 * interleave, so every pass runs to completion before the next starts — AND,
 * via `commitAdmission`, a cleared attempt's thread-status flip commits before
 * the lock releases. Those two together are what let a handler simply ask the
 * server what is running (`sdk.threads.listRunning()`) instead of maintaining
 * its own tally of in-flight `proceed`s: the fact is already true by the time
 * the next handler reads it.
 *
 * The cost is real — a slow handler delays other dispatches up to its box — and is
 * accepted deliberately; scoping the lock per project or host is the fix if it
 * bites.
 */
let evaluationLock: Promise<unknown> = Promise.resolve();

function withEvaluationLock<T>(run: () => Promise<T>): Promise<T> {
  const result = evaluationLock.then(run, run);
  // Swallow only for the chain: the caller still sees the rejection.
  evaluationLock = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function messageDispatchHookFailure(pluginId: string, detail: string): ApiError {
  // Fail-closed, mirroring how a throwing `deriveProviderOptions` fails the
  // command: 502 says the failure came from something behind the server rather
  // than from the caller's request, and the plugin is named so the user knows
  // which one to disable.
  return new ApiError(
    502,
    "dispatch_hook_failed",
    `The "${pluginId}" plugin's message.dispatch hook failed: ${detail}`,
    { details: { pluginId } },
  );
}

function dispatchRejection(pluginId: string, message: string): ApiError {
  return new ApiError(409, "dispatch_rejected", message, {
    details: { pluginId },
  });
}

/**
 * Runs one handler inside its decision box. A timeout resolves as a failure
 * rather than racing on: the handler's promise may never settle, and the whole
 * point of the box is that the dispatch does not wait on it.
 */
async function decideWithinBox<T>(
  run: () => Promise<T>,
  timeoutMs: number,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      run().then(
        (value) => ({ ok: true, value }) as const,
        (error: unknown) => ({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }) as const,
      ),
      new Promise<{ ok: false; error: string }>((resolveTimeout) => {
        timer = setTimeout(
          () =>
            resolveTimeout({
              ok: false,
              error: `did not decide within ${timeoutMs}ms`,
            }),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The environment/host pair a dispatch context carries, resolved the same way
 * for every reader so a queue-failure line names the same host record —
 * including its live connection state — that the hook context did.
 */
export function dispatchEnvironmentAndHost(
  deps: Pick<AppDeps, "db" | "hub">,
  environmentId: string | null,
): { environment: Environment | null; host: Host | null } {
  if (environmentId === null) return { environment: null, host: null };
  const environment = getEnvironment(deps.db, environmentId);
  if (environment === null) return { environment: null, host: null };
  // The same DTO `GET /threads/:id?include=host` serves, so a handler reading
  // `host.status` sees the live connection state rather than a stored row.
  return {
    environment,
    host: getNonDestroyedHostWithStatus(deps, environment.hostId),
  };
}

/** The concatenated text blocks, which is what a rules-based router matches on. */
export function dispatchInputText(input: readonly PromptInput[]): string {
  return input
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/**
 * The context every handler in a pass sees.
 *
 * Built once and shared: with no amendments, nothing a handler returns can
 * change what the next one is deciding about, so the pass is a chain of
 * independent decisions on one unchanging fact.
 */
function buildHookContext(
  deps: DispatchHookDeps,
  request: MessageDispatchHookPassRequest,
): MessageDispatchHookContext {
  const { environment, host } = dispatchEnvironmentAndHost(
    deps,
    request.environmentId,
  );
  return {
    thread: request.threadResponse,
    attempt: request.attempt,
    project: request.project,
    environment,
    host:
      host ??
      (request.intendedHostId === null
        ? null
        : getNonDestroyedHostWithStatus(deps, request.intendedHostId)),
    input: {
      blocks: [...request.input],
      text: dispatchInputText(request.input),
    },
    requestedExecution: { ...request.requestedExecution },
    executionSources: { ...request.executionSources },
    origin: request.origin,
    originPluginId: request.originPluginId,
    startedOnBehalfOf: request.startedOnBehalfOf,
    parentThreadId: request.parentThreadId,
    queuedMessage: request.queuedMessage,
  };
}

/**
 * Runs one full `message.dispatch` pass at the single dispatch checkpoint.
 *
 * Order is plugin install order; a `reject` short-circuits the pass and throws
 * a 409; `wait` decisions are COLLECTED across the whole pass rather than
 * short-circuiting, so every plugin that would have queued the message gets its
 * reason onto the one row. The attempt proceeds only when a pass yields no
 * waits.
 *
 * The caller must check {@link hasMessageDispatchHooks} first; with no handler
 * this returns an empty `proceed` without touching the lock.
 */
export async function runMessageDispatchHookPass(
  deps: DispatchHookDeps,
  request: MessageDispatchHookPassRequest,
): Promise<MessageDispatchHookPassOutcome> {
  const provider = pluginHookProvider();
  if (provider === undefined) {
    return { kind: "proceed" };
  }
  const hooks = provider.listHooks("message.dispatch");
  if (hooks.length === 0) {
    return { kind: "proceed" };
  }

  return withEvaluationLock(async () => {
    const context = buildHookContext(deps, request);
    const waits: MessageDispatchWaitDecision[] = [];

    for (const hook of hooks) {
      const invocation = await provider.invokeHook(
        hook.pluginId,
        "message.dispatch hook",
        () =>
          decideWithinBox(
            async () => hook.handler(context),
            provider.decisionTimeoutMs,
          ),
      );
      if (!invocation.ok) {
        throw messageDispatchHookFailure(hook.pluginId, invocation.error);
      }
      if (!invocation.value.ok) {
        throw messageDispatchHookFailure(
          hook.pluginId,
          invocation.value.error,
        );
      }
      const parsed = messageDispatchHookDecisionSchema.safeParse(
        invocation.value.value,
      );
      if (!parsed.success) {
        throw messageDispatchHookFailure(
          hook.pluginId,
          `returned an invalid decision: ${parsed.error.issues
            .map((issue) => `${issue.path.join(".")} ${issue.message}`)
            .join("; ")}`,
        );
      }
      const decision = parsed.data;
      if (decision.action === "reject") {
        throw dispatchRejection(hook.pluginId, decision.message);
      }
      if (decision.action === "wait") {
        waits.push({
          pluginId: hook.pluginId,
          reason: decision.reason,
          sendAt: decision.sendAt ?? null,
        });
        continue;
      }
    }

    const waiter = waits[0];
    if (waiter === undefined) {
      // Still inside the lock, deliberately: see `commitAdmission`.
      await request.commitAdmission?.();
      return { kind: "proceed" };
    }
    return { kind: "wait", waiter, additionalWaiters: waits.slice(1) };
  });
}

/**
 * The wait reason for a pass, naming every plugin that voted to wait. The
 * first waiter owns the row, so its reason leads; the rest are appended so the
 * user sees the whole picture on one card rather than one card per plugin.
 */
export function dispatchWaitReasonForPass(
  outcome: Extract<MessageDispatchHookPassOutcome, { kind: "wait" }>,
): string {
  const extra = outcome.additionalWaiters
    .map((entry) => `${entry.pluginId}: ${entry.reason}`)
    .join("; ");
  const reason =
    extra.length === 0
      ? outcome.waiter.reason
      : `${outcome.waiter.reason} (also waiting on ${extra})`;
  return reason.length > QUEUED_MESSAGE_WAIT_REASON_MAX_LENGTH
    ? `${reason.slice(0, QUEUED_MESSAGE_WAIT_REASON_MAX_LENGTH - 1)}…`
    : reason;
}

/** The per-field sources a request carries into a pass. */
export function dispatchExecutionSources(args: {
  model?: ExecutionInputFieldSource;
  permissionMode?: ExecutionInputFieldSource;
  providerId?: ExecutionInputFieldSource;
  reasoningLevel?: ExecutionInputFieldSource;
  serviceTier?: ExecutionInputFieldSource;
}): PluginDispatchExecutionSources {
  return {
    providerId: args.providerId ?? null,
    model: args.model ?? null,
    reasoningLevel: args.reasoningLevel ?? null,
    serviceTier: args.serviceTier ?? null,
    permissionMode: args.permissionMode ?? null,
  };
}
