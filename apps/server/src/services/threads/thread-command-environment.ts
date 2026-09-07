import type { Environment, Thread } from "@bb/domain";
import type { DbConnection } from "@bb/db";
import type { WorkSessionDeps } from "../../types.js";
import { requireEnvironment } from "../lib/entity-lookup.js";
import {
  goneThreadEnvironmentDetails,
  threadEnvironmentUnavailableDetails,
  throwThreadEnvironmentUnavailable,
} from "../lib/lifecycle-api-errors.js";

type ThreadCommandEnvironmentSource = Pick<Thread, "environmentId">;

interface RequireThreadCommandEnvironmentArgs {
  thread: ThreadCommandEnvironmentSource;
}

interface RequireThreadHostCommandEnvironmentArgs {
  db: DbConnection;
  thread: ThreadCommandEnvironmentSource;
}

interface ThreadHostCommandEnvironment {
  hostId: string;
  id: string;
}

export function resolveThreadHostCommandEnvironment(
  args: RequireThreadHostCommandEnvironmentArgs,
): ThreadHostCommandEnvironment | null {
  if (args.thread.environmentId === null) {
    return null;
  }
  const environment = requireEnvironment(args.db, args.thread.environmentId);
  return {
    id: environment.id,
    hostId: environment.hostId,
  };
}

export function requireThreadHostCommandEnvironment(
  args: RequireThreadHostCommandEnvironmentArgs,
): ThreadHostCommandEnvironment {
  const environment = resolveThreadHostCommandEnvironment(args);
  if (environment !== null) {
    return environment;
  }

  throwThreadEnvironmentUnavailable(
    threadEnvironmentUnavailableDetails("never_attached", null),
  );
}

export async function requireThreadCommandEnvironment(
  deps: WorkSessionDeps,
  args: RequireThreadCommandEnvironmentArgs,
): Promise<Environment> {
  if (args.thread.environmentId !== null) {
    const environment = requireEnvironment(deps.db, args.thread.environmentId);
    const goneDetails = goneThreadEnvironmentDetails(environment);
    if (goneDetails) {
      throwThreadEnvironmentUnavailable(goneDetails);
    }
    return environment;
  }

  throwThreadEnvironmentUnavailable(
    threadEnvironmentUnavailableDetails("never_attached", null),
  );
}
