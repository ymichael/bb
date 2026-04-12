import {
  createPendingInteraction,
  getActivePendingInteractionForThread,
  getEnvironment,
  getHost,
  getPendingInteraction,
  getPendingInteractionByProviderRequest,
  getThread,
  interruptPendingInteractionsForThreadIds,
  interruptPendingInteractionsForThreads,
  listPendingInteractionsByThread,
  listPendingInteractionsOnEphemeralHosts,
  setPendingInteractionExpired,
  setPendingInteractionInterrupted,
  setPendingInteractionResolved,
  type PendingInteractionRow,
} from "@bb/db";
import {
  type PendingInteraction,
  type PendingInteractionCreate,
  type PendingInteractionResolution,
} from "@bb/domain";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";
import { appendPendingInteractionTimelineEvent } from "./pending-interaction-timeline.js";
import { toPendingInteraction } from "./pending-interaction-serialization.js";
import {
  pendingInteractionResolutionEquals,
  validatePendingInteractionResolution,
} from "./pending-interaction-validation.js";

interface PendingInteractionWaiter {
  settled: boolean;
  resolve: (outcome: PendingInteractionWaitOutcome) => void;
}

interface WaitForTerminalStateArgs {
  abortReason?: string;
  interactionId: string;
  signal?: AbortSignal;
}

export type PendingInteractionWaitOutcome =
  | {
      outcome: "expired" | "interrupted";
      interaction: PendingInteraction;
      reason: string;
    }
  | {
      outcome: "resolved";
      interaction: PendingInteraction;
      resolution: PendingInteractionResolution;
    };

export type RegisterPendingInteractionResult =
  | {
      outcome: "created" | "existing";
      interaction: PendingInteraction;
    }
  | {
      outcome: "rejected";
      reason: string;
    };

interface ResolvePendingInteractionArgs {
  interactionId: string;
  resolution: PendingInteractionResolution;
  threadId: string;
}

interface GetThreadInteractionArgs {
  interactionId: string;
  threadId: string;
}

interface InterruptPendingInteractionArgs {
  interactionId: string;
  reason: string;
}

interface InterruptPendingInteractionsForThreadsLifecycleArgs {
  providerId: string;
  reason: string;
  threadIds: readonly string[];
}

interface InterruptPendingInteractionsForThreadIdsLifecycleArgs {
  reason: string;
  threadIds: readonly string[];
}

interface CreateLifecycleDeps {
  db: AppDeps["db"];
  hub: AppDeps["hub"];
}

function buildResolveConflictError(interaction: PendingInteraction): ApiError {
  return new ApiError(
    409,
    "invalid_request",
    `Pending interaction ${interaction.id} is already ${interaction.status}`,
  );
}

function getUnsupportedPendingInteractionReason(
  interaction: PendingInteractionCreate,
): string | null {
  if (
    interaction.payload.kind === "command_approval"
    && interaction.payload.availableDecisions.length === 0
  ) {
    return "Command approvals must include at least one available decision";
  }

  return null;
}

export const DEFAULT_SANDBOX_PENDING_INTERACTION_EXPIRY_MS = 10 * 60 * 1000;
const PENDING_INTERACTION_HYDRATE_BATCH_SIZE = 200;

type PendingInteractionTimeoutHandle = ReturnType<typeof setTimeout>;

interface PendingInteractionExpiryTimer {
  timeout: PendingInteractionTimeoutHandle;
}

interface PendingInteractionTimeoutHandleWithUnref {
  unref(): void;
}

interface PendingInteractionLifecycleArgs extends CreateLifecycleDeps {
  sandboxInteractionExpiryMs: number;
  now?: () => number;
}

interface ExpirePendingInteractionArgs {
  interactionId: string;
  reason: string;
}

function requireWaitableOutcome(
  interaction: PendingInteraction,
): PendingInteractionWaitOutcome | null {
  switch (interaction.status) {
    case "pending":
      return null;
    case "resolved":
      if (interaction.resolution === null) {
        throw new ApiError(
          500,
          "internal_error",
          `Pending interaction ${interaction.id} is resolved without a resolution payload`,
        );
      }
      return {
        outcome: "resolved",
        interaction,
        resolution: interaction.resolution,
      };
    case "interrupted":
    case "expired":
      return {
        outcome: interaction.status,
        interaction,
        reason: interaction.statusReason ?? `Pending interaction ${interaction.id} ${interaction.status}`,
      };
    default:
      throw new Error(`Unsupported pending interaction status: ${interaction.status}`);
  }
}

