import {
  createProjectFixture,
  createReadyHostThread,
  type ReadyThreadFixture,
} from "../../helpers/fixtures.js";
import type { IntegrationHarness } from "../../helpers/harness.js";
import { scaleTimeoutMs } from "../../helpers/time.js";

const DEFAULT_TIMEOUT_MS = scaleTimeoutMs(10_000);
export const TURN_TIMEOUT_MS = scaleTimeoutMs(15_000);
export const RECOVERY_TIMEOUT_MS = scaleTimeoutMs(30_000);
export const RECOVERY_TEST_TIMEOUT_MS = scaleTimeoutMs(180_000);
export const ACTIVE_TIMEOUT_MS = scaleTimeoutMs(5_000);
export const STOP_DELAY_TEXT = "delay:5000 recovery turn";

type RecoveryWorkspaceType = "unmanaged" | "managed-worktree";

interface RecoveryThreadFixture extends ReadyThreadFixture {
  projectName: string;
  projectRootPath: string;
}

export function requireSessionId(harness: IntegrationHarness): string {
  const sessionId = harness.daemonApp.connection.sessionId;
  if (!sessionId) {
    throw new Error("Daemon session is not open");
  }
  return sessionId;
}

export async function createRecoveryThread(
  harness: IntegrationHarness,
  name: string,
  workspaceType: RecoveryWorkspaceType = "unmanaged",
): Promise<RecoveryThreadFixture> {
  const project = await createProjectFixture(harness, { name });
  const workspace =
    workspaceType === "unmanaged"
      ? { type: "unmanaged" as const, path: harness.repoDir }
      : { type: "managed-worktree" as const };
  const readyThread = await createReadyHostThread(harness, {
    projectId: project.id,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    workspace,
  });
  return {
    ...readyThread,
    projectName: name,
    projectRootPath: harness.repoDir,
  };
}
