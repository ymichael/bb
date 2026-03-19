import { expect } from "vitest";
import type { Thread } from "@bb/core";
import {
  createProject,
  createThread,
  readJson,
  waitForThreadCondition,
  waitForThreadStatus,
} from "./environment-daemon-api.js";
import { runCliCommand, startServerE2eHarness } from "./harness.js";
import { e2eTimeoutMs } from "./provider-mode.js";

async function waitForPrimaryCheckoutState(args: {
  baseUrl: string;
  wsUrl: string;
  projectId: string;
  threadId: string;
  active: boolean;
  timeoutMs: number;
}): Promise<Thread[]> {
  return waitForThreadCondition({
    threadId: args.threadId,
    timeoutMs: args.timeoutMs,
    wsUrl: args.wsUrl,
    load: async () =>
      readJson<Thread[]>(`${args.baseUrl}/api/v1/threads?projectId=${encodeURIComponent(args.projectId)}`),
    isReady: (threads) => {
      const activeThread = threads.find((thread) => thread.primaryCheckout?.isActive);
      if (args.active) {
        return activeThread?.id === args.threadId;
      }
      return activeThread === undefined;
    },
    describeLast: (threads) =>
      `Project ${args.projectId} did not ${args.active ? "promote" : "demote"} thread ${args.threadId} (active=${threads?.find((thread) => thread.primaryCheckout?.isActive)?.id ?? "none"})`,
  });
}

export async function runThreadWorktreePrimaryCheckoutRoundtripScenario(): Promise<void> {
  const harness = await startServerE2eHarness({
    fakeCodex: {
      defaultTurnDelayMs: 25,
      defaultScenario: "turn-complete",
    },
    initGitRepo: true,
  });

  try {
    const project = await createProject(
      harness.baseUrl,
      harness.projectRoot,
      "worktree-primary-checkout-e2e-project",
    );
    const thread = await createThread(
      harness.baseUrl,
      project.id,
      "Reply with exactly WORKTREE-PROMOTE and finish. Do not run commands or add extra text.",
      { environmentKind: "worktree" },
    );

    const hydratedThread = await waitForThreadStatus(
      harness.baseUrl,
      thread.id,
      "idle",
      e2eTimeoutMs(12_000, 45_000),
      harness.wsUrl,
    );
    const environmentId = hydratedThread.attachedEnvironment?.id ?? hydratedThread.environmentId;
    expect(environmentId).toBeTruthy();
    if (!environmentId) {
      throw new Error(`Thread ${thread.id} never attached to an environment`);
    }

    const initialStatus = await runCliCommand({
      baseUrl: harness.baseUrl,
      args: ["environment", "promote-status", "--project", project.id],
    });
    expect(initialStatus.exitCode).toBe(0);
    expect(initialStatus.stderr).toBe("");
    expect(initialStatus.stdout).toContain("Primary checkout: demoted");

    const promote = await runCliCommand({
      baseUrl: harness.baseUrl,
      args: ["environment", "promote", environmentId, "--thread", thread.id],
    });
    expect(promote.exitCode).toBe(0);
    expect(promote.stderr).toBe("");

    await waitForPrimaryCheckoutState({
      baseUrl: harness.baseUrl,
      wsUrl: harness.wsUrl,
      projectId: project.id,
      threadId: thread.id,
      active: true,
      timeoutMs: e2eTimeoutMs(10_000, 30_000),
    });

    const promotedStatus = await runCliCommand({
      baseUrl: harness.baseUrl,
      args: ["environment", "promote-status", "--project", project.id],
    });
    expect(promotedStatus.exitCode).toBe(0);
    expect(promotedStatus.stderr).toBe("");
    expect(promotedStatus.stdout).toContain(
      `Primary checkout environment: ${environmentId!}`,
    );

    const demote = await runCliCommand({
      baseUrl: harness.baseUrl,
      args: ["environment", "demote", environmentId, "--thread", thread.id],
    });
    expect(demote.exitCode).toBe(0);
    expect(demote.stderr).toBe("");

    await waitForPrimaryCheckoutState({
      baseUrl: harness.baseUrl,
      wsUrl: harness.wsUrl,
      projectId: project.id,
      threadId: thread.id,
      active: false,
      timeoutMs: e2eTimeoutMs(10_000, 30_000),
    });

    const demotedStatus = await runCliCommand({
      baseUrl: harness.baseUrl,
      args: ["environment", "promote-status", "--project", project.id],
    });
    expect(demotedStatus.exitCode).toBe(0);
    expect(demotedStatus.stderr).toBe("");
    expect(demotedStatus.stdout).toContain("Primary checkout: demoted");
  } finally {
    await harness.cleanup();
  }
}
