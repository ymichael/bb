import { execFile as execFileCallback, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);

export const STANDALONE_INSTANCE_ENV = "BB_STANDALONE_INSTANCE";
export const STANDALONE_PARENT_PID_ENV = "BB_STANDALONE_PARENT_PID";
const STANDALONE_TMP_PREFIX = "bb-standalone-";
const PROCESS_SCAN_MAX_BUFFER = 10 * 1024 * 1024;

export const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function isNodeError(error) {
  return error instanceof Error;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

export function buildShellExports(env) {
  return Object.entries(env)
    .map(([key, value]) => `export ${key}=${shellQuote(String(value))}`)
    .join("\n");
}

export function readStandaloneStateRuntime(state) {
  return {
    daemonPid: state?.daemon?.pid ?? state?.daemonPid ?? null,
    instanceId: state?.instanceId ?? null,
    parentPid: state?.parentPid ?? null,
    serverPid: state?.server?.pid ?? state?.serverPid ?? null,
    tmpRoot: state?.paths?.tmpRoot ?? state?.tmpRoot ?? null,
  };
}

async function resolveProjectEnvCandidates() {
  const candidates = new Set([path.join(repoRoot, ".env")]);
  const gitMetadataPath = path.join(repoRoot, ".git");

  try {
    const gitMetadata = await fs.stat(gitMetadataPath);
    if (!gitMetadata.isFile()) {
      return [...candidates];
    }

    const gitdirPointer = await fs.readFile(gitMetadataPath, "utf8");
    const match = /^gitdir:\s*(.+)\s*$/m.exec(gitdirPointer);
    if (!match?.[1]) {
      return [...candidates];
    }

    const worktreeGitDir = path.resolve(repoRoot, match[1]);
    const commonGitDir = path.dirname(path.dirname(worktreeGitDir));
    candidates.add(path.join(path.dirname(commonGitDir), ".env"));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [...candidates];
    }
    throw error;
  }

  return [...candidates];
}

export async function createTestGitRepo(repoDir) {
  await fs.mkdir(repoDir, { recursive: true });
  await runGit(repoDir, ["init", "--initial-branch", "main"]);
  await runGit(repoDir, ["config", "user.email", "standalone-qa@example.com"]);
  await runGit(repoDir, ["config", "user.name", "BB Standalone QA"]);
  await fs.writeFile(path.join(repoDir, "alpha.txt"), "alpha\n", "utf8");
  await fs.writeFile(
    path.join(repoDir, "beta.md"),
    "# Beta\n\nStandalone QA repo.\n",
    "utf8",
  );
  await runGit(repoDir, ["add", "."]);
  await runGit(repoDir, ["commit", "-m", "Initial commit"]);
  return repoDir;
}

export async function createProject(serverUrl, project) {
  const response = await fetch(`${serverUrl}/api/v1/projects`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(project),
  });
  if (!response.ok) {
    throw new Error(
      `Failed to create project: ${response.status} ${await response.text()}`,
    );
  }
  return response.json();
}

export async function createHostJoin(serverUrl, body = { hostType: "persistent" }) {
  const response = await fetch(`${serverUrl}/api/v1/hosts/join`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(
      `Failed to create host join material: ${response.status} ${await response.text()}`,
    );
  }
  return response.json();
}

export async function killProcess(pid) {
  if (!pid) {
    return;
  }

  if (!(await isProcessRunning(pid))) {
    return;
  }

  process.kill(pid, "SIGTERM");
  await waitFor(async () => !(await isProcessRunning(pid)), {
    timeoutMs: 5_000,
    description: `process ${pid} to exit`,
  }).catch(async () => {
    if (await isProcessRunning(pid)) {
      process.kill(pid, "SIGKILL");
      await waitFor(async () => !(await isProcessRunning(pid)), {
        timeoutMs: 5_000,
        description: `process ${pid} to exit after SIGKILL`,
      });
    }
  });
}

export async function loadDotEnv() {
  const loaded = {};

  for (const candidate of await resolveProjectEnvCandidates()) {
    try {
      const content = await fs.readFile(candidate, "utf8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) {
          continue;
        }
        const equalsIndex = trimmed.indexOf("=");
        if (equalsIndex < 0) {
          continue;
        }
        const key = trimmed.slice(0, equalsIndex).trim();
        const value = trimmed.slice(equalsIndex + 1).trim();
        if (key && !(key in process.env)) {
          process.env[key] = value;
          loaded[key] = value;
        }
      }
      return {
        loaded,
        path: candidate,
      };
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }

  return {
    loaded,
    path: null,
  };
}

export async function reservePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to reserve port"));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

export async function runGit(cwd, args) {
  await execFile("git", args, { cwd });
}

export function spawnLoggedProcess(options) {
  const logFd = openSync(options.logPath, "a");
  try {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
    return child;
  } finally {
    closeSync(logFd);
  }
}

async function readJsonIfExists(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function listStandaloneTmpRoots() {
  const entries = await fs.readdir(tmpdir(), { withFileTypes: true });
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() && entry.name.startsWith(STANDALONE_TMP_PREFIX),
    )
    .map((entry) => path.join(tmpdir(), entry.name));
}

async function listOpenFilePids(targetPath) {
  try {
    const { stdout } = await execFile("lsof", ["-t", "+D", targetPath], {
      encoding: "utf8",
    });
    return stdout
      .split("\n")
      .map((value) => Number.parseInt(value.trim(), 10))
      .filter((value) => Number.isInteger(value) && value > 0);
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === 1)) {
      return [];
    }
    throw error;
  }
}

