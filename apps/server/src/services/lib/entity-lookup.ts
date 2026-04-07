import {
  getActiveSession,
  getEnvironment,
  getNonDestroyedHost,
  getMostRecentlyUpdatedConnectedHostId,
  getProject,
  getProjectOperation,
  getThread,
  listConnectedHostIds,
  listHostThreadIds as listHostThreadIdsFromDb,
  listPublicHosts,
} from "@bb/db";
import type { Environment, Host, Project, Thread } from "@bb/domain";
import type { DbConnection } from "@bb/db";
import { ApiError } from "../../errors.js";

function toHostStatus(db: DbConnection, hostId: string): Host["status"] {
  const session = getActiveSession(db, hostId);
  return session ? "connected" : "disconnected";
}

function toHostRecord(
  row: NonNullable<ReturnType<typeof getNonDestroyedHost>>,
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

function throwHostNotFound(): never {
  throw new ApiError(404, "host_not_found", "Host not found");
}

export function listPublicHostsWithStatus(db: DbConnection): Host[] {
  const rows = listPublicHosts(db);
  const connectedHostIds = new Set(listConnectedHostIds(db));

  return rows.map((row) =>
    toHostRecord(
      row,
      connectedHostIds.has(row.id) ? "connected" : "disconnected",
    ),
  );
}

export function requireNonDestroyedHostWithStatus(
  db: DbConnection,
  hostId: string,
): Host {
  const host = getNonDestroyedHost(db, hostId);
  if (!host) {
    throwHostNotFound();
  }
  return toHostRecord(host, toHostStatus(db, host.id));
}

export function requireConnectedHostSession(
  deps: Pick<{ db: DbConnection }, "db">,
  hostId: string,
) {
  const session = getActiveSession(deps.db, hostId);
  if (!session) {
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

export function requirePublicProject(
  db: DbConnection,
  projectId: string,
): Project {
  const project = requireProject(db, projectId);
  if (
    getProjectOperation(db, {
      projectId,
      kind: "delete",
    }) !== null
  ) {
    throw new ApiError(404, "project_not_found", "Project not found");
  }
  return project;
}

function requireThread(db: DbConnection, threadId: string): Thread {
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
  const hostId = getMostRecentlyUpdatedConnectedHostId(db);
  if (!hostId) {
    throw new ApiError(502, "host_disconnected", "Host is not connected");
  }
  return hostId;
}

export function listHostThreadIds(
  db: DbConnection,
  hostId: string,
): string[] {
  return listHostThreadIdsFromDb(db, { hostId });
}
