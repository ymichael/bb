import { expect } from "vitest";
import type { Thread, ThreadEvent } from "@bb/core";
import {
  createProject,
  readJson,
  waitForThreadCondition,
} from "./environment-agent-api.js";
import { startDaemonE2eHarness } from "./harness.js";
import { e2eTimeoutMs } from "./provider-mode.js";

type EnvironmentKind = "local" | "worktree";

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

async function createThread(args: {
  baseUrl: string;
  projectId: string;
  environmentKind: EnvironmentKind;
  inputText: string;
}): Promise<Thread> {
  return readJson<Thread>(`${args.baseUrl}/api/v1/threads`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId: args.projectId,
      ...(args.environmentKind === "worktree"
        ? { environmentCreationArgs: { kind: args.environmentKind } }
        : {}),
      input: [{ type: "text", text: args.inputText }],
    }),
  });
}

async function tellThread(
  baseUrl: string,
  threadId: string,
  inputText: string,
): Promise<void> {
  await readJson<{ ok: boolean }>(`${baseUrl}/api/v1/threads/${threadId}/tell`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      input: [{ type: "text", text: inputText }],
    }),
  });
}

async function waitForIdleAfterTurnProgress(
  baseUrl: string,
  wsUrl: string,
  threadId: string,
  previousCounts: TurnProgressCounts,
  additionalTurns: number,
  timeoutMs: number,
): Promise<{
  thread: Thread;
  events: ThreadEvent[];
  counts: TurnProgressCounts;
}> {
  return waitForThreadCondition({
    threadId,
    timeoutMs,
    wsUrl,
    load: async () => {
      const [thread, events] = await Promise.all([
        readJson<Thread>(`${baseUrl}/api/v1/threads/${threadId}`),
        readJson<ThreadEvent[]>(`${baseUrl}/api/v1/threads/${threadId}/events`),
      ]);
      return {
        thread,
        events,
        counts: measureTurnProgress(events),
      };
    },
    isReady: ({ thread, counts }) =>
      thread.status === "idle" &&
      counts.clientTurnStarts >= previousCounts.clientTurnStarts + additionalTurns &&
      counts.completedTurns >= previousCounts.completedTurns + additionalTurns,
    describeLast: (snapshot) =>
      `Thread ${threadId} did not complete ${additionalTurns} new turns within ${timeoutMs}ms (status=${snapshot?.thread.status ?? "unknown"}, counts=${JSON.stringify(snapshot?.counts ?? measureTurnProgress([]))}, events=${snapshot?.events.map((event) => normalizeEventType(event.type)).join(",") ?? ""})`,
  });
}

async function runImmediateFollowupScenario(args: {
  baseUrl: string;
  wsUrl: string;
  projectId: string;
  environmentKind: EnvironmentKind;
}): Promise<void> {
  const environmentToken = args.environmentKind.toUpperCase();
  const thread = await createThread({
    baseUrl: args.baseUrl,
    projectId: args.projectId,
    environmentKind: args.environmentKind,
    inputText:
      `Reply with exactly ${environmentToken}-INITIAL and finish. ` +
      "Do not run commands or add extra text.",
  });

  const initialRoundTrip = await waitForIdleAfterTurnProgress(
    args.baseUrl,
    args.wsUrl,
    thread.id,
    {
      clientTurnStarts: 0,
      completedTurns: 0,
    },
    1,
    e2eTimeoutMs(20_000, 90_000),
  );
  expect(initialRoundTrip.thread.status).toBe("idle");

  await tellThread(
    args.baseUrl,
    thread.id,
    `Reply with exactly ${environmentToken}-FOLLOWUP and finish. Do not run commands or add extra text.`,
  );

  const followUpRoundTrip = await waitForIdleAfterTurnProgress(
    args.baseUrl,
    args.wsUrl,
    thread.id,
    initialRoundTrip.counts,
    1,
    e2eTimeoutMs(20_000, 90_000),
  );

  expect(followUpRoundTrip.thread.status).toBe("idle");
  expect(followUpRoundTrip.counts.clientTurnStarts).toBeGreaterThan(
    initialRoundTrip.counts.clientTurnStarts,
  );
  expect(followUpRoundTrip.counts.completedTurns).toBeGreaterThan(
    initialRoundTrip.counts.completedTurns,
  );
}

export async function runThreadImmediateFollowupsRoundtripScenario(): Promise<void> {
  const harness = await startDaemonE2eHarness({
    fakeCodex: {
      defaultTurnDelayMs: 25,
    },
    initGitRepo: true,
  });

  try {
    const project = await createProject(
      harness.baseUrl,
      harness.projectRoot,
      "immediate-followups-e2e-project",
    );

    await runImmediateFollowupScenario({
      baseUrl: harness.baseUrl,
      wsUrl: harness.wsUrl,
      projectId: project.id,
      environmentKind: "local",
    });

    await runImmediateFollowupScenario({
      baseUrl: harness.baseUrl,
      wsUrl: harness.wsUrl,
      projectId: project.id,
      environmentKind: "worktree",
    });
  } finally {
    await harness.cleanup();
  }
}