async function listProcessesByInstance(instanceId) {
  return (await listStandaloneProcesses())
    .filter((entry) => entry.instanceId === instanceId)
    .map((entry) => entry.pid);
}

function readStandaloneEnvValue(command, envName) {
  const match = new RegExp(`${envName}=([^\\s]+)`, "u").exec(command);
  return match?.[1] ?? null;
}

async function listStandaloneProcesses() {
  const { stdout } = await execFile(
    "ps",
    ["eww", "-Ao", "pid=,command="],
    { encoding: "utf8", maxBuffer: PROCESS_SCAN_MAX_BUFFER },
  );
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d+)\s+(.*)$/u.exec(line);
      if (!match) {
        return null;
      }
      return {
        command: match[2],
        pid: Number.parseInt(match[1], 10),
      };
    })
    .filter((entry) => entry && entry.command.includes(`${STANDALONE_INSTANCE_ENV}=`))
    .map((entry) => {
      const parentPid = Number.parseInt(
        readStandaloneEnvValue(entry.command, STANDALONE_PARENT_PID_ENV) ?? "",
        10,
      );
      return {
        instanceId: readStandaloneEnvValue(entry.command, STANDALONE_INSTANCE_ENV),
        parentPid: Number.isInteger(parentPid) && parentPid > 0 ? parentPid : null,
        pid: entry.pid,
      };
    });
}

export async function cleanupStandaloneInstance(state) {
  const runtime = readStandaloneStateRuntime(state);
  const killedPids = new Set();
  const pidsToKill = new Set([
    runtime.daemonPid,
    runtime.serverPid,
    ...(runtime.instanceId ? await listProcessesByInstance(runtime.instanceId) : []),
    ...(runtime.tmpRoot ? await listOpenFilePids(runtime.tmpRoot) : []),
  ]);

  for (const pid of pidsToKill) {
    if (!pid || killedPids.has(pid)) {
      continue;
    }
    await killProcess(pid).catch(() => undefined);
    killedPids.add(pid);
  }

  if (runtime.tmpRoot) {
    await fs.rm(runtime.tmpRoot, { recursive: true, force: true });
  }

  return {
    instanceId: runtime.instanceId,
    killedPids: [...killedPids].sort((left, right) => left - right),
    removedRoot: runtime.tmpRoot,
  };
}

export async function cleanupStandaloneOrphans() {
  const killedPids = new Set();
  const removedRoots = new Set();
  const roots = await listStandaloneTmpRoots();

  for (const tmpRoot of roots) {
    const state = await readJsonIfExists(path.join(tmpRoot, "standalone-state.json"));
    const runtime = readStandaloneStateRuntime(state);
    if (!runtime.parentPid || (await isProcessRunning(runtime.parentPid))) {
      continue;
    }
    const cleanupResult = await cleanupStandaloneInstance({
      ...state,
      tmpRoot,
    }).catch(() => ({
      killedPids: [],
      removedRoot: null,
    }));
    for (const pid of cleanupResult.killedPids) {
      killedPids.add(pid);
    }
    if (cleanupResult.removedRoot) {
      removedRoots.add(cleanupResult.removedRoot);
    }
  }

  for (const processInfo of await listStandaloneProcesses()) {
    if (
      !processInfo.parentPid ||
      killedPids.has(processInfo.pid) ||
      (await isProcessRunning(processInfo.parentPid))
    ) {
      continue;
    }
    await killProcess(processInfo.pid).catch(() => undefined);
    killedPids.add(processInfo.pid);
  }

  return {
    killedPids: [...killedPids].sort((left, right) => left - right),
    removedRoots: [...removedRoots].sort(),
  };
}

export function buildDaemonRestartCommand(args) {
  const shutdownCommand = args.daemonPid
    ? [
        `(kill ${shellQuote(String(args.daemonPid))} >/dev/null 2>&1 || true)`,
        `while kill -0 ${shellQuote(String(args.daemonPid))} 2>/dev/null; do sleep 1; done`,
      ]
    : [];

  const startCommand = [
    `BB_DATA_DIR=${shellQuote(args.dataDir)}`,
    `BB_HOST_DAEMON_PORT=${shellQuote(String(args.daemonPort))}`,
    `BB_SERVER_URL=${shellQuote(args.serverUrl)}`,
    `BB_STANDALONE_PARENT_PID=${shellQuote(String(args.parentPid))}`,
    `node ${shellQuote(args.entrypoint)} >> ${shellQuote(args.logPath)} 2>&1 &`,
  ].join(" ");

  return [...shutdownCommand, startCommand].join("; ");
}

export async function waitFor(check, options) {
  const startedAt = Date.now();

  while (Date.now() - startedAt <= options.timeoutMs) {
    const result = await check();
    if (result) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 100));
  }

  throw new Error(`Timed out waiting for ${options.description}`);
}

export async function waitForConnectedHost(serverUrl) {
  return waitFor(
    async () => {
      let response;
      try {
        response = await fetch(`${serverUrl}/api/v1/hosts`);
      } catch {
        return null;
      }
      if (!response.ok) {
        return null;
      }
      const hosts = await response.json();
      return hosts.find((host) => host.status === "connected") ?? null;
    },
    {
      timeoutMs: 10_000,
      description: "host daemon connection",
    },
  );
}

export async function waitForServerReady(serverUrl) {
  return waitFor(
    async () => {
      try {
        const response = await fetch(`${serverUrl}/api/v1/system/config`);
        return response.ok ? true : null;
      } catch {
        return null;
      }
    },
    {
      timeoutMs: 10_000,
      description: "server health check",
    },
  );
}

async function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}
