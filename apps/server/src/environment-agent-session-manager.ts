import type {
  EnvironmentAgentSessionCloseReason,
  EnvironmentAgentSessionRecord,
  EnvironmentAgentSessionRepository,
} from "@bb/db";

export interface OpenEnvironmentAgentSessionInput {
  threadId: string;
  environmentId?: string;
  agentId: string;
  agentInstanceId: string;
  protocolVersion: number;
  workerName?: string;
  workerVersion?: string;
  workerBuildId?: string;
  providerMetadata?: unknown;
  selectedCapabilities?: unknown;
  controlBaseUrl?: string;
  controlAuthToken?: string;
  leaseTtlMs: number;
  now?: number;
}

export interface RecordEnvironmentAgentHeartbeatInput {
  sessionId: string;
  leaseTtlMs: number;
  now?: number;
}

export interface CloseEnvironmentAgentSessionInput {
  sessionId: string;
  reason: Exclude<
    EnvironmentAgentSessionCloseReason,
    "lease_expired" | "newer_session"
  >;
  now?: number;
}

export class EnvironmentAgentSessionManager {
  constructor(private readonly sessions: EnvironmentAgentSessionRepository) {}

  getSession(sessionId: string): EnvironmentAgentSessionRecord | undefined {
    return this.sessions.getById(sessionId);
  }

  getActiveSessionByThreadId(
    threadId: string,
    now?: number,
  ): EnvironmentAgentSessionRecord | undefined {
    return this.sessions.getActiveByThreadId(threadId, now);
  }

  getActiveSessionByEnvironmentId(
    environmentId: string,
    now?: number,
  ): EnvironmentAgentSessionRecord | undefined {
    return this.sessions.getActiveByEnvironmentId(environmentId, now);
  }

  listSessionsByThreadId(threadId: string): EnvironmentAgentSessionRecord[] {
    return this.sessions.listByThreadId(threadId);
  }

  listSessionsByEnvironmentId(environmentId: string): EnvironmentAgentSessionRecord[] {
    return this.sessions.listByEnvironmentId(environmentId);
  }

  openSession(args: OpenEnvironmentAgentSessionInput): {
    replaced?: EnvironmentAgentSessionRecord;
    active: EnvironmentAgentSessionRecord;
  } {
    const now = args.now ?? Date.now();
    if (args.environmentId) {
      const existing = this.sessions.getActiveByEnvironmentId(args.environmentId, now);
      if (existing && existing.agentInstanceId === args.agentInstanceId) {
        return { active: existing };
      }
    }
    const nextSession = {
      threadId: args.threadId,
      ...(args.environmentId ? { environmentId: args.environmentId } : {}),
      agentId: args.agentId,
      agentInstanceId: args.agentInstanceId,
      protocolVersion: args.protocolVersion,
      workerName: args.workerName,
      workerVersion: args.workerVersion,
      workerBuildId: args.workerBuildId,
      providerMetadata: args.providerMetadata,
      selectedCapabilities: args.selectedCapabilities,
      controlBaseUrl: args.controlBaseUrl,
      controlAuthToken: args.controlAuthToken,
      leaseExpiresAt: now + args.leaseTtlMs,
    };
    if (args.environmentId) {
      return this.sessions.replaceActiveForEnvironment({
        environmentId: args.environmentId,
        now,
        nextSession,
      });
    }
    return this.sessions.replaceActiveForThread({
      threadId: args.threadId,
      now,
      nextSession,
    });
  }

  recordHeartbeat(
    args: RecordEnvironmentAgentHeartbeatInput,
  ): EnvironmentAgentSessionRecord | undefined {
    const now = args.now ?? Date.now();
    return this.sessions.touchHeartbeat({
      sessionId: args.sessionId,
      heartbeatAt: now,
      leaseExpiresAt: now + args.leaseTtlMs,
    });
  }

  closeSession(
    args: CloseEnvironmentAgentSessionInput,
  ): EnvironmentAgentSessionRecord | undefined {
    return this.sessions.markClosed(args);
  }

  expireLeases(now: number = Date.now()): EnvironmentAgentSessionRecord[] {
    return this.sessions
      .listExpiringBefore(now)
      .flatMap((session) => {
        const expired = this.sessions.markExpired(session.id, now);
        return expired ? [expired] : [];
      });
  }
}
