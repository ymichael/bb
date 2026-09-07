import { execFile as execFileCallback, spawn } from "node:child_process";
import type { ChildProcess, ExecFileException } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { hostSchema } from "@bb/domain";
import type { Host } from "@bb/domain";
import {
  type CreateProjectRequest,
  type ProjectResponse,
  projectResponseSchema,
} from "@bb/server-contract";
import {
  hostDaemonEnrollKeyResponseSchema,
  type HostDaemonEnrollKeyResponse,
} from "@bb/host-daemon-contract";
import { z } from "zod";

const execFile = promisify(execFileCallback);

export const STANDALONE_INSTANCE_ENV = "BB_STANDALONE_INSTANCE";
export const STANDALONE_PARENT_PID_ENV = "BB_STANDALONE_PARENT_PID";
export const STANDALONE_OPENAI_API_KEY_ENV = "BB_QA_OPENAI_API_KEY";
const STANDALONE_TMP_PREFIX = "bb-standalone-";
const PROCESS_SCAN_MAX_BUFFER = 10 * 1024 * 1024;

type EnvironmentMap = Record<string, string>;
const STANDALONE_THREAD_CONTEXT_ENV = [
  "BB_THREAD_ID",
  "BB_ENVIRONMENT_ID",
  "BB_THREAD_STORAGE",
];
const RESTART_DAEMON_ENTRYPOINT_ENV = "BB_RESTART_DAEMON_ENTRYPOINT";
const RESTART_DAEMON_CWD_ENV = "BB_RESTART_DAEMON_CWD";
const RESTART_DAEMON_LOG_PATH_ENV = "BB_RESTART_DAEMON_LOG_PATH";
const RESTART_DAEMON_PID_PATH_ENV = "BB_RESTART_DAEMON_PID_PATH";
const DETACHED_DAEMON_LAUNCHER_SCRIPT = [
  'const { spawn } = require("node:child_process");',
  'const { closeSync, openSync, writeFileSync } = require("node:fs");',
  "function requiredEnv(name) {",
  "  const value = process.env[name];",
  "  if (!value) throw new Error(`Missing ${name}`);",
  "  return value;",
  "}",
  `const entrypoint = requiredEnv("${RESTART_DAEMON_ENTRYPOINT_ENV}");`,
  `const cwd = requiredEnv("${RESTART_DAEMON_CWD_ENV}");`,
  `const logPath = requiredEnv("${RESTART_DAEMON_LOG_PATH_ENV}");`,
  `const pidPath = requiredEnv("${RESTART_DAEMON_PID_PATH_ENV}");`,
  "const daemonEnv = { ...process.env };",
  `delete daemonEnv["${RESTART_DAEMON_ENTRYPOINT_ENV}"];`,
  `delete daemonEnv["${RESTART_DAEMON_CWD_ENV}"];`,
  `delete daemonEnv["${RESTART_DAEMON_LOG_PATH_ENV}"];`,
  `delete daemonEnv["${RESTART_DAEMON_PID_PATH_ENV}"];`,
  'const logFd = openSync(logPath, "a");',
  "try {",
  "  const child = spawn(process.execPath, [entrypoint], {",
  "    cwd,",
  "    detached: true,",
  "    env: daemonEnv,",
  '    stdio: ["ignore", logFd, logFd],',
  "  });",
  "  writeFileSync(pidPath, String(child.pid));",
  "  child.unref();",
  "} finally {",
  "  closeSync(logFd);",
  "}",
].join("\n");

