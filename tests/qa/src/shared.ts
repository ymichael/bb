import { execFile as execFileCallback, spawn } from "node:child_process";
import type { ChildProcess, ExecFileException } from "node:child_process";
import { closeSync, openSync, writeSync } from "node:fs";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { hostSchema } from "@bb/domain";
import type { Host } from "@bb/domain";
import {
  createHostJoinResponseSchema,
  projectResponseSchema,
  type CreateHostJoinRequest,
  type CreateHostJoinResponse,
  type CreateProjectRequest,
  type ProjectResponse,
} from "@bb/server-contract";
import { z } from "zod";

const execFile = promisify(execFileCallback);

export const STANDALONE_INSTANCE_ENV = "BB_STANDALONE_INSTANCE";
export const STANDALONE_PARENT_PID_ENV = "BB_STANDALONE_PARENT_PID";
const STANDALONE_TMP_PREFIX = "bb-standalone-";
const PROCESS_SCAN_MAX_BUFFER = 10 * 1024 * 1024;

type EnvironmentMap = Record<string, string>;

interface StandaloneStateRuntime {
  daemonPid: number | null;
  instanceId: string | null;
  parentPid: number | null;
  serverPid: number | null;
  tmpRoot: string | null;
}

interface SpawnLoggedProcessOptions {
  args: string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
}

interface StartQuickTunnelArgs {
  env?: NodeJS.ProcessEnv;
  logPath: string;
  maxAttempts?: number;
  port: number;
  timeoutMs?: number;
}

interface StartQuickTunnelResult {
  process: ChildProcess;
  publicUrl: string;
}

interface StartQaServerArgs {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  logPath: string;
  port: number;
  publicUrl?: string;
  reuseExisting?: boolean;
}

interface StartQaServerResult {
  process: ChildProcess | null;
  reusedExisting: boolean;
  serverUrl: string;
}

interface BuildDaemonRestartCommandArgs {
  daemonPid: number | null | undefined;
  daemonPort: number;
  dataDir: string;
  entrypoint: string;
  envFilePath: string | null;
  hostId: string;
  logPath: string;
  parentPid: number;
  serverUrl: string;
}

interface StandaloneProcessInfo {
  instanceId: string | null;
  parentPid: number | null;
  pid: number;
}

interface CleanupStandaloneResult {
  instanceId?: string | null;
  killedPids: number[];
  removedRoot?: string | null;
  removedRoots?: string[];
}

interface LoadDotEnvResult {
  loaded: EnvironmentMap;
  path: string | null;
}

export interface ResolveStandaloneParentPidArgs {
  env: NodeJS.ProcessEnv;
  fallbackPid: number;
}

interface WaitForOptions {
  description: string;
  intervalMs?: number;
  timeoutMs: number;
}

const standaloneStateSchema = z.object({
  daemon: z
    .object({
      pid: z.number().int().positive().nullable().optional(),
    })
    .optional(),
  instanceId: z.string().nullable().optional(),
  parentPid: z.number().int().positive().nullable().optional(),
  paths: z
    .object({
      tmpRoot: z.string().nullable().optional(),
    })
    .optional(),
  server: z
    .object({
      pid: z.number().int().positive().nullable().optional(),
    })
    .optional(),
});

type StandaloneState = z.infer<typeof standaloneStateSchema>;

const connectedHostListSchema = z.array(hostSchema);

export const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

function isNodeError(error: unknown): error is ExecFileException {
  return error instanceof Error;
}