function notifyInteractionChanged(
  deps: CreateLifecycleDeps,
  threadId: string,
): void {
  deps.hub.notifyThread(threadId, ["interactions-changed"]);
}

function timeoutHandleHasUnref(
  timeout: PendingInteractionTimeoutHandle,
): timeout is PendingInteractionTimeoutHandle & PendingInteractionTimeoutHandleWithUnref {
  return (
    typeof timeout === "object"
    && timeout !== null
    && "unref" in timeout
    && typeof timeout.unref === "function"
  );
}

function unrefTimeoutHandle(timeout: PendingInteractionTimeoutHandle): void {
  if (timeoutHandleHasUnref(timeout)) {
    timeout.unref();
  }
}

export class PendingInteractionLifecycle {
  private readonly deps: CreateLifecycleDeps;
  private readonly sandboxInteractionExpiryMs: number;
  private readonly now: () => number;
  private readonly expiryTimers = new Map<string, PendingInteractionExpiryTimer>();
  private readonly waiters = new Map<string, Set<PendingInteractionWaiter>>();

  constructor(args: PendingInteractionLifecycleArgs) {
    if (args.sandboxInteractionExpiryMs <= 0) {
      throw new Error("Pending interaction expiry must be positive");
    }

    this.deps = {
      db: args.db,
      hub: args.hub,
    };
    this.sandboxInteractionExpiryMs = args.sandboxInteractionExpiryMs;
    this.now = args.now ?? Date.now;

    this.hydratePendingInteractions();
  }

  listThreadInteractions(threadId: string): PendingInteraction[] {
    return listPendingInteractionsByThread(this.deps.db, { threadId }).map(toPendingInteraction);
  }

  listPendingThreadInteractions(threadId: string): PendingInteraction[] {
    return listPendingInteractionsByThread(this.deps.db, {
      threadId,
      statuses: ["pending"],
    }).map(toPendingInteraction);
  }

  getThreadInteraction(args: GetThreadInteractionArgs): PendingInteraction {
    const interaction = this.requireInteraction(args.interactionId);
    if (interaction.threadId !== args.threadId) {
      throw new ApiError(404, "invalid_request", "Pending interaction not found");
    }
    return interaction;
  }

  hasPendingThreadInteraction(threadId: string): boolean {
    return getActivePendingInteractionForThread(this.deps.db, threadId) !== null;
  }

  registerPendingInteraction(
    interaction: PendingInteractionCreate,
  ): RegisterPendingInteractionResult {
    const thread = getThread(this.deps.db, interaction.threadId);
    if (!thread || thread.deletedAt !== null) {
      return {
        outcome: "rejected",
        reason: "Thread does not exist",
      };
    }
    if (thread.providerId !== interaction.providerId) {
      return {
        outcome: "rejected",
        reason:
          `Thread ${interaction.threadId} belongs to provider ${thread.providerId}, not ${interaction.providerId}`,
      };
    }
    const unsupportedReason = getUnsupportedPendingInteractionReason(interaction);
    if (unsupportedReason) {
      return {
        outcome: "rejected",
        reason: unsupportedReason,
      };
    }

    const registered = this.deps.db.transaction((tx) => {
      const existing = getPendingInteractionByProviderRequest(tx, {
        providerId: interaction.providerId,
        providerThreadId: interaction.providerThreadId,
        providerRequestId: interaction.providerRequestId,
      });
      if (existing) {
        if (existing.status !== "pending") {
          return {
            outcome: "rejected" as const,
            reason:
              `Provider request ${interaction.providerRequestId} was already handled and cannot be reused`,
          };
        }

        return {
          outcome: "existing" as const,
          row: existing,
        };
      }

      const pendingForThread = getActivePendingInteractionForThread(
        tx,
        interaction.threadId,
      );
      if (pendingForThread) {
        return {
          outcome: "rejected" as const,
          reason: `Thread ${interaction.threadId} is already awaiting user interaction`,
        };
      }

      return {
        outcome: "created" as const,
        row: createPendingInteraction(tx, {
          threadId: interaction.threadId,
          turnId: interaction.turnId,
          providerId: interaction.providerId,
          providerThreadId: interaction.providerThreadId,
          providerRequestId: interaction.providerRequestId,
          kind: interaction.payload.kind,
          payload: JSON.stringify(interaction.payload),
        }),
      };
    });

    if (registered.outcome === "rejected") {
      return registered;
    }

    const pendingInteraction = toPendingInteraction(registered.row);
    this.scheduleInteractionExpiry(pendingInteraction);

    if (registered.outcome === "created") {
      appendPendingInteractionTimelineEvent(this.deps, pendingInteraction);
      notifyInteractionChanged(this.deps, pendingInteraction.threadId);
    }

    return {
      outcome: registered.outcome,
      interaction: pendingInteraction,
    };
  }