interface StandaloneStateRuntime {
  daemonPid: number | null;
  daemonRestartPidPath: string | null;
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

interface StartQaServerArgs {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  logPath: string;
  port: number;
  publicUrl?: string;
}

interface StartQaServerResult {
  process: ChildProcess;
  serverUrl: string;
}

interface BuildDaemonRestartCommandArgs {
  cwd: string;
  daemonPid: number | null | undefined;
  daemonPort: number;
  dataDir: string;
  entrypoint: string;
  envFilePath: string | null;
  hostId: string;
  instanceId: string;
  logPath: string;
  parentPid: number;
  pidPath: string;
  serverUrl: string;
}

interface StandaloneProcessInfo {
  instanceId: string | null;
  parentPid: number | null;
  pid: number;
}

interface ShouldCleanupStandaloneParentArgs {
  parentPid: number;
  source: string;
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

interface BuildStandaloneRuntimeEnvArgs {
  baseEnv: NodeJS.ProcessEnv;
  overrides: NodeJS.ProcessEnv;
}

interface ResolveStandaloneParentPidArgs {
  env: NodeJS.ProcessEnv;
  fallbackPid: number;
}

interface WaitForOptions {
  description: string;
  intervalMs?: number;
  timeoutMs: number;
}

type ProcessSignalStatus = "missing" | "permission-denied" | "running";

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
      daemonRestartPidPath: z.string().nullable().optional(),
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

function isRestrictedProcessScanError(error: ExecFileException): boolean {
  return error.code === "EACCES" || error.code === "EPERM" || error.code === 1;
}

function warnProcessEnumerationSkipped(error: ExecFileException): void {
  const reason =
    error.code == null ? error.message : `code ${String(error.code)}`;
  console.warn(
    `Warning: skipped standalone QA process enumeration (${reason}); orphaned QA processes may remain.`,
  );
}

function warnStandaloneParentSkipped(
  args: ShouldCleanupStandaloneParentArgs,
): void {
  console.warn(
    `Warning: skipped standalone QA cleanup for ${args.source} because parent process ${String(args.parentPid)} is not signalable; root may belong to another user or session.`,
  );
}

export function shellQuote(value: string): string {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function buildShellExports(env: EnvironmentMap): string {
  return Object.entries(env)
    .map(([key, value]) => `export ${key}=${shellQuote(String(value))}`)
    .join("\n");
}

export function buildStandaloneShellExports(env: EnvironmentMap): string {
  const unsetThreadContext = STANDALONE_THREAD_CONTEXT_ENV.map(
    (key) => `unset ${key}`,
  );
  return [...unsetThreadContext, buildShellExports(env)].join("\n");
}

export function buildStandaloneRuntimeEnv(
  args: BuildStandaloneRuntimeEnvArgs,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...args.baseEnv,
    ...args.overrides,
  };
  for (const key of STANDALONE_THREAD_CONTEXT_ENV) {
    delete env[key];
  }
  const qaOpenAiApiKey = env[STANDALONE_OPENAI_API_KEY_ENV];
  if (typeof qaOpenAiApiKey === "string" && qaOpenAiApiKey.trim().length > 0) {
    env.OPENAI_API_KEY = qaOpenAiApiKey;
  } else {
    delete env.OPENAI_API_KEY;
  }
  return env;
}

export function readStandaloneStateRuntime(
  state: StandaloneState | null,
): StandaloneStateRuntime {
  return {
    daemonPid: state?.daemon?.pid ?? null,
    daemonRestartPidPath: state?.paths?.daemonRestartPidPath ?? null,
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

export async function createHostEnrollKey(
  serverUrl: string,
): Promise<HostDaemonEnrollKeyResponse> {
  const response = await fetch(`${serverUrl}/internal/hosts/enroll-key`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({}),
  });
  if (!response.ok) {
    throw new Error(
      `Failed to create host enroll key: ${response.status} ${await response.text()}`,
    );
  }
  return hostDaemonEnrollKeyResponseSchema.parse(await response.json());
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

function buildLocalServerUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFile("git", args, { cwd });
}

export function spawnLoggedProcess(
  options: SpawnLoggedProcessOptions,
): ChildProcess {
  const logFd = openSync(options.logPath, "a");
  try {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      detached: true,
      env: options.env,
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
    return child;
  } finally {
    closeSync(logFd);
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

  const serverEnv: NodeJS.ProcessEnv = {
    ...(args.env ?? process.env),
    BB_DATA_DIR: args.dataDir,
    BB_SERVER_PORT: String(args.port),
  };
  if (args.publicUrl) {
    serverEnv.BB_APP_URL = args.publicUrl;
    serverEnv.BB_EXTERNAL_URL = args.publicUrl;
  } else {
    delete serverEnv.BB_APP_URL;
    delete serverEnv.BB_EXTERNAL_URL;
  }

  const serverProcess = spawnLoggedProcess({
    command: process.execPath,
    args: ["apps/server/dist/index.js"],
    cwd: repoRoot,
    env: serverEnv,
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

async function readPidFile(pidPath: string | null): Promise<number | null> {
  if (!pidPath) {
    return null;
  }

  try {
    const rawPid = await fs.readFile(pidPath, "utf8");
    const pid = Number.parseInt(rawPid.trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
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
  let stdout: string;
  try {
    const result = await execFile("ps", ["eww", "-Ao", "pid=,command="], {
      encoding: "utf8",
      maxBuffer: PROCESS_SCAN_MAX_BUFFER,
    });
    stdout = result.stdout;
  } catch (error) {
    if (isNodeError(error) && isRestrictedProcessScanError(error)) {
      warnProcessEnumerationSkipped(error);
      return [];
    }
    throw error;
  }

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

function getProcessSignalStatus(pid: number): ProcessSignalStatus {
  try {
    process.kill(pid, 0);
    return "running";
  } catch (error) {
    if (isNodeError(error) && error.code === "ESRCH") {
      return "missing";
    }
    if (isNodeError(error) && error.code === "EPERM") {
      return "permission-denied";
    }
    throw error;
  }
}

function shouldCleanupStandaloneParent(
  args: ShouldCleanupStandaloneParentArgs,
): boolean {
  const status = getProcessSignalStatus(args.parentPid);
  if (status === "missing") {
    return true;
  }
  if (status === "permission-denied") {
    warnStandaloneParentSkipped(args);
  }
  return false;
}

export async function cleanupStandaloneInstance(
  state: StandaloneState,
): Promise<CleanupStandaloneResult> {
  const runtime = readStandaloneStateRuntime(state);
  const killedPids = new Set<number>();
  const pidsToKill = new Set<number | null>([
    runtime.daemonPid,
    await readPidFile(runtime.daemonRestartPidPath),
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
    if (
      !runtime.parentPid ||
      !shouldCleanupStandaloneParent({
        parentPid: runtime.parentPid,
        source: tmpRoot,
      })
    ) {
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
      !shouldCleanupStandaloneParent({
        parentPid: processInfo.parentPid,
        source: `process ${String(processInfo.pid)}`,
      })
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
  const fallbackDaemonPid = args.daemonPid
    ? shellQuote(String(args.daemonPid))
    : "''";
  const pidPath = shellQuote(args.pidPath);
  const resolveCurrentPidCommand = [
    `daemon_pid=${fallbackDaemonPid}`,
    `if [ -s ${pidPath} ]; then daemon_pid=$(cat ${pidPath}); fi`,
    "daemon_pid_valid=1",
    `case "$daemon_pid" in '' ) ;; *[!0-9]*) echo "Invalid daemon PID: $daemon_pid" >&2; daemon_pid_valid=0 ;; *) if ! [ "$daemon_pid" -gt 0 ]; then echo "Invalid daemon PID: $daemon_pid" >&2; daemon_pid_valid=0; fi ;; esac`,
  ].join("; ");
  const shutdownCommand = [
    `(kill "$daemon_pid" >/dev/null 2>&1 || true)`,
    `while kill -0 "$daemon_pid" 2>/dev/null; do sleep 1; done`,
  ].join("; ");

  const envFileCommand = args.envFilePath
    ? `[ ! -f ${shellQuote(args.envFilePath)} ] || . ${shellQuote(args.envFilePath)}`
    : ":";
  const qaOpenAiApiKeyParameter = `\${${STANDALONE_OPENAI_API_KEY_ENV}-}`;
  const providerEnvCommand =
    `case "${qaOpenAiApiKeyParameter}" in *[![:space:]]*) ` +
    `OPENAI_API_KEY="$${STANDALONE_OPENAI_API_KEY_ENV}"; export OPENAI_API_KEY ;; ` +
    "*) unset OPENAI_API_KEY ;; esac";
  const daemonEnv = [
    `BB_DATA_DIR=${shellQuote(args.dataDir)}`,
    `BB_HOST_DAEMON_PORT=${shellQuote(String(args.daemonPort))}`,
    `BB_SERVER_URL=${shellQuote(args.serverUrl)}`,
    `${STANDALONE_INSTANCE_ENV}=${shellQuote(args.instanceId)}`,
    `BB_STANDALONE_PARENT_PID=${shellQuote(String(args.parentPid))}`,
  ].join(" ");
  const launcherEnv = [
    `${RESTART_DAEMON_ENTRYPOINT_ENV}=${shellQuote(args.entrypoint)}`,
    `${RESTART_DAEMON_CWD_ENV}=${shellQuote(args.cwd)}`,
    `${RESTART_DAEMON_LOG_PATH_ENV}=${shellQuote(args.logPath)}`,
    `${RESTART_DAEMON_PID_PATH_ENV}=${shellQuote(args.pidPath)}`,
  ].join(" ");
  const startScript =
    `set -a; ${envFileCommand}; set +a; ` +
    `${providerEnvCommand}; ` +
    `${daemonEnv} ${launcherEnv} node -e ${shellQuote(DETACHED_DAEMON_LAUNCHER_SCRIPT)}`;
  const startCommand = `(${startScript}) </dev/null >> ${shellQuote(args.logPath)} 2>&1`;
  const waitForReconnectCommand = [
    "connected=0",
    `for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do if curl -fsS ${shellQuote(`${args.serverUrl}/api/v1/hosts`)} | jq -e ${shellQuote(`any(.[]; .id == ${JSON.stringify(args.hostId)} and .status == "connected")`)} >/dev/null; then connected=1; break; fi`,
    "sleep 1",
    "done",
    `[ "$connected" = 1 ]`,
  ].join("; ");
  const startAndWaitCommand = `${startCommand}; ${waitForReconnectCommand}`;

  return (
    `${resolveCurrentPidCommand}; ` +
    `if [ "$daemon_pid_valid" = 1 ]; then ` +
    `if [ -n "$daemon_pid" ]; then ${shutdownCommand}; fi; ` +
    `${startAndWaitCommand}; else false; fi`
  );
}

async function waitFor<TResult>(
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

async function waitForServerReady(serverUrl: string): Promise<boolean> {
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
  return getProcessSignalStatus(pid) !== "missing";
}
