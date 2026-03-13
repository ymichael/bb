import type { EnvironmentAgentCommand } from "./protocol.js";
import type {
  EnvironmentAgentCommandReceiptRecord,
} from "./session-store.js";
import type { EnvironmentAgentSessionRuntime } from "./session-runtime.js";
import type {
  EnvironmentAgentSessionCommandAckItem,
  EnvironmentAgentSessionOpenPayload,
  EnvironmentAgentSessionProviderResponsePayload,
  EnvironmentAgentSessionWelcomeMessage,
} from "./session-protocol.js";
import { compareEnvironmentAgentSessionCursors } from "./session-protocol.js";
import type { EnvironmentAgentSessionHttpClient } from "./session-http-client.js";

export interface EnvironmentAgentSessionSyncOptions {
  runtime: EnvironmentAgentSessionRuntime;
  client: EnvironmentAgentSessionHttpClient;
}

export interface EnvironmentAgentPulledCommand {
  commandId: string;
  commandCursor: number;
  command: EnvironmentAgentCommand;
  ackState: EnvironmentAgentSessionCommandAckItem["state"];
}

export interface FlushEnvironmentAgentEventBatchResult {
  sessionId: string;
  acknowledged: boolean;
  resetCursor?: {
    generation: number;
    sequence: number;
  };
}

export class EnvironmentAgentSessionSync {
  constructor(private readonly options: EnvironmentAgentSessionSyncOptions) {}

  async openSession(args: {
    threadId: string;
    payload: EnvironmentAgentSessionOpenPayload;
  }): Promise<EnvironmentAgentSessionWelcomeMessage> {
    const welcome = await this.options.client.openSession(args.payload);
    this.options.runtime.bindSession({
      threadId: args.threadId,
      sessionId: welcome.sessionId,
      now: welcome.sentAt,
    });
    const channel = welcome.payload.channels.find(
      (candidate) => candidate.channelId === args.threadId,
    );
    if (channel) {
      this.options.runtime.alignEventCursor(
        args.threadId,
        {
          generation: channel.applyFrom.generation,
          sequence: channel.applyFrom.sequenceExclusive,
        },
        welcome.sentAt,
      );
    }
    return welcome;
  }

  async sendHeartbeat(threadId: string): Promise<void> {
    const state = this.requireSessionState(threadId);
    const pendingBatch = this.options.runtime.getPendingEventBatch({ threadId });
    await this.options.client.heartbeat(state.sessionId, {
      agentObservedAt: Date.now(),
      outboxDepth: pendingBatch?.events.length ?? 0,
      channels: [
        {
          channelId: threadId,
          ...(pendingBatch?.events.length
            ? {
                lastSent: {
                  generation: pendingBatch.generation,
                  sequence: pendingBatch.events[pendingBatch.events.length - 1]!.sequence,
                },
              }
            : {}),
          ...(state.lastAcked ? { lastAcked: state.lastAcked } : {}),
        },
      ],
    });
  }

  async flushPendingEvents(threadId: string): Promise<FlushEnvironmentAgentEventBatchResult> {
    const state = this.requireSessionState(threadId);
    const batch = this.options.runtime.getPendingEventBatch({ threadId });
    if (!batch) {
      return {
        sessionId: state.sessionId,
        acknowledged: true,
      };
    }

    const response = await this.options.client.pushEvents({
      sessionId: state.sessionId,
      payload: { batches: [batch] },
    });
    const ack = response.payload.channels.find((channel) => channel.channelId === threadId);
    if (ack) {
      const batchTail = {
        generation: batch.generation,
        sequence: batch.events[batch.events.length - 1]!.sequence,
      };
      if (compareEnvironmentAgentSessionCursors(ack.ackedThrough, batchTail) < 0) {
        return {
          sessionId: state.sessionId,
          acknowledged: false,
          resetCursor: ack.ackedThrough,
        };
      }
      this.options.runtime.acknowledgeEvents({
        threadId,
        generation: ack.ackedThrough.generation,
        sequence: ack.ackedThrough.sequence,
        ackedAt: response.sentAt,
      });
    }

    return {
      sessionId: state.sessionId,
      acknowledged: true,
    };
  }

