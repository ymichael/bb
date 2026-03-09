import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  Project,
  Thread,
  ThreadTimelineResponse,
} from "@beanbag/agent-core";
import {
  startDaemonE2eHarness,
  type DaemonE2eHarness,
} from "./harness.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function readJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`HTTP ${response.status}: ${body || response.statusText}`);
  }
  return (await response.json()) as T;
}

async function timedJson<T>(
  url: string,
  init?: RequestInit,
): Promise<{ elapsedMs: number; data: T }> {
  const startedAt = Date.now();
  const data = await readJson<T>(url, init);
  return {
    elapsedMs: Date.now() - startedAt,
    data,
  };
}

async function createProject(baseUrl: string, rootPath: string): Promise<Project> {
  return readJson<Project>(`${baseUrl}/api/v1/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "e2e-provisioning-project",
      rootPath,
    }),
  });
}

async function waitForThreadToLeaveProvisioning(
  baseUrl: string,
  threadId: string,
  timeoutMs: number = 8_000,
): Promise<Thread> {
  const deadline = Date.now() + timeoutMs;
  let lastThread: Thread | undefined;

  while (Date.now() < deadline) {
    const thread = await readJson<Thread>(`${baseUrl}/api/v1/threads/${threadId}`);
    lastThread = thread;
    if (thread.status !== "created" && thread.status !== "provisioning") {
      return thread;
    }
    await sleep(40);
  }

  throw new Error(
    `Thread ${threadId} stayed in provisioning too long (last status=${lastThread?.status ?? "unknown"})`,
  );
}

describe.sequential("e2e: thread detail stays responsive while provisioning", () => {
  let harness: DaemonE2eHarness | undefined;

  afterEach(async () => {
    if (harness) {
      await harness.cleanup();
      harness = undefined;
    }
  });

  it(
    "serves thread and timeline requests while worktree provisioning is still in flight",
    async () => {
      harness = await startDaemonE2eHarness({
        fakeCodex: {
          defaultTurnDelayMs: 10,
        },
      });

      git(harness.projectRoot, "init", "-b", "main");
      git(harness.projectRoot, "config", "user.name", "Beanbag");
      git(harness.projectRoot, "config", "user.email", "beanbag@example.com");
      writeFileSync(join(harness.projectRoot, "README.md"), "hello\n", "utf8");
      writeFileSync(
        join(harness.projectRoot, ".bb-env-setup.sh"),
        "#!/usr/bin/env sh\nsleep 2\n",
        { encoding: "utf8", mode: 0o755 },
      );
      git(harness.projectRoot, "add", "README.md", ".bb-env-setup.sh");
      git(harness.projectRoot, "commit", "-m", "init");

      const project = await createProject(harness.baseUrl, harness.projectRoot);
      const thread = await readJson<Thread>(`${harness.baseUrl}/api/v1/threads`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: project.id,
          environmentId: "worktree",
          input: [{ type: "text", text: "Verify provisioning responsiveness." }],
        }),
      });

      expect(thread.status).toBe("created");

      await sleep(150);

      const [threadResult, timelineResult] = await Promise.all([
        timedJson<Thread>(`${harness.baseUrl}/api/v1/threads/${thread.id}`),
        timedJson<ThreadTimelineResponse>(
          `${harness.baseUrl}/api/v1/threads/${thread.id}/timeline`,
        ),
      ]);

      expect(threadResult.elapsedMs).toBeLessThan(1_000);
      expect(timelineResult.elapsedMs).toBeLessThan(1_000);
      expect(threadResult.data.status).toBe("provisioning");
      await expect
        .poll(async () => {
          const timeline = await readJson<ThreadTimelineResponse>(
            `${harness.baseUrl}/api/v1/threads/${thread.id}/timeline`,
          );
          return timeline.rows.some(
            (row) =>
              row.kind === "message" &&
              row.message.kind === "operation" &&
              row.message.opType === "provisioning",
          );
        })
        .toBe(true);

      const completedThread = await waitForThreadToLeaveProvisioning(
        harness.baseUrl,
        thread.id,
      );
      expect(["active", "idle"]).toContain(completedThread.status);
    },
    15_000,
  );
});
