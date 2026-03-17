import { execFileSync } from "node:child_process";
import { expect } from "vitest";
import type { Thread, ThreadEvent } from "@bb/core";
import type { EnvironmentAgentSessionDebugView } from "./environment-agent-api.js";
import {
  allocateLocalPort,
  createProject,
  createThread,
  listEnvironmentAgentSessions,
  listThreadEvents,
  readJson,
  sleep,
  tellThread,
  waitForThreadCondition,
  waitForThreadStatus,
} from "./environment-agent-api.js";
import { startDaemonE2eHarness } from "./harness.js";
import { e2eTimeoutMs } from "./provider-mode.js";

type EnvironmentKind = "local" | "worktree";

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
    throw new Error(`Session ${session.id} has an invalid controlBaseUrl: ${session.controlBaseUrl}`);
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
    throw new Error(`Unable to find a listening process for environment-agent port ${port}`);
  }

  const pid = Number.parseInt(output, 10);
  if (!Number.isFinite(pid)) {
    throw new Error(`Unable to parse environment-agent pid from "${output}"`);
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
      return {
        thread,
        completedTurns: countCompletedTurns(events),
      };
    },
    isReady: ({ thread, completedTurns }) =>
      thread.status === "idle" && completedTurns > args.previousCompletedTurns,
    describeLast: (snapshot) =>
      `Thread ${args.threadId} did not complete another turn (status=${snapshot?.thread.status ?? "unknown"}, completedTurns=${snapshot?.completedTurns ?? -1})`,
  }).then(({ thread }) => thread);
}

async function waitForSessionCount(args: {
  baseUrl: string;
  wsUrl: string;
  threadId: string;
  expectedCount: number;
  timeoutMs: number;
}): Promise<EnvironmentAgentSessionDebugView[]> {
  return waitForThreadCondition({
    threadId: args.threadId,
    timeoutMs: args.timeoutMs,
    wsUrl: args.wsUrl,
    load: async () => listEnvironmentAgentSessions(args.baseUrl, args.threadId),
    isReady: (payload) => payload.sessions.length === args.expectedCount,
    describeLast: (payload) =>
      `Thread ${args.threadId} never reached ${args.expectedCount} session rows (actual=${payload?.sessions.length ?? 0})`,
  }).then((payload) => payload.sessions);
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
      `Thread ${args.threadId} never reached at least ${args.minimumCount} session rows (actual=${payload?.sessions.length ?? 0})`,
  }).then((payload) => payload.sessions);
}

async function tellThreadWithRetry(args: {
  baseUrl: string;
  threadId: string;
  inputText: string;
}): Promise<void> {
  try {
    await tellThread(args.baseUrl, args.threadId, args.inputText);
  } catch (error) {
    await sleep(250);
    await tellThread(args.baseUrl, args.threadId, args.inputText);
  }
}

