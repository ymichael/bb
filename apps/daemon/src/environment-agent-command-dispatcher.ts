import { assertNever } from "@beanbag/agent-core";
import type {
  EnvironmentAgentCommandRecord,
  EnvironmentAgentCommandRepository,
  EnvironmentAgentSessionRepository,
} from "@beanbag/db";
import type {
  EnvironmentAgentSessionCommandAckPayload,
  EnvironmentAgentSessionCommandResultPayload,
} from "@beanbag/environment-agent";

export interface RecordEnvironmentAgentCommandAckResult {
  commands: EnvironmentAgentCommandRecord[];
  deliveredThrough?: number;
}

export class EnvironmentAgentSessionUnavailableError extends Error {
  constructor(readonly threadId: string) {
    super(
      `Timed out waiting for active environment-agent session for thread ${threadId}`,
    );
    this.name = "EnvironmentAgentSessionUnavailableError";
  }
}

export function isEnvironmentAgentSessionUnavailableError(
  error: unknown,
): error is EnvironmentAgentSessionUnavailableError {
  return error instanceof EnvironmentAgentSessionUnavailableError;
}

export class EnvironmentAgentCommandDispatcher {
  constructor(
    private readonly sessions: EnvironmentAgentSessionRepository,
    private readonly commands: EnvironmentAgentCommandRepository,
  ) {}

  async awaitActiveSession(args: {
    threadId: string;
    timeoutMs?: number;
    pollIntervalMs?: number;
  }) {
    const timeoutMs = args.timeoutMs ?? 30_000;
    const pollIntervalMs = args.pollIntervalMs ?? 50;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() <= deadline) {
      const session = this.sessions.getActiveByThreadId(args.threadId);
      if (session) {
        return session;
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new EnvironmentAgentSessionUnavailableError(args.threadId);
  }

  hasActiveSession(threadId: string): boolean {
    return this.sessions.getActiveByThreadId(threadId) !== undefined;
  }

  async enqueueForActiveSession(args: {
    threadId: string;
    commandId: string;
    commandType: string;
    payload: unknown;
    timeoutMs?: number;
    pollIntervalMs?: number;
    sentAt?: number;
  }): Promise<EnvironmentAgentCommandRecord> {
    const existing = this.commands.getById(args.commandId);
    if (existing) {
      return this.resumeExistingCommand(args, existing);
    }

    const session = await this.awaitActiveSession({
      threadId: args.threadId,
      timeoutMs: args.timeoutMs,
      pollIntervalMs: args.pollIntervalMs,
    });
    const concurrentExisting = this.commands.getById(args.commandId);
    if (concurrentExisting) {
      return this.resumeExistingCommand(args, concurrentExisting);
    }
    this.commands.enqueue({
      id: args.commandId,
      threadId: args.threadId,
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
  }): Promise<EnvironmentAgentCommandRecord> {
    const timeoutMs = args.timeoutMs ?? 30_000;
    const pollIntervalMs = args.pollIntervalMs ?? 50;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() <= deadline) {
      const command = this.commands.getById(args.commandId);
      if (!command) {
        throw new Error(`Unknown environment-agent command ${args.commandId}`);
      }
      switch (command.state) {
        case "completed":
        case "failed":
        case "cancelled":
          return command;
        default:
          break;
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    const command = this.commands.getById(args.commandId);
    if (
      command &&
      (command.state === "queued" || command.state === "sent") &&
      this.sessions.getActiveByThreadId(command.threadId) === undefined
    ) {
      throw new EnvironmentAgentSessionUnavailableError(command.threadId);
    }

    throw new Error(`Timed out waiting for environment-agent command ${args.commandId}`);
  }

  listDeliverableCommandRecords(args: {
    sessionId: string;
    afterCursor?: number;
    limit?: number;
  }): EnvironmentAgentCommandRecord[] {
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

  rebindPendingCommandsForThread(args: {
    threadId: string;
    sessionId: string;
    now?: number;
  }): number {
    return this.commands.rebindPendingForThread(args);
  }

  recordDeliveryAck(args: {
    sessionId: string;
    payload: EnvironmentAgentSessionCommandAckPayload;
    now?: number;
  }): RecordEnvironmentAgentCommandAckResult {
    const session = this.sessions.getById(args.sessionId);
    if (!session || session.status !== "active") {
      return {
        commands: [],
        ...(args.payload.deliveredThrough !== undefined
          ? { deliveredThrough: args.payload.deliveredThrough }
          : {}),
      };
    }

    const now = args.now ?? Date.now();
    const updatedCommands: EnvironmentAgentCommandRecord[] = [];
    for (const ack of args.payload.commands) {
      if (ack.channelId !== session.threadId) {
        continue;
      }

      const existing = this.commands.getById(ack.commandId);
      if (
        !existing ||
        existing.threadId !== session.threadId ||
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

    return {
      commands: updatedCommands,
      ...(args.payload.deliveredThrough !== undefined
        ? { deliveredThrough: args.payload.deliveredThrough }
        : {}),
    };
  }

  recordCommandResult(args: {
    sessionId: string;
    payload: EnvironmentAgentSessionCommandResultPayload;
    now?: number;
  }): EnvironmentAgentCommandRecord | undefined {
    const session = this.sessions.getById(args.sessionId);
    if (!session || session.status !== "active") {
      return undefined;
    }
    if (args.payload.channelId !== session.threadId) {
      return undefined;
    }

    const existing = this.commands.getById(args.payload.commandId);
    if (
      !existing ||
      existing.threadId !== session.threadId ||
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
      threadId: string;
      commandId: string;
      timeoutMs?: number;
      pollIntervalMs?: number;
      sentAt?: number;
    },
    command: EnvironmentAgentCommandRecord,
  ): Promise<EnvironmentAgentCommandRecord> {
    if (command.threadId !== args.threadId) {
      throw new Error(
        `Environment-agent command ${args.commandId} already belongs to thread ${command.threadId}`,
      );
    }

    switch (command.state) {
      case "completed":
      case "failed":
      case "cancelled":
        return command;
      case "queued":
      case "sent": {
        const session = await this.awaitActiveSession({
          threadId: args.threadId,
          timeoutMs: args.timeoutMs,
          pollIntervalMs: args.pollIntervalMs,
        });
        if (command.sessionId !== session.id) {
          this.rebindPendingCommandsForThread({
            threadId: args.threadId,
            sessionId: session.id,
            now: args.sentAt,
          });
        }
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
}
