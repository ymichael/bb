import {
  getEnvironment,
  getHost,
  getNonDestroyedHost,
  getProject,
  getSessionById,
  getThread,
  listPublicHosts,
  type HostDaemonSessionRow,
} from "@bb/db";
import type { Environment, Host } from "@bb/domain";
import type { DbConnection } from "@bb/db";
import type { NotificationHub } from "../../ws/hub.js";
import { ApiError } from "../../errors.js";
import {
  destroyedHostUnavailableDetails,
  destroyedThreadEnvironmentDetails,
  disconnectedHostUnavailableDetails,
  throwEnvironmentNotReady,
  throwHostUnavailable,
  throwProjectUnavailable,
  throwThreadEnvironmentUnavailable,
  threadEnvironmentUnavailableDetails,
} from "./lifecycle-api-errors.js";

type HostRow = NonNullable<ReturnType<typeof getHost>>;
type ProjectRow = NonNullable<ReturnType<typeof getProject>>;
type ThreadRow = NonNullable<ReturnType<typeof getThread>>;
type StandardProject = ProjectRow & { kind: "standard" };
type HostLookupHub = Pick<NotificationHub, "getDaemonSessionIdForHost">;

interface HostLookupDeps {
  db: DbConnection;
  hub: HostLookupHub;
}

interface ThreadEnvironmentLookupResult {
  environment: Environment;
  thread: ThreadRow;
}

export function findHostDataDir(
  deps: HostLookupDeps,
  hostId: string,
): string | null {
  return getOpenDaemonSessionForHost(deps, hostId)?.dataDir ?? null;
}

function getOpenDaemonSessionForHost(
  deps: HostLookupDeps,
  hostId: string,
): HostDaemonSessionRow | null {
  const sessionId = deps.hub.getDaemonSessionIdForHost(hostId);
  if (!sessionId) {
    return null;
  }

  const session = getSessionById(deps.db, { sessionId });
  if (!session || session.hostId !== hostId || session.status !== "active") {
    return null;
  }
  return session;
}

function toHostStatus(deps: HostLookupDeps, hostId: string): Host["status"] {
  const host = getNonDestroyedHost(deps.db, hostId);
  if (!host) {
    return "disconnected";
  }

  return getOpenDaemonSessionForHost(deps, hostId)
    ? "connected"
    : "disconnected";
}

