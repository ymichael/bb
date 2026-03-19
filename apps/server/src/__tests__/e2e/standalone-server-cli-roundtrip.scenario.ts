import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import {
  createProject,
  listThreadEvents,
  readJson,
  sleep,
  waitForThreadCondition,
  waitForThreadStatus,
} from "./environment-daemon-api.js";
import { createFakeCodexBinDir } from "./fake-codex.js";
import { bbTestTmpPrefix } from "./temp-root.js";
import {
  runCliCommand,
  type CliRunResult,
  withFakeE2eEnvironmentDaemonTimingEnv,
} from "./harness.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WORKSPACE_ROOT = resolve(__dirname, "..", "..", "..", "..", "..");
const TEST_GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "BB Test",
  GIT_AUTHOR_EMAIL: "bb-test@example.com",
  GIT_COMMITTER_NAME: "BB Test",
  GIT_COMMITTER_EMAIL: "bb-test@example.com",
};

import {
  startStandaloneServer,
  collectChildPids,
  type StandaloneServerHandle,
} from "./standalone-server.js";

type EnvironmentKind = "local" | "worktree";

function prependPathEntry(pathValue: string | undefined, entryToPrepend: string): string {
  const entries = (pathValue ?? "")
    .split(delimiter)
    .filter((entry) => entry.length > 0 && entry !== entryToPrepend);
  return [entryToPrepend, ...entries].join(delimiter);
}

async function allocatePort(host: string = "127.0.0.1"): Promise<number> {
  return new Promise<number>((resolvePort, rejectPort) => {
    const server = createNetServer();
    server.once("error", rejectPort);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => rejectPort(new Error("Failed to allocate standalone server port")));
        return;
      }
      server.close((error) => {
        if (error) {
          rejectPort(error);
          return;
        }
        resolvePort(address.port);
      });
    });
  });
}

async function waitForHealth(baseUrl: string, timeoutMs: number = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/v1/system/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // Server still starting.
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
  }
  throw new Error(`Timed out waiting for standalone server health at ${baseUrl}`);
}

// startStandaloneServer, collectChildPids, StandaloneServerHandle imported from ./standalone-server.js

function parseThreadIdFromCliOutput(stdout: string): string {
  const match = stdout.match(/Thread spawned:\s+([A-Za-z0-9_-]+)/);
  if (!match) {
    throw new Error(`Unable to parse thread id from CLI output:\n${stdout}`);
  }
  return match[1];
}

function normalizeEventType(type: string): string {
  return type.toLowerCase().replaceAll(".", "/");
}

function countCompletedTurns(events: Awaited<ReturnType<typeof listThreadEvents>>): number {
  return events.filter((event) => {
    const normalized = normalizeEventType(event.type);
    return normalized === "turn/completed" || normalized === "turn/end";
  }).length;
}

function countStartedTurns(events: Awaited<ReturnType<typeof listThreadEvents>>): number {
  return events.filter((event) => normalizeEventType(event.type) === "turn/started").length;
}

async function waitForNextTurnStarted(
  baseUrl: string,
  wsUrl: string,
  threadId: string,
  previousStartedTurns: number,
): Promise<void> {
  await waitForThreadCondition({
    threadId,
    timeoutMs: 15_000,
    wsUrl,
    load: async () => listThreadEvents(baseUrl, threadId),
    isReady: (events) => countStartedTurns(events) > previousStartedTurns,
    describeLast: (events) =>
      `Thread ${threadId} never emitted another turn/started (started=${countStartedTurns(events ?? [])}, events=${events?.map((event) => normalizeEventType(event.type)).join(",") ?? ""})`,
  });
}

async function waitForIdleWithAnotherTurn(
  baseUrl: string,
  wsUrl: string,
  threadId: string,
  previousCompletedTurns: number,
): Promise<void> {
  await waitForThreadCondition({
    threadId,
    timeoutMs: 20_000,
    wsUrl,
    load: async () => {
      const [thread, events] = await Promise.all([
        readJson<{ status: string }>(`${baseUrl}/api/v1/threads/${threadId}`),
        listThreadEvents(baseUrl, threadId),
      ]);
      return {
        thread,
        completedTurns: countCompletedTurns(events),
      };
    },
    isReady: ({ thread, completedTurns }) =>
      thread.status === "idle" && completedTurns > previousCompletedTurns,
    describeLast: (snapshot) =>
      `Thread ${threadId} did not complete another turn (status=${snapshot?.thread.status ?? "unknown"}, completed=${snapshot?.completedTurns ?? -1})`,
  });
}

