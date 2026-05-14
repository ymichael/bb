import type { SystemProvidersQuery } from "@bb/server-contract";
import type { AppDeps } from "../../types.js";
import {
  requireDefaultConnectedPersistentHostId,
  requireEnvironment,
  requireNonDestroyedHostWithStatus,
} from "../lib/entity-lookup.js";

export type SystemHostLookupQuery = Pick<
  SystemProvidersQuery,
  "environmentId" | "hostId"
>;

export function resolveSystemLookupHostId(
  deps: AppDeps,
  query: SystemHostLookupQuery,
): string {
  if (query.environmentId) {
    const environment = requireEnvironment(deps.db, query.environmentId);
    requireNonDestroyedHostWithStatus(deps.db, environment.hostId);
    return environment.hostId;
  }
  if (query.hostId) {
    requireNonDestroyedHostWithStatus(deps.db, query.hostId);
    return query.hostId;
  }
  return requireDefaultConnectedPersistentHostId(deps.db);
}
