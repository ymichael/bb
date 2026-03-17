import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { Project, Thread, ThreadEvent } from "@bb/core";
import {
  startDaemonE2eHarness,
  type DaemonE2eHarness,
} from "./harness.js";
import {
  readJson,
  waitForThreadCondition,
} from "./environment-agent-api.js";
import { supportsFakeCodexControl } from "./provider-mode.js";

function hasDocker(): boolean {
  const result = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
    stdio: "pipe",
  });
  return result.status === 0;
}

function normalizeEventType(type: string): string {
  return type.toLowerCase().replaceAll(".", "/");
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
      environmentCreationArgs: {
        kind: "docker",
      },
      input: [{
        type: "text",
        text: "Reply with exactly DOCKER-ROUNDTRIP and finish. Do not run commands or add extra text.",
      }],
    }),
  });
}

async function waitForThreadRoundTrip(
  baseUrl: string,
  wsUrl: string,
  threadId: string,
  timeoutMs: number = 20_000,
): Promise<{ thread: Thread; events: ThreadEvent[]; reachedActive: boolean }> {
  let reachedActive = false;
  return waitForThreadCondition({
    threadId,
    timeoutMs,
    wsUrl,
    load: async () => {
      const [thread, events] = await Promise.all([
        readJson<Thread>(`${baseUrl}/api/v1/threads/${threadId}`),
        readJson<ThreadEvent[]>(`${baseUrl}/api/v1/threads/${threadId}/events`),
      ]);
      if (thread.status === "active") {
        reachedActive = true;
      }
      return { thread, events };
    },
    isReady: ({ thread, events }) => {
      const normalizedTypes = events.map((event) => normalizeEventType(event.type));
      const sawTurnStarted = normalizedTypes.includes("turn/started");
      const sawTurnCompleted =
        normalizedTypes.includes("turn/completed") ||
        normalizedTypes.includes("turn/end");
      return thread.status === "idle" && (reachedActive || sawTurnStarted) && sawTurnCompleted;
    },
    describeLast: (snapshot) =>
      `Thread ${threadId} did not complete within ${timeoutMs}ms (status=${snapshot?.thread.status ?? "unknown"}, events=${JSON.stringify(snapshot?.events.map((event) => ({ type: normalizeEventType(event.type), data: event.data })) ?? [])})`,
  }).then(({ thread, events }) => ({
    thread,
    events,
    reachedActive,
  }));
}

const describeDocker =
  hasDocker() && supportsFakeCodexControl() ? describe.sequential : describe.sequential.skip;

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
      harness = await startDaemonE2eHarness({
        fakeCodex: {
          defaultTurnDelayMs: 0,
        },
        useWorkspaceFakeCodex: true,
        initGitRepo: true,
      });

      const project = await createProject(harness.baseUrl, harness.projectRoot);
      const thread = await createDockerThread(harness.baseUrl, project.id);
      const { events, reachedActive } = await waitForThreadRoundTrip(
        harness.baseUrl,
        harness.wsUrl,
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
