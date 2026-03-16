import { expect } from "vitest";
import type { Thread, ThreadEvent } from "@bb/core";
import {
  createProject,
  createThread,
  listEnvironmentAgentSessions,
  listThreadEvents,
  readJson,
  tellThread,
  waitForThreadCondition,
} from "./environment-agent-api.js";
import { startDaemonE2eHarness } from "./harness.js";
import { e2eTimeoutMs } from "./provider-mode.js";

interface TurnProgressCounts {
  clientTurnStarts: number;
  completedTurns: number;
}

function normalizeEventType(type: string): string {
  return type.toLowerCase().replaceAll(".", "/");
}

function measureTurnProgress(events: ThreadEvent[]): TurnProgressCounts {
  let clientTurnStarts = 0;
  let completedTurns = 0;

  for (const event of events) {
    const normalized = normalizeEventType(event.type);
    if (normalized === "client/turn/start") {
      clientTurnStarts += 1;
    } else if (normalized === "turn/completed" || normalized === "turn/end") {
      completedTurns += 1;
    }
  }

  return { clientTurnStarts, completedTurns };
}

async function waitForIdleAfterTurnProgress(args: {
  baseUrl: string;
  wsUrl: string;
  threadId: string;
  previousCounts: TurnProgressCounts;
  additionalTurns: number;
  timeoutMs: number;
}): Promise<{
  thread: Thread;
  events: ThreadEvent[];
  counts: TurnProgressCounts;
}> {
  return waitForThreadCondition({
    threadId: args.threadId,
    timeoutMs: args.timeoutMs,
    wsUrl: args.wsUrl,
    load: async () => {
      const [thread, events] = await Promise.all([
        readJson<Thread>(`${args.baseUrl}/api/v1/threads/${args.threadId}`),
        listThreadEvents(args.baseUrl, args.threadId),
      ]);
      return {
        thread,
        events,
        counts: measureTurnProgress(events),
      };
    },
    isReady: ({ thread, counts }) =>
      thread.status === "idle" &&
      counts.clientTurnStarts >= args.previousCounts.clientTurnStarts + args.additionalTurns &&
      counts.completedTurns >= args.previousCounts.completedTurns + args.additionalTurns,
    describeLast: (snapshot) =>
      `Thread ${args.threadId} did not complete ${args.additionalTurns} new turns within ${args.timeoutMs}ms (status=${snapshot?.thread.status ?? "unknown"}, counts=${JSON.stringify(snapshot?.counts ?? { clientTurnStarts: 0, completedTurns: 0 })})`,
  });
}

/**
 * Multi-thread stress scenario: spawns 4 threads concurrently across 2
 * environment kinds (local + worktree) in the same project, verifies all
 * reach idle, sends concurrent follow-ups to all, and validates that
 * environment attachments and sessions are correct.
 *
 * This catches bugs that only manifest when multiple threads contend for
 * the same environment simultaneously — e.g., missing attachment rows,
 * multi-child provider collisions, sibling-channel event routing errors.
 */
