import {
  execFile as execFileCallback,
  spawn as spawnProcess,
} from "node:child_process";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildDaemonRestartCommand,
  buildStandaloneRuntimeEnv,
  buildStandaloneShellExports,
  resolveStandaloneParentPid,
  STANDALONE_OPENAI_API_KEY_ENV,
  STANDALONE_PARENT_PID_ENV,
} from "../src/shared.js";

const RESTART_PROVIDER_ENV_BLOCK =
  'case "${BB_QA_OPENAI_API_KEY-}" in *[![:space:]]*) OPENAI_API_KEY="$BB_QA_OPENAI_API_KEY"; export OPENAI_API_KEY ;; *) unset OPENAI_API_KEY ;; esac';
const DAEMON_ENV_BLOCK_PREFIX = "; BB_DATA_DIR=";

interface ShellCommandResult {
  processGroupId: number;
  stderr: string;
  stdout: string;
}

function buildTestRestartCommand(): string {
  return buildDaemonRestartCommand({
    cwd: "/repo",
    daemonPid: 123,
    daemonPort: 456,
    dataDir: "/tmp/bb root",
    entrypoint: "/repo/apps/host-daemon/dist/index.js",
    envFilePath: "/repo/.env",
    hostId: "host_123",
    instanceId: "instance_123",
    logPath: "/tmp/bb logs/host-daemon.log",
    parentPid: 789,
    pidPath: "/tmp/bb-restart.pid",
    serverUrl: "http://127.0.0.1:3334",
  });
}

function extractProviderEnvBlock(command: string): string {
  const blockStart = command.indexOf(RESTART_PROVIDER_ENV_BLOCK);
  if (blockStart < 0) {
    throw new Error("restart command is missing provider env block");
  }
  const blockEnd = command.indexOf(DAEMON_ENV_BLOCK_PREFIX, blockStart);
  if (blockEnd < 0) {
    throw new Error("restart command is missing daemon env block");
  }
  return command.slice(blockStart, blockEnd);
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopProcess(pid: number): Promise<void> {
  if (!isProcessRunning(pid)) {
    return;
  }
  process.kill(pid, "SIGTERM");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!isProcessRunning(pid)) {
      return;
    }
    await delay(50);
  }
  if (isProcessRunning(pid)) {
    process.kill(pid, "SIGKILL");
  }
}

async function waitForPidFile(
  pidPath: string,
  previousPid?: number,
): Promise<number> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 2_000) {
    try {
      const rawPid = await fs.readFile(pidPath, "utf8");
      const pid = Number.parseInt(rawPid.trim(), 10);
      if (Number.isInteger(pid) && pid > 0 && pid !== previousPid) {
        return pid;
      }
    } catch {}
    await delay(50);
  }
  throw new Error("Timed out waiting for restarted daemon pid file");
}

async function runShellCommand(
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<ShellCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess("sh", ["-c", command], {
      detached: true,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    if (!child.stdout || !child.stderr) {
      reject(new Error("Expected shell command pipes"));
      return;
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code !== 0) {
        reject(
          new Error(
            `Shell command failed with code ${String(code)} signal ${String(signal)}\n${stderr}`,
          ),
        );
        return;
      }
      if (!child.pid) {
        reject(new Error("Shell command exited without a pid"));
        return;
      }
      resolve({
        processGroupId: child.pid,
        stderr,
        stdout,
      });
    });
  });
}

function signalProcessGroup(processGroupId: number): void {
  try {
    process.kill(-processGroupId, "SIGTERM");
  } catch {}
}

