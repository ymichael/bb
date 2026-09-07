import {
  createPendingInteraction,
  getActivePendingInteractionForThread,
  getEnvironment,
  getPendingInteraction,
  getPendingInteractionByProviderRequest,
  getThread,
  interruptPendingInteractionsForThreadIds,
  interruptPendingInteractionsForThreads,
  interruptPendingInteractionsForPlugin,
  listActivePluginPendingInteractions,
  listPendingInteractionsByThread,
  setPendingInteractionInterrupted,
  setPendingInteractionResolved,
  setPendingInteractionResolving,
  type PendingInteractionRow,
  type DbNotifier,
  type DbTransaction,
} from "@bb/db";
import {
  isApprovalPendingInteractionPayload,
  isPluginPendingInteractionPayload,
  isPluginExtensionInteractionRequestPayload,
  isPluginExtensionPendingInteraction,
  isPluginPendingInteraction,
  parseExtensionKind,
  type JsonValue,
  type PendingInteraction,
  type PendingInteractionCreate,
  type PendingInteractionResolution,
  type ThreadChangeMetadata,
} from "@bb/domain";
import type { HostDaemonCommand } from "@bb/host-daemon-contract";
import type { CommandResultReportForType } from "../../internal/command-result-side-effects.js";
import { ApiError } from "../../errors.js";
import type { AppDeps, LoggedWorkSessionDeps } from "../../types.js";
import { productionErrorLogFields } from "../lib/error-log-fields.js";
import {
  threadEnvironmentUnavailableDetails,
  throwThreadEnvironmentUnavailable,
} from "../lib/lifecycle-api-errors.js";
import {
  appendPendingInteractionTimelineEvent,
  appendPendingInteractionTimelineEventInTransaction,
} from "./pending-interaction-timeline.js";
import {
  PendingInteractionSerializationError,
  toPendingInteraction,
} from "./pending-interaction-serialization.js";
import {
  LIVE_DAEMON_COMMAND_TIMEOUT_MS,
  startLiveHostCommand,
} from "../hosts/live-command.js";
import {
  pendingInteractionResolutionEquals,
  validatePendingInteractionResolution,
} from "./pending-interaction-validation.js";
import { emitPluginInteractionPending } from "../plugins/plugin-thread-events.js";

type RegisterPendingInteractionResult =
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
}

interface ResolvePendingInteractionArgs {
  interactionId: string;
  resolution: PendingInteractionResolution;
  threadId: string;
}

