import { expect } from "vitest";
import type { Thread, ThreadEvent } from "@beanbag/agent-core";
import {
  archiveThread,
  createProject,
  createThread,
  listEnvironmentAgentSessions,
  listThreadEvents,
  readError,
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
      continue;
    }
    if (normalized === "turn/completed" || normalized === "turn/end") {
      completedTurns += 1;
    }
  }

  return {
    clientTurnStarts,
    completedTurns,
  };
}

function latestCompletedAgentText(events: ThreadEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (normalizeEventType(event.type) !== "item/completed") {
      continue;
    }
    const data = event.data as {
      item?: {
        type?: string;
        text?: string;
        phase?: string;
      };
      payload?: {
        item?: {
          type?: string;
          text?: string;
          phase?: string;
        };
      };
    };
    const item = data.item ?? data.payload?.item;
    if (
      item?.type === "agentMessage" &&
      typeof item.text === "string" &&
      item.text.length > 0
    ) {
      return item.text;
    }
  }
  return undefined;
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

async function waitForArchivedState(args: {
  baseUrl: string;
  wsUrl: string;
  threadId: string;
  archived: boolean;
  timeoutMs: number;
}): Promise<Thread> {
  return waitForThreadCondition({
    threadId: args.threadId,
    timeoutMs: args.timeoutMs,
    wsUrl: args.wsUrl,
    load: async () => readJson<Thread>(`${args.baseUrl}/api/v1/threads/${args.threadId}`),
    isReady: (thread) =>
      args.archived
        ? typeof thread.archivedAt === "number"
        : thread.archivedAt === undefined,
    describeLast: (thread) =>
      `Thread ${args.threadId} did not ${args.archived ? "archive" : "unarchive"} within ${args.timeoutMs}ms (status=${thread?.status ?? "unknown"}, archivedAt=${thread?.archivedAt ?? "none"})`,
  });
}

function getActiveSharedSessionId(
  sessions: Awaited<ReturnType<typeof listEnvironmentAgentSessions>>["sessions"],
): string | undefined {
  return sessions.find((session) => session.status === "active")?.id;
}

