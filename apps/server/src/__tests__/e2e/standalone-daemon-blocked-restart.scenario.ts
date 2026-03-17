import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { createProject, listThreadEvents, waitForThreadCondition } from "./environment-agent-api.js";
import { createFakeCodexBinDir } from "./fake-codex.js";
import { bbTestTmpPrefix } from "./temp-root.js";
import { runCliCommand, withFakeE2eEnvironmentAgentTimingEnv } from "./harness.js";

type EnvironmentKind = "local" | "worktree";

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
  GIT_AUTHOR_NAME: "BB Test",
  GIT_AUTHOR_EMAIL: "bb-test@example.com",
  GIT_COMMITTER_NAME: "BB Test",
  GIT_COMMITTER_EMAIL: "bb-test@example.com",
};

interface LaunchTarget {
  command: string;
  args: string[];
}

import {
  startStandaloneDaemon,
  type StandaloneDaemonHandle,
} from "./standalone-daemon.js";

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

  const daemonRoot = resolve(WORKSPACE_ROOT, "apps", "server");
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

  throw new Error("Unable to launch daemon for standalone blocked-restart e2e");
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

// startStandaloneDaemon and StandaloneDaemonHandle imported from ./standalone-daemon.js

function parseThreadIdFromCliOutput(stdout: string): string {
  const match = stdout.match(/Thread spawned:\s+([A-Za-z0-9_-]+)/);
  if (!match) {
    throw new Error(`Unable to parse thread id from CLI output:\n${stdout}`);
  }
  return match[1];
}

async function waitForTurnStarted(baseUrl: string, threadId: string): Promise<void> {
  await waitForThreadCondition({
    threadId,
    timeoutMs: 15_000,
    load: async () => listThreadEvents(baseUrl, threadId),
    isReady: (events) =>
      events.some((event) => event.type.toLowerCase().replaceAll(".", "/") === "turn/started"),
    describeLast: (events) =>
      `Thread ${threadId} never emitted turn/started (events=${events?.map((event) => event.type).join(",") ?? ""})`,
  });
}

async function runBlockedRestartScenario(environmentKind: EnvironmentKind): Promise<void> {
  const tempDir = mkdtempSync(
    bbTestTmpPrefix(`bb-standalone-blocked-${environmentKind}-`),
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
  const daemonEnv = withFakeE2eEnvironmentAgentTimingEnv({
    ...process.env,
    PATH: prependPathEntry(process.env.PATH, fakeCodexBinDir),
    BB_ROOT: bbRoot,
    BB_FAKE_CODEX_CONTROL_FILE: fakeCodexControlFilePath,
    BB_FAKE_CODEX_SCENARIO: "start-then-manual-complete",
  });

  const daemon = startStandaloneDaemon({
    port,
    env: daemonEnv,
  });

  try {
    await waitForHealth(baseUrl);
    const project = await createProject(baseUrl, projectRoot, `blocked-restart-${environmentKind}`);
    const spawnResult = await runCliCommand({
      baseUrl,
      args: [
        "thread",
        "spawn",
        "--project",
        project.id,
        "--prompt",
        `Reply with exactly BLOCKED-RESTART-${environmentKind.toUpperCase()} and finish.`,
        ...(environmentKind === "local" ? [] : ["--new-environment", "worktree"]),
      ],
    });
    expect(spawnResult.exitCode).toBe(0);
    expect(spawnResult.stderr).toBe("");
    const threadId = parseThreadIdFromCliOutput(spawnResult.stdout);

    await waitForTurnStarted(baseUrl, threadId);

    const restartResult = await runCliCommand({
      baseUrl,
      args: ["daemon", "restart"],
    });
    expect(restartResult.exitCode).not.toBe(0);
    expect(`${restartResult.stdout}\n${restartResult.stderr}`).toMatch(/active thread|active work|blocked/i);

    appendFileSync(fakeCodexControlFilePath, "emit-next-event\n", "utf8");
  } finally {
    await daemon.stopAndCleanup();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export async function runStandaloneDaemonBlockedRestartScenario(): Promise<void> {
  for (const environmentKind of ["local", "worktree"] as const) {
    await runBlockedRestartScenario(environmentKind);
  }
}
