import path from "node:path";
import { ApiError } from "../errors.js";
import type { AppDeps } from "../types.js";
import { requireConnectedHostSession } from "./entity-lookup.js";

export interface RequireManagerWorkspacePathArgs {
  hostId: string;
  threadId: string;
}

export function requireManagerWorkspacePath(
  deps: Pick<AppDeps, "db">,
  args: RequireManagerWorkspacePathArgs,
): string {
  const session = requireConnectedHostSession(deps, args.hostId);
  if (!session.dataDir) {
    throw new ApiError(
      502,
      "host_protocol_mismatch",
      "Connected host session did not report its data directory",
    );
  }
  return path.join(session.dataDir, "workspace", args.threadId);
}