async function emitFakeCodexUntilIdleWithAnotherTurn(args: {
  controlFilePath: string;
  baseUrl: string;
  wsUrl: string;
  threadId: string;
  previousCompletedTurns: number;
  maxAttempts?: number;
}): Promise<void> {
  const maxAttempts = args.maxAttempts ?? 6;
  let lastStatus = "unknown";
  let lastCompletedTurns = args.previousCompletedTurns;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    appendFileSync(args.controlFilePath, "emit-next-event\n", "utf8");
    await sleep(250);

    const [thread, events] = await Promise.all([
      readJson<{ status: string }>(`${args.baseUrl}/api/v1/threads/${args.threadId}`),
      listThreadEvents(args.baseUrl, args.threadId),
    ]);
    lastStatus = thread.status;
    lastCompletedTurns = countCompletedTurns(events);
    if (thread.status === "idle" && lastCompletedTurns > args.previousCompletedTurns) {
      return;
    }

    await sleep(500);
  }

  throw new Error(
    `Thread ${args.threadId} did not complete another turn after ${maxAttempts} fake-codex pulses ` +
      `(status=${lastStatus}, completed=${lastCompletedTurns})`,
  );
}

async function spawnThread(args: {
  baseUrl: string;
  projectId: string;
  environmentKind: EnvironmentKind;
  prompt: string;
}): Promise<string> {
  const cli = await runCliCommand({
    baseUrl: args.baseUrl,
    args: [
      "thread",
      "spawn",
      "--project",
      args.projectId,
      "--prompt",
      args.prompt,
      ...(args.environmentKind === "local"
        ? []
        : ["--new-environment", args.environmentKind]),
    ],
  });
  expect(cli.exitCode).toBe(0);
  expect(cli.stderr).toBe("");
  return parseThreadIdFromCliOutput(cli.stdout);
}

async function expectCliSuccess(resultPromise: Promise<CliRunResult>): Promise<CliRunResult> {
  const result = await resultPromise;
  expect(result.exitCode, `CLI failed (stderr: ${result.stderr || "(empty)"})`).toBe(0);
  expect(result.stderr).toBe("");
  return result;
}

