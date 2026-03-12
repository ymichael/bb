import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import {
  createProject,
  listThreadEvents,
  readJson,
  waitForThreadCondition,
  waitForThreadStatus,
} from "./environment-agent-api.js";
import { createFakeCodexBinDir } from "./fake-codex.js";
import {
  runCliCommand,
  type CliRunResult,
  withFakeE2eEnvironmentAgentTimingEnv,
} from "./harness.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WORKSPACE_ROOT = resolve(__dirname, "..", "..", "..", "..", "..");
const DAEMON_DIST_PATH = resolve(WORKSPACE_ROOT, "apps", "daemon", "dist", "index.js");
const DAEMON_SOURCE_PATH = resolve(WORKSPACE_ROOT, "apps", "daemon", "src", "index.ts");
const TSX_CLI_PATH = resolve(
  WORKSPACE_ROOT,
  "apps",
  "daemon",
  "node_modules",
  "tsx",
  "dist",
  "cli.mjs",
);
const TEST_GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Beanbag Test",
  GIT_AUTHOR_EMAIL: "beanbag-test@example.com",
  GIT_COMMITTER_NAME: "Beanbag Test",
  GIT_COMMITTER_EMAIL: "beanbag-test@example.com",
};

interface LaunchTarget {
  command: string;
  args: string[];
}

interface StandaloneDaemonHandle {
  waitForExit: () => Promise<number | null>;
  stop: () => Promise<void>;
}

type EnvironmentId = "local" | "worktree";

function prependPathEntry(pathValue: string | undefined, entryToPrepend: string): string {
  const entries = (pathValue ?? "")
    .split(delimiter)
    .filter((entry) => entry.length > 0 && entry !== entryToPrepend);
  return [entryToPrepend, ...entries].join(delimiter);
}

function latestModifiedAtMs(rootPath: string): number {
  const stat = statSync(rootPath);
  if (!stat.isDirectory()) {
    return stat.mtimeMs;
  }

  let latest = stat.mtimeMs;
  for (const entry of readdirSync(rootPath)) {
    latest = Math.max(latest, latestModifiedAtMs(join(rootPath, entry)));
  }
  return latest;
}

function isCurrentDaemonDistAvailable(): boolean {
  if (!existsSync(DAEMON_DIST_PATH)) {
    return false;
  }

  const daemonRoot = resolve(WORKSPACE_ROOT, "apps", "daemon");
  const distModifiedAtMs = statSync(DAEMON_DIST_PATH).mtimeMs;
  const sourceLatestMs = Math.max(
    latestModifiedAtMs(resolve(daemonRoot, "src")),
    latestModifiedAtMs(resolve(daemonRoot, "package.json")),
    latestModifiedAtMs(resolve(daemonRoot, "tsconfig.json")),
  );
  return distModifiedAtMs >= sourceLatestMs;
}

function resolveDaemonLaunchTarget(): LaunchTarget {
  if (isCurrentDaemonDistAvailable()) {
    return {
      command: process.execPath,
      args: [DAEMON_DIST_PATH],
    };
  }

  if (existsSync(TSX_CLI_PATH) && existsSync(DAEMON_SOURCE_PATH)) {
    return {
      command: process.execPath,
      args: [TSX_CLI_PATH, DAEMON_SOURCE_PATH],
    };
  }

  throw new Error(
    "Unable to launch daemon: missing tsx source runner and apps/daemon/dist/index.js fallback.",
  );
}

async function allocatePort(host: string = "127.0.0.1"): Promise<number> {
  return new Promise<number>((resolvePort, rejectPort) => {
    const server = createNetServer();
    server.once("error", rejectPort);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => rejectPort(new Error("Failed to allocate standalone daemon port")));
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
      // Daemon still starting.
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
  }
  throw new Error(`Timed out waiting for standalone daemon health at ${baseUrl}`);
}

function startStandaloneDaemon(args: {
  port: number;
  env: NodeJS.ProcessEnv;
}): StandaloneDaemonHandle {
  const launchTarget = resolveDaemonLaunchTarget();
  const child = spawn(
    launchTarget.command,
    [...launchTarget.args, "--port", String(args.port)],
    {
      cwd: WORKSPACE_ROOT,
      env: args.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.resume();
  child.stderr.resume();

  return {
    waitForExit: async () => {
      if (child.exitCode !== null) {
        return child.exitCode;
      }
      return new Promise((resolveClose) => {
        child.once("close", (exitCode) => resolveClose(exitCode));
      });
    },
    stop: async () => {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise((resolveClose) => {
        child.once("close", () => resolveClose(undefined));
      });
    },
  };
}

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

async function spawnThread(args: {
  baseUrl: string;
  projectId: string;
  environmentId: EnvironmentId;
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
      ...(args.environmentId === "local"
        ? []
        : ["--environment", args.environmentId]),
    ],
  });
  expect(cli.exitCode).toBe(0);
  expect(cli.stderr).toBe("");
  return parseThreadIdFromCliOutput(cli.stdout);
}

