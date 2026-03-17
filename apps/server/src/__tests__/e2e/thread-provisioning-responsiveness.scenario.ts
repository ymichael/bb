import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import type {
  Project,
  Thread,
  ThreadTimelineResponse,
} from "@bb/core";
import {
  startDaemonE2eHarness,
} from "./harness.js";
import { waitForThreadCondition } from "./environment-agent-api.js";
import { e2eTimeoutMs } from "./provider-mode.js";

const TEST_GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "BB",
  GIT_AUTHOR_EMAIL: "bb@example.com",
  GIT_COMMITTER_NAME: "BB",
  GIT_COMMITTER_EMAIL: "bb@example.com",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: TEST_GIT_ENV,
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

async function waitForThreadToEnterProvisioning(
  baseUrl: string,
  wsUrl: string,
  threadId: string,
  timeoutMs: number = 2_000,
): Promise<Thread> {
  return waitForThreadCondition({
    threadId,
    timeoutMs,
    wsUrl,
    load: async () => readJson<Thread>(`${baseUrl}/api/v1/threads/${threadId}`),
    isReady: (thread) => thread.status === "provisioning",
    describeLast: (thread) =>
      `Thread ${threadId} did not enter provisioning (last status=${thread?.status ?? "unknown"})`,
  });
}

export async function runThreadProvisioningResponsivenessScenario(): Promise<void> {
  const harness = await startDaemonE2eHarness({
    fakeCodex: {
      defaultTurnDelayMs: 10,
    },
  });

  try {
    git(harness.projectRoot, "init", "-b", "main");
    writeFileSync(join(harness.projectRoot, "README.md"), "hello\n", "utf8");
    const setupReadyPath = join(harness.tempDir, "env-setup-ready");
    writeFileSync(
      join(harness.projectRoot, ".bb-env-setup.sh"),
      `#!/usr/bin/env sh
while [ ! -f '${setupReadyPath}' ]; do
  sleep 0.05
done
`,
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
        environmentCreationArgs: {
          kind: "worktree",
        },
        input: [{
          type: "text",
          text: "Reply with exactly PROVISIONING-READY and finish. Do not run commands or add extra text.",
        }],
      }),
    });

    expect(thread.status).toBe("created");

    await waitForThreadToEnterProvisioning(
      harness.baseUrl,
      harness.wsUrl,
      thread.id,
      e2eTimeoutMs(2_000, 20_000),
    );

    const [threadResult, timelineResult] = await Promise.all([
      timedJson<Thread>(`${harness.baseUrl}/api/v1/threads/${thread.id}`),
      timedJson<ThreadTimelineResponse>(
        `${harness.baseUrl}/api/v1/threads/${thread.id}/timeline`,
      ),
    ]);

    expect(threadResult.elapsedMs).toBeLessThan(1_000);
    expect(timelineResult.elapsedMs).toBeLessThan(1_000);
    expect(threadResult.data.status).toBe("provisioning");
    expect(timelineResult.data.rows.length).toBeGreaterThan(0);

    expect(existsSync(setupReadyPath)).toBe(false);
    writeFileSync(setupReadyPath, "ready\n", "utf8");

    const completedThread = await waitForThreadCondition({
      threadId: thread.id,
      timeoutMs: e2eTimeoutMs(8_000, 60_000),
      wsUrl: harness.wsUrl,
      load: async () =>
        readJson<Thread>(`${harness.baseUrl}/api/v1/threads/${thread.id}`),
      isReady: (nextThread) => nextThread.status === "idle",
      describeLast: (nextThread) =>
        `Thread ${thread.id} did not complete its initial turn (last status=${nextThread?.status ?? "unknown"})`,
    });
    expect(completedThread.status).toBe("idle");
  } finally {
    await harness.cleanup();
  }
}
