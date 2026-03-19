import type {
  EnvironmentDaemonSessionCloseReason,
  EnvironmentDaemonSessionRecord,
  EnvironmentDaemonSessionRepository,
} from "@bb/db";

export interface OpenEnvironmentDaemonSessionInput {
  environmentId: string;
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

export interface RecordEnvironmentDaemonHeartbeatInput {
  sessionId: string;
  leaseTtlMs: number;
  now?: number;
}

export interface CloseEnvironmentDaemonSessionInput {
  sessionId: string;
  reason: Exclude<
    EnvironmentDaemonSessionCloseReason,
    "lease_expired" | "newer_session"
  >;
  now?: number;
}

export class EnvironmentDaemonSessionManager {
  constructor(private readonly sessions: EnvironmentDaemonSessionRepository) {}

  getSession(sessionId: string): EnvironmentDaemonSessionRecord | undefined {
    return this.sessions.getById(sessionId);
  }

  getActiveSessionByEnvironmentId(
    environmentId: string,
    now?: number,
  ): EnvironmentDaemonSessionRecord | undefined {
    return this.sessions.getActiveByEnvironmentId(environmentId, now);
  }

  listSessionsByEnvironmentId(environmentId: string): EnvironmentDaemonSessionRecord[] {
    return this.sessions.listByEnvironmentId(environmentId);
  }

  openSession(args: OpenEnvironmentDaemonSessionInput): {
    replaced?: EnvironmentDaemonSessionRecord;
    active: EnvironmentDaemonSessionRecord;
  } {
    const now = args.now ?? Date.now();
    const existing = this.sessions.getActiveByEnvironmentId(args.environmentId, now);
    if (existing && existing.agentInstanceId === args.agentInstanceId) {
      return { active: existing };
    }
    return this.sessions.replaceActiveForEnvironment({
      environmentId: args.environmentId,
      now,
      nextSession: {
        environmentId: args.environmentId,
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
      },
    });
  }

  recordHeartbeat(
    args: RecordEnvironmentDaemonHeartbeatInput,
  ): EnvironmentDaemonSessionRecord | undefined {
    const now = args.now ?? Date.now();
    return this.sessions.touchHeartbeat({
      sessionId: args.sessionId,
      heartbeatAt: now,
      leaseExpiresAt: now + args.leaseTtlMs,
    });
  }

  closeSession(
    args: CloseEnvironmentDaemonSessionInput,
  ): EnvironmentDaemonSessionRecord | undefined {
    return this.sessions.markClosed(args);
  }

  expireLeases(now: number = Date.now()): EnvironmentDaemonSessionRecord[] {
    return this.sessions
      .listExpiringBefore(now)
      .flatMap((session) => {
        const expired = this.sessions.markExpired(session.id, now);
        return expired ? [expired] : [];
      });
  }
}
