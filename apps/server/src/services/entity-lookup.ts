import { and, desc, eq, gt } from "drizzle-orm";
import {
  environments,
  getActiveSession,
  getEnvironment,
  getHost,
  getProject,
  getThread,
  hostDaemonSessions,
  listHosts,
  threads,
} from "@bb/db";
import type { Environment, Host, Project, Thread } from "@bb/domain";
import type { DbConnection } from "@bb/db";
import { ApiError } from "../errors.js";

function toHostStatus(db: DbConnection, hostId: string): Host["status"] {
  const session = db
    .select({ id: hostDaemonSessions.id })
    .from(hostDaemonSessions)
    .where(
      and(
        eq(hostDaemonSessions.hostId, hostId),
        eq(hostDaemonSessions.status, "active"),
        gt(hostDaemonSessions.leaseExpiresAt, Date.now()),
      ),
    )
    .get();
  return session ? "connected" : "disconnected";
}

function toHostRecord(
  row: NonNullable<ReturnType<typeof getHost>>,
  status: Host["status"],
): Host {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    status,
    ...(row.provider ? { provider: row.provider } : {}),
    ...(row.externalId ? { externalId: row.externalId } : {}),
    lastSeenAt: row.lastSeenAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function listHostsWithStatus(db: DbConnection): Host[] {
  const rows = listHosts(db);
  const connectedHostIds = new Set(
    db
      .select({ hostId: hostDaemonSessions.hostId })
      .from(hostDaemonSessions)
      .where(
        and(
          eq(hostDaemonSessions.status, "active"),
          gt(hostDaemonSessions.leaseExpiresAt, Date.now()),
        ),
      )
      .all()
      .map((row) => row.hostId),
  );

  return rows.map((row) =>
    toHostRecord(
      row,
      connectedHostIds.has(row.id) ? "connected" : "disconnected",
    ),
  );
}

export function requireHostWithStatus(db: DbConnection, hostId: string): Host {
  const host = getHost(db, hostId);
  if (!host) {
    throw new ApiError(404, "host_not_found", "Host not found");
  }
  return toHostRecord(host, toHostStatus(db, host.id));
}

export function requireConnectedHostSession(
  deps: Pick<{ db: DbConnection }, "db">,
  hostId: string,
) {
  const session = getActiveSession(deps.db, hostId);
  if (!session || session.leaseExpiresAt <= Date.now()) {
    throw new ApiError(502, "host_disconnected", "Host is not connected");
  }
  return session;
}

export function requireProject(db: DbConnection, projectId: string): Project {
  const project = getProject(db, projectId);
  if (!project) {
    throw new ApiError(404, "project_not_found", "Project not found");
  }
  return project;
}

export function requireThread(db: DbConnection, threadId: string): Thread {
  const thread = getThread(db, threadId);
  if (!thread) {
    throw new ApiError(404, "thread_not_found", "Thread not found");
  }
  return thread;
}

export function requirePublicThread(
  db: DbConnection,
  threadId: string,
): Thread {
  const thread = requireThread(db, threadId);
  if (thread.deletedAt !== null) {
    throw new ApiError(404, "thread_not_found", "Thread not found");
  }
  return thread;
}

export function requireEnvironment(
  db: DbConnection,
  environmentId: string,
): Environment {
  const environment = getEnvironment(db, environmentId);
  if (!environment) {
    throw new ApiError(404, "environment_not_found", "Environment not found");
  }
  return environment;
}

export function requireReadyEnvironment(
  db: DbConnection,
  environmentId: string,
): Environment & { path: string; status: "ready" } {
  const environment = requireEnvironment(db, environmentId);
  if (environment.status !== "ready" || !environment.path) {
    throw new ApiError(409, "invalid_request", "Environment is not ready");
  }
  return {
    ...environment,
    path: environment.path,
    status: "ready",
  };
}

export function requireThreadEnvironment(
  db: DbConnection,
  threadId: string,
): { environment: Environment; thread: Thread } {
  const thread = requireThread(db, threadId);
  if (!thread.environmentId) {
    throw new ApiError(409, "invalid_request", "Thread has no environment");
  }
  return {
    thread,
    environment: requireEnvironment(db, thread.environmentId),
  };
}

export function requirePublicThreadEnvironment(
  db: DbConnection,
  threadId: string,
): { environment: Environment; thread: Thread } {
  const thread = requirePublicThread(db, threadId);
  if (!thread.environmentId) {
    throw new ApiError(409, "invalid_request", "Thread has no environment");
  }
  return {
    thread,
    environment: requireEnvironment(db, thread.environmentId),
  };
}

export function requireDefaultConnectedHostId(db: DbConnection): string {
  const session = db
    .select({ hostId: hostDaemonSessions.hostId })
    .from(hostDaemonSessions)
    .where(
      and(
        eq(hostDaemonSessions.status, "active"),
        gt(hostDaemonSessions.leaseExpiresAt, Date.now()),
      ),
    )
    .orderBy(desc(hostDaemonSessions.updatedAt))
    .limit(1)
    .get();
  if (!session) {
    throw new ApiError(502, "host_disconnected", "Host is not connected");
  }
  return session.hostId;
}

export function listHostThreadIds(
  db: DbConnection,
  hostId: string,
): string[] {
  return db
    .select({ id: threads.id })
    .from(threads)
    .innerJoin(environments, eq(threads.environmentId, environments.id))
    .where(eq(environments.hostId, hostId))
    .all()
    .map((row) => row.id);
}