async function runEnvironmentBattery(
  environmentKind: EnvironmentKind,
): Promise<void> {
  const preserveTempDir = process.env.BB_E2E_PRESERVE_TEMP_DIR === "1";
  const tempDir = mkdtempSync(
    bbTestTmpPrefix(`bb-standalone-server-${environmentKind}-`),
  );
  const bbRoot = join(tempDir, "bb-root");
  const projectRoot = join(tempDir, "project");
  mkdirSync(bbRoot, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  if (environmentKind === "worktree") {
    execFileSync("git", ["init", "-b", "main"], {
      cwd: projectRoot,
      env: TEST_GIT_ENV,
      stdio: "pipe",
    });
    execFileSync("git", ["commit", "--allow-empty", "-m", "init"], {
      cwd: projectRoot,
      env: TEST_GIT_ENV,
      stdio: "pipe",
    });
  }

  const fakeCodexControlFilePath = join(tempDir, "fake-codex-control", "events.log");
  const fakeCodexBinDir = createFakeCodexBinDir(tempDir, {
    defaultTurnDelayMs: 25,
    defaultScenario: "start-then-manual-complete",
  });
  const port = await allocatePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/ws`;
  const serverEnv = withFakeE2eEnvironmentDaemonTimingEnv({
    ...process.env,
    PATH: prependPathEntry(process.env.PATH, fakeCodexBinDir),
    BB_ROOT: bbRoot,
    BB_FAKE_CODEX_CONTROL_FILE: fakeCodexControlFilePath,
    BB_FAKE_CODEX_SCENARIO: "start-then-manual-complete",
  });

  // Track all server instances so we can kill their process trees on cleanup.
  // The server restart test replaces `server` mid-test, but the old server's
  // env-daemons survive as orphans. We need to kill them all.
  const allServerChildPids: number[] = [];

  let server = startStandaloneServer({
    port,
    env: serverEnv,
  });

  try {
    await waitForHealth(baseUrl);
    const project = await createProject(
      baseUrl,
      projectRoot,
      `standalone-server-${environmentKind}`,
    );

    const initialThreadId = await spawnThread({
      baseUrl,
      projectId: project.id,
      environmentKind,
      prompt:
        `Reply with exactly BATTERY-START-${environmentKind.toUpperCase()} and finish. ` +
        "Do not run commands or add extra text.",
    });
    await waitForNextTurnStarted(baseUrl, wsUrl, initialThreadId, 0);
    appendFileSync(fakeCodexControlFilePath, "emit-next-event\n", "utf8");
    await waitForThreadStatus(baseUrl, initialThreadId, "idle", 15_000, wsUrl);

    const followUpBaseline = await listThreadEvents(baseUrl, initialThreadId);
    await expectCliSuccess(
      runCliCommand({
        baseUrl,
        args: [
          "thread",
          "tell",
          initialThreadId,
          `Reply with exactly BATTERY-FOLLOWUP-${environmentKind.toUpperCase()} and finish. Do not run commands or add extra text.`,
        ],
      }),
    );
    await waitForNextTurnStarted(
      baseUrl,
      wsUrl,
      initialThreadId,
      countStartedTurns(followUpBaseline),
    );
    appendFileSync(fakeCodexControlFilePath, "emit-next-event\n", "utf8");
    await waitForIdleWithAnotherTurn(
      baseUrl,
      wsUrl,
      initialThreadId,
      countCompletedTurns(followUpBaseline),
    );

    const restartThreadId = await spawnThread({
      baseUrl,
      projectId: project.id,
      environmentKind,
      prompt:
        `Reply with exactly BATTERY-RESTART-${environmentKind.toUpperCase()} and finish. ` +
        "Do not run commands or add extra text.",
    });
    await waitForNextTurnStarted(baseUrl, wsUrl, restartThreadId, 0);
    // Snapshot child PIDs before restart kills the server — once the server
    // exits, its children (env-daemons, codex) get reparented to PID 1.
    allServerChildPids.push(...server.snapshotChildPids());

    const restartResult = await expectCliSuccess(
      runCliCommand({
        baseUrl,
        args: ["server", "restart", "--force"],
      }),
    );
    expect(restartResult.stdout).toContain("Server shutdown requested");
    expect(await server.waitForExit()).toBe(0);
    appendFileSync(fakeCodexControlFilePath, "emit-next-event\n", "utf8");
    server = startStandaloneServer({
      port,
      env: serverEnv,
    });
    await waitForHealth(baseUrl, 15_000);
    await waitForThreadStatus(baseUrl, restartThreadId, "idle", 20_000, wsUrl);

    const restartedEvents = await listThreadEvents(baseUrl, restartThreadId);
    expect(
      restartedEvents.filter((event) => normalizeEventType(event.type) === "turn/started"),
    ).toHaveLength(1);
    expect(
      restartedEvents.filter((event) => {
        const normalized = normalizeEventType(event.type);
        return normalized === "turn/completed" || normalized === "turn/end";
      }),
    ).toHaveLength(1);

    const steerThreadId = await spawnThread({
      baseUrl,
      projectId: project.id,
      environmentKind,
      prompt:
        `Reply with exactly BATTERY-STEER-START-${environmentKind.toUpperCase()} and finish. ` +
        "Do not run commands or add extra text.",
    });
    await waitForNextTurnStarted(baseUrl, wsUrl, steerThreadId, 0);
    await expectCliSuccess(
      runCliCommand({
        baseUrl,
        args: [
          "thread",
          "tell",
          steerThreadId,
          `Reply with exactly BATTERY-STEERED-${environmentKind.toUpperCase()} and finish. Do not run commands or add extra text.`,
          "--mode",
          "steer",
        ],
      }),
    );
    appendFileSync(fakeCodexControlFilePath, "emit-next-event\n", "utf8");
    await waitForThreadStatus(baseUrl, steerThreadId, "idle", 20_000, wsUrl);
    const steerEvents = await listThreadEvents(baseUrl, steerThreadId);
    expect(JSON.stringify(steerEvents)).toContain(
      `BATTERY-STEERED-${environmentKind.toUpperCase()}`,
    );

    const stopThreadId = await spawnThread({
      baseUrl,
      projectId: project.id,
      environmentKind,
      prompt:
        `Reply with exactly BATTERY-STOP-${environmentKind.toUpperCase()} and finish. ` +
        "Do not run commands or add extra text.",
    });
    await waitForNextTurnStarted(baseUrl, wsUrl, stopThreadId, 0);
    await expectCliSuccess(
      runCliCommand({
        baseUrl,
        args: ["thread", "stop", stopThreadId],
      }),
    );
    await waitForThreadStatus(baseUrl, stopThreadId, "idle", 15_000, wsUrl);
    const stoppedEvents = await listThreadEvents(baseUrl, stopThreadId);
    await expectCliSuccess(
      runCliCommand({
        baseUrl,
        args: [
          "thread",
          "tell",
          stopThreadId,
          `Reply with exactly BATTERY-POST-STOP-${environmentKind.toUpperCase()} and finish. Do not run commands or add extra text.`,
        ],
      }),
    );
    await waitForNextTurnStarted(
      baseUrl,
      wsUrl,
      stopThreadId,
      countStartedTurns(stoppedEvents),
    );
    await emitFakeCodexUntilIdleWithAnotherTurn({
      controlFilePath: fakeCodexControlFilePath,
      baseUrl,
      wsUrl,
      threadId: stopThreadId,
      previousCompletedTurns: countCompletedTurns(stoppedEvents),
    });
  } finally {
    // stopAndCleanup kills the server + its entire process tree.
    await server.stopAndCleanup();
    // Also kill children from earlier server instances (pre-restart orphans).
    for (const pid of allServerChildPids.reverse()) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
    }
    if (preserveTempDir) {
      console.log(`[standalone-cli-roundtrip] preserved temp dir: ${tempDir}`);
    } else {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

export async function runStandaloneServerCliRoundtripScenario(): Promise<void> {
  const environments: readonly EnvironmentKind[] = ["local", "worktree"];
  for (const environmentKind of environments) {
    await runEnvironmentBattery(environmentKind);
  }
}
