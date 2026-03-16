import type { EnvironmentAgentSessionRepository } from "@bb/db";
import type { Orchestrator } from "./orchestrator.js";

interface StartupTaskLogger {
  log(message: string): void;
  warn(message: string): void;
}

const DEFAULT_SESSION_SYNC_TIMEOUT_MS = 2_000;

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
  timeoutMs: number,
): Promise<boolean> {
  try {
    const response = await fetch(new URL("/control/session-sync", record.controlBaseUrl), {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
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
  requestTimeoutMs?: number;
}): Promise<{
  activeSessionCount: number;
  pokedCount: number;
  unreachableCount: number;
}> {
  const logger = args.logger ?? console;
  const requestTimeoutMs =
    args.requestTimeoutMs ?? DEFAULT_SESSION_SYNC_TIMEOUT_MS;
  const activeSessions = args.sessionRepo.listActive();
  if (activeSessions.length === 0) {
    return {
      activeSessionCount: 0,
      pokedCount: 0,
      unreachableCount: 0,
    };
  }

  const results = await Promise.all(
    activeSessions.map(async (session) => {
      if (!session.controlBaseUrl || !session.controlAuthToken) {
        return false;
      }
      return requestEnvironmentAgentSessionSync(
        {
          controlBaseUrl: session.controlBaseUrl,
          controlAuthToken: session.controlAuthToken,
        },
        requestTimeoutMs,
      );
    }),
  );
  const pokedCount = results.filter(Boolean).length;
  const unreachableSessions = activeSessions.filter((_, index) => !results[index]);
  const unreachableCount = unreachableSessions.length;

  logger.log(
    `Environment-agent startup recovery poked ${pokedCount}/${activeSessions.length} active sessions; left ${unreachableCount} unreachable sessions for lazy replacement.`,
  );
  return {
    activeSessionCount: activeSessions.length,
    pokedCount,
    unreachableCount,
  };
}

export function scheduleManagedEnvironmentAgentSessionRecoveryOnBoot(args: {
  sessionRepo: Pick<EnvironmentAgentSessionRepository, "listActive">;
  logger?: StartupTaskLogger;
  requestTimeoutMs?: number;
}): void {
  const logger = args.logger ?? console;
  const task = setImmediate(() => {
    logger.log("Reconciling managed environment-agent sessions in background...");
    void recoverManagedEnvironmentAgentSessionsOnBoot(args).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Managed environment-agent session recovery skipped: ${message}`);
    });
  });
  task.unref();
}