interface QueueInteractionResolutionCommandArgs {
  interaction: PendingInteraction;
  resolution: PendingInteractionResolution;
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

interface RequestPluginInteractionArgs {
  pluginId: string;
  threadId: string;
  rendererId: string;
  title: string;
  payload: JsonValue;
  timeoutMs: number;
  signal?: AbortSignal;
}

interface PluginInteractionWaiter {
  resolve: (result: PluginInteractionResult) => void;
  timer: ReturnType<typeof setTimeout>;
  removeAbortListener: () => void;
}

interface GetThreadInteractionArgs {
  interactionId: string;
  threadId: string;
}

interface InterruptPendingInteractionArgs {
  interactionId: string;
  reason: string;
}

type InteractiveResolveCommand = Extract<
  HostDaemonCommand,
  { type: "interactive.resolve" }
>;

type InteractiveResolveCommandResultReport = Extract<
  CommandResultReportForType<"interactive.resolve">,
  { type: "interactive.resolve" }
>;

interface SettleInteractiveResolveCommandResultArgs {
  command: InteractiveResolveCommand;
  deps: PendingInteractionTransactionDeps;
  report: InteractiveResolveCommandResultReport;
}

interface PendingInteractionTransactionDeps {
  db: DbTransaction;
  hub: DbNotifier;
}

interface BuildInteractionChangeMetadataArgs {
  db: AppDeps["db"] | DbTransaction;
  hasPendingInteraction: boolean;
  threadId: string;
}

interface InteractionChangeNotificationDeps {
  db: AppDeps["db"] | DbTransaction;
  hub: DbNotifier;
}

interface NotifyInteractionChangedArgs {
  deps: InteractionChangeNotificationDeps;
  hasPendingInteraction: boolean;
  threadId: string;
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

type CreateLifecycleDeps = LoggedWorkSessionDeps &
  Pick<AppDeps, "terminalSessions">;

function buildResolveConflictError(interaction: PendingInteraction): ApiError {
  return new ApiError(
    409,
    "invalid_request",
    `Pending interaction ${interaction.id} is already ${interaction.status}`,
  );
}

export interface PendingInteractionPluginDirectory {
  isLoaded(pluginId: string): boolean;
}

function getUnsupportedPendingInteractionReason(
  interaction: PendingInteractionCreate,
  plugins: PendingInteractionPluginDirectory | null,
): string | null {
  if (isPluginExtensionInteractionRequestPayload(interaction.payload)) {
    const { pluginId } = parseExtensionKind(interaction.payload.kind);
    if (plugins === null || !plugins.isLoaded(pluginId)) {
      return `Plugin "${pluginId}" is not loaded on this server, so the "${interaction.payload.kind}" request has no form to render`;
    }
    return null;
  }
  if (!isApprovalPendingInteractionPayload(interaction.payload)) {
    return null;
  }
  if (interaction.payload.availableDecisions.length === 0) {
    return "Approvals must include at least one available decision";
  }

  return null;
}

function buildInteractiveResolveCommand(
  args: BuildInteractiveResolveCommandArgs,
): Extract<HostDaemonCommand, { type: "interactive.resolve" }> {
  if (isPluginPendingInteraction(args.interaction)) {
    throw new Error("Plugin interactions do not produce host resolve commands");
  }
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

type PendingInteractionLifecycleArgs = CreateLifecycleDeps;

export type ThreadInteractionSettledListener = (threadId: string) => void;

function buildInteractionChangeMetadata({
  db,
  hasPendingInteraction,
  threadId,
}: BuildInteractionChangeMetadataArgs): ThreadChangeMetadata | undefined {
  const thread = getThread(db, threadId);
  if (!thread) {
    return undefined;
  }
  return {
    hasPendingInteraction,
    projectId: thread.projectId,
  };
}

function notifyInteractionChanged({
  deps,
  hasPendingInteraction,
  threadId,
}: NotifyInteractionChangedArgs): void {
  deps.hub.notifyThread(
    threadId,
    ["interactions-changed"],
    buildInteractionChangeMetadata({
      db: deps.db,
      hasPendingInteraction,
      threadId,
    }),
  );
}

export class PendingInteractionLifecycle {
  private readonly deps: CreateLifecycleDeps;
  private readonly pluginWaiters = new Map<string, PluginInteractionWaiter>();
  private pluginDirectory: PendingInteractionPluginDirectory | null = null;
  private started = false;
  private interactionSettledListener: ThreadInteractionSettledListener | null =
    null;

  constructor(args: PendingInteractionLifecycleArgs) {
    this.deps = {
      config: args.config,
      db: args.db,
      hub: args.hub,
      lifecycleDedupers: args.lifecycleDedupers,
      logger: args.logger,
      machineAuth: args.machineAuth,
      providerRegistry: args.providerRegistry,
      pluginHostArtifacts: args.pluginHostArtifacts,
      aiServices: args.aiServices,
      skillTreeRegistry: args.skillTreeRegistry,
      telemetry: args.telemetry,
      terminalSessions: args.terminalSessions,
    };
  }

  setPluginDirectory(directory: PendingInteractionPluginDirectory): void {
    this.pluginDirectory = directory;
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.settleInterruptedRows(
      listActivePluginPendingInteractions(this.deps.db).flatMap((row) => {
        const updated = setPendingInteractionInterrupted(this.deps.db, {
          id: row.id,
          statusReason: "server-restarted",
        });
        return updated ? [updated] : [];
      }),
    );
  }

  setThreadInteractionSettledListener(
    listener: ThreadInteractionSettledListener,
  ): void {
    this.interactionSettledListener = listener;
  }

  listThreadInteractions(threadId: string): PendingInteraction[] {
    return this.parseListRows(
      listPendingInteractionsByThread(this.deps.db, { threadId }),
    );
  }

  listPendingThreadInteractions(threadId: string): PendingInteraction[] {
    return this.parseListRows(
      listPendingInteractionsByThread(this.deps.db, {
        threadId,
        statuses: ["pending", "resolving"],
      }),
    );
  }

  getThreadInteraction(args: GetThreadInteractionArgs): PendingInteraction {
    const interaction = this.requireInteraction(args.interactionId);
    if (interaction.threadId !== args.threadId) {
      throw new ApiError(
        404,
        "invalid_request",
        "Pending interaction not found",
      );
    }
    return interaction;
  }

  hasPendingThreadInteraction(threadId: string): boolean {
    return (
      getActivePendingInteractionForThread(this.deps.db, threadId) !== null
    );
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
        reason: `Thread ${interaction.threadId} belongs to provider ${thread.providerId}, not ${interaction.providerId}`,
      };
    }
    const unsupportedReason = getUnsupportedPendingInteractionReason(
      interaction,
      this.pluginDirectory,
    );
    if (unsupportedReason) {
      return {
        outcome: "rejected",
        reason: unsupportedReason,
      };
    }

    const payload = JSON.stringify(interaction.payload);
    const registered = this.deps.db.transaction((tx) => {
      const existing = getPendingInteractionByProviderRequest(tx, {
        providerId: interaction.providerId,
        providerThreadId: interaction.providerThreadId,
        providerRequestId: interaction.providerRequestId,
      });
      if (existing) {
        if (existing.status !== "pending" && existing.status !== "resolving") {
          return {
            outcome: "rejected" as const,
            reason: `Provider request ${interaction.providerRequestId} was already handled and cannot be reused`,
          };
        }
        if (existing.payload !== payload) {
          return {
            outcome: "rejected" as const,
            reason: `Provider request ${interaction.providerRequestId} is already awaiting a different interaction payload`,
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
          originKind: "provider",
          providerId: interaction.providerId,
          providerThreadId: interaction.providerThreadId,
          providerRequestId: interaction.providerRequestId,
          payload,
          expiresAt: null,
        }),
      };
    });

    if (registered.outcome === "rejected") {
      return registered;
    }

    const pendingInteraction = toPendingInteraction(registered.row);

    if (registered.outcome === "created") {
      appendPendingInteractionTimelineEvent(this.deps, pendingInteraction);
      notifyInteractionChanged({
        deps: this.deps,
        hasPendingInteraction: true,
        threadId: pendingInteraction.threadId,
      });
      emitPluginInteractionPending(thread, pendingInteraction);
    }

    return {
      outcome: registered.outcome,
      interaction: pendingInteraction,
    };
  }

