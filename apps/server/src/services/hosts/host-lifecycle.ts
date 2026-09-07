import { getHost } from "@bb/db";
import type { WorkSessionDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { requireConnectedHostSession } from "../lib/entity-lookup.js";
import { resumeMachine } from "../machines/provider-orchestration.js";

export async function ensureHostSessionReadyForWork(
  deps: WorkSessionDeps,
  args: { hostId: string },
) {
  const host = getHost(deps.db, args.hostId);
  if (!host || host.destroyedAt !== null) {
    throw new ApiError(404, "host_not_found", "Host not found");
  }

  await resumeMachine(deps, host.id);

  return requireConnectedHostSession(deps, host.id);
}
