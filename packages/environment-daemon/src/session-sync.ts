import type { EnvironmentDaemonCommand } from "./protocol.js";
import type {
  EnvironmentDaemonCommandReceiptRecord,
  EnvironmentDaemonSessionStateRecord,
} from "./session-store.js";
import type { EnvironmentDaemonSessionRuntime } from "./session-runtime.js";
import type {
  EnvironmentDaemonSessionCommandAckItem,
  EnvironmentDaemonSessionOpenPayload,
  EnvironmentDaemonSessionProviderResponsePayload,
  EnvironmentDaemonSessionWelcomeMessage,
} from "./session-protocol.js";
import { compareEnvironmentDaemonSessionCursors } from "./session-protocol.js";
import type { EnvironmentDaemonSessionHttpClient } from "./session-http-client.js";

export interface EnvironmentDaemonSessionSyncOptions {
  runtime: EnvironmentDaemonSessionRuntime;
  client: EnvironmentDaemonSessionHttpClient;
}

export interface EnvironmentDaemonPulledCommand {
  threadId: string;
  commandId: string;
  commandCursor: number;
  command: EnvironmentDaemonCommand;
  ackState: EnvironmentDaemonSessionCommandAckItem["state"];
}

export interface FlushEnvironmentDaemonEventBatchResult {
  sessionId: string;
  channelResults: Array<{
    threadId: string;
    acknowledged: boolean;
    resetCursor?: {
      generation: number;
      sequence: number;
    };
  }>;
}

export class EnvironmentDaemonSessionSync {
  constructor(private readonly options: EnvironmentDaemonSessionSyncOptions) {}

