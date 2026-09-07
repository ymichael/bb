import {
  findForeignManagedEnvironmentAtHostPath,
  findProjectEnvironmentByHostPath,
  hasLiveThreadAtHostPath,
  type DbConnection,
} from "@bb/db";
import { isBbManagedWorkspacePath } from "./worktree-paths.js";

interface UnmanagedAttachRefusal {
  reason: "foreign-managed" | "live-thread";
  message: string;
}

interface UnmanagedAttachCheckArgs {
  dataDir: string | null;
  checksOutBranch: boolean;
  hostId: string;
  path: string;
  projectId: string;
}

export function unmanagedAttachRefusal(
  db: DbConnection,
  args: UnmanagedAttachCheckArgs,
): UnmanagedAttachRefusal | null {
  const foreignManagedMessage =
    "Workspace path is a bb-managed workspace owned by another project";

  if (
    findForeignManagedEnvironmentAtHostPath(db, {
      hostId: args.hostId,
      path: args.path,
      projectId: args.projectId,
    })
  ) {
    return { reason: "foreign-managed", message: foreignManagedMessage };
  }

  if (
    args.dataDir !== null &&
    isBbManagedWorkspacePath({ dataDir: args.dataDir, path: args.path }) &&
    !findProjectOwnsPath(db, args)
  ) {
    return { reason: "foreign-managed", message: foreignManagedMessage };
  }

  if (
    args.checksOutBranch &&
    hasLiveThreadAtHostPath(db, { hostId: args.hostId, path: args.path })
  ) {
    return {
      reason: "live-thread",
      message:
        "Cannot checkout branch while another thread is using this workspace",
    };
  }

  return null;
}

function findProjectOwnsPath(
  db: DbConnection,
  args: Pick<UnmanagedAttachCheckArgs, "hostId" | "path" | "projectId">,
): boolean {
  return (
    findProjectEnvironmentByHostPath(
      db,
      args.projectId,
      args.hostId,
      args.path,
    ) !== null
  );
}
