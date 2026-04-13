import {
  createPendingInteraction,
  getActivePendingInteractionForThread,
  getEnvironment,
  getPendingInteraction,
  getPendingInteractionByProviderRequest,
  interruptPendingInteractionsForSessionIds,
  getThread,
  interruptPendingInteractionsForThreadIds,
  interruptPendingInteractionsForThreads,
  isThreadOnEphemeralHost,
  listPendingInteractionsByThread,
  listPendingInteractionsOnEphemeralHosts,
  queueCommandInTransaction,
  setPendingInteractionExpired,
  setPendingInteractionInterrupted,
  setPendingInteractionResolved,
  setPendingInteractionResolving,
  type PendingInteractionRow,
} from "@bb/db";
import {
  type PendingInteraction,
  type PendingInteractionCreate,
  type PendingInteractionResolution,
} from "@bb/domain";
import type { HostDaemonCommand } from "@bb/host-daemon-contract";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";
import { appendPendingInteractionTimelineEvent } from "./pending-interaction-timeline.js";
import { toPendingInteraction } from "./pending-interaction-serialization.js";
import {
  pendingInteractionResolutionEquals,
  validatePendingInteractionResolution,
} from "./pending-interaction-validation.js";

export type RegisterPendingInteractionResult =
  | {
      outcome: "created" | "existing";
      interaction: PendingInteraction;
    }
  | {
      outcome: "rejected";
      reason: string;
    };

interface RegisterPendingInteractionArgs {
  interaction: PendingInteractionCreate;
  sessionId: string;
}

interface ResolvePendingInteractionArgs {
  interactionId: string;
  resolution: PendingInteractionResolution;
  threadId: string;
}

interface QueueInteractionResolutionCommandArgs {
  interaction: PendingInteraction;
  resolution: PendingInteractionResolution;
  sessionId: string;
}

interface CompleteResolvingInteractionArgs {
  interactionId: string;
  resolution: PendingInteractionResolution;
}

interface BuildInteractiveResolveCommandArgs {
  environmentId: string;
  interaction: PendingInteraction;
  resolution: PendingInteractionResolution;
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

interface InterruptPendingInteractionsForSessionIdsLifecycleArgs {
  reason: string;
  sessionIds: readonly string[];
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

function buildInteractiveResolveCommand(
  args: BuildInteractiveResolveCommandArgs,
): Extract<HostDaemonCommand, { type: "interactive.resolve" }> {
  return {
    type: "interactive.resolve",
    environmentId: args.environmentId,
    threadId: args.interaction.threadId,
    interactionId: args.interaction.id,
    providerId: args.interaction.providerId,
    providerThreadId: args.interaction.providerThreadId,
    providerRequestId: args.interaction.providerRequestId,
    resolution: args.resolution,
  };
}

export const DEFAULT_SANDBOX_PENDING_INTERACTION_EXPIRY_MS = 10 * 60 * 1000;
const PENDING_INTERACTION_HYDRATE_BATCH_SIZE = 200;

type PendingInteractionTimeoutHandle = ReturnType<typeof setTimeout>;

interface PendingInteractionExpiryTimer {
  timeout: PendingInteractionTimeoutHandle;
}

interface PendingInteractionLifecycleArgs extends CreateLifecycleDeps {
  sandboxInteractionExpiryMs: number;
  now?: () => number;
}

interface ExpirePendingInteractionArgs {
  interactionId: string;
  reason: string;
}

function notifyInteractionChanged(
  deps: CreateLifecycleDeps,
  threadId: string,
): void {
  deps.hub.notifyThread(threadId, ["interactions-changed"]);
}

/**
 * Owns the server-side pending interaction lifecycle: registration, resolution
 * command queuing, terminal state transitions, timeline events, and restart
 * hydration for ephemeral-host expiries.
 */
export class PendingInteractionLifecycle {
  private readonly deps: CreateLifecycleDeps;
  private readonly sandboxInteractionExpiryMs: number;
  private readonly now: () => number;
  private readonly expiryTimers = new Map<string, PendingInteractionExpiryTimer>();
  private started = false;

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
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.hydratePendingInteractions();
  }

  listThreadInteractions(threadId: string): PendingInteraction[] {
    return listPendingInteractionsByThread(this.deps.db, { threadId }).map(toPendingInteraction);
  }

