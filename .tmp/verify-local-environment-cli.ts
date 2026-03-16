import assert from "node:assert/strict";
import type { Project, Thread, ThreadEvent } from "@bb/core";
import {
  runCliCommand,
  startDaemonE2eHarness,
} from "../apps/server/src/__tests__/e2e/harness.ts";

function normalizeEventType(type: string): string {
  return type.toLowerCase().replaceAll(".", "/");
}

async function readJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`HTTP ${response.status}: ${body || response.statusText}`);
  }
  return (await response.json()) as T;
}

function parseThreadIdFromCliOutput(stdout: string): string {
  const match = stdout.match(/Thread spawned:\s+([A-Za-z0-9_-]+)/);
  if (!match) {
    throw new Error(`Unable to parse thread id from CLI output:\n${stdout}`);
  }
  return match[1];
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

async function waitForThreadCompletion(baseUrl: string, threadId: string): Promise<{ thread: Thread; events: ThreadEvent[] }> {
  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline) {
    const [thread, events] = await Promise.all([
      readJson<Thread>(`${baseUrl}/api/v1/threads/${threadId}`),
      readJson<ThreadEvent[]>(`${baseUrl}/api/v1/threads/${threadId}/events`),
    ]);

    const eventTypes = new Set(events.map((event) => normalizeEventType(event.type)));
    const done =
      thread.status === "idle" &&
      eventTypes.has("system/provisioning/completed") &&
      eventTypes.has("turn/completed");
    if (done) {
      return { thread, events };
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`Timed out waiting for thread ${threadId} to finish in local environment`);
}

async function main(): Promise<void> {
  const harness = await startDaemonE2eHarness({
    fakeCodex: { defaultTurnDelayMs: 25 },
    initGitRepo: true,
  });

  try {
    const project = await readJson<Project>(`${harness.baseUrl}/api/v1/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "verify-local-environment-project",
        rootPath: harness.projectRoot,
      }),
    });

    const cli = await runCliCommand({
      baseUrl: harness.baseUrl,
      args: ["thread", "spawn", "--prompt", "Verify local environment wiring."],
      env: {
        BB_PROJECT_ID: project.id,
        BB_ENVIRONMENT: "local",
      },
    });

    assert.equal(cli.exitCode, 0, `CLI exited with ${cli.exitCode}: ${cli.stderr}`);
    assert.equal(cli.signal, null, `CLI exited via signal ${cli.signal}`);
    assert.ok(!cli.stderr.includes("Error:"), `CLI stderr contained an error: ${cli.stderr}`);

    const threadId = parseThreadIdFromCliOutput(cli.stdout);
    const { thread, events } = await waitForThreadCompletion(harness.baseUrl, threadId);

    assert.equal(thread.projectId, project.id);
    assert.equal(thread.environmentId, "local");
    assert.equal(thread.status, "idle");

    const provisioningEvent = events.find(
      (event) => normalizeEventType(event.type) === "system/provisioning/completed",
    );
    const provisioningData = toRecord(provisioningEvent?.data);
    assert.equal(provisioningData?.environmentId, "local");
    assert.equal(provisioningData?.workspaceRoot, harness.projectRoot);

    console.log("Local environment CLI verification passed.");
    console.log(
      JSON.stringify(
        {
          projectId: project.id,
          threadId,
          threadStatus: thread.status,
          environmentId: thread.environmentId,
          workspaceRoot: provisioningData?.workspaceRoot,
          eventTypes: events.map((event) => normalizeEventType(event.type)),
        },
        null,
        2,
      ),
    );
  } finally {
    await harness.cleanup();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
