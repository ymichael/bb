import { assertNever } from "@bb/core";
import type {
  EnvironmentDaemonCommandRecord,
  EnvironmentDaemonCommandRepository,
  EnvironmentDaemonSessionRecord,
  EnvironmentDaemonSessionRepository,
} from "@bb/db";
import type {
  EnvironmentDaemonSessionCommandAckPayload,
  EnvironmentDaemonSessionCommandResultPayload,
} from "@bb/environment-daemon";
import { assessEnvironmentDaemonSessionCompatibility } from "./environment-daemon-session-compatibility.js";

export interface RecordEnvironmentDaemonCommandAckResult {
  commands: EnvironmentDaemonCommandRecord[];
}

export interface InvalidateEnvironmentDaemonSessionCommandsResult {
  failedCommands: EnvironmentDaemonCommandRecord[];
}

export class EnvironmentDaemonSessionUnavailableError extends Error {
  constructor(readonly channelId: string) {
    super(
      `Timed out waiting for active environment-daemon session for channel ${channelId}`,
    );
    this.name = "EnvironmentDaemonSessionUnavailableError";
  }
}

export function isEnvironmentDaemonSessionUnavailableError(
  error: unknown,
): error is EnvironmentDaemonSessionUnavailableError {
  return error instanceof EnvironmentDaemonSessionUnavailableError;
}

export class EnvironmentDaemonCommandDispatcher {
  private readonly clock: () => number;
  private readonly resolveEnvironmentId?: (channelId: string) => string | undefined;

  constructor(
    private readonly sessions: EnvironmentDaemonSessionRepository,
    private readonly commands: EnvironmentDaemonCommandRepository,
    options: {
      clock?: () => number;
      resolveEnvironmentId?: (channelId: string) => string | undefined;
    } = {},
  ) {
    this.clock = options.clock ?? (() => Date.now());
    this.resolveEnvironmentId = options.resolveEnvironmentId;
  }

  private getActiveSessionForChannel(
    channelId: string,
    now: number = this.clock(),
  ): EnvironmentDaemonSessionRecord | undefined {
    const environmentId = this.resolveEnvironmentId?.(channelId);
    if (!environmentId) {
      return undefined;
    }
    const session = this.sessions.getActiveByEnvironmentId(environmentId, now);
    if (!session) {
      return undefined;
    }
    return assessEnvironmentDaemonSessionCompatibility(session).compatibility
      .disposition === "replace"
      ? undefined
      : session;
  }

