import { execFileSync } from "node:child_process";
import { expect } from "vitest";
import {
  createProviderEventEnvelope,
  type Thread,
  type ThreadEvent,
  type ThreadQueuedMessage,
} from "@beanbag/agent-core";
import { ENVIRONMENT_AGENT_SESSION_PROTOCOL } from "@beanbag/environment-agent";
import type { EnvironmentAgentSessionDebugView } from "./environment-agent-api.js";
import {
  allocateLocalPort,
  archiveThread,
  createProject,
  createThread,
  enqueueThreadFollowUp,
  listEnvironmentAgentSessions,
  listThreadEvents,
  readError,
  readJson,
  sendQueuedThreadFollowUp,
  sleep,
  tellThread,
  unarchiveThread,
  waitForThreadCondition,
  waitForThreadStatus,
} from "./environment-agent-api.js";
import { startDaemonE2eHarness } from "./harness.js";
import { e2eTimeoutMs } from "./provider-mode.js";

type EnvironmentKind = "local" | "worktree";

function debugLog(message: string): void {
  if (process.env.BEANBAG_E2E_DEBUG !== "1") {
    return;
  }
  console.info(`[thread-recovery-heavy-runbook] ${message}`);
}

function normalizeEventType(type: string): string {
  return type.toLowerCase().replaceAll(".", "/");
}

function countCompletedTurns(events: ThreadEvent[]): number {
  return events.filter((event) => {
    const normalized = normalizeEventType(event.type);
    return normalized === "turn/completed" || normalized === "turn/end";
  }).length;
}

function parseControlPort(session: EnvironmentAgentSessionDebugView): number {
  if (!session.controlBaseUrl) {
    throw new Error(`Session ${session.id} has no controlBaseUrl`);
  }
  const parsed = new URL(session.controlBaseUrl);
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port)) {
    throw new Error(`Invalid controlBaseUrl: ${session.controlBaseUrl}`);
  }
  return port;
}

function lookupListeningPid(port: number): number {
  const output = execFileSync(
    "lsof",
    ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
    { stdio: ["ignore", "pipe", "pipe"] },
  )
    .toString("utf8")
    .trim()
    .split(/\r?\n/)
    .find((entry) => entry.trim().length > 0);
  if (!output) {
    throw new Error(`Unable to find listening pid for port ${port}`);
  }
  const pid = Number.parseInt(output, 10);
  if (!Number.isFinite(pid)) {
    throw new Error(`Invalid pid from lsof output "${output}"`);
  }
  return pid;
}

function killSessionProcess(session: EnvironmentAgentSessionDebugView): void {
  const pid = lookupListeningPid(parseControlPort(session));
  process.kill(pid, "SIGKILL");
}

async function waitForThreadIdleWithAnotherTurn(args: {
  baseUrl: string;
  wsUrl: string;
  threadId: string;
  previousCompletedTurns: number;
  timeoutMs: number;
}): Promise<Thread> {
  return waitForThreadCondition({
    threadId: args.threadId,
    timeoutMs: args.timeoutMs,
    wsUrl: args.wsUrl,
    load: async () => {
      const [thread, events] = await Promise.all([
        readJson<Thread>(`${args.baseUrl}/api/v1/threads/${args.threadId}`),
        listThreadEvents(args.baseUrl, args.threadId),
      ]);
      return { thread, completedTurns: countCompletedTurns(events) };
    },
    isReady: ({ thread, completedTurns }) =>
      thread.status === "idle" && completedTurns > args.previousCompletedTurns,
    describeLast: (snapshot) =>
      `Thread ${args.threadId} did not complete another turn (status=${snapshot?.thread.status ?? "unknown"}, completedTurns=${snapshot?.completedTurns ?? -1})`,
  }).then(({ thread }) => thread);
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
      args.archived ? typeof thread.archivedAt === "number" : thread.archivedAt === undefined,
    describeLast: (thread) =>
      `Thread ${args.threadId} did not ${args.archived ? "archive" : "unarchive"} (archivedAt=${thread?.archivedAt ?? "none"}, status=${thread?.status ?? "unknown"})`,
  });
}

