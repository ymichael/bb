import {
  findForeignManagedEnvironmentAtHostPath,
  findProjectEnvironmentByHostPath,
  type DbConnection,
} from "@bb/db";
import { isBbManagedWorkspacePath } from "./workspace-paths.js";

interface ForeignProviderOwnedPathCheckArgs {
  dataDir: string | null;
  hostId: string;
  path: string;
  projectId: string;
}

export function foreignProviderOwnedPathRefusal(
  db: DbConnection,
  args: ForeignProviderOwnedPathCheckArgs,
): string | null {
  const refusal =
    "Workspace path is a bb-managed workspace owned by another project";

  if (
    findForeignManagedEnvironmentAtHostPath(db, {
      hostId: args.hostId,
      path: args.path,
      projectId: args.projectId,
    })
  ) {
    return refusal;
  }

  if (
    args.dataDir !== null &&
    isBbManagedWorkspacePath({ dataDir: args.dataDir, path: args.path }) &&
    findProjectEnvironmentByHostPath(
      db,
      args.projectId,
      args.hostId,
      args.path,
    ) === null
  ) {
    return refusal;
  }

  return null;
}
