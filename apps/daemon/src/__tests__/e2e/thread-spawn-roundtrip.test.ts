import { afterEach, describe, expect, it } from "vitest";
import type { Project, Thread, ThreadEvent } from "@beanbag/agent-core";
import {
  runCliCommand,
  startDaemonE2eHarness,
  type DaemonE2eHarness,
} from "./harness.js";

function normalizeEventType(type: string): string {
  return type.toLowerCase().replaceAll(".", "/");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`HTTP ${response.status}: ${body || response.statusText}`);
  }
  return (await response.json()) as T;
}

async function createProject(baseUrl: string, rootPath: string): Promise<Project> {
  return readJson<Project>(`${baseUrl}/api/v1/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "e2e-daemon-project",
      rootPath,
    }),
  });
}

function parseThreadIdFromCliOutput(stdout: string): string {
  const match = stdout.match(/Thread spawned:\s+([A-Za-z0-9_-]+)/);
  if (!match) {
    throw new Error(`Unable to parse thread id from CLI output:\n${stdout}`);
  }
  return match[1];
}

async function waitForThreadRoundTrip(
  baseUrl: string,
  threadId: string,
  timeoutMs: number = 8_000,
): Promise<{ thread: Thread; events: ThreadEvent[]; reachedActive: boolean }> {
  const deadline = Date.now() + timeoutMs;
  let reachedActive = false;
  let lastThread: Thread | undefined;
  let lastEvents: ThreadEvent[] = [];

  while (Date.now() < deadline) {
    const [thread, events] = await Promise.all([
      readJson<Thread>(`${baseUrl}/api/v1/threads/${threadId}`),
      readJson<ThreadEvent[]>(`${baseUrl}/api/v1/threads/${threadId}/events`),
    ]);
    lastThread = thread;
    lastEvents = events;

    if (thread.status === "active") {
      reachedActive = true;
    }

    const normalizedTypes = events.map((event) => normalizeEventType(event.type));
    const sawTurnStarted = normalizedTypes.includes("turn/started");
    const sawTurnCompleted =
      normalizedTypes.includes("turn/completed") ||
      normalizedTypes.includes("turn/end");
    const reachedActiveOrStarted = reachedActive || sawTurnStarted;

    if (thread.status === "idle" && reachedActiveOrStarted && sawTurnCompleted) {
      return {
        thread,
        events,
        reachedActive: reachedActiveOrStarted,
      };
    }

    await sleep(40);
  }

  throw new Error(
    `Thread ${threadId} did not complete within ${timeoutMs}ms (status=${lastThread?.status ?? "unknown"}, actions=${JSON.stringify(lastThread?.builtInActions)}, events=${lastEvents.map((event) => normalizeEventType(event.type)).join(",")})`,
  );
}

describe.sequential("e2e: CLI -> HTTP -> daemon -> agent -> API", () => {
  let harness: DaemonE2eHarness | undefined;

  afterEach(async () => {
    if (harness) {
      await harness.cleanup();
      harness = undefined;
    }
  });

  it(
    "spawns a thread via CLI and records outbound + lifecycle events",
    async () => {
      harness = await startDaemonE2eHarness({
        fakeCodex: {
          defaultTurnDelayMs: 25,
        },
      });

      const project = await createProject(harness.baseUrl, harness.projectRoot);

      const cli = await runCliCommand({
        baseUrl: harness.baseUrl,
        args: [
          "thread",
          "spawn",
          "--project",
          project.id,
          "--prompt",
          "Implement deterministic e2e daemon coverage.",
        ],
      });

      expect(cli.exitCode).toBe(0);
      expect(cli.signal).toBeNull();
      expect(cli.stderr).not.toContain("Error:");

      const threadId = parseThreadIdFromCliOutput(cli.stdout);

      const { thread, events, reachedActive } = await waitForThreadRoundTrip(
        harness.baseUrl,
        threadId,
      );
      expect(reachedActive).toBe(true);
      expect(thread.projectId).toBe(project.id);
      expect(thread.status).toBe("idle");

      const eventTypes = events.map((event) => normalizeEventType(event.type));
      expect(eventTypes).toContain("client/thread/start");
      expect(eventTypes).toContain("client/turn/start");
      expect(eventTypes).toContain("turn/started");
      expect(eventTypes).toContain("turn/completed");
      expect(eventTypes.indexOf("turn/started")).toBeLessThan(
        eventTypes.indexOf("turn/completed"),
      );
    },
    15_000,
  );
});
