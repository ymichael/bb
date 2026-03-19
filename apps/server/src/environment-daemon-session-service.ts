import { randomUUID } from "node:crypto";
import type { ProviderToolCallResponse } from "@bb/core";
import type {
  EnvironmentDaemonCursorPosition,
  EnvironmentDaemonCursorRepository,
  EnvironmentDaemonSessionRecord,
} from "@bb/db";
import {
  ENVIRONMENT_DAEMON_SESSION_PROTOCOL,
  ENVIRONMENT_DAEMON_PROTOCOL_VERSION,
  ENVIRONMENT_DAEMON_SESSION_SUPPORTED_PROTOCOL_VERSIONS,
  negotiateEnvironmentDaemonSessionCapabilities,
  selectEnvironmentDaemonSessionProtocolVersion,
  type EnvironmentDaemonSessionCapabilities,
  type EnvironmentDaemonSessionCommandAckPayload,
  type EnvironmentDaemonSessionCommandBatchMessage,
  type EnvironmentDaemonSessionCommandResultPayload,
  type EnvironmentDaemonSessionEventAckMessage,
  type EnvironmentDaemonSessionEventBatchPayload,
  type EnvironmentDaemonSessionHeartbeatPayload,
  type EnvironmentDaemonSessionOpenPayload,
  type EnvironmentDaemonSessionProviderRequestPayload,
  type EnvironmentDaemonSessionProviderResponseMessage,
  type EnvironmentDaemonSessionWelcomeMessage,
  type EnvironmentDaemonStatusSnapshot,
} from "@bb/environment-daemon";
import type { EnvironmentDaemonCommandDispatcher } from "./environment-daemon-command-dispatcher.js";
import type { EnvironmentDaemonEventApplier } from "./environment-daemon-event-applier.js";
import { inactiveSessionError, invalidRequestError } from "./domain-errors.js";
import { decodePersistedEnvironmentDaemonCommand } from "./environment-daemon-command-decoder.js";
import { EnvironmentDaemonSessionManager } from "./environment-daemon-session-manager.js";

export interface EnvironmentDaemonSessionServiceOptions {
  leaseTtlMs?: number;
  heartbeatIntervalMs?: number;
  commandLongPollTimeoutMs?: number;
  commandLongPollIntervalMs?: number;
  clock?: () => number;
  commandDispatcher?: EnvironmentDaemonCommandDispatcher;
  eventApplier?: EnvironmentDaemonEventApplier;
  providerRequestHandler?: (args: {
    threadId: string;
    request: EnvironmentDaemonSessionProviderRequestPayload;
  }) => Promise<
    | { result: unknown }
    | { toolCallResponse: ProviderToolCallResponse }
    | { errorCode?: string; errorMessage: string }
  >;
  listAttachedThreadIds?: (environmentId: string) => string[];
  onSessionInvalidated?: (session: EnvironmentDaemonSessionRecord) => void;
}

const DEFAULT_LEASE_TTL_MS = 30_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_COMMAND_LONG_POLL_TIMEOUT_MS = 10_000;
const DEFAULT_COMMAND_LONG_POLL_INTERVAL_MS = 100;

function cursorForReply(args: {
  batchGeneration: number;
  acknowledgedCursor?: EnvironmentDaemonCursorPosition;
  serverCursor?: EnvironmentDaemonCursorPosition;
}): EnvironmentDaemonCursorPosition {
  if (args.acknowledgedCursor) {
    return args.acknowledgedCursor;
  }
  if (args.serverCursor) {
    return args.serverCursor;
  }
  return {
    generation: args.batchGeneration,
    sequence: 0,
  };
}

function inactiveEnvironmentDaemonSessionError(sessionId: string): Error {
  return inactiveSessionError(`Environment-daemon session ${sessionId} is not active`);
}

