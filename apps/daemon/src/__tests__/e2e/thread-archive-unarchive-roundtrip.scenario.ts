import { expect } from "vitest";
import type { Thread, ThreadEvent } from "@beanbag/agent-core";
import {
  createProject,
  createThread,
  listThreadEvents,
  readError,
  readJson,
  waitForThreadCondition,
  waitForThreadStatus,
} from "./environment-agent-api.js";
import {
  startDaemonE2eHarness,
} from "./harness.js";

function normalizeEventType(type: string): string {
  return type.toLowerCase().replaceAll(".", "/");
}

function countCompletedTurns(events: ThreadEvent[]): number {
  return events.filter((event) => {
    const normalizedType = normalizeEventType(event.type);
    return normalizedType === "turn/completed" || normalizedType === "turn/end";
  }).length;
}

async function archiveThread(baseUrl: string, threadId: string): Promise<void> {
  await readJson<{ ok: boolean }>(`${baseUrl}/api/v1/threads/${threadId}/archive`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
}

async function unarchiveThread(baseUrl: string, threadId: string): Promise<void> {
  await readJson<{ ok: boolean }>(`${baseUrl}/api/v1/threads/${threadId}/unarchive`, {
    method: "POST",
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

async function waitForArchivedState(
  baseUrl: string,
  wsUrl: string,
  threadId: string,
  archived: boolean,
  timeoutMs: number = 8_000,
): Promise<Thread> {
  return waitForThreadCondition({
    threadId,
    timeoutMs,
    wsUrl,
    load: async () => readJson<Thread>(`${baseUrl}/api/v1/threads/${threadId}`),
    isReady: (thread) =>
      archived ? typeof thread.archivedAt === "number" : thread.archivedAt === undefined,
    describeLast: (thread) =>
      `Thread ${threadId} did not ${archived ? "archive" : "unarchive"} within ${timeoutMs}ms (status=${thread?.status ?? "unknown"}, archivedAt=${thread?.archivedAt ?? "none"})`,
  });
}

async function waitForCompletedTurnAfterUnarchive(
  baseUrl: string,
  wsUrl: string,
  threadId: string,
  previousCompletedTurns: number,
  timeoutMs: number = 12_000,
): Promise<{ thread: Thread; completedTurns: number }> {
  return waitForThreadCondition({
    threadId,
    timeoutMs,
    wsUrl,
    load: async () => {
      const [thread, events] = await Promise.all([
        readJson<Thread>(`${baseUrl}/api/v1/threads/${threadId}`),
        listThreadEvents(baseUrl, threadId),
      ]);
      return {
        thread,
        completedTurns: countCompletedTurns(events),
      };
    },
    isReady: ({ thread, completedTurns }) =>
      thread.status === "idle" && completedTurns > previousCompletedTurns,
    describeLast: (snapshot) =>
      `Thread ${threadId} did not finish a new turn after unarchive within ${timeoutMs}ms (status=${snapshot?.thread.status ?? "unknown"}, completedTurns=${snapshot?.completedTurns ?? 0})`,
  });
}

export async function runThreadArchiveUnarchiveRoundtripScenario(): Promise<void> {
  const harness = await startDaemonE2eHarness({
    fakeCodex: {
      defaultTurnDelayMs: 25,
    },
  });

  try {
    const project = await createProject(
      harness.baseUrl,
      harness.projectRoot,
      "e2e-archive-unarchive-project",
    );
    const thread = await createThread(
      harness.baseUrl,
      project.id,
      "Finish the initial roundtrip before archive coverage.",
    );

    await waitForThreadStatus(harness.baseUrl, thread.id, "idle", 12_000, harness.wsUrl);

    const initialEvents = await listThreadEvents(harness.baseUrl, thread.id);
    const initialCompletedTurns = countCompletedTurns(initialEvents);
    expect(initialCompletedTurns).toBeGreaterThan(0);

    await archiveThread(harness.baseUrl, thread.id);
    const archivedThread = await waitForArchivedState(
      harness.baseUrl,
      harness.wsUrl,
      thread.id,
      true,
    );
    expect(archivedThread.archivedAt).toBeTypeOf("number");

    const archivedTellError = await readError(
      `${harness.baseUrl}/api/v1/threads/${thread.id}/tell`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: [{ type: "text", text: "This tell should be rejected while archived." }],
        }),
      },
    );
    expect(archivedTellError.status).toBe(409);
    expect(JSON.parse(archivedTellError.body) as { code?: string }).toMatchObject({
      code: "thread_archived",
    });

    await unarchiveThread(harness.baseUrl, thread.id);
    const unarchivedThread = await waitForArchivedState(
      harness.baseUrl,
      harness.wsUrl,
      thread.id,
      false,
    );
    expect(unarchivedThread.archivedAt).toBeUndefined();

    await tellThread(
      harness.baseUrl,
      thread.id,
      "Continue with a follow-up after the archive roundtrip.",
    );

    const followUp = await waitForCompletedTurnAfterUnarchive(
      harness.baseUrl,
      harness.wsUrl,
      thread.id,
      initialCompletedTurns,
    );
    expect(followUp.thread.status).toBe("idle");
    expect(followUp.completedTurns).toBeGreaterThan(initialCompletedTurns);
  } finally {
    await harness.cleanup();
  }
}