export async function runThreadSharedEnvironmentRoundtripScenario(): Promise<void> {
  const harness = await startDaemonE2eHarness({
    fakeCodex: {
      defaultTurnDelayMs: 25,
    },
    initGitRepo: true,
    preserveTempDirOnCleanup: process.env.BEANBAG_E2E_PRESERVE_TEMP_DIR === "1",
  });

  try {
    const project = await createProject(
      harness.baseUrl,
      harness.projectRoot,
      "shared-environment-roundtrip-project",
    );

    const firstThread = await createThread(
      harness.baseUrl,
      project.id,
      "Reply with exactly SHARED-INITIAL-ONE and finish. Do not run commands or add extra text.",
      { environmentKind: "worktree" },
    );

    const firstInitialRoundTrip = await waitForIdleAfterTurnProgress({
      baseUrl: harness.baseUrl,
      wsUrl: harness.wsUrl,
      threadId: firstThread.id,
      previousCounts: {
        clientTurnStarts: 0,
        completedTurns: 0,
      },
      additionalTurns: 1,
      timeoutMs: e2eTimeoutMs(20_000, 90_000),
    });

    const hydratedFirstThread = firstInitialRoundTrip.thread;
    const attachedEnvironmentId = hydratedFirstThread.attachedEnvironment?.id;
    expect(attachedEnvironmentId).toBeTruthy();

    const secondThread = await createThread(
      harness.baseUrl,
      project.id,
      "Reply with exactly SHARED-INITIAL-TWO and finish. Do not run commands or add extra text.",
      { environmentId: attachedEnvironmentId },
    );

    const secondInitialRoundTrip = await waitForIdleAfterTurnProgress({
      baseUrl: harness.baseUrl,
      wsUrl: harness.wsUrl,
      threadId: secondThread.id,
      previousCounts: {
        clientTurnStarts: 0,
        completedTurns: 0,
      },
      additionalTurns: 1,
      timeoutMs: e2eTimeoutMs(20_000, 90_000),
    });

    expect(secondInitialRoundTrip.thread.attachedEnvironment?.id).toBe(attachedEnvironmentId);
    expect(latestCompletedAgentText(firstInitialRoundTrip.events)).toBeTruthy();
    expect(latestCompletedAgentText(secondInitialRoundTrip.events)).toBeTruthy();

    const sessionsBeforeFollowUps = await Promise.all([
      listEnvironmentAgentSessions(harness.baseUrl, firstThread.id),
      listEnvironmentAgentSessions(harness.baseUrl, secondThread.id),
    ]);
    const firstSharedSessionId = getActiveSharedSessionId(sessionsBeforeFollowUps[0].sessions);
    const secondSharedSessionId = getActiveSharedSessionId(sessionsBeforeFollowUps[1].sessions);
    expect(firstSharedSessionId).toBeTruthy();
    expect(secondSharedSessionId).toBe(firstSharedSessionId);

    await Promise.all([
      tellThread(
        harness.baseUrl,
        firstThread.id,
        "Reply with exactly SHARED-FOLLOWUP-ONE and finish. Do not run commands or add extra text.",
      ),
      tellThread(
        harness.baseUrl,
        secondThread.id,
        "Reply with exactly SHARED-FOLLOWUP-TWO and finish. Do not run commands or add extra text.",
      ),
    ]);

    const [firstFollowUpRoundTrip, secondFollowUpRoundTrip] = await Promise.all([
      waitForIdleAfterTurnProgress({
        baseUrl: harness.baseUrl,
        wsUrl: harness.wsUrl,
        threadId: firstThread.id,
        previousCounts: firstInitialRoundTrip.counts,
        additionalTurns: 1,
        timeoutMs: e2eTimeoutMs(30_000, 120_000),
      }),
      waitForIdleAfterTurnProgress({
        baseUrl: harness.baseUrl,
        wsUrl: harness.wsUrl,
        threadId: secondThread.id,
        previousCounts: secondInitialRoundTrip.counts,
        additionalTurns: 1,
        timeoutMs: e2eTimeoutMs(30_000, 120_000),
      }),
    ]);

    expect(latestCompletedAgentText(firstFollowUpRoundTrip.events)).toBeTruthy();
    expect(latestCompletedAgentText(secondFollowUpRoundTrip.events)).toBeTruthy();

    const sessionsAfterFollowUps = await Promise.all([
      listEnvironmentAgentSessions(harness.baseUrl, firstThread.id),
      listEnvironmentAgentSessions(harness.baseUrl, secondThread.id),
    ]);
    expect(getActiveSharedSessionId(sessionsAfterFollowUps[0].sessions)).toBe(
      getActiveSharedSessionId(sessionsAfterFollowUps[1].sessions),
    );

    await archiveThread(harness.baseUrl, firstThread.id);
    await waitForArchivedState({
      baseUrl: harness.baseUrl,
      wsUrl: harness.wsUrl,
      threadId: firstThread.id,
      archived: true,
      timeoutMs: e2eTimeoutMs(8_000, 30_000),
    });

    const archivedTellError = await readError(
      `${harness.baseUrl}/api/v1/threads/${firstThread.id}/tell`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: [{ type: "text", text: "This tell should be rejected while archived." }],
        }),
      },
    );
    expect(archivedTellError.status).toBe(409);

    await tellThread(
      harness.baseUrl,
      secondThread.id,
      "Reply with exactly SHARED-SIBLING-SURVIVES and finish. Do not run commands or add extra text.",
    );

    const secondPostArchiveRoundTrip = await waitForIdleAfterTurnProgress({
      baseUrl: harness.baseUrl,
      wsUrl: harness.wsUrl,
      threadId: secondThread.id,
      previousCounts: secondFollowUpRoundTrip.counts,
      additionalTurns: 1,
      timeoutMs: e2eTimeoutMs(30_000, 120_000),
    });
    expect(latestCompletedAgentText(secondPostArchiveRoundTrip.events)).toBeTruthy();
  } finally {
    await harness.cleanup();
  }
}