  listPendingThreadInteractions(threadId: string): PendingInteraction[] {
    return listPendingInteractionsByThread(this.deps.db, {
      threadId,
      statuses: ["pending", "resolving"],
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
    args: RegisterPendingInteractionArgs,
  ): RegisterPendingInteractionResult {
    const { interaction } = args;
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
        sessionId: args.sessionId,
      });
      if (existing) {
        if (
          existing.status !== "pending"
          && existing.status !== "resolving"
        ) {
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
          sessionId: args.sessionId,
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

  resolvePendingInteraction(
    args: ResolvePendingInteractionArgs,
  ): PendingInteraction {
    const currentRow = this.requireInteractionRow(args.interactionId);
    const current = toPendingInteraction(currentRow);
    if (current.threadId !== args.threadId) {
      throw new ApiError(404, "invalid_request", "Pending interaction not found");
    }
    if (current.status !== "pending") {
      if (
        (current.status === "resolving" || current.status === "resolved")
        && pendingInteractionResolutionEquals(current.resolution, args.resolution)
      ) {
        return current;
      }

      throw buildResolveConflictError(current);
    }
    validatePendingInteractionResolution(current, args.resolution);

    const updated = this.queueInteractionResolutionCommand({
      interaction: current,
      resolution: args.resolution,
      sessionId: currentRow.sessionId,
    });
    if (!updated) {
      const latest = this.getThreadInteraction({
        threadId: args.threadId,
        interactionId: args.interactionId,
      });
      if (
        (latest.status === "resolving" || latest.status === "resolved")
        && pendingInteractionResolutionEquals(latest.resolution, args.resolution)
      ) {
        return latest;
      }

      throw buildResolveConflictError(latest);
    }

    const interaction = toPendingInteraction(updated);
    this.settleInteractionTerminalState(interaction);
    return interaction;
  }

  completeResolvingInteraction(
    args: CompleteResolvingInteractionArgs,
  ): PendingInteraction | null {
    const updated = setPendingInteractionResolved(this.deps.db, {
      id: args.interactionId,
      resolution: JSON.stringify(args.resolution),
    });
    if (!updated) {
      return null;
    }

    const interaction = toPendingInteraction(updated);
    this.settleInteractionTerminalState(interaction);
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
    this.settleInteractionTerminalState(interaction);
    return interaction;
  }

  interruptPendingInteractionsForThreads(
    args: InterruptPendingInteractionsForThreadsLifecycleArgs,
  ): PendingInteraction[] {
    return this.settleInterruptedRows(
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
    return this.settleInterruptedRows(
      interruptPendingInteractionsForThreadIds(this.deps.db, {
        threadIds: args.threadIds,
        statusReason: args.reason,
      }),
    );
  }

  interruptPendingInteractionsForSessionIds(
    args: InterruptPendingInteractionsForSessionIdsLifecycleArgs,
  ): PendingInteraction[] {
    return this.settleInterruptedRows(
      interruptPendingInteractionsForSessionIds(this.deps.db, {
        sessionIds: args.sessionIds,
        statusReason: args.reason,
      }),
    );
  }

  private settleInterruptedRows(
    rows: PendingInteractionRow[],
  ): PendingInteraction[] {
    const interactions = rows.map(toPendingInteraction);
    for (const interaction of interactions) {
      this.settleInteractionTerminalState(interaction);
    }
    return interactions;
  }

  private queueInteractionResolutionCommand(
    args: QueueInteractionResolutionCommandArgs,
  ): PendingInteractionRow | null {
    const thread = getThread(this.deps.db, args.interaction.threadId);
    if (!thread?.environmentId) {
      throw new ApiError(
        409,
        "invalid_request",
        "Cannot resolve pending interaction because its thread has no active environment",
      );
    }

    const environment = getEnvironment(this.deps.db, thread.environmentId);
    if (!environment) {
      throw new ApiError(
        409,
        "invalid_request",
        "Cannot resolve pending interaction because its environment no longer exists",
      );
    }

    const command = buildInteractiveResolveCommand({
      environmentId: environment.id,
      interaction: args.interaction,
      resolution: args.resolution,
    });
    const resolutionJson = JSON.stringify(args.resolution);
    const commandPayload = JSON.stringify(command);
    const updated = this.deps.db.transaction((tx) => {
      const resolving = setPendingInteractionResolving(tx, {
        id: args.interaction.id,
        resolution: resolutionJson,
      });
      if (!resolving) {
        return null;
      }

      queueCommandInTransaction(tx, {
        hostId: environment.hostId,
        sessionId: args.sessionId,
        type: command.type,
        payload: commandPayload,
      });
      return resolving;
    });

    if (updated) {
      this.deps.hub.notifyCommand(environment.hostId);
    }

    return updated;
  }

  private requireInteraction(interactionId: string): PendingInteraction {
    return toPendingInteraction(this.requireInteractionRow(interactionId));
  }

  private requireInteractionRow(interactionId: string): PendingInteractionRow {
    const interaction = getPendingInteraction(this.deps.db, interactionId);
    if (!interaction) {
      throw new ApiError(404, "invalid_request", "Pending interaction not found");
    }

    return interaction;
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
    if (!isThreadOnEphemeralHost(this.deps.db, { threadId: interaction.threadId })) {
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
    timeout.unref();

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
    this.settleInteractionTerminalState(interaction);
    return interaction;
  }

  private settleInteractionTerminalState(interaction: PendingInteraction): void {
    this.clearExpiryTimer(interaction.id);
    appendPendingInteractionTimelineEvent(this.deps, interaction);
    notifyInteractionChanged(this.deps, interaction.threadId);
  }
}