  async waitForTerminalState(
    args: WaitForTerminalStateArgs,
  ): Promise<PendingInteractionWaitOutcome> {
    const interaction = this.requireInteraction(args.interactionId);
    const terminalOutcome = requireWaitableOutcome(interaction);
    if (terminalOutcome) {
      return terminalOutcome;
    }

    return new Promise<PendingInteractionWaitOutcome>((resolve) => {
      let abortHandler: (() => void) | null = null;
      const waiter: PendingInteractionWaiter = {
        settled: false,
        resolve: (outcome) => {
          if (waiter.settled) {
            return;
          }
          waiter.settled = true;
          if (args.signal && abortHandler) {
            args.signal.removeEventListener("abort", abortHandler);
          }
          this.removeWaiter(args.interactionId, waiter);
          resolve(outcome);
        },
      };

      const resolveCurrentTerminalOutcome = (): void => {
        const current = this.requireInteraction(args.interactionId);
        const currentOutcome = requireWaitableOutcome(current);
        if (!currentOutcome) {
          return;
        }
        waiter.resolve(currentOutcome);
      };

      abortHandler = (): void => {
        const interrupted = this.interruptPendingInteraction({
          interactionId: args.interactionId,
          reason:
            args.abortReason
            ?? "Daemon request ended while awaiting user interaction",
        });
        if (interrupted) {
          return;
        }
        resolveCurrentTerminalOutcome();
      };

      const waiters =
        this.waiters.get(args.interactionId) ?? new Set<PendingInteractionWaiter>();
      waiters.add(waiter);
      this.waiters.set(args.interactionId, waiters);

      if (args.signal) {
        args.signal.addEventListener("abort", abortHandler, { once: true });
      }

      if (args.signal?.aborted) {
        abortHandler();
        return;
      }

      resolveCurrentTerminalOutcome();
    });
  }

  resolvePendingInteraction(
    args: ResolvePendingInteractionArgs,
  ): PendingInteraction {
    const current = this.getThreadInteraction({
      threadId: args.threadId,
      interactionId: args.interactionId,
    });
    if (current.status !== "pending") {
      if (
        current.status === "resolved"
        && pendingInteractionResolutionEquals(current.resolution, args.resolution)
      ) {
        return current;
      }

      throw buildResolveConflictError(current);
    }
    validatePendingInteractionResolution(current, args.resolution);

    const updated = setPendingInteractionResolved(this.deps.db, {
      id: args.interactionId,
      resolution: JSON.stringify(args.resolution),
    });
    if (!updated) {
      const latest = this.getThreadInteraction({
        threadId: args.threadId,
        interactionId: args.interactionId,
      });
      if (
        latest.status === "resolved"
        && pendingInteractionResolutionEquals(latest.resolution, args.resolution)
      ) {
        return latest;
      }

      throw buildResolveConflictError(latest);
    }

    const interaction = toPendingInteraction(updated);
    this.finishInteraction(interaction);
    return interaction;
  }

  interruptPendingInteraction(
    args: InterruptPendingInteractionArgs,
  ): PendingInteraction | null {
    const updated = setPendingInteractionInterrupted(this.deps.db, {
      id: args.interactionId,
      statusReason: args.reason,
    });
    if (!updated) {
      return null;
    }

    const interaction = toPendingInteraction(updated);
    this.finishInteraction(interaction);
    return interaction;
  }

  interruptPendingInteractionsForThreads(
    args: InterruptPendingInteractionsForThreadsLifecycleArgs,
  ): PendingInteraction[] {
    return this.finishInterruptedRows(
      interruptPendingInteractionsForThreads(this.deps.db, {
        providerId: args.providerId,
        threadIds: args.threadIds,
        statusReason: args.reason,
      }),
    );
  }

  interruptPendingInteractionsForThreadIds(
    args: InterruptPendingInteractionsForThreadIdsLifecycleArgs,
  ): PendingInteraction[] {
    return this.finishInterruptedRows(
      interruptPendingInteractionsForThreadIds(this.deps.db, {
        threadIds: args.threadIds,
        statusReason: args.reason,
      }),
    );
  }