function toHostRecord(row: HostRow, status: Host["status"]): Host {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    status,
    maxPermissionMode: row.maxPermissionMode,
    lastSeenAt: row.lastSeenAt,
    lastRejectedProtocolVersion: row.lastRejectedProtocolVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function throwHostNotFound(): never {
  throw new ApiError(404, "host_not_found", "Host not found");
}

function isStandardProject(project: ProjectRow): project is StandardProject {
  return project.kind === "standard";
}

export function listPublicHostsWithStatus(deps: HostLookupDeps): Host[] {
  const rows = listPublicHosts(deps.db);

  return rows.map((row) =>
    toHostRecord(
      row,
      getOpenDaemonSessionForHost(deps, row.id) ? "connected" : "disconnected",
    ),
  );
}

export function requireNonDestroyedHostWithStatus(
  deps: HostLookupDeps,
  hostId: string,
): Host {
  const host = getHost(deps.db, hostId);
  if (!host) {
    throwHostNotFound();
  }
  if (host.destroyedAt !== null) {
    throwHostUnavailable(
      404,
      "Host is unavailable",
      destroyedHostUnavailableDetails(host.destroyedAt),
    );
  }
  return toHostRecord(host, toHostStatus(deps, host.id));
}

export function getNonDestroyedHostWithStatus(
  deps: HostLookupDeps,
  hostId: string,
): Host | null {
  const host = getNonDestroyedHost(deps.db, hostId);
  if (!host) {
    return null;
  }
  return toHostRecord(host, toHostStatus(deps, host.id));
}

export function requireConnectedHostSession(
  deps: HostLookupDeps,
  hostId: string,
) {
  const session = getOpenDaemonSessionForHost(deps, hostId);
  if (!session) {
    const host = getHost(deps.db, hostId);
    if (!host) {
      throwHostNotFound();
    }
    if (host.destroyedAt !== null) {
      throwHostUnavailable(
        404,
        "Host is unavailable",
        destroyedHostUnavailableDetails(host.destroyedAt),
      );
    }
    const hostStatus = toHostStatus(deps, hostId);
    throwHostUnavailable(
      502,
      "Host is not connected",
      disconnectedHostUnavailableDetails(hostStatus),
    );
  }
  return session;
}

export function requireProject(
  db: DbConnection,
  projectId: string,
): ProjectRow {
  const project = getProject(db, projectId);
  if (!project) {
    throw new ApiError(404, "project_not_found", "Project not found");
  }
  return project;
}

export function requirePublicProject(
  db: DbConnection,
  projectId: string,
): ProjectRow {
  const project = requireProject(db, projectId);
  if (project.deletedAt !== null) {
    throwProjectUnavailable({
      reason: "pending_deletion",
      deletedAt: project.deletedAt,
    });
  }
  return project;
}

export function requirePublicStandardProject(
  db: DbConnection,
  projectId: string,
): StandardProject {
  const project = requirePublicProject(db, projectId);
  if (!isStandardProject(project)) {
    throw new ApiError(404, "project_not_found", "Project not found");
  }
  return project;
}

function requireThread(db: DbConnection, threadId: string): ThreadRow {
  const thread = getThread(db, threadId);
  if (!thread) {
    throw new ApiError(404, "thread_not_found", "Thread not found");
  }
  return thread;
}

export function requirePublicThread(
  db: DbConnection,
  threadId: string,
): ThreadRow {
  const thread = requireThread(db, threadId);
  const project = getProject(db, thread.projectId);
  if (thread.deletedAt !== null || project?.deletedAt !== null) {
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
    throwEnvironmentNotReady(environment);
  }
  return {
    ...environment,
    path: environment.path,
    status: "ready",
  };
}

function requireEnvironmentForThread(
  db: DbConnection,
  thread: ThreadRow,
): Environment {
  if (!thread.environmentId) {
    throwThreadEnvironmentUnavailable(
      threadEnvironmentUnavailableDetails("never_attached", null),
    );
  }
  return requireEnvironment(db, thread.environmentId);
}

function ensureThreadEnvironmentAvailable(environment: Environment): void {
  const unavailableDetails = destroyedThreadEnvironmentDetails(environment);
  if (unavailableDetails) {
    throwThreadEnvironmentUnavailable(unavailableDetails);
  }
}

function requireThreadEnvironmentAllowingDestroyed(
  db: DbConnection,
  threadId: string,
): ThreadEnvironmentLookupResult {
  const thread = requireThread(db, threadId);
  return {
    thread,
    environment: requireEnvironmentForThread(db, thread),
  };
}

export function requireThreadEnvironment(
  db: DbConnection,
  threadId: string,
): ThreadEnvironmentLookupResult {
  const result = requireThreadEnvironmentAllowingDestroyed(db, threadId);
  ensureThreadEnvironmentAvailable(result.environment);
  return result;
}

function requirePublicThreadEnvironmentAllowingDestroyed(
  db: DbConnection,
  threadId: string,
): ThreadEnvironmentLookupResult {
  const thread = requirePublicThread(db, threadId);
  return {
    thread,
    environment: requireEnvironmentForThread(db, thread),
  };
}

export function requirePublicThreadEnvironment(
  db: DbConnection,
  threadId: string,
): ThreadEnvironmentLookupResult {
  const result = requirePublicThreadEnvironmentAllowingDestroyed(db, threadId);
  ensureThreadEnvironmentAvailable(result.environment);
  return result;
}