async function waitForMinimumSessionCount(args: {
  baseUrl: string;
  wsUrl: string;
  threadId: string;
  minimumCount: number;
  timeoutMs: number;
}): Promise<EnvironmentAgentSessionDebugView[]> {
  return waitForThreadCondition({
    threadId: args.threadId,
    timeoutMs: args.timeoutMs,
    wsUrl: args.wsUrl,
    load: async () => listEnvironmentAgentSessions(args.baseUrl, args.threadId),
    isReady: (payload) => payload.sessions.length >= args.minimumCount,
    describeLast: (payload) =>
      `Thread ${args.threadId} never reached ${args.minimumCount} session rows (actual=${payload?.sessions.length ?? 0})`,
  }).then((payload) => payload.sessions);
}

async function tellThreadWithRetry(args: {
  baseUrl: string;
  threadId: string;
  inputText: string;
}): Promise<void> {
  try {
    await tellThread(args.baseUrl, args.threadId, args.inputText);
  } catch {
    await sleep(250);
    await tellThread(args.baseUrl, args.threadId, args.inputText);
  }
}

async function driveFakeCodexTurnToCompletion(args: {
  harness: Awaited<ReturnType<typeof startDaemonE2eHarness>>;
  threadId: string;
  previousCompletedTurns: number;
  maxAttempts?: number;
}): Promise<Thread> {
  const maxAttempts = args.maxAttempts ?? 6;
  let lastThread: Thread | undefined;
  let lastCompletedTurns = args.previousCompletedTurns;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    args.harness.emitFakeCodexControlEvent();
    await sleep(250);

    const [thread, events] = await Promise.all([
      readJson<Thread>(`${args.harness.baseUrl}/api/v1/threads/${args.threadId}`),
      listThreadEvents(args.harness.baseUrl, args.threadId),
    ]);
    lastThread = thread;
    lastCompletedTurns = countCompletedTurns(events);
    if (thread.status === "idle" && lastCompletedTurns > args.previousCompletedTurns) {
      return thread;
    }

    await sleep(750);
  }

  throw new Error(
    `Thread ${args.threadId} did not complete a recovery turn after ${maxAttempts} fake-codex completion attempts ` +
      `(last status=${lastThread?.status ?? "unknown"}, completedTurns=${lastCompletedTurns})`,
  );
}

