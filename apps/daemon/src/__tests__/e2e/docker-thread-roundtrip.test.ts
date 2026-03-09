import { execFileSync, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { Project, Thread, ThreadEvent } from "@beanbag/agent-core";
import {
  startDaemonE2eHarness,
  type DaemonE2eHarness,
} from "./harness.js";

function hasDocker(): boolean {
  const result = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
    stdio: "pipe",
  });
  return result.status === 0;
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
      name: "docker-e2e-daemon-project",
      rootPath,
    }),
  });
}

async function createDockerThread(baseUrl: string, projectId: string): Promise<Thread> {
  return readJson<Thread>(`${baseUrl}/api/v1/threads`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId,
      environmentId: "docker",
      input: [{ type: "text", text: "Implement docker daemon coverage." }],
    }),
  });
}

async function waitForThreadRoundTrip(
  baseUrl: string,
  threadId: string,
  timeoutMs: number = 20_000,
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

    await sleep(50);
  }

  throw new Error(
    `Thread ${threadId} did not complete within ${timeoutMs}ms (status=${lastThread?.status ?? "unknown"}, events=${JSON.stringify(lastEvents.map((event) => ({ type: normalizeEventType(event.type), data: event.data })))})`,
  );
}

const describeDocker = hasDocker() ? describe.sequential : describe.sequential.skip;

describeDocker("e2e: daemon -> docker environment", () => {
  let harness: DaemonE2eHarness | undefined;

  afterEach(async () => {
    if (harness) {
      await harness.cleanup();
      harness = undefined;
    }
  });

  it(
    "spawns a docker-backed thread and completes a provider roundtrip inside the container",
    async () => {
      ensureEnvironmentAgentBundle();
      harness = await startDaemonE2eHarness({
        fakeCodex: {
          defaultTurnDelayMs: 25,
        },
        useWorkspaceFakeCodex: true,
        initGitRepo: true,
      });

      const project = await createProject(harness.baseUrl, harness.projectRoot);
      const thread = await createDockerThread(harness.baseUrl, project.id);
      const { events, reachedActive } = await waitForThreadRoundTrip(
        harness.baseUrl,
        thread.id,
      );

      expect(reachedActive).toBe(true);

      const eventTypes = events.map((event) => normalizeEventType(event.type));
      expect(eventTypes).toContain("thread/started");
      expect(eventTypes).toContain("turn/started");
      expect(eventTypes).toContain("turn/completed");
      expect(eventTypes).toContain("item/completed");
    },
    90_000,
  );
});