async function expectCliSuccess(resultPromise: Promise<CliRunResult>): Promise<CliRunResult> {
  const result = await resultPromise;
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  return result;
}

async function runEnvironmentBattery(
  environmentId: EnvironmentId,
): Promise<void> {
  const tempDir = mkdtempSync(join(tmpdir(), `beanbag-standalone-daemon-${environmentId}-`));
  const beanbagRoot = join(tempDir, "beanbag-root");
  const projectRoot = join(tempDir, "project");
  mkdirSync(beanbagRoot, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  if (environmentId === "worktree") {
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
  const daemonEnv = withFakeE2eEnvironmentAgentTimingEnv({
    ...process.env,
    PATH: prependPathEntry(process.env.PATH, fakeCodexBinDir),
    BEANBAG_ROOT: beanbagRoot,
    BEANBAG_FAKE_CODEX_CONTROL_FILE: fakeCodexControlFilePath,
    BEANBAG_FAKE_CODEX_SCENARIO: "start-then-manual-complete",
  });

  let daemon = startStandaloneDaemon({
    port,
    env: daemonEnv,
  });

  try {
    await waitForHealth(baseUrl);
    const project = await createProject(
      baseUrl,
      projectRoot,
      `standalone-daemon-${environmentId}`,
    );

    const initialThreadId = await spawnThread({
      baseUrl,
      projectId: project.id,
      environmentId,
      prompt:
        `Reply with exactly BATTERY-START-${environmentId.toUpperCase()} and finish. ` +
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
          `Reply with exactly BATTERY-FOLLOWUP-${environmentId.toUpperCase()} and finish. Do not run commands or add extra text.`,
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
      environmentId,
      prompt:
        `Reply with exactly BATTERY-RESTART-${environmentId.toUpperCase()} and finish. ` +
        "Do not run commands or add extra text.",
    });
    await waitForNextTurnStarted(baseUrl, wsUrl, restartThreadId, 0);
    const restartResult = await expectCliSuccess(
      runCliCommand({
        baseUrl,
        args: ["daemon", "restart", "--force"],
      }),
    );
    expect(restartResult.stdout).toContain("Daemon shutdown requested");
    expect(await daemon.waitForExit()).toBe(0);
    appendFileSync(fakeCodexControlFilePath, "emit-next-event\n", "utf8");
    daemon = startStandaloneDaemon({
      port,
      env: daemonEnv,
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
      environmentId,
      prompt:
        `Reply with exactly BATTERY-STEER-START-${environmentId.toUpperCase()} and finish. ` +
        "Do not run commands or add extra text.",
    });
    await waitForNextTurnStarted(baseUrl, wsUrl, steerThreadId, 0);
    await expectCliSuccess(
      runCliCommand({
        baseUrl,
        args: [
          "thread",
          "steer",
          steerThreadId,
          `Reply with exactly BATTERY-STEERED-${environmentId.toUpperCase()} and finish. Do not run commands or add extra text.`,
        ],
      }),
    );
    appendFileSync(fakeCodexControlFilePath, "emit-next-event\n", "utf8");
    await waitForThreadStatus(baseUrl, steerThreadId, "idle", 20_000, wsUrl);
    const steerEvents = await listThreadEvents(baseUrl, steerThreadId);
    expect(JSON.stringify(steerEvents)).toContain(
      `BATTERY-STEERED-${environmentId.toUpperCase()}`,
    );

    const stopThreadId = await spawnThread({
      baseUrl,
      projectId: project.id,
      environmentId,
      prompt:
        `Reply with exactly BATTERY-STOP-${environmentId.toUpperCase()} and finish. ` +
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
          `Reply with exactly BATTERY-POST-STOP-${environmentId.toUpperCase()} and finish. Do not run commands or add extra text.`,
        ],
      }),
    );
    await waitForNextTurnStarted(
      baseUrl,
      wsUrl,
      stopThreadId,
      countStartedTurns(stoppedEvents),
    );
    appendFileSync(fakeCodexControlFilePath, "emit-next-event\n", "utf8");
    await waitForIdleWithAnotherTurn(
      baseUrl,
      wsUrl,
      stopThreadId,
      countCompletedTurns(stoppedEvents),
    );
  } finally {
    await daemon.stop();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export async function runStandaloneDaemonCliRoundtripScenario(): Promise<void> {
  const environments: readonly EnvironmentId[] = ["local", "worktree"];
  for (const environmentId of environments) {
    await runEnvironmentBattery(environmentId);
  }
}