export async function runQueuedFollowUpWorkerLossScenario(
  environmentKind: EnvironmentKind,
): Promise<void> {
  debugLog(`queued-followup/${environmentKind}: start`);
  const port = await allocateLocalPort();
  let harness = await startDaemonE2eHarness({
    port,
    fakeCodex: {
      defaultTurnDelayMs: 25,
      defaultScenario: "start-then-manual-complete",
    },
    initGitRepo: true,
    preserveTempDirOnCleanup: true,
  });

  try {
    const project = await createProject(
      harness.baseUrl,
      harness.projectRoot,
      `queued-followup-recovery-${environmentKind}`,
    );
    const thread = await createThread(
      harness.baseUrl,
      project.id,
      `Reply with exactly QUEUE-BASE-${environmentKind.toUpperCase()} and finish.`,
      { environmentKind },
    );

    await waitForThreadStatus(
      harness.baseUrl,
      thread.id,
      "active",
      e2eTimeoutMs(8_000, 30_000),
      harness.wsUrl,
    );
    debugLog(`queued-followup/${environmentKind}: active`);

    const queued = await enqueueThreadFollowUp(
      harness.baseUrl,
      thread.id,
      `Reply with exactly QUEUED-RECOVERY-${environmentKind.toUpperCase()} and finish.`,
    );
    const threadAfterQueue = await readJson<Thread>(`${harness.baseUrl}/api/v1/threads/${thread.id}`);
    expect(threadAfterQueue.queuedMessages?.map((message) => message.id)).toContain(queued.id);

    const completedBeforeRestart = countCompletedTurns(
      await listThreadEvents(harness.baseUrl, thread.id),
    );
    const sessionsBeforeRestart = await listEnvironmentAgentSessions(harness.baseUrl, thread.id);
    const activeSession = sessionsBeforeRestart.sessions.find((session) => session.status === "active");
    expect(activeSession).toBeDefined();

    const tempDir = harness.tempDir;
    await harness.shutdownForRestart();
    killSessionProcess(activeSession!);

    harness = await startDaemonE2eHarness({
      tempDir,
      port,
      fakeCodex: {
        defaultTurnDelayMs: 25,
        defaultScenario: "start-then-manual-complete",
      },
      initGitRepo: true,
      preserveTempDirOnCleanup: true,
    });
    await sleep(250);

    await waitForThreadCondition({
      wsUrl: harness.wsUrl,
      threadId: thread.id,
      timeoutMs: e2eTimeoutMs(45_000, 75_000),
      load: async () => listEnvironmentAgentSessions(harness.baseUrl, thread.id),
      isReady: (sessions) =>
        sessions.sessions.every((session) => session.status !== "active"),
      describeLast: (sessions) =>
        `Thread ${thread.id} still has an active env-daemon session (${sessions?.sessions.map((session) => `${session.id}:${session.status}`).join(",") ?? "none"})`,
    });
    debugLog(`queued-followup/${environmentKind}: old session retired after missing worker`);

    const threadAfterWorkerLoss = await readJson<Thread>(`${harness.baseUrl}/api/v1/threads/${thread.id}`);
    expect(threadAfterWorkerLoss.queuedMessages?.map((message) => message.id)).toContain(queued.id);
    expect(
      countCompletedTurns(await listThreadEvents(harness.baseUrl, thread.id)),
    ).toBe(completedBeforeRestart);

    await sendQueuedThreadFollowUp(harness.baseUrl, thread.id, queued.id);
    await waitForThreadCondition({
      wsUrl: harness.wsUrl,
      threadId: thread.id,
      timeoutMs: e2eTimeoutMs(12_000, 30_000),
      load: async () => listEnvironmentAgentSessions(harness.baseUrl, thread.id),
      isReady: (sessions) =>
        sessions.sessions.some(
          (session) => session.status === "active" && session.id !== activeSession!.id,
        ),
      describeLast: (sessions) =>
        `Thread ${thread.id} never opened a fresh env-daemon session (sessions=${sessions?.sessions.map((session) => `${session.id}:${session.status}`).join(",") ?? "none"})`,
    });
    await waitForThreadStatus(
      harness.baseUrl,
      thread.id,
      "active",
      e2eTimeoutMs(8_000, 20_000),
      harness.wsUrl,
    );
    const recoveredThread = await driveFakeCodexTurnToCompletion({
      harness,
      threadId: thread.id,
      previousCompletedTurns: completedBeforeRestart,
    });
    expect(recoveredThread.status).toBe("idle");
    debugLog(`queued-followup/${environmentKind}: recovered`);

    const finalThread = await readJson<Thread>(`${harness.baseUrl}/api/v1/threads/${thread.id}`);
    expect(finalThread.queuedMessages?.map((message) => message.id) ?? []).not.toContain(queued.id);
  } finally {
    await harness.cleanup();
  }
}

