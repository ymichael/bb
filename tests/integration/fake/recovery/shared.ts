import type { ThreadEventRow } from "@bb/domain";
import { expect } from "vitest";
import {
  createProjectFixture,
  createReadyHostThread,
  type ReadyThreadFixture,
} from "../../helpers/fixtures.js";
import type { IntegrationHarness } from "../../helpers/harness.js";
import { scaleTimeoutMs } from "../../helpers/time.js";

// Setup waits: create the thread and observe the first ready/idle state.
export const DEFAULT_TIMEOUT_MS = scaleTimeoutMs(10_000);
// Whole-turn waits: standard provider turns should settle within this budget.
export const TURN_TIMEOUT_MS = scaleTimeoutMs(15_000);
// Recovery waits: allow for disconnect detection plus daemon restart and reconciliation.
export const RECOVERY_TIMEOUT_MS = scaleTimeoutMs(30_000);
// Active-turn waits: only long enough to catch a turn in flight before the crash/restart step.
export const ACTIVE_TIMEOUT_MS = scaleTimeoutMs(5_000);
// Hold the turn beyond RECOVERY_TIMEOUT_MS so active-crash recovery must interrupt
// an in-flight provider call instead of racing a normally completed fake turn.
export const STOP_DELAY_TEXT = "delay:60000 recovery turn";

export type RecoveryWorkspaceType = "unmanaged" | "managed-worktree";

export interface RecoveryThreadFixture extends ReadyThreadFixture {
  projectName: string;
  projectRootPath: string;
}

export function assertMonotonicSequences(events: ThreadEventRow[]): void {
  for (let index = 1; index < events.length; index += 1) {
    expect(events[index]?.seq).toBeGreaterThan(events[index - 1]?.seq ?? -1);
  }
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