async function runMissingWorkerRestartRecoveryScenario(args: {
  environmentKind: EnvironmentKind;
}): Promise<void> {
  const port = await allocateLocalPort();
  let harness = await startDaemonE2eHarness({
    port,
    fakeCodex: {
      defaultTurnDelayMs: 2_000,
      defaultScenario: "turn-complete",
    },
    initGitRepo: true,
    preserveTempDirOnCleanup: true,
  });

  try {
    const project = await createProject(
      harness.baseUrl,
      harness.projectRoot,
      `restart-missing-worker-${args.environmentKind}`,
    );
    const thread = await createThread(
      harness.baseUrl,
      project.id,
      `Reply with exactly RESTART-${args.environmentKind.toUpperCase()} and finish.`,
      { environmentKind: args.environmentKind },
    );

    await waitForThreadStatus(
      harness.baseUrl,
      thread.id,
      "active",
      e2eTimeoutMs(8_000, 30_000),
      harness.wsUrl,
    );

    const sessionsBeforeRestart = await listEnvironmentAgentSessions(harness.baseUrl, thread.id);
    const activeSession = [...sessionsBeforeRestart.sessions]
      .reverse()
      .find((session) => session.status === "active");
    expect(activeSession).toBeDefined();

    const completedTurnsBeforeRestart = countCompletedTurns(
      await listThreadEvents(harness.baseUrl, thread.id),
    );

    const tempDir = harness.tempDir;
    await harness.shutdownForRestart();
    killSessionProcess(activeSession!);

    harness = await startDaemonE2eHarness({
      tempDir,
      port,
      fakeCodex: {
        defaultTurnDelayMs: 2_000,
        defaultScenario: "turn-complete",
      },
      initGitRepo: true,
      preserveTempDirOnCleanup: true,
    });

    await waitForThreadCondition({
      threadId: thread.id,
      timeoutMs: e2eTimeoutMs(45_000, 75_000),
      wsUrl: harness.wsUrl,
      load: async () => listEnvironmentAgentSessions(harness.baseUrl, thread.id),
      isReady: (sessions) =>
        sessions.sessions.every((session) => session.status !== "active"),
      describeLast: (sessions) =>
        `Thread ${thread.id} still has an active env-daemon session (${sessions?.sessions.map((session) => `${session.id}:${session.status}`).join(",") ?? "none"})`,
    });

    const errorEvents = await listThreadEvents(harness.baseUrl, thread.id);
    expect(countCompletedTurns(errorEvents)).toBe(completedTurnsBeforeRestart);
    const sessionsBeforeRecoveryFollowUp = await listEnvironmentAgentSessions(
      harness.baseUrl,
      thread.id,
    );

    await tellThreadWithRetry({
      baseUrl: harness.baseUrl,
      threadId: thread.id,
      inputText:
        `Reply with exactly AFTER-ERROR-${args.environmentKind.toUpperCase()} and finish. ` +
        "Do not run commands or add extra text.",
    });

    await waitForThreadCondition({
      threadId: thread.id,
      timeoutMs: e2eTimeoutMs(12_000, 30_000),
      wsUrl: harness.wsUrl,
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
    const recoveredThread = await waitForThreadIdleWithAnotherTurn({
      baseUrl: harness.baseUrl,
      wsUrl: harness.wsUrl,
      threadId: thread.id,
      previousCompletedTurns: completedTurnsBeforeRestart,
      timeoutMs: e2eTimeoutMs(12_000, 30_000),
    });
    expect(recoveredThread.status).toBe("idle");
  } finally {
    await harness.cleanup();
  }
}

async function runIdleRestartFreshSessionScenario(args: {
  environmentKind: EnvironmentKind;
}): Promise<void> {
  const port = await allocateLocalPort();
  let harness = await startDaemonE2eHarness({
    port,
    fakeCodex: {
      defaultTurnDelayMs: 25,
      defaultScenario: "turn-complete",
    },
    initGitRepo: true,
    preserveTempDirOnCleanup: true,
  });

  try {
    const project = await createProject(
      harness.baseUrl,
      harness.projectRoot,
      `restart-idle-session-${args.environmentKind}`,
    );
    const thread = await createThread(
      harness.baseUrl,
      project.id,
      `Reply with exactly IDLE-${args.environmentKind.toUpperCase()} and finish.`,
      { environmentKind: args.environmentKind },
    );

    await waitForThreadStatus(
      harness.baseUrl,
      thread.id,
      "idle",
      e2eTimeoutMs(12_000, 45_000),
      harness.wsUrl,
    );
    const sessionsBeforeRestart = await listEnvironmentAgentSessions(harness.baseUrl, thread.id);
    const previousSessionCount = sessionsBeforeRestart.sessions.length;
    const previousLatestSession = sessionsBeforeRestart.sessions.at(-1);
    expect(previousLatestSession).toBeDefined();

    const completedTurnsBeforeFollowUp = countCompletedTurns(
      await listThreadEvents(harness.baseUrl, thread.id),
    );

    const tempDir = harness.tempDir;
    await harness.shutdownForRestart();

    harness = await startDaemonE2eHarness({
      tempDir,
      port,
      fakeCodex: {
        defaultTurnDelayMs: 25,
        defaultScenario: "turn-complete",
      },
      initGitRepo: true,
      preserveTempDirOnCleanup: true,
    });

    await sleep(250);
    await tellThreadWithRetry({
      baseUrl: harness.baseUrl,
      threadId: thread.id,
      inputText:
        `Reply with exactly IDLE-FOLLOWUP-${args.environmentKind.toUpperCase()} and finish. ` +
        "Do not run commands or add extra text.",
    });

    await waitForMinimumSessionCount({
      baseUrl: harness.baseUrl,
      wsUrl: harness.wsUrl,
      threadId: thread.id,
      minimumCount: previousSessionCount,
      timeoutMs: e2eTimeoutMs(10_000, 30_000),
    });

    const recoveredThread = await waitForThreadIdleWithAnotherTurn({
      baseUrl: harness.baseUrl,
      wsUrl: harness.wsUrl,
      threadId: thread.id,
      previousCompletedTurns: completedTurnsBeforeFollowUp,
      timeoutMs: e2eTimeoutMs(15_000, 45_000),
    });
    expect(recoveredThread.status).toBe("idle");

    const sessionsAfterRestart = await listEnvironmentAgentSessions(harness.baseUrl, thread.id);
    expect(sessionsAfterRestart.sessions.length).toBeGreaterThanOrEqual(previousSessionCount);
    expect(
      sessionsAfterRestart.sessions.filter((session) => session.status === "active").length,
    ).toBeLessThanOrEqual(1);
    if (sessionsAfterRestart.sessions.length > previousSessionCount) {
      expect(
        sessionsAfterRestart.sessions.some(
          (session) => session.id === previousLatestSession?.id && session.status === "active",
        ),
      ).toBe(false);
    }
  } finally {
    await harness.cleanup();
  }
}

export async function runThreadRestartRecoveryMatrixScenario(): Promise<void> {
  const environments: readonly EnvironmentKind[] = ["local", "worktree"];

  for (const environmentKind of environments) {
    await runMissingWorkerRestartRecoveryScenario({ environmentKind });
    await runIdleRestartFreshSessionScenario({ environmentKind });
  }
}