export async function runArchiveAfterWorkerLossRecoveryScenario(): Promise<void> {
  debugLog("archive-after-worker-loss: start");
  const port = await allocateLocalPort();
  let harness = await startDaemonE2eHarness({
    port,
    fakeCodex: {
      defaultTurnDelayMs: 25,
      defaultScenario: "start-then-manual-complete",
    },
    initGitRepo: true,
    preserveTempDirOnCleanup: true,
  });

  try {
    const project = await createProject(
      harness.baseUrl,
      harness.projectRoot,
      "archive-after-worker-loss-recovery",
    );
    const thread = await createThread(
      harness.baseUrl,
      project.id,
      "Reply with exactly ARCHIVE-ERROR-BASE and finish.",
      { environmentKind: "worktree" },
    );

    await waitForThreadStatus(
      harness.baseUrl,
      thread.id,
      "active",
      e2eTimeoutMs(8_000, 30_000),
      harness.wsUrl,
    );
    debugLog("archive-after-worker-loss: active");

    const sessionsBeforeRestart = await listEnvironmentAgentSessions(harness.baseUrl, thread.id);
    const activeSession = sessionsBeforeRestart.sessions.find((session) => session.status === "active");
    expect(activeSession).toBeDefined();

    const tempDir = harness.tempDir;
    await harness.shutdownForRestart();
    killSessionProcess(activeSession!);

    harness = await startDaemonE2eHarness({
      tempDir,
      port,
      fakeCodex: {
        defaultTurnDelayMs: 25,
        defaultScenario: "start-then-manual-complete",
      },
      initGitRepo: true,
      preserveTempDirOnCleanup: true,
    });
    await sleep(250);

    const completedBeforeRecovery = countCompletedTurns(
      await listThreadEvents(harness.baseUrl, thread.id),
    );

    await waitForThreadCondition({
      wsUrl: harness.wsUrl,
      threadId: thread.id,
      timeoutMs: e2eTimeoutMs(45_000, 75_000),
      load: async () => listEnvironmentAgentSessions(harness.baseUrl, thread.id),
      isReady: (sessions) =>
        sessions.sessions.every((session) => session.status !== "active"),
      describeLast: (sessions) =>
        `Thread ${thread.id} still has an active env-daemon session (${sessions?.sessions.map((session) => `${session.id}:${session.status}`).join(",") ?? "none"})`,
    });
    debugLog("archive-after-worker-loss: old session retired after missing worker");

    await archiveThread(harness.baseUrl, thread.id);
    const archivedThread = await waitForArchivedState({
      baseUrl: harness.baseUrl,
      wsUrl: harness.wsUrl,
      threadId: thread.id,
      archived: true,
      timeoutMs: e2eTimeoutMs(8_000, 30_000),
    });
    expect(archivedThread.archivedAt).toBeTypeOf("number");
    debugLog("archive-after-worker-loss: archived");

    const sessionsWhileArchived = await listEnvironmentAgentSessions(harness.baseUrl, thread.id);
    expect(sessionsWhileArchived.sessions.filter((session) => session.status === "active")).toHaveLength(0);

    const archivedTellError = await readError(
      `${harness.baseUrl}/api/v1/threads/${thread.id}/tell`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: [{ type: "text", text: "This should fail while archived." }],
        }),
      },
    );
    expect(archivedTellError.status).toBe(409);
    expect(JSON.parse(archivedTellError.body) as { code?: string }).toMatchObject({
      code: "thread_archived",
    });

    await unarchiveThread(harness.baseUrl, thread.id);
    const unarchivedThread = await waitForArchivedState({
      baseUrl: harness.baseUrl,
      wsUrl: harness.wsUrl,
      threadId: thread.id,
      archived: false,
      timeoutMs: e2eTimeoutMs(8_000, 30_000),
    });
    expect(unarchivedThread.archivedAt).toBeUndefined();
    debugLog("archive-after-worker-loss: unarchived");

    await tellThreadWithRetry({
      baseUrl: harness.baseUrl,
      threadId: thread.id,
      inputText: "Reply with exactly ARCHIVE-AFTER-ERROR and finish. Do not run commands or add extra text.",
    });
    await waitForThreadCondition({
      wsUrl: harness.wsUrl,
      threadId: thread.id,
      timeoutMs: e2eTimeoutMs(12_000, 30_000),
      load: async () => listEnvironmentAgentSessions(harness.baseUrl, thread.id),
      isReady: (sessions) =>
        sessions.sessions.some(
          (session) => session.status === "active" && session.id !== activeSession!.id,
        ),
      describeLast: (sessions) =>
        `Thread ${thread.id} never opened a fresh env-daemon session (sessions=${sessions?.sessions.map((session) => `${session.id}:${session.status}`).join(",") ?? "none"})`,
    });
    await waitForThreadStatus(
      harness.baseUrl,
      thread.id,
      "active",
      e2eTimeoutMs(8_000, 20_000),
      harness.wsUrl,
    );
    const recoveredThread = await driveFakeCodexTurnToCompletion({
      harness,
      threadId: thread.id,
      previousCompletedTurns: completedBeforeRecovery,
    });
    expect(recoveredThread.status).toBe("idle");
    debugLog("archive-after-worker-loss: recovered");
  } finally {
    await harness.cleanup();
  }
}