  requestPluginInteraction(
    args: RequestPluginInteractionArgs,
  ): Promise<PluginInteractionResult> {
    const thread = getThread(this.deps.db, args.threadId);
    if (!thread || thread.deletedAt !== null) {
      throw new ApiError(404, "invalid_request", "Thread does not exist");
    }
    if (args.signal?.aborted) {
      return Promise.resolve({
        outcome: "cancelled",
        reason: "request-aborted",
      });
    }

    const expiresAt = Date.now() + args.timeoutMs;
    const row = this.deps.db.transaction((tx) => {
      if (getActivePendingInteractionForThread(tx, args.threadId)) {
        throw new ApiError(
          409,
          "invalid_request",
          `Thread ${args.threadId} is already awaiting user interaction`,
        );
      }
      return createPendingInteraction(tx, {
        originKind: "plugin",
        pluginId: args.pluginId,
        rendererId: args.rendererId,
        threadId: args.threadId,
        turnId: null,
        expiresAt,
        payload: JSON.stringify({
          kind: "plugin",
          title: args.title,
          data: args.payload,
        }),
      });
    });
    const interaction = toPendingInteraction(row);

    const pending = new Promise<PluginInteractionResult>((resolve) => {
      const abort = () => {
        this.cancelPluginInteractionFromCallback({
          interactionId: interaction.id,
          threadId: interaction.threadId,
          reason: "request-aborted",
        });
      };
      args.signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => {
        this.cancelPluginInteractionFromCallback({
          interactionId: interaction.id,
          threadId: interaction.threadId,
          reason: "timeout",
        });
      }, args.timeoutMs);
      this.pluginWaiters.set(interaction.id, {
        resolve,
        timer,
        removeAbortListener: () =>
          args.signal?.removeEventListener("abort", abort),
      });
      if (args.signal?.aborted) {
        abort();
      }
    });
    if (args.signal?.aborted) {
      return pending;
    }
    try {
      appendPendingInteractionTimelineEvent(this.deps, interaction);
      notifyInteractionChanged({
        deps: this.deps,
        hasPendingInteraction: true,
        threadId: interaction.threadId,
      });
    } catch (error) {
      try {
        setPendingInteractionInterrupted(this.deps.db, {
          id: interaction.id,
          statusReason: "Plugin interaction setup failed",
        });
      } catch (cleanupError) {
        this.deps.logger.warn(
          {
            err: cleanupError,
            interactionId: interaction.id,
          },
          "Failed to clean up plugin interaction after setup failure",
        );
      }
      this.settlePluginWaiter(interaction.id, {
        outcome: "cancelled",
        reason: "thread-stopped",
      });
      throw error;
    }
    return pending;
  }

