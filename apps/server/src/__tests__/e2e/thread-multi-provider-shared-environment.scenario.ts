import { expect } from "vitest";
import type { Thread, ThreadEvent } from "@bb/core";
import {
  archiveThread,
  createProject,
  createThread,
  listThreadEvents,
  readError,
  readJson,
  tellThread,
  waitForThreadCondition,
} from "./environment-daemon-api.js";
import { startServerE2eHarness } from "./harness.js";
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
      };
      payload?: {
        item?: {
          type?: string;
          text?: string;
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

function requiredMultiProviderEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} must be set for the real multi-provider e2e scenario`);
  }
  return value;
}

export async function runThreadMultiProviderSharedEnvironmentScenario(): Promise<void> {
  const primaryProviderId = requiredMultiProviderEnv("BB_E2E_MULTI_PROVIDER_A");
  const secondaryProviderId = requiredMultiProviderEnv("BB_E2E_MULTI_PROVIDER_B");

  const harness = await startServerE2eHarness({
    providerMode: "real",
    initGitRepo: true,
    preserveTempDirOnCleanup: process.env.BB_E2E_PRESERVE_TEMP_DIR === "1",
  });

  try {
    const project = await createProject(
      harness.baseUrl,
      harness.projectRoot,
      "multi-provider-shared-environment-project",
    );

    const primaryThread = await createThread(
      harness.baseUrl,
      project.id,
      `Reply with exactly ${primaryProviderId.toUpperCase()}-HELLO and finish.`,
      { providerId: primaryProviderId },
    );

    const primaryInitialRoundTrip = await waitForIdleAfterTurnProgress({
      baseUrl: harness.baseUrl,
      wsUrl: harness.wsUrl,
      threadId: primaryThread.id,
      previousCounts: { clientTurnStarts: 0, completedTurns: 0 },
      additionalTurns: 1,
      timeoutMs: e2eTimeoutMs(20_000, 120_000),
    });

    expect(primaryInitialRoundTrip.thread.providerId).toBe(primaryProviderId);
    expect(latestCompletedAgentText(primaryInitialRoundTrip.events)).toContain(
      `${primaryProviderId.toUpperCase()}-HELLO`,
    );

    const sharedEnvironmentId = primaryInitialRoundTrip.thread.attachedEnvironment?.id;
    expect(sharedEnvironmentId).toBeTruthy();

    const secondaryThread = await createThread(
      harness.baseUrl,
      project.id,
      `Reply with exactly ${secondaryProviderId.toUpperCase()}-HELLO and finish.`,
      {
        environmentId: sharedEnvironmentId,
        providerId: secondaryProviderId,
      },
    );

    const secondaryInitialRoundTrip = await waitForIdleAfterTurnProgress({
      baseUrl: harness.baseUrl,
      wsUrl: harness.wsUrl,
      threadId: secondaryThread.id,
      previousCounts: { clientTurnStarts: 0, completedTurns: 0 },
      additionalTurns: 1,
      timeoutMs: e2eTimeoutMs(20_000, 120_000),
    });

    expect(secondaryInitialRoundTrip.thread.providerId).toBe(secondaryProviderId);
    expect(secondaryInitialRoundTrip.thread.attachedEnvironment?.id).toBe(sharedEnvironmentId);
    expect(latestCompletedAgentText(secondaryInitialRoundTrip.events)).toContain(
      `${secondaryProviderId.toUpperCase()}-HELLO`,
    );

    await tellThread(
      harness.baseUrl,
      primaryThread.id,
      `Reply with exactly ${primaryProviderId.toUpperCase()}-FOLLOWUP-ONE and finish.`,
    );
    const primaryFollowUpRoundTrip = await waitForIdleAfterTurnProgress({
      baseUrl: harness.baseUrl,
      wsUrl: harness.wsUrl,
      threadId: primaryThread.id,
      previousCounts: primaryInitialRoundTrip.counts,
      additionalTurns: 1,
      timeoutMs: e2eTimeoutMs(30_000, 120_000),
    });
    expect(latestCompletedAgentText(primaryFollowUpRoundTrip.events)).toContain(
      `${primaryProviderId.toUpperCase()}-FOLLOWUP-ONE`,
    );

    await tellThread(
      harness.baseUrl,
      secondaryThread.id,
      `Reply with exactly ${secondaryProviderId.toUpperCase()}-FOLLOWUP-ONE and finish.`,
    );
    const secondaryFollowUpRoundTrip = await waitForIdleAfterTurnProgress({
      baseUrl: harness.baseUrl,
      wsUrl: harness.wsUrl,
      threadId: secondaryThread.id,
      previousCounts: secondaryInitialRoundTrip.counts,
      additionalTurns: 1,
      timeoutMs: e2eTimeoutMs(30_000, 120_000),
    });
    expect(latestCompletedAgentText(secondaryFollowUpRoundTrip.events)).toContain(
      `${secondaryProviderId.toUpperCase()}-FOLLOWUP-ONE`,
    );

    await Promise.all([
      tellThread(
        harness.baseUrl,
        primaryThread.id,
        `Reply with exactly ${primaryProviderId.toUpperCase()}-PARALLEL and finish.`,
      ),
      tellThread(
        harness.baseUrl,
        secondaryThread.id,
        `Reply with exactly ${secondaryProviderId.toUpperCase()}-PARALLEL and finish.`,
      ),
    ]);

    const [primaryParallelRoundTrip, secondaryParallelRoundTrip] = await Promise.all([
      waitForIdleAfterTurnProgress({
        baseUrl: harness.baseUrl,
        wsUrl: harness.wsUrl,
        threadId: primaryThread.id,
        previousCounts: primaryFollowUpRoundTrip.counts,
        additionalTurns: 1,
        timeoutMs: e2eTimeoutMs(30_000, 120_000),
      }),
      waitForIdleAfterTurnProgress({
        baseUrl: harness.baseUrl,
        wsUrl: harness.wsUrl,
        threadId: secondaryThread.id,
        previousCounts: secondaryFollowUpRoundTrip.counts,
        additionalTurns: 1,
        timeoutMs: e2eTimeoutMs(30_000, 120_000),
      }),
    ]);

    expect(latestCompletedAgentText(primaryParallelRoundTrip.events)).toContain(
      `${primaryProviderId.toUpperCase()}-PARALLEL`,
    );
    expect(latestCompletedAgentText(secondaryParallelRoundTrip.events)).toContain(
      `${secondaryProviderId.toUpperCase()}-PARALLEL`,
    );

    await archiveThread(harness.baseUrl, primaryThread.id);
    await waitForArchivedState({
      baseUrl: harness.baseUrl,
      wsUrl: harness.wsUrl,
      threadId: primaryThread.id,
      archived: true,
      timeoutMs: e2eTimeoutMs(8_000, 30_000),
    });

    const archivedTellError = await readError(
      `${harness.baseUrl}/api/v1/threads/${primaryThread.id}/tell`,
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
      secondaryThread.id,
      `Reply with exactly ${secondaryProviderId.toUpperCase()}-AFTER-ARCHIVE and finish.`,
    );
    const secondaryAfterArchiveRoundTrip = await waitForIdleAfterTurnProgress({
      baseUrl: harness.baseUrl,
      wsUrl: harness.wsUrl,
      threadId: secondaryThread.id,
      previousCounts: secondaryParallelRoundTrip.counts,
      additionalTurns: 1,
      timeoutMs: e2eTimeoutMs(30_000, 120_000),
    });
    expect(latestCompletedAgentText(secondaryAfterArchiveRoundTrip.events)).toContain(
      `${secondaryProviderId.toUpperCase()}-AFTER-ARCHIVE`,
    );
  } finally {
    await harness.cleanup();
  }
}