  async awaitActiveSession(args: {
    channelId: string;
    timeoutMs?: number;
    pollIntervalMs?: number;
  }) {
    const timeoutMs = args.timeoutMs ?? 30_000;
    const pollIntervalMs = args.pollIntervalMs ?? 50;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() <= deadline) {
      const session = this.getActiveSessionForChannel(args.channelId, this.clock());
      if (session) {
        return session;
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new EnvironmentDaemonSessionUnavailableError(args.channelId);
  }

  hasActiveSession(channelId: string): boolean {
    return this.getActiveSessionForChannel(channelId, this.clock()) !== undefined;
  }

  async enqueueForActiveSession(args: {
    channelId: string;
    commandId: string;
    commandType: string;
    payload: unknown;
    timeoutMs?: number;
    pollIntervalMs?: number;
    sentAt?: number;
  }): Promise<EnvironmentDaemonCommandRecord> {
    const existing = this.commands.getById(args.commandId);
    if (existing) {
      return this.resumeExistingCommand(args, existing);
    }

    const session = await this.awaitActiveSession({
      channelId: args.channelId,
      timeoutMs: args.timeoutMs,
      pollIntervalMs: args.pollIntervalMs,
    });
    const concurrentExisting = this.commands.getById(args.commandId);
    if (concurrentExisting) {
      return this.resumeExistingCommand(args, concurrentExisting);
    }
    this.commands.enqueue({
      id: args.commandId,
      threadId: args.channelId,
      sessionId: session.id,
      commandType: args.commandType,
      payload: args.payload,
      now: args.sentAt,
    });
    return this.waitForTerminalState({
      commandId: args.commandId,
      timeoutMs: args.timeoutMs,
      pollIntervalMs: args.pollIntervalMs,
    });
  }

  async waitForTerminalState(args: {
    commandId: string;
    timeoutMs?: number;
    pollIntervalMs?: number;
  }): Promise<EnvironmentDaemonCommandRecord> {
    const timeoutMs = args.timeoutMs ?? 30_000;
    const pollIntervalMs = args.pollIntervalMs ?? 50;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() <= deadline) {
      const command = this.commands.getById(args.commandId);
      if (!command) {
        throw new Error(`Unknown environment-daemon command ${args.commandId}`);
      }
      switch (command.state) {
        case "completed":
        case "failed":
        case "cancelled":
          return command;
        default:
          break;
      }
      if (this.isPendingCommandStranded(command)) {
        throw new EnvironmentDaemonSessionUnavailableError(command.threadId);
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    const command = this.commands.getById(args.commandId);
    if (command && this.isPendingCommandStranded(command)) {
      throw new EnvironmentDaemonSessionUnavailableError(command.threadId);
    }

    throw new Error(`Timed out waiting for environment-daemon command ${args.commandId}`);
  }

  listDeliverableCommandRecords(args: {
    sessionId: string;
    afterCursor?: number;
    limit?: number;
  }): EnvironmentDaemonCommandRecord[] {
    const session = this.sessions.getById(args.sessionId);
    if (!session || session.status !== "active") {
      return [];
    }

    return this.commands.listDeliverableBySessionId(
      args.sessionId,
      args.afterCursor,
      args.limit,
    );
  }

  getPendingCommandCount(threadId: string): number {
    return this.commands.listPendingByThreadId(threadId).length;
  }

  invalidateCommandsForSession(
    session: Pick<
      EnvironmentDaemonSessionRecord,
      "id" | "status" | "closeReason"
    >,
    now: number = Date.now(),
  ): InvalidateEnvironmentDaemonSessionCommandsResult {
    const failedCommands = this.commands
      .listPendingBySessionId(session.id)
      .filter(
        (command) =>
          (command.state === "queued" ||
            command.state === "sent" ||
            command.state === "received" ||
            command.state === "started"),
      )
      .flatMap((command) => {
        const failed = this.commands.markFailed({
          commandId: command.id,
          errorCode: "provider_unavailable",
          errorMessage: this.buildInvalidatedSessionCommandMessage(session),
          now,
        });
        return failed ? [failed] : [];
      });

    return { failedCommands };
  }

  recordDeliveryAck(args: {
    sessionId: string;
    payload: EnvironmentDaemonSessionCommandAckPayload;
    now?: number;
  }): RecordEnvironmentDaemonCommandAckResult {
    const session = this.sessions.getById(args.sessionId);
    if (!session || session.status !== "active") {
      return { commands: [] };
    }

    const now = args.now ?? Date.now();
    const updatedCommands: EnvironmentDaemonCommandRecord[] = [];
    for (const ack of args.payload.commands) {
      const existing = this.commands.getById(ack.commandId);
      if (
        !existing ||
        existing.threadId !== ack.channelId ||
        existing.sessionId !== args.sessionId
      ) {
        continue;
      }

      switch (ack.state) {
        case "received":
        case "duplicate": {
          const updated = this.commands.markReceived(ack.commandId, now);
          if (updated) {
            updatedCommands.push(updated);
          }
          break;
        }
        default:
          assertNever(ack.state);
      }
    }

    return { commands: updatedCommands };
  }

  recordCommandResult(args: {
    sessionId: string;
    payload: EnvironmentDaemonSessionCommandResultPayload;
    now?: number;
  }): EnvironmentDaemonCommandRecord | undefined {
    const session = this.sessions.getById(args.sessionId);
    if (!session) {
      return undefined;
    }

    const existing = this.commands.getById(args.payload.commandId);
    if (
      !existing ||
      existing.threadId !== args.payload.channelId ||
      existing.sessionId !== args.sessionId
    ) {
      return undefined;
    }

    switch (args.payload.state) {
      case "started":
        return this.commands.markStarted(args.payload.commandId, args.now);
      case "completed":
        return this.commands.markCompleted({
          commandId: args.payload.commandId,
          now: args.now,
          ...(args.payload.result !== undefined
            ? { result: args.payload.result }
            : {}),
        });
      case "failed":
        return this.commands.markFailed({
          commandId: args.payload.commandId,
          now: args.now,
          ...(args.payload.errorCode !== undefined
            ? { errorCode: args.payload.errorCode }
            : {}),
          ...(args.payload.errorMessage !== undefined
            ? { errorMessage: args.payload.errorMessage }
            : {}),
        });
      default:
        return assertNever(args.payload.state);
    }
  }

  private async resumeExistingCommand(
    args: {
      channelId: string;
      commandId: string;
      timeoutMs?: number;
      pollIntervalMs?: number;
      sentAt?: number;
    },
    command: EnvironmentDaemonCommandRecord,
  ): Promise<EnvironmentDaemonCommandRecord> {
    if (command.threadId !== args.channelId) {
      throw new Error(
        `Environment-daemon command ${args.commandId} already belongs to channel ${command.threadId}`,
      );
    }

    switch (command.state) {
      case "completed":
      case "failed":
      case "cancelled":
        return command;
      case "queued":
      case "sent": {
        return this.waitForTerminalState({
          commandId: args.commandId,
          timeoutMs: args.timeoutMs,
          pollIntervalMs: args.pollIntervalMs,
        });
      }
      case "received":
      case "started":
        return this.waitForTerminalState({
          commandId: args.commandId,
          timeoutMs: args.timeoutMs,
          pollIntervalMs: args.pollIntervalMs,
        });
      default:
        return assertNever(command.state);
    }
  }

  private isPendingCommandStranded(command: EnvironmentDaemonCommandRecord): boolean {
    switch (command.state) {
      case "completed":
      case "failed":
      case "cancelled":
      case "started":
        return false;
      case "queued":
      case "sent":
      case "received": {
        const activeSession = this.getActiveSessionForChannel(command.threadId, this.clock());
        if (!activeSession) {
          return true;
        }
        return command.sessionId !== undefined && command.sessionId !== activeSession.id;
      }
      default:
        return assertNever(command.state);
    }
  }

  private buildInvalidatedSessionCommandMessage(
    session: Pick<EnvironmentDaemonSessionRecord, "id" | "closeReason">,
  ): string {
    const reason = session.closeReason ?? "internal_error";
    return `Environment-daemon session ${session.id} closed (${reason}) while command execution was in progress`;
  }
}