async function postStaleEventBatch(args: {
  baseUrl: string;
  threadId: string;
  sessionId: string;
  eventId: string;
}): Promise<{ status: number; body: string }> {
  return readError(`${args.baseUrl}/api/v1/threads/${args.threadId}/env-daemon/session/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      protocol: ENVIRONMENT_AGENT_SESSION_PROTOCOL,
      messageId: `msg-${args.eventId}`,
      sentAt: Date.now(),
      sessionId: args.sessionId,
      type: "event_batch",
      payload: {
        batches: [
          {
            channelId: args.threadId,
            generation: 1,
            events: [
              {
                sequence: 999,
                eventId: args.eventId,
                emittedAt: Date.now(),
                event: createProviderEventEnvelope({
                  providerId: "codex",
                  method: "turn/completed",
                  payload: { turnId: "stale-turn" },
                }),
              },
            ],
          },
        ],
      },
    }),
  });
}

export async function runStaleOldSessionNoiseScenario(): Promise<void> {
  debugLog("stale-old-session-noise: start");
  const port = await allocateLocalPort();
  let harness = await startDaemonE2eHarness({
    port,
    fakeCodex: {
      defaultTurnDelayMs: 25,
      defaultScenario: "start-then-manual-complete",
    },
    initGitRepo: true,
    preserveTempDirOnCleanup: true,
  });

  try {
    const project = await createProject(harness.baseUrl, harness.projectRoot, "stale-old-session-noise");
    const thread = await createThread(
      harness.baseUrl,
      project.id,
      "Reply with exactly STALE-BASE and finish.",
      { environmentKind: "local" },
    );

    await waitForThreadStatus(
      harness.baseUrl,
      thread.id,
      "active",
      e2eTimeoutMs(8_000, 30_000),
      harness.wsUrl,
    );
    debugLog("stale-old-session-noise: active");

    const sessionsBeforeRestart = await listEnvironmentAgentSessions(harness.baseUrl, thread.id);
    const oldSession = sessionsBeforeRestart.sessions.find((session) => session.status === "active");
    expect(oldSession).toBeDefined();
    const completedBeforeRestart = countCompletedTurns(
      await listThreadEvents(harness.baseUrl, thread.id),
    );

    const tempDir = harness.tempDir;
    await harness.shutdownForRestart();
    killSessionProcess(oldSession!);

    harness = await startDaemonE2eHarness({
      tempDir,
      port,
      fakeCodex: {
        defaultTurnDelayMs: 25,
        defaultScenario: "start-then-manual-complete",
      },
      initGitRepo: true,
      preserveTempDirOnCleanup: true,
    });
    await sleep(250);

    await waitForThreadCondition({
      wsUrl: harness.wsUrl,
      threadId: thread.id,
      timeoutMs: e2eTimeoutMs(45_000, 75_000),
      load: async () => listEnvironmentAgentSessions(harness.baseUrl, thread.id),
      isReady: (sessions) =>
        sessions.sessions.every((session) => session.status !== "active"),
      describeLast: (sessions) =>
        `Thread ${thread.id} still has an active env-daemon session (${sessions?.sessions.map((session) => `${session.id}:${session.status}`).join(",") ?? "none"})`,
    });
    debugLog("stale-old-session-noise: old session retired after missing worker");

    await tellThreadWithRetry({
      baseUrl: harness.baseUrl,
      threadId: thread.id,
      inputText: "Reply with exactly STALE-RECOVERY and finish. Do not run commands or add extra text.",
    });

    await waitForMinimumSessionCount({
      baseUrl: harness.baseUrl,
      wsUrl: harness.wsUrl,
      threadId: thread.id,
      minimumCount: sessionsBeforeRestart.sessions.length + 1,
      timeoutMs: e2eTimeoutMs(12_000, 30_000),
    });
    await waitForThreadStatus(
      harness.baseUrl,
      thread.id,
      "active",
      e2eTimeoutMs(8_000, 20_000),
      harness.wsUrl,
    );

    const staleResult = await postStaleEventBatch({
      baseUrl: harness.baseUrl,
      threadId: thread.id,
      sessionId: oldSession!.id,
      eventId: "stale-event-1",
    });
    expect(staleResult.status).toBeGreaterThanOrEqual(400);
    debugLog(`stale-old-session-noise: stale event rejected with ${staleResult.status}`);

    const recoveredThread = await driveFakeCodexTurnToCompletion({
      harness,
      threadId: thread.id,
      previousCompletedTurns: completedBeforeRestart,
    });
    expect(recoveredThread.status).toBe("idle");
    debugLog("stale-old-session-noise: recovered");

    const completedAfterRecovery = countCompletedTurns(
      await listThreadEvents(harness.baseUrl, thread.id),
    );
    expect(completedAfterRecovery).toBe(completedBeforeRestart + 1);
  } finally {
    await harness.cleanup();
  }
}

export async function runThreadRecoveryHeavyRunbookScenario(): Promise<void> {
  for (const environmentKind of ["local", "worktree"] as const) {
    await runQueuedFollowUpWorkerLossScenario(environmentKind);
  }
  await runArchiveAfterWorkerLossRecoveryScenario();
  await runStaleOldSessionNoiseScenario();
}