  private finishInterruptedRows(
    rows: PendingInteractionRow[],
  ): PendingInteraction[] {
    const interactions = rows.map(toPendingInteraction);
    for (const interaction of interactions) {
      this.finishInteraction(interaction);
    }
    return interactions;
  }

  private requireInteraction(interactionId: string): PendingInteraction {
    const interaction = getPendingInteraction(this.deps.db, interactionId);
    if (!interaction) {
      throw new ApiError(404, "invalid_request", "Pending interaction not found");
    }

    return toPendingInteraction(interaction);
  }

  private removeWaiter(
    interactionId: string,
    waiter: PendingInteractionWaiter,
  ): void {
    const waiters = this.waiters.get(interactionId);
    if (!waiters) {
      return;
    }

    waiters.delete(waiter);
    if (waiters.size === 0) {
      this.waiters.delete(interactionId);
    }
  }

  private hydratePendingInteractions(): void {
    let offset = 0;
    while (true) {
      const pendingInteractions = listPendingInteractionsOnEphemeralHosts(this.deps.db, {
        limit: PENDING_INTERACTION_HYDRATE_BATCH_SIZE,
        offset,
      }).map(toPendingInteraction);

      for (const interaction of pendingInteractions) {
        this.scheduleInteractionExpiryWithMs(
          interaction,
          this.sandboxInteractionExpiryMs,
        );
      }

      if (pendingInteractions.length < PENDING_INTERACTION_HYDRATE_BATCH_SIZE) {
        return;
      }
      offset += PENDING_INTERACTION_HYDRATE_BATCH_SIZE;
    }
  }

  private resolveInteractionExpiryMs(
    interaction: PendingInteraction,
  ): number | null {
    const thread = getThread(this.deps.db, interaction.threadId);
    if (!thread?.environmentId) {
      return null;
    }

    const environment = getEnvironment(this.deps.db, thread.environmentId);
    if (!environment) {
      return null;
    }

    const host = getHost(this.deps.db, environment.hostId);
    if (host?.type !== "ephemeral") {
      return null;
    }

    return this.sandboxInteractionExpiryMs;
  }

  private scheduleInteractionExpiry(interaction: PendingInteraction): void {
    const interactionExpiryMs = this.resolveInteractionExpiryMs(interaction);
    if (interactionExpiryMs === null) {
      return;
    }

    this.scheduleInteractionExpiryWithMs(interaction, interactionExpiryMs);
  }

  private scheduleInteractionExpiryWithMs(
    interaction: PendingInteraction,
    interactionExpiryMs: number,
  ): void {
    this.clearExpiryTimer(interaction.id);

    if (interaction.status !== "pending") {
      return;
    }

    const expiresAt = interaction.createdAt + interactionExpiryMs;
    const delayMs = expiresAt - this.now();
    if (delayMs <= 0) {
      this.expirePendingInteraction({
        interactionId: interaction.id,
        reason: "Pending interaction expired while waiting for a user response",
      });
      return;
    }

    const timeout = setTimeout(() => {
      this.expiryTimers.delete(interaction.id);
      this.expirePendingInteraction({
        interactionId: interaction.id,
        reason: "Pending interaction expired while waiting for a user response",
      });
    }, delayMs);
    unrefTimeoutHandle(timeout);

    this.expiryTimers.set(interaction.id, {
      timeout,
    });
  }

  private clearExpiryTimer(interactionId: string): void {
    const timer = this.expiryTimers.get(interactionId);
    if (!timer) {
      return;
    }

    clearTimeout(timer.timeout);
    this.expiryTimers.delete(interactionId);
  }

  private expirePendingInteraction(
    args: ExpirePendingInteractionArgs,
  ): PendingInteraction | null {
    const updated = setPendingInteractionExpired(this.deps.db, {
      id: args.interactionId,
      statusReason: args.reason,
    });
    if (!updated) {
      return null;
    }

    const interaction = toPendingInteraction(updated);
    this.finishInteraction(interaction);
    return interaction;
  }

  private finishInteraction(interaction: PendingInteraction): void {
    this.clearExpiryTimer(interaction.id);
    appendPendingInteractionTimelineEvent(this.deps, interaction);
    notifyInteractionChanged(this.deps, interaction.threadId);
    const outcome = requireWaitableOutcome(interaction);
    if (!outcome) {
      return;
    }

    const waiters = this.waiters.get(interaction.id);
    if (!waiters) {
      return;
    }

    for (const waiter of [...waiters]) {
      waiter.resolve(outcome);
    }
    this.waiters.delete(interaction.id);
  }
}