  async openSession(args: {
    threadId: string;
    payload: EnvironmentDaemonSessionOpenPayload;
  }): Promise<EnvironmentDaemonSessionWelcomeMessage> {
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

  bindWelcomeChannels(args: {
    welcome: EnvironmentDaemonSessionWelcomeMessage;
    agentId: string;
    agentInstanceId: string;
    now?: number;
  }): void {
    const now = args.now ?? args.welcome.sentAt;
    for (const channel of args.welcome.payload.channels) {
      const existing = this.options.runtime.loadThreadState(channel.channelId);
      if (!existing) {
        this.options.runtime.initializeThread({
          threadId: channel.channelId,
          agentId: args.agentId,
          agentInstanceId: args.agentInstanceId,
          generation: Math.max(1, channel.applyFrom.generation),
          now,
        });
      }
      this.options.runtime.bindSession({
        threadId: channel.channelId,
        sessionId: args.welcome.sessionId,
        now,
      });
      this.options.runtime.alignEventCursor(
        channel.channelId,
        {
          generation: channel.applyFrom.generation,
          sequence: channel.applyFrom.sequenceExclusive,
        },
        now,
      );
    }
  }

  async sendHeartbeat(threadIds: readonly string[]): Promise<void> {
    const state = this.requireSessionState(threadIds[0]!);
    await this.options.client.heartbeat(state.sessionId, {
      agentObservedAt: Date.now(),
      outboxDepth: threadIds.reduce(
        (count, threadId) =>
          count + (this.options.runtime.getPendingEventBatch({ threadId })?.events.length ?? 0),
        0,
      ),
      channels: threadIds.map((threadId) => {
        const channelState = this.requireSessionState(threadId);
        const pendingBatch = this.options.runtime.getPendingEventBatch({ threadId });
        return {
          channelId: threadId,
          ...(pendingBatch?.events.length
            ? {
                lastSent: {
                  generation: pendingBatch.generation,
                  sequence: pendingBatch.events[pendingBatch.events.length - 1]!.sequence,
                },
              }
            : {}),
          ...(channelState.lastAcked ? { lastAcked: channelState.lastAcked } : {}),
        };
      }),
    });
  }

  async flushPendingEvents(
    threadIds: readonly string[],
  ): Promise<FlushEnvironmentDaemonEventBatchResult> {
    const state = this.requireSessionState(threadIds[0]!);
    const batches = threadIds
      .map((threadId) => this.options.runtime.getPendingEventBatch({ threadId }))
      .filter((batch) => batch !== undefined);
    if (batches.length === 0) {
      return {
        sessionId: state.sessionId,
        channelResults: threadIds.map((threadId) => ({
          threadId,
          acknowledged: true,
        })),
      };
    }

    const response = await this.options.client.pushEvents({
      sessionId: state.sessionId,
      payload: { batches },
    });
    return {
      sessionId: state.sessionId,
      channelResults: batches.map((batch) => {
        const ack = response.payload.channels.find(
          (channel) => channel.channelId === batch.channelId,
        );
        if (!ack) {
          return { threadId: batch.channelId, acknowledged: true };
        }
        const batchTail = {
          generation: batch.generation,
          sequence: batch.events[batch.events.length - 1]!.sequence,
        };
        if (compareEnvironmentDaemonSessionCursors(ack.ackedThrough, batchTail) < 0) {
          return {
            threadId: batch.channelId,
            acknowledged: false,
            resetCursor: ack.ackedThrough,
          };
        }
        this.options.runtime.acknowledgeEvents({
          threadId: batch.channelId,
          generation: ack.ackedThrough.generation,
          sequence: ack.ackedThrough.sequence,
          ackedAt: response.sentAt,
        });
        return { threadId: batch.channelId, acknowledged: true };
      }),
    };
  }

  async pullCommands(args: {
    threadIds: readonly string[];
    afterCursor?: number;
    limit?: number;
    waitMs?: number;
    signal?: AbortSignal;
  }): Promise<EnvironmentDaemonPulledCommand[]> {
    const state = this.requireSessionState(args.threadIds[0]!);
    const batch = await this.options.client.pullCommands({
      sessionId: state.sessionId,
      ...(args.afterCursor !== undefined && args.threadIds.length === 1
        ? { afterCursor: args.afterCursor }
        : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      ...(args.waitMs !== undefined ? { waitMs: args.waitMs } : {}),
      ...(args.signal ? { signal: args.signal } : {}),
    });

    const pulled = batch.payload.commands
      .map((command) => {
        this.ensureChannelState({
          threadId: command.channelId,
          sessionId: state.sessionId,
          agentId: state.agentId,
          agentInstanceId: state.agentInstanceId,
          now: batch.sentAt,
        });
        const received = this.options.runtime.receiveCommand({
          commandId: command.commandId,
          threadId: command.channelId,
          commandCursor: command.commandCursor,
          commandType: command.command.type,
          now: batch.sentAt,
        });
        this.options.runtime.setLastDeliveredCommandCursor({
          threadId: command.channelId,
          commandCursor: command.commandCursor,
          now: batch.sentAt,
        });
        return {
          threadId: command.channelId,
          commandId: command.commandId,
          commandCursor: command.commandCursor,
          command: command.command,
          ackState: received.ackState,
        } satisfies EnvironmentDaemonPulledCommand;
      });

    if (pulled.length > 0) {
      await this.options.client.acknowledgeCommands(state.sessionId, {
        commands: pulled.map((command) => ({
          commandId: command.commandId,
          channelId: command.threadId,
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

  private ensureChannelState(args: {
    threadId: string;
    sessionId: string;
    agentId: string;
    agentInstanceId: string;
    now: number;
  }): void {
    const existing = this.options.runtime.loadThreadState(args.threadId);
    if (!existing) {
      this.options.runtime.initializeThread({
        threadId: args.threadId,
        agentId: args.agentId,
        agentInstanceId: args.agentInstanceId,
        generation: 1,
        now: args.now,
      });
      this.options.runtime.bindSession({
        threadId: args.threadId,
        sessionId: args.sessionId,
        now: args.now,
      });
      return;
    }
    if (!existing.sessionId) {
      this.options.runtime.bindSession({
        threadId: args.threadId,
        sessionId: args.sessionId,
        now: args.now,
      });
    }
  }

  async closeSession(
    threadId: string,
    reason: "agent_shutdown" | "server_shutdown" | "migration" | "internal_error",
  ): Promise<void> {
    const state = this.requireSessionState(threadId);
    await this.options.client.closeSession(state.sessionId, reason);
  }

  async forwardProviderRequest(args: {
    threadId: string;
    requestId: string | number;
    method: string;
    params?: unknown;
    providerId?: string;
    normalizedMethod?: string;
    toolCall?: import("@bb/core").ProviderToolCallRequest;
  }): Promise<EnvironmentDaemonSessionProviderResponsePayload> {
    const state = this.requireSessionState(args.threadId);
    const response = await this.options.client.sendProviderRequest({
      sessionId: state.sessionId,
      payload: {
        requestId: args.requestId,
        method: args.method,
        ...(args.params !== undefined ? { params: args.params } : {}),
        ...(args.providerId ? { providerId: args.providerId } : {}),
        ...(args.normalizedMethod
          ? { normalizedMethod: args.normalizedMethod }
          : {}),
        ...(args.toolCall ? { toolCall: args.toolCall } : {}),
        channelId: args.threadId,
      },
    });
    return response.payload;
  }

  async flushPendingCommandResults(threadId: string): Promise<EnvironmentDaemonCommandReceiptRecord[]> {
    const state = this.requireSessionState(threadId);
    const pending = this.options.runtime.getPendingCommandResults(threadId);
    const sent: EnvironmentDaemonCommandReceiptRecord[] = [];

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

  async flushPendingCommandResultsForThreads(
    threadIds: readonly string[],
  ): Promise<EnvironmentDaemonCommandReceiptRecord[]> {
    const sent: EnvironmentDaemonCommandReceiptRecord[] = [];
    for (const threadId of threadIds) {
      sent.push(...await this.flushPendingCommandResults(threadId));
    }
    return sent;
  }

  private requireSessionState(
    threadId: string,
  ): EnvironmentDaemonSessionStateRecord & {
    sessionId: string;
  } {
    const state = this.options.runtime.loadThreadState(threadId);
    if (!state?.sessionId) {
      throw new Error(`Missing bound session for thread ${threadId}`);
    }
    return state as EnvironmentDaemonSessionStateRecord & { sessionId: string };
  }
}
