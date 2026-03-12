import type { EnvironmentAgentSessionRepository } from "@beanbag/db";
import type { Orchestrator } from "./orchestrator.js";

interface StartupTaskLogger {
  log(message: string): void;
  warn(message: string): void;
}

// Defer startup maintenance until the daemon is already serving requests.
export function scheduleManagedArtifactReconciliation(
  threadManager: Pick<Orchestrator, "reconcileManagedArtifacts">,
  logger: StartupTaskLogger = console,
): void {
  const task = setImmediate(() => {
    logger.log("Reconciling managed storage artifacts in background...");
    void threadManager.reconcileManagedArtifacts()
      .then(() => {
        logger.log("Managed artifact reconciliation complete.");
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`Managed artifact cleanup skipped: ${message}`);
      });
  });
  task.unref();
}

async function requestEnvironmentAgentSessionSync(
  record: { controlBaseUrl: string; controlAuthToken: string },
): Promise<boolean> {
  try {
    const response = await fetch(new URL("/control/session-sync", record.controlBaseUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${record.controlAuthToken}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    return response.status === 202;
  } catch {
    return false;
  }
}

export async function recoverManagedEnvironmentAgentSessionsOnBoot(args: {
  sessionRepo: Pick<EnvironmentAgentSessionRepository, "listActive">;
  logger?: StartupTaskLogger;
}): Promise<{
  activeSessionCount: number;
  pokedCount: number;
  unreachableCount: number;
}> {
  const logger = args.logger ?? console;
  const activeSessions = args.sessionRepo.listActive();
  if (activeSessions.length === 0) {
    return {
      activeSessionCount: 0,
      pokedCount: 0,
      unreachableCount: 0,
    };
  }

  let pokedCount = 0;
  let unreachableCount = 0;
  for (const session of activeSessions) {
    if (!session.controlBaseUrl || !session.controlAuthToken) {
      unreachableCount += 1;
      continue;
    }
    if (await requestEnvironmentAgentSessionSync({
      controlBaseUrl: session.controlBaseUrl,
      controlAuthToken: session.controlAuthToken,
    })) {
      pokedCount += 1;
      continue;
    }
    unreachableCount += 1;
  }

  logger.log(
    `Environment-agent startup recovery poked ${pokedCount}/${activeSessions.length} active sessions; ${unreachableCount} are awaiting heartbeat timeout handling.`,
  );
  return {
    activeSessionCount: activeSessions.length,
    pokedCount,
    unreachableCount,
  };
}