export async function runMultiThreadStressScenario(): Promise<void> {
  const harness = await startDaemonE2eHarness({
    fakeCodex: {
      defaultTurnDelayMs: 25,
    },
    initGitRepo: true,
    preserveTempDirOnCleanup: process.env.BB_E2E_PRESERVE_TEMP_DIR === "1",
  });

  try {
    const project = await createProject(
      harness.baseUrl,
      harness.projectRoot,
      "multi-thread-stress-project",
    );

    // --- Phase 1: Spawn 4 threads concurrently ---
    // 2 use implicit local environment (no environmentKind), 2 use worktree.
    // The local pair should share an environment; the worktree pair each get their own.
    const [localThread1, localThread2, worktreeThread1, worktreeThread2] = await Promise.all([
      createThread(harness.baseUrl, project.id, "Reply with LOCAL-ONE and finish."),
      createThread(harness.baseUrl, project.id, "Reply with LOCAL-TWO and finish."),
      createThread(harness.baseUrl, project.id, "Reply with WORKTREE-ONE and finish.", {
        environmentKind: "worktree",
      }),
      createThread(harness.baseUrl, project.id, "Reply with WORKTREE-TWO and finish.", {
        environmentKind: "worktree",
      }),
    ]);

    const allThreadIds = [
      localThread1.id,
      localThread2.id,
      worktreeThread1.id,
      worktreeThread2.id,
    ];

    // --- Phase 2: Wait for all threads to reach idle ---
    const zeroCounts: TurnProgressCounts = { clientTurnStarts: 0, completedTurns: 0 };
    const initialTimeoutMs = e2eTimeoutMs(30_000, 120_000);

    const initialResults = await Promise.all(
      allThreadIds.map((threadId) =>
        waitForIdleAfterTurnProgress({
          baseUrl: harness.baseUrl,
          wsUrl: harness.wsUrl,
          threadId,
          previousCounts: zeroCounts,
          additionalTurns: 1,
          timeoutMs: initialTimeoutMs,
        }),
      ),
    );

    // All threads must have completed at least one turn.
    for (const result of initialResults) {
      expect(result.counts.completedTurns).toBeGreaterThanOrEqual(1);
    }

    // --- Phase 3: Verify environment sharing ---
    // The two local threads should share an environmentId.
    const localEnv1 = initialResults[0].thread.attachedEnvironment?.id;
    const localEnv2 = initialResults[1].thread.attachedEnvironment?.id;
    expect(localEnv1).toBeTruthy();
    expect(localEnv2).toBeTruthy();
    expect(localEnv1).toBe(localEnv2);

    // The worktree threads should each have their own environment (different
    // from each other and from the local environment).
    const worktreeEnv1 = initialResults[2].thread.attachedEnvironment?.id;
    const worktreeEnv2 = initialResults[3].thread.attachedEnvironment?.id;
    expect(worktreeEnv1).toBeTruthy();
    expect(worktreeEnv2).toBeTruthy();
    expect(worktreeEnv1).not.toBe(localEnv1);
    expect(worktreeEnv2).not.toBe(localEnv1);

    // --- Phase 4: Verify shared env-daemon sessions for local threads ---
    const [localSessions1, localSessions2] = await Promise.all([
      listEnvironmentAgentSessions(harness.baseUrl, localThread1.id),
      listEnvironmentAgentSessions(harness.baseUrl, localThread2.id),
    ]);
    const activeLocal1 = localSessions1.sessions.find((s) => s.status === "active")?.id;
    const activeLocal2 = localSessions2.sessions.find((s) => s.status === "active")?.id;
    expect(activeLocal1).toBeTruthy();
    expect(activeLocal2).toBe(activeLocal1);

    // --- Phase 5: Send concurrent follow-ups to ALL 4 threads ---
    await Promise.all([
      tellThread(harness.baseUrl, localThread1.id, "Reply with LOCAL-ONE-FOLLOWUP and finish."),
      tellThread(harness.baseUrl, localThread2.id, "Reply with LOCAL-TWO-FOLLOWUP and finish."),
      tellThread(harness.baseUrl, worktreeThread1.id, "Reply with WORKTREE-ONE-FOLLOWUP and finish."),
      tellThread(harness.baseUrl, worktreeThread2.id, "Reply with WORKTREE-TWO-FOLLOWUP and finish."),
    ]);

    const followUpTimeoutMs = e2eTimeoutMs(30_000, 120_000);

    const followUpResults = await Promise.all(
      allThreadIds.map((threadId, index) =>
        waitForIdleAfterTurnProgress({
          baseUrl: harness.baseUrl,
          wsUrl: harness.wsUrl,
          threadId,
          previousCounts: initialResults[index].counts,
          additionalTurns: 1,
          timeoutMs: followUpTimeoutMs,
        }),
      ),
    );

    // All threads must have completed the follow-up turn.
    for (const result of followUpResults) {
      expect(result.counts.completedTurns).toBeGreaterThanOrEqual(2);
    }

    // --- Phase 6: Verify sessions still healthy after concurrent follow-ups ---
    const [postLocal1, postLocal2] = await Promise.all([
      listEnvironmentAgentSessions(harness.baseUrl, localThread1.id),
      listEnvironmentAgentSessions(harness.baseUrl, localThread2.id),
    ]);
    const postActiveLocal1 = postLocal1.sessions.find((s) => s.status === "active")?.id;
    const postActiveLocal2 = postLocal2.sessions.find((s) => s.status === "active")?.id;
    expect(postActiveLocal1).toBeTruthy();
    expect(postActiveLocal2).toBe(postActiveLocal1);

    // --- Phase 7: Third round of follow-ups to confirm sustained health ---
    await Promise.all([
      tellThread(harness.baseUrl, localThread1.id, "Reply with LOCAL-ONE-ROUND3 and finish."),
      tellThread(harness.baseUrl, localThread2.id, "Reply with LOCAL-TWO-ROUND3 and finish."),
      tellThread(harness.baseUrl, worktreeThread1.id, "Reply with WORKTREE-ONE-ROUND3 and finish."),
      tellThread(harness.baseUrl, worktreeThread2.id, "Reply with WORKTREE-TWO-ROUND3 and finish."),
    ]);

    const round3Results = await Promise.all(
      allThreadIds.map((threadId, index) =>
        waitForIdleAfterTurnProgress({
          baseUrl: harness.baseUrl,
          wsUrl: harness.wsUrl,
          threadId,
          previousCounts: followUpResults[index].counts,
          additionalTurns: 1,
          timeoutMs: followUpTimeoutMs,
        }),
      ),
    );

    for (const result of round3Results) {
      expect(result.counts.completedTurns).toBeGreaterThanOrEqual(3);
    }
  } finally {
    await harness.cleanup();
  }
}