  respondToInteraction(args: {
    interactionId: string;
    threadId: string;
    value: JsonValue;
  }): PendingInteraction {
    const current = this.getThreadInteraction(args);
    if (isPluginExtensionPendingInteraction(current)) {
      return this.resolvePendingInteraction({
        interactionId: args.interactionId,
        threadId: args.threadId,
        resolution: { kind: "request_answer", value: args.value },
      });
    }
    return this.respondToPluginInteraction(args);
  }

  respondToPluginInteraction(args: {
    interactionId: string;
    threadId: string;
    value: JsonValue;
  }): PendingInteraction {
    const current = this.getThreadInteraction(args);
    if (!isPluginPendingInteraction(current)) {
      throw new ApiError(400, "invalid_request", "Plugin interaction expected");
    }
    if (current.status !== "pending") throw buildResolveConflictError(current);
    const updated = setPendingInteractionResolved(this.deps.db, {
      id: current.id,
      resolution: JSON.stringify({ kind: "plugin_submitted" }),
    });
    if (!updated)
      throw buildResolveConflictError(this.requireInteraction(current.id));
    const interaction = toPendingInteraction(updated);
    this.settlePluginWaiter(interaction.id, {
      outcome: "submitted",
      value: args.value,
    });
    this.settlePluginInteractionTerminalSideEffects(interaction);
    return interaction;
  }

  cancelPluginInteraction(args: {
    interactionId: string;
    threadId: string;
    reason: PluginInteractionCancelReason;
  }): PendingInteraction {
    const current = this.getThreadInteraction(args);
    if (!isPluginPendingInteraction(current)) {
      throw new ApiError(
        400,
        "invalid_request",
        isPluginExtensionPendingInteraction(current)
          ? "A provider's request cannot be cancelled; stop the turn instead"
          : "Plugin interaction expected",
      );
    }
    if (current.status !== "pending" && current.status !== "resolving") {
      throw buildResolveConflictError(current);
    }
    const updated = setPendingInteractionInterrupted(this.deps.db, {
      id: current.id,
      statusReason: args.reason,
    });
    if (!updated)
      throw buildResolveConflictError(this.requireInteraction(current.id));
    const interaction = toPendingInteraction(updated);
    this.settlePluginWaiter(interaction.id, {
      outcome: "cancelled",
      reason: args.reason,
    });
    this.settlePluginInteractionTerminalSideEffects(interaction);
    return interaction;
  }

  interruptPluginInteractions(pluginId: string): PendingInteraction[] {
    return this.settleInterruptedRows(
      interruptPendingInteractionsForPlugin(this.deps.db, {
        pluginId,
        statusReason: "plugin-disposed",
      }),
    );
  }

