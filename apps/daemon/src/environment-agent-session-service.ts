import { randomUUID } from "node:crypto";
import type {
  EnvironmentAgentCursorPosition,
  EnvironmentAgentCursorRepository,
  EnvironmentAgentSessionRecord,
} from "@beanbag/db";
import {
  ENVIRONMENT_AGENT_SESSION_PROTOCOL,
  ENVIRONMENT_AGENT_SESSION_PROTOCOL_VERSION,
  ENVIRONMENT_AGENT_PROTOCOL_VERSION,
  type EnvironmentAgentSessionCommandAckPayload,
  type EnvironmentAgentSessionCommandBatchMessage,
  type EnvironmentAgentSessionCommandResultPayload,
  type EnvironmentAgentSessionEventAckMessage,
  type EnvironmentAgentSessionEventBatchPayload,
  type EnvironmentAgentSessionHeartbeatPayload,
  type EnvironmentAgentSessionOpenPayload,
  type EnvironmentAgentSessionWelcomeMessage,
  type EnvironmentAgentStatusSnapshot,
} from "@beanbag/environment-agent";
import type { EnvironmentAgentCommandDispatcher } from "./environment-agent-command-dispatcher.js";
import type { EnvironmentAgentEventApplier } from "./environment-agent-event-applier.js";
import { inactiveSessionError, invalidRequestError } from "./domain-errors.js";
import { decodePersistedEnvironmentAgentCommand } from "./environment-agent-command-decoder.js";
import { EnvironmentAgentSessionManager } from "./environment-agent-session-manager.js";

export interface EnvironmentAgentSessionServiceOptions {
  leaseTtlMs?: number;
  heartbeatIntervalMs?: number;
  commandLongPollTimeoutMs?: number;
  commandLongPollIntervalMs?: number;
  clock?: () => number;
  commandDispatcher?: EnvironmentAgentCommandDispatcher;
  eventApplier?: EnvironmentAgentEventApplier;
  onSessionInvalidated?: (session: EnvironmentAgentSessionRecord) => void;
}

const DEFAULT_LEASE_TTL_MS = 30_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_COMMAND_LONG_POLL_TIMEOUT_MS = 10_000;
const DEFAULT_COMMAND_LONG_POLL_INTERVAL_MS = 100;

function cursorForReply(args: {
  threadId: string;
  batchGeneration: number;
  acknowledgedCursor?: EnvironmentAgentCursorPosition;
  daemonCursor?: EnvironmentAgentCursorPosition;
}): EnvironmentAgentCursorPosition {
  if (args.acknowledgedCursor) {
    return args.acknowledgedCursor;
  }
  if (args.daemonCursor) {
    return args.daemonCursor;
  }
  return {
    generation: args.batchGeneration,
    sequence: 0,
  };
}

function inactiveEnvironmentAgentSessionError(sessionId: string): Error {
  return inactiveSessionError(`Environment-agent session ${sessionId} is not active`);
}

function isSessionLeaseActive(
  session: Pick<EnvironmentAgentSessionRecord, "status" | "leaseExpiresAt">,
  now: number,
): boolean {
  return session.status === "active" && session.leaseExpiresAt > now;
}

function normalizeCommandLongPollWaitMs(args: {
  requestedWaitMs?: number;
  maxWaitMs: number;
}): number {
  if (!Number.isFinite(args.requestedWaitMs)) {
    return args.maxWaitMs;
  }
  return Math.max(
    0,
    Math.min(args.maxWaitMs, Math.floor(args.requestedWaitMs ?? args.maxWaitMs)),
  );
}

