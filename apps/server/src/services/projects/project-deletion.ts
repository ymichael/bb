import { eq } from "drizzle-orm";
import {
  deleteProject,
  getProject,
  getProjectOperation,
  listEnvironments,
  listProjectOperations,
  markThreadDeleted,
  threads,
} from "@bb/db";
import { upsertProjectOperationRecord } from "@bb/db/internal-lifecycle";
import type { Environment } from "@bb/domain";
import type { AppDeps, PendingInteractionWorkSessionDeps } from "../../types.js";
import { deleteProjectAttachments } from "./attachments.js";
import {
  advanceEnvironmentCleanup,
  requestEnvironmentCleanup,
} from "../environments/environment-cleanup.js";
import {
  finalizeStoppedThread,
  requestThreadStopIfNeeded,
} from "../threads/thread-lifecycle.js";

export interface ProjectDeletionArgs {
  projectId: string;
}

function isProjectDeletionActive(
  deps: Pick<AppDeps, "db">,
  projectId: string,
): boolean {
  return getProjectOperation(deps.db, {
    projectId,
    kind: "delete",
  }) !== null;
}

async function advanceProjectThreadsForDeletion(
  deps: PendingInteractionWorkSessionDeps,
  args: {
    environmentsById: Map<string, Environment>;
    projectId: string;
  },
): Promise<void> {
  const projectThreads = deps.db
    .select({
      deletedAt: threads.deletedAt,
      environmentId: threads.environmentId,
      id: threads.id,
      projectId: threads.projectId,
      status: threads.status,
      stopRequestedAt: threads.stopRequestedAt,
    })
    .from(threads)
    .where(eq(threads.projectId, args.projectId))
    .all();

  for (const thread of projectThreads) {
    const environment = thread.environmentId
      ? args.environmentsById.get(thread.environmentId) ?? null
      : null;

    if (thread.deletedAt === null) {
      markThreadDeleted(deps.db, deps.hub, { threadId: thread.id });
    }
    if (environment) {
      requestThreadStopIfNeeded(deps, thread, environment);
    }
    await finalizeStoppedThread(deps, {
      threadId: thread.id,
      cancelPendingCommand: false,
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

function hasRemainingManagedEnvironments(
  environments: Environment[],
): boolean {
  return environments.some((environment) =>
    environment.managed && environment.status !== "destroyed"
  );
}

export function requestProjectDeletion(
  deps: Pick<AppDeps, "db">,
  args: ProjectDeletionArgs,
): void {
  if (!getProject(deps.db, args.projectId)) {
    return;
  }

  upsertProjectOperationRecord(deps.db, {
    projectId: args.projectId,
    kind: "delete",
    payload: JSON.stringify({}),
  });
}

export async function advanceProjectDeletion(
  deps: PendingInteractionWorkSessionDeps,
  args: ProjectDeletionArgs,
): Promise<boolean> {
  if (!isProjectDeletionActive(deps, args.projectId)) {
    return false;
  }

  if (!getProject(deps.db, args.projectId)) {
    return true;
  }

  const projectEnvironments = listEnvironments(deps.db, args.projectId);
  const environmentsById = new Map(
    projectEnvironments.map((environment) => [environment.id, environment]),
  );

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
      mode: "force",
    });
    await advanceEnvironmentCleanup(deps, {
      environmentId: environment.id,
    });
  }

  const refreshedEnvironments = listEnvironments(deps.db, args.projectId);
  if (
    hasRemainingProjectThreads(deps, args.projectId)
    || hasRemainingManagedEnvironments(refreshedEnvironments)
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