  resolvePendingInteraction(
    args: ResolvePendingInteractionArgs,
  ): PendingInteraction {
    const currentRow = this.requireInteractionRow(args.interactionId);
    const current = toPendingInteraction(currentRow);
    if (current.threadId !== args.threadId) {
      throw new ApiError(
        404,
        "invalid_request",
        "Pending interaction not found",
      );
    }
    if (current.status !== "pending") {
      if (
        (current.status === "resolving" || current.status === "resolved") &&
        pendingInteractionResolutionEquals(current.resolution, args.resolution)
      ) {
        return current;
      }

      throw buildResolveConflictError(current);
    }
    validatePendingInteractionResolution(current, args.resolution);

    const updated = this.queueInteractionResolutionCommand({
      interaction: current,
      resolution: args.resolution,
    });
    if (!updated) {
      const latest = this.getThreadInteraction({
        threadId: args.threadId,
        interactionId: args.interactionId,
      });
      if (
        (latest.status === "resolving" || latest.status === "resolved") &&
        pendingInteractionResolutionEquals(latest.resolution, args.resolution)
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

  completeResolvingInteractionInTransaction(
    deps: PendingInteractionTransactionDeps,
    args: CompleteResolvingInteractionArgs,
  ): PendingInteraction | null {
    const updated = setPendingInteractionResolved(deps.db, {
      id: args.interactionId,
      resolution: JSON.stringify(args.resolution),
    });
    if (!updated) {
      return null;
    }

    const interaction = toPendingInteraction(updated);
    this.settleInteractionTerminalStateInTransaction(deps, interaction);
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

  interruptPendingInteractionInTransaction(
    deps: PendingInteractionTransactionDeps,
    args: InterruptPendingInteractionArgs,
  ): PendingInteraction | null {
    const updated = setPendingInteractionInterrupted(deps.db, {
      id: args.interactionId,
      statusReason: args.reason,
    });
    if (!updated) {
      return null;
    }

    const interaction = toPendingInteraction(updated);
    this.settleInteractionTerminalStateInTransaction(deps, interaction);
    return interaction;
  }

  settleInteractiveResolveCommandResultInTransaction(
    args: SettleInteractiveResolveCommandResultArgs,
  ): void {
    if (!args.report.ok) {
      this.interruptPendingInteractionInTransaction(args.deps, {
        interactionId: args.command.interactionId,
        reason: args.report.errorMessage,
      });
      return;
    }

    const completed = this.completeResolvingInteractionInTransaction(
      args.deps,
      {
        interactionId: args.command.interactionId,
        resolution: args.command.resolution,
      },
    );
    if (!completed) {
      this.deps.logger.info(
        {
          executionId: args.report.executionId,
          interactionId: args.command.interactionId,
        },
        "Interactive resolve command result did not advance pending interaction",
      );
    }
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

  interruptPendingInteractionsForThreadIdsInTransaction(
    deps: PendingInteractionTransactionDeps,
    args: InterruptPendingInteractionsForThreadIdsLifecycleArgs,
  ): PendingInteraction[] {
    return this.settleInterruptedRowsInTransaction(
      deps,
      interruptPendingInteractionsForThreadIds(deps.db, {
        threadIds: args.threadIds,
        statusReason: args.reason,
      }),
    );
  }

  private settleInterruptedRows(
    rows: PendingInteractionRow[],
  ): PendingInteraction[] {
    const interactions = rows.map(toPendingInteraction);
    for (const interaction of interactions) {
      this.settleInterruptedPluginWaiter(interaction);
    }
    for (const interaction of interactions) {
      this.settleInteractionTerminalState(interaction);
    }
    return interactions;
  }

  private settleInterruptedRowsInTransaction(
    deps: PendingInteractionTransactionDeps,
    rows: PendingInteractionRow[],
  ): PendingInteraction[] {
    const interactions = rows.map(toPendingInteraction);
    for (const interaction of interactions) {
      this.settleInteractionTerminalStateInTransaction(deps, interaction);
    }
    for (const interaction of interactions) {
      this.settleInterruptedPluginWaiterAfterTransaction(interaction);
    }
    return interactions;
  }

  private queueInteractionResolutionCommand(
    args: QueueInteractionResolutionCommandArgs,
  ): PendingInteractionRow | null {
    const thread = getThread(this.deps.db, args.interaction.threadId);
    if (!thread?.environmentId) {
      throwThreadEnvironmentUnavailable(
        threadEnvironmentUnavailableDetails("never_attached", null),
      );
    }

    const environment = getEnvironment(this.deps.db, thread.environmentId);
    if (!environment) {
      throwThreadEnvironmentUnavailable(
        threadEnvironmentUnavailableDetails("destroyed", null),
      );
    }

    const command = buildInteractiveResolveCommand({
      environmentId: environment.id,
      interaction: args.interaction,
      resolution: args.resolution,
    });
    const resolutionJson = JSON.stringify(args.resolution);
    const updated = this.deps.db.transaction((tx) => {
      const resolving = setPendingInteractionResolving(tx, {
        id: args.interaction.id,
        resolution: resolutionJson,
      });
      if (resolving) {
        return resolving;
      }
      return null;
    });

    if (updated) {
      startLiveHostCommand(
        { ...this.deps, pendingInteractions: this },
        {
          command,
          hostId: environment.hostId,
          timeoutMs: LIVE_DAEMON_COMMAND_TIMEOUT_MS,
          onError: ({ error }) => {
            this.deps.logger.warn(
              { err: error, interactionId: args.interaction.id },
              "Live interactive resolve command failed",
            );
          },
        },
      );
    }

    return updated;
  }

  private requireInteraction(interactionId: string): PendingInteraction {
    return toPendingInteraction(this.requireInteractionRow(interactionId));
  }

  private parseListRows(rows: PendingInteractionRow[]): PendingInteraction[] {
    const interactions: PendingInteraction[] = [];
    for (const row of rows) {
      try {
        interactions.push(toPendingInteraction(row));
      } catch (error) {
        if (error instanceof PendingInteractionSerializationError) {
          this.deps.logger.warn(
            {
              field: error.field,
              interactionId: error.interactionId,
              ...productionErrorLogFields(error),
            },
            "Skipping corrupt pending interaction row",
          );
          continue;
        }
        throw error;
      }
    }
    return interactions;
  }

  private requireInteractionRow(interactionId: string): PendingInteractionRow {
    const interaction = getPendingInteraction(this.deps.db, interactionId);
    if (!interaction) {
      throw new ApiError(
        404,
        "invalid_request",
        "Pending interaction not found",
      );
    }

    return interaction;
  }

  private settleInteractionTerminalState(
    interaction: PendingInteraction,
  ): void {
    appendPendingInteractionTimelineEvent(this.deps, interaction);
    notifyInteractionChanged({
      deps: this.deps,
      hasPendingInteraction: false,
      threadId: interaction.threadId,
    });
    this.notifyInteractionSettled(interaction.threadId);
  }

  private settleInteractionTerminalStateInTransaction(
    deps: PendingInteractionTransactionDeps,
    interaction: PendingInteraction,
  ): void {
    appendPendingInteractionTimelineEventInTransaction(deps, interaction);
    notifyInteractionChanged({
      deps,
      hasPendingInteraction: false,
      threadId: interaction.threadId,
    });
    this.notifyInteractionSettled(interaction.threadId);
  }

  private notifyInteractionSettled(threadId: string): void {
    if (!this.interactionSettledListener) {
      return;
    }
    try {
      this.interactionSettledListener(threadId);
    } catch (error) {
      this.deps.logger.warn(
        { err: error, threadId },
        "Pending interaction settled listener failed",
      );
    }
  }

  private cancelPluginInteractionFromCallback(args: {
    interactionId: string;
    threadId: string;
    reason: PluginInteractionCancelReason;
  }): void {
    try {
      this.cancelPluginInteraction(args);
    } catch (error) {
      this.settlePluginWaiter(args.interactionId, {
        outcome: "cancelled",
        reason: args.reason,
      });
      this.deps.logger.warn(
        {
          err: error,
          interactionId: args.interactionId,
          reason: args.reason,
        },
        "Failed to cancel plugin interaction from callback",
      );
    }
  }

  private settlePluginInteractionTerminalSideEffects(
    interaction: PendingInteraction,
  ): void {
    try {
      this.settleInteractionTerminalState(interaction);
    } catch (error) {
      this.deps.logger.warn(
        { err: error, interactionId: interaction.id },
        "Failed to publish plugin interaction terminal state",
      );
    }
  }

  private settleInterruptedPluginWaiterAfterTransaction(
    interaction: PendingInteraction,
  ): void {
    queueMicrotask(() => {
      try {
        const row = getPendingInteraction(this.deps.db, interaction.id);
        if (!row) {
          this.settleInterruptedPluginWaiter(interaction);
          return;
        }
        const current = toPendingInteraction(row);
        if (current.status === "interrupted") {
          this.settleInterruptedPluginWaiter(current);
        }
      } catch (error) {
        this.deps.logger.warn(
          { err: error, interactionId: interaction.id },
          "Failed to settle plugin interaction after transaction",
        );
      }
    });
  }

  private settleInterruptedPluginWaiter(interaction: PendingInteraction): void {
    if (
      isPluginPendingInteractionPayload(interaction.payload) &&
      interaction.status === "interrupted"
    ) {
      this.settlePluginWaiter(interaction.id, {
        outcome: "cancelled",
        reason: this.normalizePluginCancelReason(interaction.statusReason),
      });
    }
  }

  private settlePluginWaiter(
    interactionId: string,
    result: PluginInteractionResult,
  ): void {
    const waiter = this.pluginWaiters.get(interactionId);
    if (!waiter) return;
    this.pluginWaiters.delete(interactionId);
    clearTimeout(waiter.timer);
    waiter.removeAbortListener();
    waiter.resolve(result);
  }

  private normalizePluginCancelReason(
    reason: string | null,
  ): PluginInteractionCancelReason {
    switch (reason) {
      case "user":
      case "request-aborted":
      case "thread-stopped":
      case "thread-deleted":
      case "plugin-disposed":
      case "server-restarted":
      case "timeout":
        return reason;
      default:
        return "thread-stopped";
    }
  }
}