function createAbortError(): Error {
  const error = new Error("Operation aborted");
  error.name = "AbortError";
  return error;
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return;
  }
  if (signal?.aborted) {
    throw createAbortError();
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(createAbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class EnvironmentAgentSessionService {
  private readonly clock: () => number;
  private readonly leaseTtlMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly commandLongPollTimeoutMs: number;
  private readonly commandLongPollIntervalMs: number;
  private readonly commandDispatcher?: EnvironmentAgentCommandDispatcher;
  private readonly eventApplier?: EnvironmentAgentEventApplier;
  private readonly onSessionInvalidated?: (
    session: EnvironmentAgentSessionRecord,
  ) => void;

  constructor(
    private readonly sessions: EnvironmentAgentSessionManager,
    private readonly cursors: EnvironmentAgentCursorRepository,
    options: EnvironmentAgentSessionServiceOptions = {},
  ) {
    this.clock = options.clock ?? (() => Date.now());
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    this.heartbeatIntervalMs =
      options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.commandLongPollTimeoutMs =
      options.commandLongPollTimeoutMs ?? DEFAULT_COMMAND_LONG_POLL_TIMEOUT_MS;
    this.commandLongPollIntervalMs =
      options.commandLongPollIntervalMs ?? DEFAULT_COMMAND_LONG_POLL_INTERVAL_MS;
    this.commandDispatcher = options.commandDispatcher;
    this.eventApplier = options.eventApplier;
    this.onSessionInvalidated = options.onSessionInvalidated;
  }

  private invalidateSession(session: EnvironmentAgentSessionRecord): void {
    this.commandDispatcher?.invalidateCommandsForSession(session, this.clock());
    this.onSessionInvalidated?.(session);
  }

  openSession(args: {
    threadId: string;
    payload: EnvironmentAgentSessionOpenPayload;
    now?: number;
  }): {
    session: EnvironmentAgentSessionRecord;
    replaced?: EnvironmentAgentSessionRecord;
    welcome: EnvironmentAgentSessionWelcomeMessage;
  } {
    const now = args.now ?? this.clock();
    if (
      !args.payload.supportedProtocolVersions.includes(
        ENVIRONMENT_AGENT_SESSION_PROTOCOL_VERSION,
      )
    ) {
      throw new Error("No compatible environment-agent session protocol version");
    }

    const channel = args.payload.channels.find(
      (candidate) => candidate.channelId === args.threadId,
    );
    if (!channel) {
      throw new Error(
        `Missing environment-agent channel bootstrap for thread ${args.threadId}`,
      );
    }
    if (args.payload.channels.length !== 1) {
      throw new Error("Multi-channel environment-agent sessions are not supported yet");
    }

    const opened = this.sessions.openSession({
      threadId: args.threadId,
      agentId: args.payload.agentId,
      agentInstanceId: args.payload.agentInstanceId,
      protocolVersion: ENVIRONMENT_AGENT_SESSION_PROTOCOL_VERSION,
      controlBaseUrl: args.payload.controlEndpoint?.baseUrl,
      controlAuthToken: args.payload.controlEndpoint?.authToken,
      leaseTtlMs: this.leaseTtlMs,
      now,
    });
    if (opened.replaced) {
      this.invalidateSession(opened.replaced);
    }

    let cursor = this.cursors.getByThreadId(args.threadId);
    if (cursor && channel.lastDaemonAcked === undefined) {
      // A fresh environment-agent process has no local delivery state, so the
      // daemon cursor must be reset to accept the restarted event stream.
      this.cursors.deleteByThreadId(args.threadId);
      cursor = undefined;
    }
    return {
      ...(opened.replaced ? { replaced: opened.replaced } : {}),
      session: opened.active,
      welcome: {
        protocol: ENVIRONMENT_AGENT_SESSION_PROTOCOL,
        type: "session_welcome",
        messageId: randomUUID(),
        sessionId: opened.active.id,
        sentAt: now,
        payload: {
          leaseTtlMs: this.leaseTtlMs,
          heartbeatIntervalMs: this.heartbeatIntervalMs,
          protocolVersion: ENVIRONMENT_AGENT_SESSION_PROTOCOL_VERSION,
          channels: [
            {
              channelId: args.threadId,
              applyFrom: {
                generation: cursor?.generation ?? channel.generation,
                sequenceExclusive: cursor?.sequence ?? 0,
              },
            },
          ],
        },
      },
    };
  }

  recordHeartbeat(args: {
    threadId: string;
    sessionId: string;
    payload: EnvironmentAgentSessionHeartbeatPayload;
    now?: number;
  }): EnvironmentAgentSessionRecord {
    const now = args.now ?? this.clock();
    this.requireActiveSession(args.threadId, args.sessionId, now);
    const heartbeat = this.sessions.recordHeartbeat({
      sessionId: args.sessionId,
      leaseTtlMs: this.leaseTtlMs,
      now,
    });
    if (!heartbeat) {
      throw inactiveEnvironmentAgentSessionError(args.sessionId);
    }
    if (heartbeat.threadId !== args.threadId) {
      throw invalidRequestError(
        `Environment-agent session ${args.sessionId} does not belong to thread ${args.threadId}`,
      );
    }
    if (!isSessionLeaseActive(heartbeat, now)) {
      throw inactiveEnvironmentAgentSessionError(args.sessionId);
    }

    return heartbeat;
  }

  closeSession(args: {
    threadId: string;
    sessionId: string;
    reason: "agent_shutdown" | "daemon_shutdown" | "migration" | "internal_error";
    now?: number;
  }): EnvironmentAgentSessionRecord {
    this.requireActiveSession(args.threadId, args.sessionId);
    const closed = this.sessions.closeSession({
      sessionId: args.sessionId,
      reason: args.reason,
      now: args.now,
    });
    if (!closed) {
      throw new Error(`Unknown environment-agent session: ${args.sessionId}`);
    }
    this.invalidateSession(closed);
    return closed;
  }

  retireActiveSessionForThread(args: {
    threadId: string;
    reason: "daemon_shutdown" | "migration" | "internal_error";
    now?: number;
  }): EnvironmentAgentSessionRecord | undefined {
    const now = args.now ?? this.clock();
    const active = this.sessions.getActiveSessionByThreadId(args.threadId, now);
    if (!active) {
      return undefined;
    }

    const closed = this.sessions.closeSession({
      sessionId: active.id,
      reason: args.reason,
      now,
    });
    if (!closed) {
      return undefined;
    }

    this.commandDispatcher?.invalidateCommandsForSession(closed, now);
    return closed;
  }

  expireLeases(now?: number): EnvironmentAgentSessionRecord[] {
    const expired = this.sessions.expireLeases(now);
    for (const session of expired) {
      this.invalidateSession(session);
    }
    return expired;
  }

  getThreadStatus(threadId: string): EnvironmentAgentStatusSnapshot {
    const session = this.sessions.getActiveSessionByThreadId(threadId, this.clock());
    if (!session) {
      throw new Error(`No active environment-agent session for thread ${threadId}`);
    }

    const cursor = this.cursors.getByThreadId(threadId);
    return {
      protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
      threadId,
      latestSequence: cursor?.sequence ?? 0,
      ...(cursor ? { lastAckedSequence: cursor.sequence } : {}),
      connectedToDaemon: true,
      pendingEventCount: 0,
      pendingCommandCount: this.commandDispatcher?.getPendingCommandCount(threadId) ?? 0,
      deliveryState: "healthy",
      retryAttemptCount: 0,
    };
  }

  applyEventBatch(args: {
    threadId: string;
    sessionId: string;
    payload: EnvironmentAgentSessionEventBatchPayload;
    now?: number;
  }): Promise<EnvironmentAgentSessionEventAckMessage> {
    if (!this.eventApplier) {
      throw new Error("Environment-agent session event apply is unavailable");
    }

    const session = this.requireActiveSession(args.threadId, args.sessionId);
    const now = args.now ?? this.clock();
    const daemonCursor = this.cursors.getByThreadId(args.threadId);
    if (args.payload.batches.length !== 1) {
      throw new Error("Multi-channel environment-agent event batches are not supported yet");
    }

    const batch = args.payload.batches[0]!;
    return this.eventApplier.applyChannelBatch({
      threadId: args.threadId,
      batch,
      now,
    }).then((result) => {
      if (result.blockedReason === "gap") {
        const ackedThrough = cursorForReply({
          threadId: args.threadId,
          batchGeneration: batch.generation,
          acknowledgedCursor: result.acknowledgedCursor,
          daemonCursor: daemonCursor
            ? { generation: daemonCursor.generation, sequence: daemonCursor.sequence }
            : undefined,
        });
        return {
          protocol: ENVIRONMENT_AGENT_SESSION_PROTOCOL,
          type: "event_ack",
          messageId: randomUUID(),
          sessionId: session.id,
          sentAt: now,
          payload: {
            channels: [
              {
                channelId: args.threadId,
                ackedThrough,
              },
            ],
          },
        };
      }

      if (result.blockedReason === "invalid_channel") {
        throw new Error(`Environment-agent batch channel mismatch for thread ${args.threadId}`);
      }

      return {
        protocol: ENVIRONMENT_AGENT_SESSION_PROTOCOL,
        type: "event_ack",
        messageId: randomUUID(),
        sessionId: session.id,
        sentAt: now,
        payload: {
          channels: [
            {
              channelId: args.threadId,
              ackedThrough: cursorForReply({
                threadId: args.threadId,
                batchGeneration: batch.generation,
                acknowledgedCursor: result.acknowledgedCursor,
                daemonCursor: daemonCursor
                  ? { generation: daemonCursor.generation, sequence: daemonCursor.sequence }
                  : undefined,
              }),
            },
          ],
        },
      };
    });
  }

  listCommands(args: {
    threadId: string;
    sessionId: string;
    afterCursor?: number;
    limit?: number;
    now?: number;
  }): EnvironmentAgentSessionCommandBatchMessage {
    if (!this.commandDispatcher) {
      throw new Error("Environment-agent session command dispatch is unavailable");
    }

    const session = this.requireActiveSession(args.threadId, args.sessionId);
    const now = args.now ?? this.clock();
    const records = this.commandDispatcher.listDeliverableCommandRecords({
      sessionId: session.id,
      afterCursor: args.afterCursor,
      limit: args.limit,
    });

    return {
      protocol: ENVIRONMENT_AGENT_SESSION_PROTOCOL,
      type: "command_batch",
      messageId: randomUUID(),
      sessionId: args.sessionId,
      sentAt: now,
      payload: {
        commands: records
          .filter((record) => record.threadId === args.threadId)
          .map((record) => ({
            channelId: record.threadId,
            commandCursor: record.commandCursor,
            commandId: record.id,
            createdAt: record.createdAt,
            command: decodePersistedEnvironmentAgentCommand({
              commandType: record.commandType,
              payload: record.payload,
            }),
          })),
      },
    };
  }

  async waitForCommands(args: {
    threadId: string;
    sessionId: string;
    afterCursor?: number;
    limit?: number;
    waitMs?: number;
    signal?: AbortSignal;
  }): Promise<EnvironmentAgentSessionCommandBatchMessage> {
    const waitMs = normalizeCommandLongPollWaitMs({
      requestedWaitMs: args.waitMs,
      maxWaitMs: this.commandLongPollTimeoutMs,
    });
    const deadline = Date.now() + waitMs;

    while (true) {
      const response = this.listCommands({
        threadId: args.threadId,
        sessionId: args.sessionId,
        ...(args.afterCursor !== undefined ? { afterCursor: args.afterCursor } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      });
      if (response.payload.commands.length > 0 || Date.now() >= deadline) {
        return response;
      }
      await delay(
        Math.min(this.commandLongPollIntervalMs, Math.max(deadline - Date.now(), 0)),
        args.signal,
      );
    }
  }

  recordCommandAck(args: {
    threadId: string;
    sessionId: string;
    payload: EnvironmentAgentSessionCommandAckPayload;
    now?: number;
  }): void {
    if (!this.commandDispatcher) {
      throw new Error("Environment-agent session command dispatch is unavailable");
    }

    const session = this.requireActiveSession(args.threadId, args.sessionId);
    this.commandDispatcher.recordDeliveryAck({
      sessionId: session.id,
      payload: args.payload,
      now: args.now,
    });
  }

  recordCommandResult(args: {
    threadId: string;
    sessionId: string;
    payload: EnvironmentAgentSessionCommandResultPayload;
    now?: number;
  }): void {
    if (!this.commandDispatcher) {
      throw new Error("Environment-agent session command dispatch is unavailable");
    }

    const session = this.requireSession(args.threadId, args.sessionId);
    this.commandDispatcher.recordCommandResult({
      sessionId: session.id,
      payload: args.payload,
      now: args.now,
    });
  }

  private requireSession(
    threadId: string,
    sessionId: string,
  ): EnvironmentAgentSessionRecord {
    const session = this.sessions.getSession(sessionId);
    if (!session) {
      throw inactiveEnvironmentAgentSessionError(sessionId);
    }
    if (session.threadId !== threadId) {
      throw invalidRequestError(
        `Environment-agent session ${sessionId} does not belong to thread ${threadId}`,
      );
    }
    return session;
  }

  private requireActiveSession(
    threadId: string,
    sessionId: string,
    now: number = this.clock(),
  ): EnvironmentAgentSessionRecord {
    const session = this.requireSession(threadId, sessionId);
    if (!isSessionLeaseActive(session, now)) {
      throw inactiveEnvironmentAgentSessionError(sessionId);
    }
    return session;
  }
}
