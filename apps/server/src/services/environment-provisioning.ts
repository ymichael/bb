import { environments } from "@bb/db";
import { eq } from "drizzle-orm";
import type {
  Environment,
  Thread,
} from "@bb/domain";
import type { AppDeps } from "../types.js";
import { ApiError } from "../errors.js";
import {
  appendProvisioningEvent,
} from "./thread-events.js";
import {
  buildManagedBranchNameFromSeed,
  buildManagedTargetPath,
  queueEnvironmentProvision,
  SETUP_SCRIPT_NAME,
  SETUP_TIMEOUT_MS,
  requireSourceForHost,
} from "./thread-create-helpers.js";
import { tryTransition } from "./thread-transitions.js";

function toProvisioningLabel(
  workspaceProvisionType: Environment["workspaceProvisionType"],
): string {
  switch (workspaceProvisionType) {
    case "unmanaged":
      return "Environment";
    case "managed-worktree":
      return "Worktree";
    case "managed-clone":
      return "Clone";
  }
}

export const MANAGED_REPROVISION_QUEUED = "queued" as const;
export const MANAGED_REPROVISION_IN_PROGRESS = "already-provisioning" as const;
export type ManagedReprovisionResult =
  | typeof MANAGED_REPROVISION_QUEUED
  | typeof MANAGED_REPROVISION_IN_PROGRESS;

export function queueManagedEnvironmentReprovision(
  deps: Pick<AppDeps, "db" | "hub">,
  args: {
    environment: Environment;
    thread: Thread;
  },
): ManagedReprovisionResult {
  const provisionType = args.environment.workspaceProvisionType;
  if (!args.environment.managed || provisionType === "unmanaged") {
    throw new ApiError(
      409,
      "invalid_request",
      "Environment cannot be reprovisioned automatically",
    );
  }

  const source = requireSourceForHost(
    deps,
    args.thread.projectId,
    args.environment.hostId,
  );

  const targetPath =
    args.environment.path ??
    buildManagedTargetPath(source.path, args.thread.projectId, args.thread.id);
  const branchName =
    args.environment.branchName ??
    buildManagedBranchNameFromSeed(
      args.thread.title ?? args.thread.titleFallback ?? args.thread.id,
      args.thread.id,
    );

  const now = Date.now();
  let claimed = false;
  deps.db.transaction((tx) => {
    const current = tx
      .select({
        status: environments.status,
      })
      .from(environments)
      .where(eq(environments.id, args.environment.id))
      .get();
    if (!current || current.status === "provisioning") {
      return;
    }

    tx.update(environments)
      .set({
        status: "provisioning",
        updatedAt: now,
      })
      .where(eq(environments.id, args.environment.id))
      .run();
    claimed = true;
  });
  if (!claimed) {
    return MANAGED_REPROVISION_IN_PROGRESS;
  }

  deps.hub.notifyEnvironment(args.environment.id, ["status-changed"]);
  if (args.thread.status === "idle") {
    tryTransition(deps.db, deps.hub, args.thread.id, "provisioning");
  }
  appendProvisioningEvent(deps, {
    threadId: args.thread.id,
    environmentId: args.environment.id,
    status: "started",
    entries: [
      {
        type: "step",
        key: "environment",
        text: `environment: ${toProvisioningLabel(args.environment.workspaceProvisionType)}`,
        status: "completed",
      },
    ],
  });
  queueEnvironmentProvision(deps, {
    branchName,
    environmentId: args.environment.id,
    hostId: args.environment.hostId,
    sourcePath: source.path,
    targetPath,
    workspaceProvisionType: provisionType,
    setupScript: SETUP_SCRIPT_NAME,
    setupTimeoutMs: SETUP_TIMEOUT_MS,
  });
  return MANAGED_REPROVISION_QUEUED;
}
