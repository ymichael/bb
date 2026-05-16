import { eq } from "drizzle-orm";
import {
  deleteProject,
  getProject,
  getProjectOperation,
  listEnvironments,
  listProjectOperations,
  markThreadDeleted,
  threads,
  type DbQueryConnection,
} from "@bb/db";
import { upsertProjectOperationRecord } from "@bb/db/internal-lifecycle";
import type { Environment, ThreadStatus } from "@bb/domain";
import type {
  AppDeps,
  LoggedPendingInteractionWorkSessionDeps,
  ServerAppDeps,
} from "../../types.js";
import { deleteProjectAttachments } from "./attachments.js";
import {
  advanceEnvironmentCleanup,
  requestEnvironmentCleanup,
} from "../environments/environment-cleanup.js";
import { scheduleAfterDaemonIngressResponse } from "../hosts/command-wait-context.js";
import {
  finalizeStoppedThreadAndAdvanceCleanup,
  requestThreadStopIfNeeded,
} from "../threads/thread-lifecycle.js";
import { NotificationBuffer } from "../lib/notification-buffer.js";

export interface ProjectDeletionArgs {
  projectId: string;
}

interface ProjectDeletionThread {
  deletedAt: number | null;
  environmentId: string | null;
  id: string;
  status: ThreadStatus;
  stopRequestedAt: number | null;
}

interface ProjectDeletionThreadStopArgs {
  environmentsById: Map<string, Environment>;
  threads: ProjectDeletionThread[];
}

interface AdvanceProjectThreadsForDeletionArgs {
  environmentsById: Map<string, Environment>;
  projectId: string;
}

type ProjectDeletionDeps = LoggedPendingInteractionWorkSessionDeps &
  Pick<ServerAppDeps, "terminalSessions">;

function isProjectDeletionActive(
  deps: Pick<AppDeps, "db">,
  projectId: string,
): boolean {
  return (
    getProjectOperation(deps.db, {
      projectId,
      kind: "delete",
    }) !== null
  );
}

function listProjectDeletionThreads(
  db: DbQueryConnection,
  args: ProjectDeletionArgs,
): ProjectDeletionThread[] {
  return db
    .select({
      deletedAt: threads.deletedAt,
      environmentId: threads.environmentId,
      id: threads.id,
      status: threads.status,
      stopRequestedAt: threads.stopRequestedAt,
    })
    .from(threads)
    .where(eq(threads.projectId, args.projectId))
    .all();
}

function mapEnvironmentsById(
  environments: Environment[],
): Map<string, Environment> {
  return new Map(
    environments.map((environment) => [environment.id, environment]),
  );
}

function requestProjectThreadStopsForDeletion(
  deps: Pick<AppDeps, "db" | "hub">,
  args: ProjectDeletionThreadStopArgs,
): void {
  for (const thread of args.threads) {
    const environment = thread.environmentId
      ? (args.environmentsById.get(thread.environmentId) ?? null)
      : null;
    if (environment) {
      requestThreadStopIfNeeded(deps, thread, environment);
    }
  }
}

function tombstoneProjectThreadsForDeletion(
  deps: Pick<AppDeps, "db" | "hub">,
  args: ProjectDeletionArgs,
): ProjectDeletionThread[] {
  const notificationBuffer = new NotificationBuffer();
  const projectThreads = deps.db.transaction(
    (tx) => {
      upsertProjectOperationRecord(tx, {
        projectId: args.projectId,
        kind: "delete",
        payload: JSON.stringify({}),
      });

      const threadsForDeletion = listProjectDeletionThreads(tx, args);
      for (const thread of threadsForDeletion) {
        if (thread.deletedAt === null) {
          markThreadDeleted(tx, notificationBuffer, { threadId: thread.id });
        }
      }
      return threadsForDeletion;
    },
    { behavior: "immediate" },
  );
  notificationBuffer.flushInto(deps.hub);
  return projectThreads;
}

async function advanceProjectThreadsForDeletion(
  deps: ProjectDeletionDeps,
  args: AdvanceProjectThreadsForDeletionArgs,
): Promise<void> {
  const projectThreads = listProjectDeletionThreads(deps.db, {
    projectId: args.projectId,
  });

  for (const thread of projectThreads) {
    const environment = thread.environmentId
      ? (args.environmentsById.get(thread.environmentId) ?? null)
      : null;

    if (thread.deletedAt === null) {
      markThreadDeleted(deps.db, deps.hub, { threadId: thread.id });
    }
    deps.terminalSessions.closeDeletedThreadTerminals({ threadId: thread.id });
    if (environment) {
      requestThreadStopIfNeeded(deps, thread, environment);
    }
    await finalizeStoppedThreadAndAdvanceCleanup(deps, {
      cancelPendingCommand: false,
      threadId: thread.id,
    });
  }
}

function hasRemainingProjectThreads(
  deps: Pick<AppDeps, "db">,
  projectId: string,
): boolean {
  return (
    deps.db
      .select({ id: threads.id })
      .from(threads)
      .where(eq(threads.projectId, projectId))
      .get() !== undefined
  );
}

function hasRemainingManagedEnvironments(environments: Environment[]): boolean {
  return environments.some(
    (environment) => environment.managed && environment.status !== "destroyed",
  );
}

export function beginProjectDeletion(
  deps: Pick<AppDeps, "db" | "hub">,
  args: ProjectDeletionArgs,
): void {
  if (!getProject(deps.db, args.projectId)) {
    return;
  }

  const projectEnvironments = listEnvironments(deps.db, args.projectId);
  const projectThreads = tombstoneProjectThreadsForDeletion(deps, args);
  requestProjectThreadStopsForDeletion(deps, {
    environmentsById: mapEnvironmentsById(projectEnvironments),
    threads: projectThreads,
  });
}

export function requestProjectDeletionAdvance(
  deps: ProjectDeletionDeps,
  args: ProjectDeletionArgs,
): void {
  scheduleAfterDaemonIngressResponse({
    context: {
      projectId: args.projectId,
    },
    logger: deps.logger,
    name: "Project deletion advance request",
    work: async () => {
      await advanceProjectDeletion(deps, args);
    },
  });
}

export async function advanceProjectDeletion(
  deps: ProjectDeletionDeps,
  args: ProjectDeletionArgs,
): Promise<boolean> {
  if (!isProjectDeletionActive(deps, args.projectId)) {
    return false;
  }

  if (!getProject(deps.db, args.projectId)) {
    return true;
  }

  const projectEnvironments = listEnvironments(deps.db, args.projectId);
  const environmentsById = mapEnvironmentsById(projectEnvironments);

  await advanceProjectThreadsForDeletion(deps, {
    environmentsById,
    projectId: args.projectId,
  });

  for (const environment of projectEnvironments) {
    if (!environment.managed || environment.status === "destroyed") {
      continue;
    }

    requestEnvironmentCleanup(deps, {
      environmentId: environment.id,
    });
    await advanceEnvironmentCleanup(deps, {
      environmentId: environment.id,
    });
  }

  const refreshedEnvironments = listEnvironments(deps.db, args.projectId);
  if (
    hasRemainingProjectThreads(deps, args.projectId) ||
    hasRemainingManagedEnvironments(refreshedEnvironments)
  ) {
    return false;
  }

  deleteProject(deps.db, deps.hub, args.projectId);
  await deleteProjectAttachments(deps.config.dataDir, args.projectId);
  return true;
}

export function listProjectsPendingDeletion(
  deps: Pick<AppDeps, "db">,
): string[] {
  return listProjectOperations(deps.db, {
    kind: "delete",
  }).map((operation) => operation.projectId);
}
