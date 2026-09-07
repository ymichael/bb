import { describe, expect, it } from "vitest";
import {
  createConnection,
  createEnvironment,
  createProject,
  createThread,
  migrate,
  markProjectDeleted,
  noopNotifier,
  updateHost,
  upsertHost,
  type DbConnection,
} from "@bb/db";
import type { Host, Project } from "@bb/domain";
import { makeHost } from "@bb/test-helpers/domain-fixtures";
import { ApiError } from "../../src/errors.js";
import { NotificationHub } from "../../src/ws/hub.js";
import {
  requireConnectedHostSession,
  requireNonDestroyedHostWithStatus,
  requirePublicProject,
  requireReadyEnvironment,
  requireThreadEnvironment,
} from "../../src/services/lib/entity-lookup.js";

interface SetupResult {
  db: DbConnection;
  host: Host;
  hub: NotificationHub;
  project: Project;
}

type ThrowingCallback = () => void;

function setup(): SetupResult {
  const db = createConnection(":memory:");
  migrate(db);
  const hub = new NotificationHub();
  const hostRow = upsertHost(db, noopNotifier, {
    id: "host_entity_lookup",
    name: "Entity Lookup Host",
    type: "persistent",
  });
  const { project } = createProject(db, noopNotifier, {
    name: "Entity Lookup Project",
    source: {
      type: "local_path",
      hostId: hostRow.id,
      path: "/tmp/entity-lookup",
    },
  });
  const host = makeHost({
    id: hostRow.id,
    name: hostRow.name,
    type: hostRow.type,
    status: "disconnected",
    maxPermissionMode: hostRow.maxPermissionMode,
    lastSeenAt: hostRow.lastSeenAt,
    createdAt: hostRow.createdAt,
    updatedAt: hostRow.updatedAt,
  });
  return { db, host, hub, project };
}

function captureApiError(callback: ThrowingCallback): ApiError {
  try {
    callback();
  } catch (error) {
    if (error instanceof ApiError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected ApiError");
}

describe("entity lookup lifecycle errors", () => {
  it("returns structured environment_not_ready details", () => {
    const { db, host, project } = setup();
    try {
      const environment = createEnvironment(db, noopNotifier, {
        hostId: host.id,
        projectId: project.id,
        workspaceProvisionType: "managed-worktree",
        path: null,
        status: "destroyed",
      });

      const error = captureApiError(() => {
        requireReadyEnvironment(db, environment.id);
      });

      expect(error.status).toBe(409);
      expect(error.body).toEqual({
        code: "environment_not_ready",
        message: "Environment unavailable",
        details: {
          environmentStatus: "destroyed",
          hasPath: false,
        },
      });
    } finally {
      db.$client.close();
    }
  });

  it("returns structured thread_environment_unavailable details", () => {
    const { db, host, project } = setup();
    try {
      const unattachedThread = createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
      });
      const unattachedError = captureApiError(() => {
        requireThreadEnvironment(db, unattachedThread.id);
      });
      expect(unattachedError.body).toEqual({
        code: "thread_environment_unavailable",
        message: "Thread environment is unavailable",
        details: {
          reason: "never_attached",
          environmentStatus: null,
        },
      });

      const environment = createEnvironment(db, noopNotifier, {
        hostId: host.id,
        projectId: project.id,
        workspaceProvisionType: "managed-worktree",
        path: null,
        status: "destroyed",
      });
      const destroyedEnvironmentThread = createThread(db, noopNotifier, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "codex",
      });
      const destroyedError = captureApiError(() => {
        requireThreadEnvironment(db, destroyedEnvironmentThread.id);
      });
      expect(destroyedError.body).toEqual({
        code: "thread_environment_unavailable",
        message: "Thread environment is unavailable",
        details: {
          reason: "destroyed",
          environmentStatus: "destroyed",
        },
      });
    } finally {
      db.$client.close();
    }
  });

  it("returns structured host_unavailable details", () => {
    const { db, host, hub } = setup();
    try {
      const disconnectedError = captureApiError(() => {
        requireConnectedHostSession({ db, hub }, host.id);
      });
      expect(disconnectedError.status).toBe(502);
      expect(disconnectedError.body).toEqual({
        code: "host_unavailable",
        message: "Host is not connected",
        details: {
          reason: "disconnected",
          hostStatus: "disconnected",
          suspendedAt: null,
          destroyedAt: null,
        },
      });

      updateHost(db, noopNotifier, host.id, { destroyedAt: 456 });
      const destroyedError = captureApiError(() => {
        requireNonDestroyedHostWithStatus({ db, hub }, host.id);
      });
      expect(destroyedError.status).toBe(404);
      expect(destroyedError.body).toEqual({
        code: "host_unavailable",
        message: "Host is unavailable",
        details: {
          reason: "destroyed",
          hostStatus: null,
          suspendedAt: null,
          destroyedAt: 456,
        },
      });
    } finally {
      db.$client.close();
    }
  });

  it("returns project_unavailable for pending project deletion", () => {
    const { db, project } = setup();
    try {
      markProjectDeleted(db, noopNotifier, {
        deletedAt: 123,
        projectId: project.id,
      });

      const error = captureApiError(() => {
        requirePublicProject(db, project.id);
      });

      expect(error.status).toBe(404);
      expect(error.body).toEqual({
        code: "project_unavailable",
        message: "Project is unavailable",
        details: {
          reason: "pending_deletion",
          deletedAt: 123,
        },
      });
    } finally {
      db.$client.close();
    }
  });

  it("returns project_unavailable for repeated project deletion", () => {
    const { db, project } = setup();
    try {
      markProjectDeleted(db, noopNotifier, {
        deletedAt: 123,
        projectId: project.id,
      });
      const repeated = markProjectDeleted(db, noopNotifier, {
        deletedAt: 456,
        projectId: project.id,
      });
      expect(repeated).toBeNull();

      const error = captureApiError(() => {
        requirePublicProject(db, project.id);
      });

      expect(error.status).toBe(404);
      expect(error.body).toEqual({
        code: "project_unavailable",
        message: "Project is unavailable",
        details: {
          reason: "pending_deletion",
          deletedAt: 123,
        },
      });
    } finally {
      db.$client.close();
    }
  });
});