  async pullCommands(args: {
    threadId: string;
    afterCursor?: number;
    limit?: number;
    waitMs?: number;
    signal?: AbortSignal;
  }): Promise<EnvironmentAgentPulledCommand[]> {
    const state = this.requireSessionState(args.threadId);
    const batch = await this.options.client.pullCommands({
      sessionId: state.sessionId,
      ...(args.afterCursor !== undefined ? { afterCursor: args.afterCursor } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      ...(args.waitMs !== undefined ? { waitMs: args.waitMs } : {}),
      ...(args.signal ? { signal: args.signal } : {}),
    });

    const pulled = batch.payload.commands
      .filter((command) => command.channelId === args.threadId)
      .map((command) => {
        const received = this.options.runtime.receiveCommand({
          commandId: command.commandId,
          threadId: args.threadId,
          commandCursor: command.commandCursor,
          commandType: command.command.type,
          now: batch.sentAt,
        });
        this.options.runtime.setLastDeliveredCommandCursor({
          threadId: args.threadId,
          commandCursor: command.commandCursor,
          now: batch.sentAt,
        });
        return {
          commandId: command.commandId,
          commandCursor: command.commandCursor,
          command: command.command,
          ackState: received.ackState,
        } satisfies EnvironmentAgentPulledCommand;
      });

    if (pulled.length > 0) {
      await this.options.client.acknowledgeCommands(state.sessionId, {
        commands: pulled.map((command) => ({
          commandId: command.commandId,
          channelId: args.threadId,
          state: command.ackState,
        })),
      });
      for (const command of pulled) {
        if (command.ackState === "received") {
          this.options.runtime.markCommandAckReported(command.commandId, batch.sentAt);
        }
      }
    }

    return pulled;
  }

  async closeSession(
    threadId: string,
    reason: "agent_shutdown" | "daemon_shutdown" | "migration" | "internal_error",
  ): Promise<void> {
    const state = this.requireSessionState(threadId);
    await this.options.client.closeSession(state.sessionId, reason);
  }

  async forwardProviderRequest(args: {
    threadId: string;
    requestId: string | number;
    method: string;
    params?: unknown;
  }): Promise<EnvironmentAgentSessionProviderResponsePayload> {
    const state = this.requireSessionState(args.threadId);
    const response = await this.options.client.sendProviderRequest({
      sessionId: state.sessionId,
      payload: {
        requestId: args.requestId,
        method: args.method,
        ...(args.params !== undefined ? { params: args.params } : {}),
      },
    });
    return response.payload;
  }

  async flushPendingCommandResults(threadId: string): Promise<EnvironmentAgentCommandReceiptRecord[]> {
    const state = this.requireSessionState(threadId);
    const pending = this.options.runtime.getPendingCommandResults(threadId);
    const sent: EnvironmentAgentCommandReceiptRecord[] = [];

    for (const receipt of pending) {
      if (receipt.state === "received") {
        continue;
      }
      await this.options.client.sendCommandResult(state.sessionId, {
        commandId: receipt.commandId,
        channelId: threadId,
        state: receipt.state,
        ...(receipt.result !== undefined ? { result: receipt.result } : {}),
        ...(receipt.errorCode !== undefined ? { errorCode: receipt.errorCode } : {}),
        ...(receipt.errorMessage !== undefined ? { errorMessage: receipt.errorMessage } : {}),
      });
      const updated = this.options.runtime.markCommandResultReported({
        commandId: receipt.commandId,
        state: receipt.state,
      });
      if (updated) {
        sent.push(updated);
      }
    }

    return sent;
  }

  private requireSessionState(threadId: string): {
    threadId: string;
    sessionId: string;
    lastAcked?: { generation: number; sequence: number };
  } {
    const state = this.options.runtime.loadThreadState(threadId);
    if (!state?.sessionId) {
      throw new Error(`Missing bound session for thread ${threadId}`);
    }
    return {
      threadId: state.threadId,
      sessionId: state.sessionId,
      ...(state.lastAcked ? { lastAcked: state.lastAcked } : {}),
    };
  }
}