function isSessionLeaseActive(
  session: Pick<EnvironmentDaemonSessionRecord, "status" | "leaseExpiresAt">,
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

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
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

export class EnvironmentDaemonSessionService {
  private readonly clock: () => number;
  private readonly leaseTtlMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly commandLongPollTimeoutMs: number;
  private readonly commandLongPollIntervalMs: number;
  private readonly commandDispatcher?: EnvironmentDaemonCommandDispatcher;
  private readonly eventApplier?: EnvironmentDaemonEventApplier;
  private readonly providerRequestHandler?: (
    args: {
      threadId: string;
      request: EnvironmentDaemonSessionProviderRequestPayload;
    },
  ) => Promise<
    | { result: unknown }
    | { toolCallResponse: ProviderToolCallResponse }
    | { errorCode?: string; errorMessage: string }
  >;
  private readonly onSessionInvalidated?: (
    session: EnvironmentDaemonSessionRecord,
  ) => void;
  private readonly listAttachedThreadIds?: (environmentId: string) => string[];

  constructor(
    private readonly sessions: EnvironmentDaemonSessionManager,
    private readonly cursors: EnvironmentDaemonCursorRepository,
    options: EnvironmentDaemonSessionServiceOptions = {},
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
    this.providerRequestHandler = options.providerRequestHandler;
    this.listAttachedThreadIds = options.listAttachedThreadIds;
    this.onSessionInvalidated = options.onSessionInvalidated;
  }

  private listAllowedChannelIds(environmentId: string): string[] {
    const attachedThreadIds = this.listAttachedThreadIds?.(environmentId) ?? [];
    return attachedThreadIds;
  }

  private isAllowedChannelId(environmentId: string, channelId: string): boolean {
    return this.listAllowedChannelIds(environmentId).includes(channelId);
  }

  private invalidateSession(session: EnvironmentDaemonSessionRecord): void {
    this.commandDispatcher?.invalidateCommandsForSession(session, this.clock());
    this.onSessionInvalidated?.(session);
  }

  openSession(args: {
    environmentId: string;
    payload: EnvironmentDaemonSessionOpenPayload;
    now?: number;
  }): {
    session: EnvironmentDaemonSessionRecord;
    replaced?: EnvironmentDaemonSessionRecord;
    welcome: EnvironmentDaemonSessionWelcomeMessage;
  } {
    const now = args.now ?? this.clock();
    const selectedProtocolVersion = selectEnvironmentDaemonSessionProtocolVersion({
      supportedByServer: ENVIRONMENT_DAEMON_SESSION_SUPPORTED_PROTOCOL_VERSIONS,
      supportedByAgent: args.payload.supportedProtocolVersions,
    });
    if (selectedProtocolVersion === undefined) {
      throw new Error("No compatible environment-daemon session protocol version");
    }

    const allowedChannelIds = this.listAllowedChannelIds(args.environmentId);
    const requestedChannelIds = args.payload.channels.map((channel) => channel.channelId);
    if (hasDuplicates(requestedChannelIds)) {
      throw invalidRequestError("Environment-daemon session open payload contains duplicate channels");
    }
    const invalidChannelId = requestedChannelIds.find(
      (channelId) => !allowedChannelIds.includes(channelId),
    );
    if (invalidChannelId) {
      throw invalidRequestError(
        `Environment-daemon session open payload contains unattached channel ${invalidChannelId}`,
      );
    }

    const selectedCapabilities: EnvironmentDaemonSessionCapabilities =
      negotiateEnvironmentDaemonSessionCapabilities({
        requested: args.payload.capabilities,
        fallback: {
          worker: args.payload.worker,
          providers: args.payload.providers,
          controlEndpoint: args.payload.controlEndpoint,
        },
      });
    const opened = this.sessions.openSession({
      environmentId: args.environmentId,
      agentId: args.payload.agentId,
      agentInstanceId: args.payload.agentInstanceId,
      protocolVersion: selectedProtocolVersion,
      workerName: args.payload.worker?.name,
      workerVersion: args.payload.worker?.version,
      workerBuildId: args.payload.worker?.buildId,
      ...(args.payload.providers !== undefined
        ? { providerMetadata: args.payload.providers }
        : {}),
      selectedCapabilities,
      controlBaseUrl: args.payload.controlEndpoint?.baseUrl,
      controlAuthToken: args.payload.controlEndpoint?.authToken,
      leaseTtlMs: this.leaseTtlMs,
      now,
    });
    if (opened.replaced) {
      this.invalidateSession(opened.replaced);
    }

    const bootstrapByChannelId = new Map(
      args.payload.channels.map((bootstrap) => [bootstrap.channelId, bootstrap] as const),
    );
    return {
      ...(opened.replaced ? { replaced: opened.replaced } : {}),
      session: opened.active,
      welcome: {
        protocol: ENVIRONMENT_DAEMON_SESSION_PROTOCOL,
        type: "session_welcome",
        messageId: randomUUID(),
        sessionId: opened.active.id,
        sentAt: now,
        payload: {
          leaseTtlMs: this.leaseTtlMs,
          heartbeatIntervalMs: this.heartbeatIntervalMs,
          protocolVersion: selectedProtocolVersion,
          selectedCapabilities,
          channels: allowedChannelIds.map((channelId) => {
            const bootstrap = bootstrapByChannelId.get(channelId);
            let cursor = this.cursors.getByThreadId(channelId);
            if (cursor && bootstrap?.lastServerAcked === undefined) {
              this.cursors.deleteByThreadId(channelId);
              cursor = undefined;
            }
            return {
              channelId,
              applyFrom: {
                generation: cursor?.generation ?? bootstrap?.generation ?? 1,
                sequenceExclusive: cursor?.sequence ?? 0,
              },
            };
          }),
        },
      },
    };
  }

  recordHeartbeat(args: {
    environmentId: string;
    sessionId: string;
    payload: EnvironmentDaemonSessionHeartbeatPayload;
    now?: number;
  }): EnvironmentDaemonSessionRecord {
    const now = args.now ?? this.clock();
    this.requireActiveSession(args.environmentId, args.sessionId, now);
    const heartbeat = this.sessions.recordHeartbeat({
      sessionId: args.sessionId,
      leaseTtlMs: this.leaseTtlMs,
      now,
    });
    if (!heartbeat) {
      throw inactiveEnvironmentDaemonSessionError(args.sessionId);
    }
    if (!isSessionLeaseActive(heartbeat, now)) {
      throw inactiveEnvironmentDaemonSessionError(args.sessionId);
    }

    return heartbeat;
  }

  closeSession(args: {
    environmentId: string;
    sessionId: string;
    reason: "agent_shutdown" | "server_shutdown" | "migration" | "internal_error";
    now?: number;
  }): EnvironmentDaemonSessionRecord {
    this.requireActiveSession(args.environmentId, args.sessionId);
    const closed = this.sessions.closeSession({
      sessionId: args.sessionId,
      reason: args.reason,
      now: args.now,
    });
    if (!closed) {
      throw new Error(`Unknown environment-daemon session: ${args.sessionId}`);
    }
    this.invalidateSession(closed);
    return closed;
  }

  retireActiveSessionForEnvironment(args: {
    environmentId: string;
    reason: "server_shutdown" | "migration" | "internal_error";
    now?: number;
  }): EnvironmentDaemonSessionRecord | undefined {
    const now = args.now ?? this.clock();
    const active = this.sessions.getActiveSessionByEnvironmentId(args.environmentId, now);
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

  expireLeases(now?: number): EnvironmentDaemonSessionRecord[] {
    const expired = this.sessions.expireLeases(now);
    for (const session of expired) {
      this.invalidateSession(session);
    }
    return expired;
  }

  listSessions(environmentId: string): EnvironmentDaemonSessionRecord[] {
    return this.sessions.listSessionsByEnvironmentId(environmentId);
  }

  getEnvironmentStatus(environmentId: string, threadId: string): EnvironmentDaemonStatusSnapshot {
    const session = this.sessions.getActiveSessionByEnvironmentId(environmentId, this.clock());
    if (!session) {
      throw new Error(`No active environment-daemon session for environment ${environmentId}`);
    }

    const cursor = this.cursors.getByThreadId(threadId);
    return {
      protocolVersion: ENVIRONMENT_DAEMON_PROTOCOL_VERSION,
      threadId,
      latestSequence: cursor?.sequence ?? 0,
      ...(cursor ? { lastAckedSequence: cursor.sequence } : {}),
      connectedToServer: true,
      pendingEventCount: 0,
      pendingCommandCount: this.commandDispatcher?.getPendingCommandCount(threadId) ?? 0,
      deliveryState: "healthy",
      retryAttemptCount: 0,
    };
  }

  applyEventBatch(args: {
    environmentId: string;
    sessionId: string;
    payload: EnvironmentDaemonSessionEventBatchPayload;
    now?: number;
  }): Promise<EnvironmentDaemonSessionEventAckMessage> {
    const eventApplier = this.eventApplier;
    if (!eventApplier) {
      throw new Error("Environment-daemon session event apply is unavailable");
    }

    const session = this.requireActiveSession(args.environmentId, args.sessionId);
    const now = args.now ?? this.clock();
    return Promise.all(
      args.payload.batches.map(async (batch) => {
        if (!this.isAllowedChannelId(args.environmentId, batch.channelId)) {
          throw invalidRequestError(
            `Environment-daemon batch channel mismatch for thread ${batch.channelId}`,
          );
        }
        const serverCursor = this.cursors.getByThreadId(batch.channelId);
        const result = await eventApplier.applyChannelBatch({
          threadId: batch.channelId,
          batch,
          now,
        });
        if (result.blockedReason === "invalid_channel") {
          throw invalidRequestError(
            `Environment-daemon batch channel mismatch for thread ${batch.channelId}`,
          );
        }
        return {
          channelId: batch.channelId,
          ackedThrough: cursorForReply({
            batchGeneration: batch.generation,
            acknowledgedCursor: result.acknowledgedCursor,
            serverCursor: serverCursor
              ? { generation: serverCursor.generation, sequence: serverCursor.sequence }
              : undefined,
          }),
        };
      }),
    ).then((channels) => ({
      protocol: ENVIRONMENT_DAEMON_SESSION_PROTOCOL,
      type: "event_ack",
      messageId: randomUUID(),
      sessionId: session.id,
      sentAt: now,
      payload: {
        channels,
      },
    }));
  }

  listCommands(args: {
    environmentId: string;
    sessionId: string;
    afterCursor?: number;
    limit?: number;
    now?: number;
  }): EnvironmentDaemonSessionCommandBatchMessage {
    if (!this.commandDispatcher) {
      throw new Error("Environment-daemon session command dispatch is unavailable");
    }

    const session = this.requireActiveSession(args.environmentId, args.sessionId);
    const now = args.now ?? this.clock();
    const records = this.commandDispatcher.listDeliverableCommandRecords({
      sessionId: session.id,
      ...(this.listAllowedChannelIds(args.environmentId).length === 1 &&
      args.afterCursor !== undefined
        ? { afterCursor: args.afterCursor }
        : {}),
      limit: args.limit,
    });

    return {
      protocol: ENVIRONMENT_DAEMON_SESSION_PROTOCOL,
      type: "command_batch",
      messageId: randomUUID(),
      sessionId: args.sessionId,
      sentAt: now,
      payload: {
        commands: records.map((record) => ({
          channelId: record.threadId,
          commandCursor: record.commandCursor,
          commandId: record.id,
          createdAt: record.createdAt,
          command: decodePersistedEnvironmentDaemonCommand({
            commandType: record.commandType,
            payload: record.payload,
          }),
        })),
      },
    };
  }

  async waitForCommands(args: {
    environmentId: string;
    sessionId: string;
    afterCursor?: number;
    limit?: number;
    waitMs?: number;
    signal?: AbortSignal;
  }): Promise<EnvironmentDaemonSessionCommandBatchMessage> {
    const waitMs = normalizeCommandLongPollWaitMs({
      requestedWaitMs: args.waitMs,
      maxWaitMs: this.commandLongPollTimeoutMs,
    });
    const deadline = Date.now() + waitMs;

    while (true) {
      const response = this.listCommands({
        environmentId: args.environmentId,
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
    environmentId: string;
    sessionId: string;
    payload: EnvironmentDaemonSessionCommandAckPayload;
    now?: number;
  }): void {
    if (!this.commandDispatcher) {
      throw new Error("Environment-daemon session command dispatch is unavailable");
    }

    const session = this.requireActiveSession(args.environmentId, args.sessionId);
    this.commandDispatcher.recordDeliveryAck({
      sessionId: session.id,
      payload: args.payload,
      now: args.now,
    });
  }

  recordCommandResult(args: {
    environmentId: string;
    sessionId: string;
    payload: EnvironmentDaemonSessionCommandResultPayload;
    now?: number;
  }): void {
    if (!this.commandDispatcher) {
      throw new Error("Environment-daemon session command dispatch is unavailable");
    }

    const session = this.requireSession(args.environmentId, args.sessionId);
    this.commandDispatcher.recordCommandResult({
      sessionId: session.id,
      payload: args.payload,
      now: args.now,
    });
  }

  async handleProviderRequest(args: {
    environmentId: string;
    sessionId: string;
    payload: EnvironmentDaemonSessionProviderRequestPayload;
    now?: number;
  }): Promise<EnvironmentDaemonSessionProviderResponseMessage> {
    if (!this.providerRequestHandler) {
      throw new Error("Environment-daemon provider request handling is unavailable");
    }

    const session = this.requireActiveSession(args.environmentId, args.sessionId, args.now);
    const now = args.now ?? this.clock();

    const channelId = args.payload.channelId;
    if (!channelId || !this.isAllowedChannelId(args.environmentId, channelId)) {
      throw invalidRequestError(
        `Environment-daemon provider request missing or invalid channelId`,
      );
    }

    try {
      const response = await this.providerRequestHandler({
        threadId: channelId,
        request: args.payload,
      });
      return {
        protocol: ENVIRONMENT_DAEMON_SESSION_PROTOCOL,
        type: "provider_response",
        messageId: randomUUID(),
        sessionId: session.id,
        sentAt: now,
        payload: "result" in response
          ? {
              requestId: args.payload.requestId,
              ok: true,
              result: response.result,
            }
          : "toolCallResponse" in response
            ? {
                requestId: args.payload.requestId,
                ok: true,
                toolCallResponse: response.toolCallResponse,
              }
          : {
              requestId: args.payload.requestId,
              ok: false,
              ...(response.errorCode ? { errorCode: response.errorCode } : {}),
              errorMessage: response.errorMessage,
            },
      };
    } catch (error) {
      return {
        protocol: ENVIRONMENT_DAEMON_SESSION_PROTOCOL,
        type: "provider_response",
        messageId: randomUUID(),
        sessionId: session.id,
        sentAt: now,
        payload: {
          requestId: args.payload.requestId,
          ok: false,
          errorMessage: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  private requireSession(
    environmentId: string,
    sessionId: string,
  ): EnvironmentDaemonSessionRecord {
    const session = this.sessions.getSession(sessionId);
    if (!session) {
      throw inactiveEnvironmentDaemonSessionError(sessionId);
    }
    if (session.environmentId !== environmentId) {
      throw invalidRequestError(
        `Environment-daemon session ${sessionId} does not belong to environment ${environmentId}`,
      );
    }
    return session;
  }

  private requireActiveSession(
    environmentId: string,
    sessionId: string,
    now: number = this.clock(),
  ): EnvironmentDaemonSessionRecord {
    const session = this.requireSession(environmentId, sessionId);
    if (!isSessionLeaseActive(session, now)) {
      throw inactiveEnvironmentDaemonSessionError(sessionId);
    }
    return session;
  }
}
