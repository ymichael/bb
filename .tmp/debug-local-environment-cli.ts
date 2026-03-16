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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
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
        name: "debug-local-environment-project",
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

    const threadId = parseThreadIdFromCliOutput(cli.stdout);
    console.log("cli", JSON.stringify(cli, null, 2));
    console.log("threadId", threadId);

    for (let i = 0; i < 10; i += 1) {
      await sleep(500);
      const [thread, events] = await Promise.all([
        readJson<Thread>(`${harness.baseUrl}/api/v1/threads/${threadId}`),
        readJson<ThreadEvent[]>(`${harness.baseUrl}/api/v1/threads/${threadId}/events`),
      ]);
      console.log(`snapshot ${i}`);
      console.log(JSON.stringify(thread, null, 2));
      console.log(
        JSON.stringify(
          events.map((event) => ({
            type: normalizeEventType(event.type),
            data: event.data,
          })),
          null,
          2,
        ),
      );
    }
  } finally {
    await harness.cleanup();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
