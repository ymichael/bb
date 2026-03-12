import type {
  EnvironmentAgentSessionCloseReason,
  EnvironmentAgentSessionRecord,
  EnvironmentAgentSessionRepository,
} from "@beanbag/db";

export interface OpenEnvironmentAgentSessionInput {
  threadId: string;
  agentId: string;
  agentInstanceId: string;
  protocolVersion: number;
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

  openSession(args: OpenEnvironmentAgentSessionInput): {
    replaced?: EnvironmentAgentSessionRecord;
    active: EnvironmentAgentSessionRecord;
  } {
    const now = args.now ?? Date.now();
    return this.sessions.replaceActiveForThread({
      threadId: args.threadId,
      now,
      nextSession: {
        threadId: args.threadId,
        agentId: args.agentId,
        agentInstanceId: args.agentInstanceId,
        protocolVersion: args.protocolVersion,
        controlBaseUrl: args.controlBaseUrl,
        controlAuthToken: args.controlAuthToken,
        leaseExpiresAt: now + args.leaseTtlMs,
      },
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