export function shellQuote(value: string): string {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

export function buildShellExports(env: EnvironmentMap): string {
  return Object.entries(env)
    .map(([key, value]) => `export ${key}=${shellQuote(String(value))}`)
    .join("\n");
}

export function readStandaloneStateRuntime(
  state: StandaloneState | null,
): StandaloneStateRuntime {
  return {
    daemonPid: state?.daemon?.pid ?? null,
    instanceId: state?.instanceId ?? null,
    parentPid: state?.parentPid ?? null,
    serverPid: state?.server?.pid ?? null,
    tmpRoot: state?.paths?.tmpRoot ?? null,
  };
}

export function parseStandaloneState(raw: string): StandaloneState {
  return standaloneStateSchema.parse(JSON.parse(raw));
}

export function resolveStandaloneParentPid(
  args: ResolveStandaloneParentPidArgs,
): number {
  const configuredPid = Number.parseInt(
    args.env[STANDALONE_PARENT_PID_ENV] ?? "",
    10,
  );
  return Number.isInteger(configuredPid) && configuredPid > 0
    ? configuredPid
    : args.fallbackPid;
}

async function resolveProjectEnvCandidates(): Promise<string[]> {
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

export async function createTestGitRepo(repoDir: string): Promise<string> {
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

export async function createProject(
  serverUrl: string,
  project: CreateProjectRequest,
): Promise<ProjectResponse> {
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
  return projectResponseSchema.parse(await response.json());
}

export async function createHostJoin(
  serverUrl: string,
  body: CreateHostJoinRequest = { hostType: "persistent" },
): Promise<CreateHostJoinResponse> {
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
  return createHostJoinResponseSchema.parse(await response.json());
}

export async function killProcess(
  pid: number | null | undefined,
): Promise<void> {
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

export async function loadDotEnv(): Promise<LoadDotEnvResult> {
  const loaded: EnvironmentMap = {};

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

export async function reservePort(): Promise<number> {
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

export function buildLocalServerUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFile("git", args, { cwd });
}

export function spawnLoggedProcess(
  options: SpawnLoggedProcessOptions,
): ChildProcess {
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

function extractQuickTunnelUrl(text: string): string | null {
  const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/iu);
  return match?.[0] ?? null;
}

export async function startQuickTunnel(
  args: StartQuickTunnelArgs,
): Promise<StartQuickTunnelResult> {
  const originUrl = buildLocalServerUrl(args.port);
  const maxAttempts = args.maxAttempts ?? 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const logFd = openSync(args.logPath, "a");
    let closed = false;
    let child: ChildProcess | null = null;

    const closeLogFd = () => {
      if (closed) {
        return;
      }
      closed = true;
      closeSync(logFd);
    };

    writeSync(
      logFd,
      `\n--- quick tunnel attempt ${attempt}/${maxAttempts} ---\n`,
    );

    try {
      child = spawn(
        "cloudflared",
        [
          "tunnel",
          "--no-autoupdate",
          "--url",
          originUrl,
          "--metrics",
          "127.0.0.1:0",
        ],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            ...(args.env ?? {}),
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      child.unref();
      const tunnelProcess = child;

      let discoveredUrl: string | null = null;

      const handleOutput = (chunk: Buffer): void => {
        writeSync(logFd, chunk);
        if (discoveredUrl) {
          return;
        }
        const nextUrl = extractQuickTunnelUrl(String(chunk));
        if (nextUrl) {
          discoveredUrl = nextUrl;
        }
      };

      tunnelProcess.stdout?.on("data", handleOutput);
      tunnelProcess.stderr?.on("data", handleOutput);
      tunnelProcess.once("exit", closeLogFd);

      tunnelProcess.once("error", (error) => {
        writeSync(logFd, `${String(error)}\n`);
      });

      try {
        const publicUrl = await waitFor(
          async () => {
            if (discoveredUrl) {
              return discoveredUrl;
            }
            if (tunnelProcess.exitCode !== null) {
              throw new Error(
                `cloudflared exited with code ${tunnelProcess.exitCode}`,
              );
            }
            if (tunnelProcess.killed) {
              throw new Error(
                "cloudflared was killed before producing a public URL",
              );
            }
            return null;
          },
          {
            timeoutMs: args.timeoutMs ?? 20_000,
            description: "cloudflared quick tunnel URL",
          },
        );

        return {
          process: tunnelProcess,
          publicUrl,
        };
      } catch (error) {
        await killProcess(child.pid).catch(() => undefined);
        closeLogFd();
        if (attempt === maxAttempts) {
          throw new Error(
            `Failed to start quick tunnel for ${originUrl}. See ${args.logPath} for details.`,
            { cause: error instanceof Error ? error : undefined },
          );
        }
      }
    } catch (error) {
      await killProcess(child?.pid).catch(() => undefined);
      closeLogFd();
      if (attempt === maxAttempts) {
        throw error;
      }
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 1_000 * attempt);
    });
  }

  throw new Error(`Failed to start quick tunnel for ${originUrl}`);
}

async function isServerReady(serverUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${serverUrl}/api/v1/system/config`, {
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function readLogExcerpt(logPath: string): Promise<string | null> {
  try {
    const content = await fs.readFile(logPath, "utf8");
    return content.slice(-4_000);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function startQaServer(
  args: StartQaServerArgs,
): Promise<StartQaServerResult> {
  const serverUrl = buildLocalServerUrl(args.port);

  if (args.reuseExisting && (await isServerReady(serverUrl))) {
    return {
      process: null,
      reusedExisting: true,
      serverUrl,
    };
  }

  const serverProcess = spawnLoggedProcess({
    command: process.execPath,
    args: ["apps/server/dist/index.js"],
    cwd: repoRoot,
    env: {
      ...process.env,
      BB_DATA_DIR: args.dataDir,
      BB_SERVER_PORT: String(args.port),
      ...(args.publicUrl ? { BB_EXTERNAL_URL: args.publicUrl } : {}),
      ...(args.env ?? {}),
    },
    logPath: args.logPath,
  });

  try {
    await waitForServerReady(serverUrl);
  } catch (error) {
    await killProcess(serverProcess.pid).catch(() => undefined);
    const logExcerpt = await readLogExcerpt(args.logPath);
    const logDetails = logExcerpt ? `\n\nLog output:\n${logExcerpt}` : "";
    throw new Error(
      `Failed to start QA server at ${serverUrl}. See ${args.logPath} for details.${logDetails}`,
      { cause: error instanceof Error ? error : undefined },
    );
  }

  return {
    process: serverProcess,
    reusedExisting: false,
    serverUrl,
  };
}

async function readJsonIfExists(
  filePath: string,
): Promise<StandaloneState | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return parseStandaloneState(raw);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function listStandaloneTmpRoots(): Promise<string[]> {
  const entries = await fs.readdir(tmpdir(), { withFileTypes: true });
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() && entry.name.startsWith(STANDALONE_TMP_PREFIX),
    )
    .map((entry) => path.join(tmpdir(), entry.name));
}

async function listOpenFilePids(targetPath: string): Promise<number[]> {
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

async function listProcessesByInstance(instanceId: string): Promise<number[]> {
  return (await listStandaloneProcesses())
    .filter((entry) => entry.instanceId === instanceId)
    .map((entry) => entry.pid);
}

function readStandaloneEnvValue(
  command: string,
  envName: string,
): string | null {
  const match = new RegExp(`${envName}=([^\\s]+)`, "u").exec(command);
  return match?.[1] ?? null;
}

async function listStandaloneProcesses(): Promise<StandaloneProcessInfo[]> {
  const { stdout } = await execFile("ps", ["eww", "-Ao", "pid=,command="], {
    encoding: "utf8",
    maxBuffer: PROCESS_SCAN_MAX_BUFFER,
  });
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line): Array<{ command: string; pid: number }> => {
      const match = /^(\d+)\s+(.*)$/u.exec(line);
      if (!match) {
        return [];
      }
      return [
        {
          command: match[2],
          pid: Number.parseInt(match[1], 10),
        },
      ];
    })
    .filter((entry) => entry.command.includes(`${STANDALONE_INSTANCE_ENV}=`))
    .map((entry) => {
      const parentPid = Number.parseInt(
        readStandaloneEnvValue(entry.command, STANDALONE_PARENT_PID_ENV) ?? "",
        10,
      );
      return {
        instanceId: readStandaloneEnvValue(
          entry.command,
          STANDALONE_INSTANCE_ENV,
        ),
        parentPid:
          Number.isInteger(parentPid) && parentPid > 0 ? parentPid : null,
        pid: entry.pid,
      };
    });
}

export async function cleanupStandaloneInstance(
  state: StandaloneState,
): Promise<CleanupStandaloneResult> {
  const runtime = readStandaloneStateRuntime(state);
  const killedPids = new Set<number>();
  const pidsToKill = new Set<number | null>([
    runtime.daemonPid,
    runtime.serverPid,
    ...(runtime.instanceId
      ? await listProcessesByInstance(runtime.instanceId)
      : []),
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

export async function cleanupStandaloneOrphans(): Promise<CleanupStandaloneResult> {
  const killedPids = new Set<number>();
  const removedRoots = new Set<string>();
  const roots = await listStandaloneTmpRoots();

  for (const tmpRoot of roots) {
    const state = await readJsonIfExists(
      path.join(tmpRoot, "standalone-state.json"),
    );
    const runtime = readStandaloneStateRuntime(state);
    if (!runtime.parentPid || (await isProcessRunning(runtime.parentPid))) {
      continue;
    }
    const cleanupResult = await cleanupStandaloneInstance({
      ...state,
      paths: {
        ...state?.paths,
        tmpRoot,
      },
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

export function buildDaemonRestartCommand(
  args: BuildDaemonRestartCommandArgs,
): string {
  const shutdownCommand = args.daemonPid
    ? [
        `(kill ${shellQuote(String(args.daemonPid))} >/dev/null 2>&1 || true)`,
        `while kill -0 ${shellQuote(String(args.daemonPid))} 2>/dev/null; do sleep 1; done`,
      ]
    : [];

  const envFileCommand = args.envFilePath
    ? `[ ! -f ${shellQuote(args.envFilePath)} ] || . ${shellQuote(args.envFilePath)}`
    : ":";
  const daemonEnv = [
    `BB_DATA_DIR=${shellQuote(args.dataDir)}`,
    `BB_HOST_DAEMON_PORT=${shellQuote(String(args.daemonPort))}`,
    `BB_SERVER_URL=${shellQuote(args.serverUrl)}`,
    `BB_STANDALONE_PARENT_PID=${shellQuote(String(args.parentPid))}`,
  ].join(" ");
  const startCommand =
    `(set -a; ${envFileCommand}; set +a; ` +
    `${daemonEnv} exec node ${shellQuote(args.entrypoint)} ` +
    `>> ${shellQuote(args.logPath)} 2>&1) &`;
  const waitForReconnectCommand = [
    "connected=0",
    `for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do if curl -fsS ${shellQuote(`${args.serverUrl}/api/v1/hosts`)} | jq -e ${shellQuote(`any(.[]; .id == ${JSON.stringify(args.hostId)} and .status == "connected")`)} >/dev/null; then connected=1; break; fi`,
    "sleep 1",
    "done",
    `[ "$connected" = 1 ]`,
  ].join("; ");
  const startAndWaitCommand = `${startCommand} ${waitForReconnectCommand}`;

  return [...shutdownCommand, startAndWaitCommand].join("; ");
}

export async function waitFor<TResult>(
  check: () => Promise<TResult | null | false> | TResult | null | false,
  options: WaitForOptions,
): Promise<TResult> {
  const startedAt = Date.now();

  while (Date.now() - startedAt <= options.timeoutMs) {
    const result = await check();
    if (result) {
      return result;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, options.intervalMs ?? 100),
    );
  }

  throw new Error(`Timed out waiting for ${options.description}`);
}

export async function waitForConnectedHost(serverUrl: string): Promise<Host> {
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
      const hosts = connectedHostListSchema.parse(await response.json());
      return hosts.find((host) => host.status === "connected") ?? null;
    },
    {
      timeoutMs: 10_000,
      description: "host daemon connection",
    },
  );
}

export async function waitForServerReady(serverUrl: string): Promise<boolean> {
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

async function isProcessRunning(pid: number): Promise<boolean> {
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
