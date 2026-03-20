import { existsSync } from "node:fs";
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

function completedAgentTexts(events: ThreadEvent[]): string[] {
  const texts: string[] = [];
  for (const event of events) {
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
      texts.push(item.text);
    }
  }
  return texts;
}

function expectThreadToContainOnlyProviderOutputs(args: {
  events: ThreadEvent[];
  expectedTokens: string[];
  forbiddenTokens: string[];
}): void {
  const texts = completedAgentTexts(args.events);
  expect(texts.length).toBeGreaterThan(0);
  for (const token of args.expectedTokens) {
    expect(texts.some((text) => text.includes(token))).toBe(true);
  }
  for (const token of args.forbiddenTokens) {
    expect(texts.some((text) => text.includes(token))).toBe(false);
  }
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

async function logThreadDebugSnapshot(args: {
  baseUrl: string;
  threadId: string;
  label: string;
}): Promise<void> {
  if (process.env.BB_E2E_DEBUG_SHARED_MULTI_PROVIDER !== "1") {
    return;
  }
  const [thread, events] = await Promise.all([
    readJson<Thread>(`${args.baseUrl}/api/v1/threads/${args.threadId}`),
    listThreadEvents(args.baseUrl, args.threadId),
  ]);
  console.error(
    `[multi-provider-debug] ${args.label} thread=${args.threadId} snapshot=${JSON.stringify({
      status: thread.status,
      providerId: thread.providerId,
      environmentId: thread.attachedEnvironment?.id,
      eventTypes: events.slice(-20).map((event) => event.type),
      lastEvents: events.slice(-10),
    })}`,
  );
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

async function waitForPathRemoval(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!existsSync(path)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Path ${path} still exists after ${timeoutMs}ms`);
}

export async function runThreadMultiProviderSharedEnvironmentScenario(): Promise<void> {
  const primaryProviderId = requiredMultiProviderEnv("BB_E2E_MULTI_PROVIDER_A");
  const secondaryProviderId = requiredMultiProviderEnv("BB_E2E_MULTI_PROVIDER_B");
  const primaryTag = primaryProviderId.toUpperCase();
  const secondaryTag = secondaryProviderId.toUpperCase();

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
      { environmentKind: "worktree", providerId: primaryProviderId },
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
      `${primaryTag}-HELLO`,
    );
    expectThreadToContainOnlyProviderOutputs({
      events: primaryInitialRoundTrip.events,
      expectedTokens: [`${primaryTag}-HELLO`],
      forbiddenTokens: [secondaryTag],
    });

    const sharedEnvironmentId = primaryInitialRoundTrip.thread.attachedEnvironment?.id;
    const sharedEnvironmentPath =
      primaryInitialRoundTrip.thread.attachedEnvironment?.descriptor?.type === "path"
        ? primaryInitialRoundTrip.thread.attachedEnvironment.descriptor.path
        : undefined;
    expect(sharedEnvironmentId).toBeTruthy();
    expect(sharedEnvironmentPath).toBeTruthy();

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
    }).catch(async (error) => {
      await logThreadDebugSnapshot({
        baseUrl: harness.baseUrl,
        threadId: secondaryThread.id,
        label: "secondary-initial",
      });
      throw error;
    });

    expect(secondaryInitialRoundTrip.thread.providerId).toBe(secondaryProviderId);
    expect(secondaryInitialRoundTrip.thread.attachedEnvironment?.id).toBe(sharedEnvironmentId);
    expect(latestCompletedAgentText(secondaryInitialRoundTrip.events)).toContain(
      `${secondaryTag}-HELLO`,
    );
    expectThreadToContainOnlyProviderOutputs({
      events: secondaryInitialRoundTrip.events,
      expectedTokens: [`${secondaryTag}-HELLO`],
      forbiddenTokens: [primaryTag],
    });

    await tellThread(
      harness.baseUrl,
      primaryThread.id,
      `Reply with exactly ${primaryTag}-FOLLOWUP-ONE and finish.`,
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
      `${primaryTag}-FOLLOWUP-ONE`,
    );
    expectThreadToContainOnlyProviderOutputs({
      events: primaryFollowUpRoundTrip.events,
      expectedTokens: [`${primaryTag}-HELLO`, `${primaryTag}-FOLLOWUP-ONE`],
      forbiddenTokens: [secondaryTag],
    });

    await tellThread(
      harness.baseUrl,
      secondaryThread.id,
      `Reply with exactly ${secondaryTag}-FOLLOWUP-ONE and finish.`,
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
      `${secondaryTag}-FOLLOWUP-ONE`,
    );
    expectThreadToContainOnlyProviderOutputs({
      events: secondaryFollowUpRoundTrip.events,
      expectedTokens: [`${secondaryTag}-HELLO`, `${secondaryTag}-FOLLOWUP-ONE`],
      forbiddenTokens: [primaryTag],
    });

    await Promise.all([
      tellThread(
        harness.baseUrl,
        primaryThread.id,
        `Reply with exactly ${primaryTag}-PARALLEL and finish.`,
      ),
      tellThread(
        harness.baseUrl,
        secondaryThread.id,
        `Reply with exactly ${secondaryTag}-PARALLEL and finish.`,
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
      `${primaryTag}-PARALLEL`,
    );
    expect(latestCompletedAgentText(secondaryParallelRoundTrip.events)).toContain(
      `${secondaryTag}-PARALLEL`,
    );
    expectThreadToContainOnlyProviderOutputs({
      events: primaryParallelRoundTrip.events,
      expectedTokens: [`${primaryTag}-HELLO`, `${primaryTag}-FOLLOWUP-ONE`, `${primaryTag}-PARALLEL`],
      forbiddenTokens: [secondaryTag],
    });
    expectThreadToContainOnlyProviderOutputs({
      events: secondaryParallelRoundTrip.events,
      expectedTokens: [`${secondaryTag}-HELLO`, `${secondaryTag}-FOLLOWUP-ONE`, `${secondaryTag}-PARALLEL`],
      forbiddenTokens: [primaryTag],
    });

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
      `Reply with exactly ${secondaryTag}-AFTER-ARCHIVE and finish.`,
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
      `${secondaryTag}-AFTER-ARCHIVE`,
    );
    expectThreadToContainOnlyProviderOutputs({
      events: secondaryAfterArchiveRoundTrip.events,
      expectedTokens: [
        `${secondaryTag}-HELLO`,
        `${secondaryTag}-FOLLOWUP-ONE`,
        `${secondaryTag}-PARALLEL`,
        `${secondaryTag}-AFTER-ARCHIVE`,
      ],
      forbiddenTokens: [primaryTag],
    });

    await archiveThread(harness.baseUrl, secondaryThread.id);
    await waitForArchivedState({
      baseUrl: harness.baseUrl,
      wsUrl: harness.wsUrl,
      threadId: secondaryThread.id,
      archived: true,
      timeoutMs: e2eTimeoutMs(8_000, 30_000),
    });
    await waitForPathRemoval(
      sharedEnvironmentPath!,
      e2eTimeoutMs(8_000, 30_000),
    );
  } finally {
    await harness.cleanup();
  }
}
