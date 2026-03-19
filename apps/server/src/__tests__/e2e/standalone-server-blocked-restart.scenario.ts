import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { createProject, listThreadEvents, waitForThreadCondition } from "./environment-daemon-api.js";
import { createFakeCodexBinDir } from "./fake-codex.js";
import { bbTestTmpPrefix } from "./temp-root.js";
import { runCliCommand, withFakeE2eEnvironmentDaemonTimingEnv } from "./harness.js";

type EnvironmentKind = "local" | "worktree";

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
  type StandaloneServerHandle,
} from "./standalone-server.js";

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

// startStandaloneServer and StandaloneServerHandle imported from ./standalone-server.js

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
  const preserveTempDir = process.env.BB_E2E_PRESERVE_TEMP_DIR === "1";
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
  const serverEnv = withFakeE2eEnvironmentDaemonTimingEnv({
    ...process.env,
    PATH: prependPathEntry(process.env.PATH, fakeCodexBinDir),
    BB_ROOT: bbRoot,
    BB_FAKE_CODEX_CONTROL_FILE: fakeCodexControlFilePath,
    BB_FAKE_CODEX_SCENARIO: "start-then-manual-complete",
  });

  const server = startStandaloneServer({
    port,
    env: serverEnv,
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
      args: ["server", "restart"],
    });
    expect(restartResult.exitCode).not.toBe(0);
    expect(`${restartResult.stdout}\n${restartResult.stderr}`).toMatch(/active thread|active work|blocked/i);

    appendFileSync(fakeCodexControlFilePath, "emit-next-event\n", "utf8");
  } finally {
    await server.stopAndCleanup();
    if (preserveTempDir) {
      console.log(`[standalone-blocked-restart] preserved temp dir: ${tempDir}`);
    } else {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

export async function runStandaloneServerBlockedRestartScenario(): Promise<void> {
  for (const environmentKind of ["local", "worktree"] as const) {
    await runBlockedRestartScenario(environmentKind);
  }
}
