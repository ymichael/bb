import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { Thread, ThreadEvent } from "@beanbag/agent-core";
import {
  createProject,
  readJson,
  sleep,
} from "./environment-agent-api.js";
import {
  startDaemonE2eHarness,
  type DaemonE2eHarness,
} from "./harness.js";

interface TurnProgressCounts {
  clientTurnStarts: number;
  completedTurns: number;
}

function ensureEnvironmentAgentBundle(): void {
  execFileSync("pnpm", ["--filter", "@beanbag/environment-agent", "build"], {
    cwd: process.cwd(),
    stdio: "pipe",
  });
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

async function createWorktreeThread(
  baseUrl: string,
  projectId: string,
  inputText: string,
): Promise<Thread> {
  return readJson<Thread>(`${baseUrl}/api/v1/threads`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId,
      environmentId: "worktree",
      input: [{ type: "text", text: inputText }],
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
  threadId: string,
  previousCounts: TurnProgressCounts,
  timeoutMs: number = 20_000,
): Promise<{
  thread: Thread;
  events: ThreadEvent[];
  counts: TurnProgressCounts;
}> {
  const deadline = Date.now() + timeoutMs;
  let lastThread: Thread | undefined;
  let lastEvents: ThreadEvent[] = [];

  while (Date.now() < deadline) {
    const [thread, events] = await Promise.all([
      readJson<Thread>(`${baseUrl}/api/v1/threads/${threadId}`),
      readJson<ThreadEvent[]>(`${baseUrl}/api/v1/threads/${threadId}/events`),
    ]);
    lastThread = thread;
    lastEvents = events;

    const counts = measureTurnProgress(events);
    if (
      thread.status === "idle" &&
      counts.clientTurnStarts > previousCounts.clientTurnStarts &&
      counts.completedTurns > previousCounts.completedTurns
    ) {
      return {
        thread,
        events,
        counts,
      };
    }

    await sleep(40);
  }

  throw new Error(
    `Thread ${threadId} did not complete a new turn within ${timeoutMs}ms (status=${lastThread?.status ?? "unknown"}, counts=${JSON.stringify(measureTurnProgress(lastEvents))}, events=${lastEvents.map((event) => normalizeEventType(event.type)).join(",")})`,
  );
}

describe.sequential("e2e: worktree follow-up roundtrip", () => {
  let harness: DaemonE2eHarness | undefined;

  afterEach(async () => {
    if (harness) {
      await harness.cleanup();
      harness = undefined;
    }
  });

  it(
    "accepts a follow-up after an idle worktree thread restores its managed environment-agent",
    async () => {
      ensureEnvironmentAgentBundle();
      harness = await startDaemonE2eHarness({
        fakeCodex: {
          defaultTurnDelayMs: 25,
        },
        initGitRepo: true,
      });

      const project = await createProject(
        harness.baseUrl,
        harness.projectRoot,
        "worktree-followup-e2e-project",
      );
      const thread = await createWorktreeThread(
        harness.baseUrl,
        project.id,
        "Complete the initial worktree turn.",
      );

      expect(thread.environmentId).toBe("worktree");

      const initialRoundTrip = await waitForIdleAfterTurnProgress(
        harness.baseUrl,
        thread.id,
        {
          clientTurnStarts: 0,
          completedTurns: 0,
        },
      );
      expect(initialRoundTrip.thread.status).toBe("idle");

      await tellThread(
        harness.baseUrl,
        thread.id,
        "Continue with a follow-up after the first turn completed.",
      );

      const followUpRoundTrip = await waitForIdleAfterTurnProgress(
        harness.baseUrl,
        thread.id,
        initialRoundTrip.counts,
      );
      expect(followUpRoundTrip.thread.status).toBe("idle");
      expect(followUpRoundTrip.counts.clientTurnStarts).toBeGreaterThan(
        initialRoundTrip.counts.clientTurnStarts,
      );
      expect(followUpRoundTrip.counts.completedTurns).toBeGreaterThan(
        initialRoundTrip.counts.completedTurns,
      );
    },
    30_000,
  );
});