async function runRestartProviderEnvBlock(
  block: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const script =
    `${block}; ` +
    'if [ "${OPENAI_API_KEY+x}" = x ]; then printf \'set:%s\' "$OPENAI_API_KEY"; else printf unset; fi';
  return new Promise((resolve, reject) => {
    execFileCallback(
      "sh",
      ["-c", script],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "",
          ...env,
        },
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function buildTestRestartProviderEnvBlock(): string {
  const block = extractProviderEnvBlock(buildTestRestartCommand());
  expect(block).toBe(RESTART_PROVIDER_ENV_BLOCK);
  return block;
}

describe("standalone restart command", () => {
  it("prefers a caller-provided parent pid for orphan cleanup ownership", () => {
    expect(
      resolveStandaloneParentPid({
        env: {
          [STANDALONE_PARENT_PID_ENV]: "4242",
        },
        fallbackPid: 1111,
      }),
    ).toBe(4242);
  });

  it("falls back to the current parent pid when the configured owner is absent", () => {
    expect(
      resolveStandaloneParentPid({
        env: {
          [STANDALONE_PARENT_PID_ENV]: "not-a-pid",
        },
        fallbackPid: 1111,
      }),
    ).toBe(1111);
  });

  it("clears inherited thread context from env-format setup output", () => {
    expect(
      buildStandaloneShellExports({
        BB_HOST_DAEMON_PORT: "3334",
        BB_PROJECT_ID: "proj_standalone",
        BB_SERVER_URL: "http://127.0.0.1:3333",
      }).split("\n"),
    ).toEqual([
      "unset BB_THREAD_ID",
      "unset BB_ENVIRONMENT_ID",
      "unset BB_THREAD_STORAGE",
      "export BB_HOST_DAEMON_PORT='3334'",
      "export BB_PROJECT_ID='proj_standalone'",
      "export BB_SERVER_URL='http://127.0.0.1:3333'",
    ]);
  });

  it("strips inherited thread context so the daemon derives its own storage root", () => {
    expect(
      buildStandaloneRuntimeEnv({
        baseEnv: {
          BB_ENVIRONMENT_ID: "env_parent",
          BB_THREAD_ID: "thr_parent",
          BB_THREAD_STORAGE: "/home/user/.bb/thread-storage/thr_parent",
          PATH: "/usr/bin",
        },
        overrides: {
          BB_DATA_DIR: "/tmp/standalone/bb-root",
        },
      }),
    ).toEqual({
      BB_DATA_DIR: "/tmp/standalone/bb-root",
      PATH: "/usr/bin",
    });
  });

  it("does not inherit OPENAI_API_KEY into standalone runtime env by default", () => {
    expect(
      buildStandaloneRuntimeEnv({
        baseEnv: {
          OPENAI_API_KEY: "ambient-openai-key",
          PATH: "/usr/bin",
        },
        overrides: {},
      }),
    ).toEqual({
      PATH: "/usr/bin",
    });
  });

  it("maps the QA OpenAI opt-in key into standalone runtime env", () => {
    expect(
      buildStandaloneRuntimeEnv({
        baseEnv: {
          OPENAI_API_KEY: "ambient-openai-key",
          PATH: "/usr/bin",
          [STANDALONE_OPENAI_API_KEY_ENV]: "qa-openai-key",
        },
        overrides: {},
      }),
    ).toEqual({
      OPENAI_API_KEY: "qa-openai-key",
      PATH: "/usr/bin",
      [STANDALONE_OPENAI_API_KEY_ENV]: "qa-openai-key",
    });
  });

  it("reloads the env file without embedding provider secrets", () => {
    const command = buildTestRestartCommand();

    expect(command).toContain("daemon_pid='123'");
    expect(command).toContain("daemon_pid=$(cat '/tmp/bb-restart.pid')");
    expect(command).toContain('(kill "$daemon_pid"');
    expect(command).toContain("/repo/.env");
    expect(command).toContain(RESTART_PROVIDER_ENV_BLOCK);
    expect(command).toContain("BB_DATA_DIR=");
    expect(command).toContain("BB_STANDALONE_INSTANCE=");
    expect(command).toContain("BB_RESTART_DAEMON_ENTRYPOINT=");
    expect(command).toContain("BB_RESTART_DAEMON_CWD=");
    expect(command).toContain("BB_RESTART_DAEMON_PID_PATH=");
    expect(command).toContain("/repo/apps/host-daemon/dist/index.js");
    expect(command).toContain(
      "</dev/null >> '/tmp/bb logs/host-daemon.log' 2>&1",
    );
    expect(command).toContain("'http://127.0.0.1:3334/api/v1/hosts'");
    expect(command).toContain(
      '\'any(.[]; .id == "host_123" and .status == "connected")\'',
    );
    expect(command).toContain('[ "$connected" = 1 ]');
    expect(command).not.toContain("&;");
    expect(command).not.toContain("do; if");
    expect(command).not.toContain("test-openai-key");
  });

  it("does not map whitespace-only QA OpenAI opt-in restart keys", async () => {
    await expect(
      runRestartProviderEnvBlock(buildTestRestartProviderEnvBlock(), {
        OPENAI_API_KEY: "ambient-openai-key",
        [STANDALONE_OPENAI_API_KEY_ENV]: " \t ",
      }),
    ).resolves.toBe("unset");
  });

  it("keeps OpenAI unset during restart when ambient and opt-in keys are absent", async () => {
    await expect(
      runRestartProviderEnvBlock(buildTestRestartProviderEnvBlock(), {}),
    ).resolves.toBe("unset");
  });

  it("maps a non-empty QA OpenAI opt-in key during restart", async () => {
    await expect(
      runRestartProviderEnvBlock(buildTestRestartProviderEnvBlock(), {
        OPENAI_API_KEY: "ambient-openai-key",
        [STANDALONE_OPENAI_API_KEY_ENV]: "qa-openai-key",
      }),
    ).resolves.toBe("set:qa-openai-key");
  });

  it("uses a no-op env loader when no env file exists", () => {
    const command = buildDaemonRestartCommand({
      cwd: "/repo",
      daemonPid: null,
      daemonPort: 456,
      dataDir: "/tmp/bb-root",
      entrypoint: "/repo/apps/host-daemon/dist/index.js",
      envFilePath: null,
      hostId: "host_123",
      instanceId: "instance_123",
      logPath: "/tmp/host-daemon.log",
      parentPid: 789,
      pidPath: "/tmp/host-daemon-restart.pid",
      serverUrl: "http://127.0.0.1:3334",
    });

    expect(command).toContain("set -a; :; set +a;");
    expect(command).toContain("daemon_pid=''");
  });

  it("starts a detached daemon repeatedly and replaces the current pid", async () => {
    const tempDir = await fs.mkdtemp(
      path.join(tmpdir(), "bb-restart-command-"),
    );
    const pidPath = path.join(tempDir, "daemon.pid");
    const logPath = path.join(tempDir, "host-daemon.log");
    const entrypoint = path.join(tempDir, "daemon-child.mjs");
    let daemonPid: number | null = null;
    const server = createServer((request, response) => {
      if (request.url === "/api/v1/hosts") {
        response.setHeader("content-type", "application/json");
        response.end('[{"id":"host_123","status":"connected"}]');
        return;
      }
      response.statusCode = 404;
      response.end("not found");
    });

    try {
      await fs.writeFile(
        entrypoint,
        "setInterval(() => undefined, 1_000);\n",
        "utf8",
      );

      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected test server to listen on a TCP port");
      }

      const command = buildDaemonRestartCommand({
        cwd: tempDir,
        daemonPid: null,
        daemonPort: 456,
        dataDir: path.join(tempDir, "bb-root"),
        entrypoint,
        envFilePath: null,
        hostId: "host_123",
        instanceId: "instance_signal_test",
        logPath,
        parentPid: process.pid,
        pidPath,
        serverUrl: `http://127.0.0.1:${address.port}`,
      });

      const shellResult = await runShellCommand(command, {
        PATH: process.env.PATH ?? "",
      });
      daemonPid = await waitForPidFile(pidPath);
      expect(isProcessRunning(daemonPid)).toBe(true);

      signalProcessGroup(shellResult.processGroupId);
      await delay(500);

      expect(isProcessRunning(daemonPid)).toBe(true);

      const firstDaemonPid = daemonPid;
      await runShellCommand(command, {
        PATH: process.env.PATH ?? "",
      });
      daemonPid = await waitForPidFile(pidPath, firstDaemonPid);

      expect(isProcessRunning(firstDaemonPid)).toBe(false);
      expect(isProcessRunning(daemonPid)).toBe(true);
    } finally {
      if (daemonPid) {
        await stopProcess(daemonPid);
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
