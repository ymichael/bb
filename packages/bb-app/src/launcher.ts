#!/usr/bin/env node
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";

const DEFAULT_SERVER_PORT = 38886;
const DEFAULT_HOST_DAEMON_PORT = 38887;
const DEFAULT_DATA_DIR_NAME = ".bb";
const CONFIG_FILE_NAME = "config.json";
const HOST_AUTH_FILE_NAME = "auth.json";
const HOST_ID_FILE_NAME = "host-id";
const HEALTH_CHECK_TIMEOUT_MS = 15_000;
const HEALTH_CHECK_INTERVAL_MS = 100;
const START_COMMAND = "start";
const HOST_DAEMON_COMMAND = "host-daemon";
const HOST_DAEMON_JOIN_COMMAND = "join";

const hostJoinResponseSchema = z
  .object({
    hostId: z.string().min(1),
    joinCode: z.string().min(1),
  })
  .passthrough();

const managedConfigSchema = z.object({
  serverUrl: z.string().min(1).optional(),
});

export type HostJoinResponse = z.infer<typeof hostJoinResponseSchema>;
export type ManagedConfig = z.infer<typeof managedConfigSchema>;

export interface PersistentHostJoinRequestBody {
  hostId?: string;
  hostType?: "persistent";
}

export interface LocalHostJoinRequestBody {
  hostId?: string;
  hostType: "persistent";
  joinMode: "local";
}

export type HostJoinRequestBody =
  | LocalHostJoinRequestBody
  | PersistentHostJoinRequestBody;

export interface CreateHostJoinRequestBodyArgs {
  localJoin: boolean;
  requestedHostId: string | null;
}

export interface ResolveDataDirArgs {
  env: NodeJS.ProcessEnv;
  homeDir: string;
}

export interface ResolvePortArgs {
  defaultPort: number;
  env: NodeJS.ProcessEnv;
  name: string;
}

export interface ResolveBbAppStartContextArgs {
  entrypointUrl: string;
  env: NodeJS.ProcessEnv;
  homeDir: string;
}

export interface ResolveBbAppRuntimeContextArgs {
  entrypointUrl: string;
  env: NodeJS.ProcessEnv;
  homeDir: string;
  options: LauncherCliOptions;
  serverUrlMode: "local" | "managed";
}

export interface BbAppStartContext {
  appDistDir: string;
  configFile: string;
  daemonBundleDir: string;
  daemonEntry: string;
  daemonLockDir: string;
  daemonLockFile: string;
  daemonPort: number;
  dataDir: string;
  dbPath: string;
  logDir: string;
  packageRoot: string;
  serverEntry: string;
  serverPort: number;
  serverUrl: string;
}

export interface IsMainModuleArgs {
  entrypointPath: string | undefined;
  moduleUrl: string;
}

export interface StartCommand {
  kind: "start";
}

export interface HostDaemonCommand {
  args: string[];
  kind: "host-daemon";
}

export interface HelpCommand {
  kind: "help";
}

export interface InvalidCommand {
  command: string;
  kind: "invalid";
}

export interface LauncherCliOptions {
  dataDir?: string;
  enrollKey?: string;
  help: boolean;
  hostDaemonPort?: string;
  hostId?: string;
  joinCode?: string;
  serverPort?: string;
  serverUrl?: string;
}

export interface ParsedLauncherArgs {
  options: LauncherCliOptions;
  positionals: string[];
}

interface ManagedSpawnArgs {
  args: string[];
  command: string;
  env: NodeJS.ProcessEnv;
  outputBuffer: OutputBuffer;
}

interface OutputBuffer {
  flush(): void;
  handler(chunk: OutputChunk): void;
}

interface ProcessExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

type ManagedProcessName = "daemon" | "server";
type OutputChunk = Buffer | string;
type BbAppCommand =
  | HelpCommand
  | HostDaemonCommand
  | InvalidCommand
  | StartCommand;

interface WaitForNamedProcessExitArgs {
  childProcess: ChildProcess;
  processName: ManagedProcessName;
}

interface NamedProcessExitResult {
  processName: ManagedProcessName;
  result: ProcessExitResult;
}

interface WaitForHealthArgs {
  childProcess: ChildProcess | null;
  timeoutMs?: number;
  url: string;
}

interface RequestHostJoinArgs {
  localJoin: boolean;
  requestedHostId: string | null;
  serverUrl: string;
}

interface MaybeAddAutoJoinEnvArgs {
  dataDir: string;
  env: NodeJS.ProcessEnv;
  serverUrl: string;
}

interface ArtifactPath {
  label: string;
  path: string;
}

interface CreateCliEnvArgs {
  context: BbAppStartContext;
  env: NodeJS.ProcessEnv;
}

interface CreateHostDaemonOnlyEnvArgs {
  context: BbAppStartContext;
  env: NodeJS.ProcessEnv;
  serverUrl: string;
}

interface EnrollmentRequirements {
  enrollKey?: string;
  enrolled: boolean;
}

interface ResolveEnrollmentRequirementsArgs {
  context: BbAppStartContext;
  env: NodeJS.ProcessEnv;
}

interface ResolveHostDaemonServerUrlArgs {
  context: BbAppStartContext;
  env: NodeJS.ProcessEnv;
}

interface CreateHostDaemonJoinEnvArgs {
  context: BbAppStartContext;
  env: NodeJS.ProcessEnv;
  serverUrl: string;
}

interface CreateEnvFromOptionsArgs {
  env: NodeJS.ProcessEnv;
  options: LauncherCliOptions;
}

interface ResolveManagedConfigArgs {
  dataDir: string;
}

interface WriteManagedConfigArgs {
  config: ManagedConfig;
  dataDir: string;
}

interface ResolveServerUrlArgs {
  config: ManagedConfig;
  defaultServerUrl: string;
  env: NodeJS.ProcessEnv;
}

interface ResolveHostDaemonCommandResult {
  kind: "join" | "start";
}

function color(code: number, value: string): string {
  return `\x1b[${code}m${value}\x1b[0m`;
}

function bold(value: string): string {
  return color(1, value);
}

function cyan(value: string): string {
  return color(36, value);
}

function dim(value: string): string {
  return color(2, value);
}

function green(value: string): string {
  return color(32, value);
}

function red(value: string): string {
  return color(31, value);
}

function yellow(value: string): string {
  return color(33, value);
}

function log(icon: string, message: string): void {
  process.stdout.write(`  ${icon}  ${message}\n`);
}

function beginStep(message: string): void {
  process.stdout.write(`\x1b[2K  ${dim("○")}  ${message}\r`);
}

function endStep(icon: string, message: string): void {
  process.stdout.write(`\x1b[2K  ${icon}  ${message}\n`);
}

function formatReadyOutputRow(label: string, value: string): string {
  return `${dim(label.padEnd("daemon".length))} ${value}`;
}

function createDefaultLauncherOptions(): LauncherCliOptions {
  return { help: false };
}

function trimToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readStringOption(
  value: boolean | string | string[] | undefined,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return trimToUndefined(value);
}

function readBooleanOption(
  value: boolean | string | string[] | undefined,
): boolean {
  return value === true;
}

function chooseServerUrlOption(
  serverUrl: string | undefined,
  server: string | undefined,
): string | undefined {
  if (serverUrl !== undefined && server !== undefined && serverUrl !== server) {
    throw new Error("--server-url and --server must match when both are set");
  }
  return serverUrl ?? server;
}

export function parseLauncherArgs(args: string[]): ParsedLauncherArgs {
  const parsed = parseArgs({
    allowPositionals: true,
    args,
    options: {
      "data-dir": { type: "string" },
      "enroll-key": { type: "string" },
      "host-daemon-port": { type: "string" },
      "host-id": { type: "string" },
      "join-code": { type: "string" },
      "server-port": { type: "string" },
      "server-url": { type: "string" },
      help: { short: "h", type: "boolean" },
      server: { type: "string" },
    },
  });
  const options: LauncherCliOptions = {
    help: readBooleanOption(parsed.values.help),
  };
  const dataDir = readStringOption(parsed.values["data-dir"]);
  const enrollKey = readStringOption(parsed.values["enroll-key"]);
  const hostDaemonPort = readStringOption(parsed.values["host-daemon-port"]);
  const hostId = readStringOption(parsed.values["host-id"]);
  const joinCode = readStringOption(parsed.values["join-code"]);
  const serverPort = readStringOption(parsed.values["server-port"]);
  const serverUrl = chooseServerUrlOption(
    readStringOption(parsed.values["server-url"]),
    readStringOption(parsed.values.server),
  );
  if (dataDir !== undefined) {
    options.dataDir = dataDir;
  }
  if (enrollKey !== undefined) {
    options.enrollKey = enrollKey;
  }
  if (hostDaemonPort !== undefined) {
    options.hostDaemonPort = hostDaemonPort;
  }
  if (hostId !== undefined) {
    options.hostId = hostId;
  }
  if (joinCode !== undefined) {
    options.joinCode = joinCode;
  }
  if (serverPort !== undefined) {
    options.serverPort = serverPort;
  }
  if (serverUrl !== undefined) {
    options.serverUrl = serverUrl;
  }

  return {
    options,
    positionals: parsed.positionals,
  };
}

function expandHomeDirectory(pathValue: string, homeDir: string): string {
  if (pathValue === "~") {
    return homeDir;
  }
  if (pathValue.startsWith("~/")) {
    return resolve(homeDir, pathValue.slice(2));
  }
  return resolve(pathValue);
}

export function resolveDataDir(args: ResolveDataDirArgs): string {
  const rawDataDir = args.env.BB_DATA_DIR;
  if (rawDataDir === undefined) {
    return join(args.homeDir, DEFAULT_DATA_DIR_NAME);
  }

  const trimmedDataDir = rawDataDir.trim();
  if (trimmedDataDir.length === 0) {
    throw new Error("BB_DATA_DIR must not be empty");
  }

  return expandHomeDirectory(trimmedDataDir, args.homeDir);
}

export function resolvePort(args: ResolvePortArgs): number {
  const rawPort = trimToUndefined(args.env[args.name]);
  if (rawPort === undefined) {
    return args.defaultPort;
  }

  const port = Number(rawPort);
  if (Number.isInteger(port) && port >= 1 && port <= 65535) {
    return port;
  }

  throw new Error(`${args.name} must be a valid TCP port`);
}

function createEnvFromOptions(
  args: CreateEnvFromOptionsArgs,
): NodeJS.ProcessEnv {
  const env = { ...args.env };
  if (args.options.dataDir !== undefined) {
    env.BB_DATA_DIR = args.options.dataDir;
  }
  if (args.options.hostDaemonPort !== undefined) {
    env.BB_HOST_DAEMON_PORT = args.options.hostDaemonPort;
  }
  if (args.options.serverPort !== undefined) {
    env.BB_SERVER_PORT = args.options.serverPort;
  }
  if (args.options.serverUrl !== undefined) {
    env.BB_SERVER_URL = args.options.serverUrl;
  }
  if (args.options.hostId !== undefined) {
    env.BB_HOST_ID = args.options.hostId;
  }
  if (args.options.joinCode !== undefined) {
    env.BB_HOST_ENROLL_KEY = args.options.joinCode;
  }
  if (args.options.enrollKey !== undefined) {
    env.BB_HOST_ENROLL_KEY = args.options.enrollKey;
  }
  return env;
}

function resolveServerUrl(args: ResolveServerUrlArgs): string {
  return (
    trimToUndefined(args.env.BB_SERVER_URL) ??
    args.config.serverUrl ??
    args.defaultServerUrl
  );
}

async function readManagedConfig(
  args: ResolveManagedConfigArgs,
): Promise<ManagedConfig> {
  try {
    const rawConfig = await readFile(
      join(args.dataDir, CONFIG_FILE_NAME),
      "utf8",
    );
    return managedConfigSchema.parse(JSON.parse(rawConfig));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(
        `Invalid bb-app config JSON at ${join(args.dataDir, CONFIG_FILE_NAME)}`,
      );
    }
    if (error instanceof z.ZodError) {
      throw new Error(
        `Invalid bb-app config at ${join(args.dataDir, CONFIG_FILE_NAME)}: ${error.message}`,
      );
    }
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function writeManagedConfig(args: WriteManagedConfigArgs): Promise<void> {
  await mkdir(args.dataDir, { recursive: true });
  const existingConfig = await readManagedConfig({ dataDir: args.dataDir });
  const nextConfig: ManagedConfig = {
    ...existingConfig,
    ...args.config,
  };
  await writeFile(
    join(args.dataDir, CONFIG_FILE_NAME),
    `${JSON.stringify(nextConfig, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

export function resolveBbAppStartContext(
  args: ResolveBbAppStartContextArgs,
): BbAppStartContext {
  const entrypointDir = dirname(fileURLToPath(args.entrypointUrl));
  const packageRoot = resolve(entrypointDir, "..");
  const dataDir = resolveDataDir({ env: args.env, homeDir: args.homeDir });
  const serverPort = resolvePort({
    defaultPort: DEFAULT_SERVER_PORT,
    env: args.env,
    name: "BB_SERVER_PORT",
  });
  const daemonPort = resolvePort({
    defaultPort: DEFAULT_HOST_DAEMON_PORT,
    env: args.env,
    name: "BB_HOST_DAEMON_PORT",
  });
  const daemonBundleDir = resolve(packageRoot, "host-daemon", "dist");

  return {
    appDistDir: resolve(packageRoot, "app", "dist"),
    configFile: join(dataDir, CONFIG_FILE_NAME),
    daemonBundleDir,
    daemonEntry: resolve(daemonBundleDir, "daemon-bundle.mjs"),
    daemonLockDir: `${join(dataDir, "daemon.lock")}.lock`,
    daemonLockFile: join(dataDir, "daemon.lock"),
    daemonPort,
    dataDir,
    dbPath: join(dataDir, "bb.db"),
    logDir: join(dataDir, "logs"),
    packageRoot,
    serverEntry: resolve(packageRoot, "server", "dist", "index.js"),
    serverPort,
    serverUrl:
      trimToUndefined(args.env.BB_SERVER_URL) ??
      `http://127.0.0.1:${serverPort}`,
  };
}

export async function resolveBbAppRuntimeContext(
  args: ResolveBbAppRuntimeContextArgs,
): Promise<BbAppStartContext> {
  const initialEnv = createEnvFromOptions({
    env: args.env,
    options: args.options,
  });
  if (args.serverUrlMode === "local") {
    const localEnv = { ...initialEnv };
    delete localEnv.BB_SERVER_URL;
    return resolveBbAppStartContext({
      entrypointUrl: args.entrypointUrl,
      env: localEnv,
      homeDir: args.homeDir,
    });
  }

  const initialContext = resolveBbAppStartContext({
    entrypointUrl: args.entrypointUrl,
    env: initialEnv,
    homeDir: args.homeDir,
  });
  const config = await readManagedConfig({ dataDir: initialContext.dataDir });
  const finalEnv = {
    ...initialEnv,
    BB_SERVER_URL: resolveServerUrl({
      config,
      defaultServerUrl: initialContext.serverUrl,
      env: initialEnv,
    }),
  };
  return resolveBbAppStartContext({
    entrypointUrl: args.entrypointUrl,
    env: finalEnv,
    homeDir: args.homeDir,
  });
}

export function createHostJoinRequestBody(
  args: CreateHostJoinRequestBodyArgs,
): HostJoinRequestBody {
  if (args.localJoin) {
    const requestBody: LocalHostJoinRequestBody = {
      hostType: "persistent",
      joinMode: "local",
    };
    if (args.requestedHostId !== null) {
      requestBody.hostId = args.requestedHostId;
    }
    return requestBody;
  }

  const requestBody: PersistentHostJoinRequestBody = {
    hostType: "persistent",
  };
  if (args.requestedHostId !== null) {
    requestBody.hostId = args.requestedHostId;
  }
  return requestBody;
}

export function resolveBbAppCommand(args: string[]): BbAppCommand {
  if (args.length === 0) {
    return { kind: "start" };
  }

  if (args[0] === START_COMMAND && args.length === 1) {
    return { kind: "start" };
  }

  if (args[0] === HOST_DAEMON_COMMAND) {
    return {
      args: args.slice(1),
      kind: "host-daemon",
    };
  }

  if (args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    return { kind: "help" };
  }

  return {
    command: args[0],
    kind: "invalid",
  };
}

function requiredArtifactPaths(context: BbAppStartContext): ArtifactPath[] {
  return [
    { label: "server entry", path: context.serverEntry },
    { label: "host daemon entry", path: context.daemonEntry },
    { label: "bundled bb CLI", path: join(context.daemonBundleDir, "bb") },
    {
      label: "Claude Code bridge",
      path: join(context.daemonBundleDir, "bb-claude-code-bridge.mjs"),
    },
    {
      label: "Pi bridge",
      path: join(context.daemonBundleDir, "bb-pi-bridge.mjs"),
    },
    { label: "web app", path: join(context.appDistDir, "index.html") },
  ];
}

export function assertBbAppArtifacts(context: BbAppStartContext): void {
  const missingArtifact = requiredArtifactPaths(context).find(
    (artifact) => !existsSync(artifact.path),
  );
  if (missingArtifact) {
    throw new Error(
      `Missing ${missingArtifact.label} at ${missingArtifact.path}. Rebuild bb-app before running this package.`,
    );
  }
}

async function pathExists(pathToCheck: string): Promise<boolean> {
  try {
    await access(pathToCheck);
    return true;
  } catch {
    return false;
  }
}

async function readPersistedHostId(dataDir: string): Promise<string | null> {
  try {
    const value = (
      await readFile(join(dataDir, HOST_ID_FILE_NAME), "utf8")
    ).trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export async function requestHostJoin(
  args: RequestHostJoinArgs,
): Promise<HostJoinResponse> {
  const response = await fetch(`${args.serverUrl}/api/v1/hosts/join`, {
    body: JSON.stringify(
      createHostJoinRequestBody({
        localJoin: args.localJoin,
        requestedHostId: args.requestedHostId,
      }),
    ),
    headers: {
      "content-type": "application/json",
    },
    method: "POST",
  });

  if (response.status !== 201) {
    const detail = await response.text();
    throw new Error(
      `Failed to request host join material: ${response.status} ${response.statusText}${detail ? ` - ${detail}` : ""}`,
    );
  }

  return hostJoinResponseSchema.parse(await response.json());
}

export async function maybeAddAutoJoinEnv(
  args: MaybeAddAutoJoinEnvArgs,
): Promise<NodeJS.ProcessEnv> {
  if (trimToUndefined(args.env.BB_HOST_ENROLL_KEY) !== undefined) {
    return args.env;
  }
  if (await pathExists(join(args.dataDir, HOST_AUTH_FILE_NAME))) {
    return args.env;
  }

  const requestedHostId =
    trimToUndefined(args.env.BB_HOST_ID) ??
    (await readPersistedHostId(args.dataDir));
  const joinResponse = await requestHostJoin({
    localJoin: true,
    requestedHostId,
    serverUrl: args.serverUrl,
  });

  if (requestedHostId !== null && joinResponse.hostId !== requestedHostId) {
    throw new Error(
      `Join response host ID ${joinResponse.hostId} does not match persisted host ID ${requestedHostId}`,
    );
  }

  return {
    ...args.env,
    BB_HOST_ENROLL_KEY: joinResponse.joinCode,
    BB_HOST_ID: joinResponse.hostId,
  };
}

async function waitForHealth(args: WaitForHealthArgs): Promise<void> {
  const timeoutMs = args.timeoutMs ?? HEALTH_CHECK_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (
      args.childProcess &&
      (args.childProcess.exitCode !== null ||
        args.childProcess.signalCode !== null)
    ) {
      throw new Error("Process exited before becoming healthy");
    }
    try {
      const response = await fetch(args.url);
      if (response.ok) {
        return;
      }
    } catch {}
    await new Promise<void>((resolvePromise) => {
      setTimeout(resolvePromise, HEALTH_CHECK_INTERVAL_MS);
    });
  }
  throw new Error(`Timed out waiting for health at ${args.url}`);
}

function toChunkString(chunk: OutputChunk): string {
  return typeof chunk === "string" ? chunk : chunk.toString("utf8");
}

function createOutputBuffer(): OutputBuffer {
  const chunks: OutputChunk[] = [];
  let passthrough = false;

  return {
    handler(chunk) {
      if (passthrough) {
        process.stdout.write(chunk);
        return;
      }
      chunks.push(chunk);
    },
    flush() {
      process.stdout.write("\n");
      for (const chunk of chunks) {
        process.stdout.write(toChunkString(chunk));
      }
      chunks.length = 0;
      passthrough = true;
    },
  };
}

function spawnManagedProcess(args: ManagedSpawnArgs): ChildProcess {
  const child = spawn(args.command, args.args, {
    cwd: process.cwd(),
    env: args.env,
    stdio: ["ignore", "pipe", "inherit"],
  });

  if (child.stdout === null) {
    throw new Error("Expected managed process stdout to be piped");
  }

  child.stdout.on("data", args.outputBuffer.handler);
  return child;
}

function waitForProcessExit(
  childProcess: ChildProcess,
): Promise<ProcessExitResult> {
  return new Promise<ProcessExitResult>((resolvePromise) => {
    childProcess.once("exit", (code, signal) => {
      resolvePromise({ code, signal });
    });
  });
}

async function waitForNamedProcessExit(
  args: WaitForNamedProcessExitArgs,
): Promise<NamedProcessExitResult> {
  return {
    processName: args.processName,
    result: await waitForProcessExit(args.childProcess),
  };
}

function toExitCode(result: ProcessExitResult): number {
  if (result.code !== null) {
    return result.code;
  }
  return result.signal === null ? 1 : 128;
}

function killProcessIfRunning(
  childProcess: ChildProcess,
  signal: NodeJS.Signals,
): void {
  if (childProcess.exitCode !== null || childProcess.signalCode !== null) {
    return;
  }
  childProcess.kill(signal);
}

function createSharedEnv(context: BbAppStartContext): NodeJS.ProcessEnv {
  return {
    ...process.env,
    BB_DATA_DIR: context.dataDir,
    BB_HOST_DAEMON_PORT: String(context.daemonPort),
    BB_SERVER_PORT: String(context.serverPort),
    NODE_ENV: "production",
  };
}

function createDaemonEnv(
  context: BbAppStartContext,
  autoJoinEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return {
    ...autoJoinEnv,
    BB_BRIDGE_DIR: context.daemonBundleDir,
    BB_CLI_DIR: context.daemonBundleDir,
    BB_DATA_DIR: context.dataDir,
    BB_HOST_DAEMON_PORT: String(context.daemonPort),
    BB_SERVER_URL: context.serverUrl,
    NODE_ENV: "production",
  };
}

function createCliEnv(args: CreateCliEnvArgs): NodeJS.ProcessEnv {
  const cliEnv: NodeJS.ProcessEnv = {
    ...args.env,
    BB_HOST_DAEMON_PORT: String(args.context.daemonPort),
    NODE_ENV: "production",
  };

  if (trimToUndefined(cliEnv.BB_SERVER_URL) === undefined) {
    cliEnv.BB_SERVER_URL = args.context.serverUrl;
  }

  return cliEnv;
}

function resolveHostDaemonServerUrl(
  args: ResolveHostDaemonServerUrlArgs,
): string {
  return trimToUndefined(args.env.BB_SERVER_URL) ?? args.context.serverUrl;
}

function createHostDaemonOnlyEnv(
  args: CreateHostDaemonOnlyEnvArgs,
): NodeJS.ProcessEnv {
  return {
    ...args.env,
    BB_BRIDGE_DIR: args.context.daemonBundleDir,
    BB_CLI_DIR: args.context.daemonBundleDir,
    BB_DATA_DIR: args.context.dataDir,
    BB_HOST_DAEMON_PORT: String(args.context.daemonPort),
    BB_SERVER_URL: args.serverUrl,
    NODE_ENV: "production",
  };
}

function resolveEnrollmentRequirements(
  args: ResolveEnrollmentRequirementsArgs,
): EnrollmentRequirements {
  const enrollKey = trimToUndefined(args.env.BB_HOST_ENROLL_KEY);
  return {
    enrolled: existsSync(join(args.context.dataDir, HOST_AUTH_FILE_NAME)),
    ...(enrollKey !== undefined ? { enrollKey } : {}),
  };
}

function resolveHostDaemonCommand(
  args: string[],
): ResolveHostDaemonCommandResult {
  if (args.length === 0) {
    return { kind: "start" };
  }
  if (args.length === 1 && args[0] === HOST_DAEMON_JOIN_COMMAND) {
    return { kind: "join" };
  }
  throw new Error(
    `bb-app host-daemon accepts no subcommand except ${HOST_DAEMON_JOIN_COMMAND}`,
  );
}

function isLoopbackServerUrl(serverUrl: string): boolean {
  const { hostname } = new URL(serverUrl);
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
  );
}

async function createHostDaemonJoinEnv(
  args: CreateHostDaemonJoinEnvArgs,
): Promise<NodeJS.ProcessEnv> {
  const requestedHostId =
    trimToUndefined(args.env.BB_HOST_ID) ??
    (await readPersistedHostId(args.context.dataDir));
  const joinResponse = await requestHostJoin({
    localJoin: isLoopbackServerUrl(args.serverUrl),
    requestedHostId,
    serverUrl: args.serverUrl,
  });

  if (requestedHostId !== null && joinResponse.hostId !== requestedHostId) {
    throw new Error(
      `Join response host ID ${joinResponse.hostId} does not match persisted host ID ${requestedHostId}`,
    );
  }

  await writeManagedConfig({
    config: { serverUrl: args.serverUrl },
    dataDir: args.context.dataDir,
  });

  return {
    ...args.env,
    BB_HOST_ENROLL_KEY: joinResponse.joinCode,
    BB_HOST_ID: joinResponse.hostId,
  };
}

async function runBundledCliCommand(
  context: BbAppStartContext,
  args: string[],
): Promise<number> {
  const childProcess = spawn(join(context.daemonBundleDir, "bb"), args, {
    cwd: process.cwd(),
    env: createCliEnv({ context, env: process.env }),
    stdio: "inherit",
  });

  return toExitCode(await waitForProcessExit(childProcess));
}

export async function runBbCli(
  cliArgs: string[] = process.argv.slice(2),
): Promise<void> {
  const context = await resolveBbAppRuntimeContext({
    entrypointUrl: import.meta.url,
    env: process.env,
    homeDir: homedir(),
    options: createDefaultLauncherOptions(),
    serverUrlMode: "managed",
  });
  assertBbAppArtifacts(context);
  process.exitCode = await runBundledCliCommand(context, cliArgs);
}

export async function runBbServer(
  cliArgs: string[] = process.argv.slice(2),
): Promise<void> {
  const parsedArgs = parseLauncherArgs(cliArgs);
  if (parsedArgs.options.help) {
    process.stdout.write(`bb-server

Usage:
  bb-server [--data-dir <path>] [--server-port <port>]
`);
    return;
  }
  if (parsedArgs.positionals.length > 0) {
    throw new Error("bb-server does not accept arguments.");
  }

  const context = await resolveBbAppRuntimeContext({
    entrypointUrl: import.meta.url,
    env: process.env,
    homeDir: homedir(),
    options: parsedArgs.options,
    serverUrlMode: "local",
  });
  assertBbAppArtifacts(context);

  const childProcess = spawn(process.execPath, [context.serverEntry], {
    cwd: process.cwd(),
    env: createSharedEnv(context),
    stdio: "inherit",
  });
  process.exitCode = toExitCode(await waitForProcessExit(childProcess));
}

async function runHostDaemonOnly(
  context: BbAppStartContext,
  args: string[],
  options: LauncherCliOptions,
): Promise<void> {
  const command = resolveHostDaemonCommand(args);

  const serverUrl = resolveHostDaemonServerUrl({
    context,
    env: process.env,
  });
  const baseDaemonEnv = createEnvFromOptions({
    env: process.env,
    options,
  });
  const joinEnv =
    command.kind === "join"
      ? await createHostDaemonJoinEnv({
          context,
          env: baseDaemonEnv,
          serverUrl,
        })
      : baseDaemonEnv;
  const daemonEnv = createHostDaemonOnlyEnv({
    context,
    env: joinEnv,
    serverUrl,
  });
  const enrollment = resolveEnrollmentRequirements({
    context,
    env: daemonEnv,
  });

  process.stdout.write(`\n  ${bold("bb host-daemon")}\n\n`);

  if (existsSync(context.daemonLockDir)) {
    log(yellow("!"), "Daemon lock is held - another instance may be running");
    log(" ", dim(`lock: ${context.daemonLockDir}`));
    log(
      " ",
      dim("Remove it manually if the previous process exited uncleanly."),
    );
    process.stdout.write("\n");
  }

  if (!enrollment.enrolled && enrollment.enrollKey === undefined) {
    endStep(
      red("✗"),
      `Not enrolled - set BB_HOST_ENROLL_KEY to join ${serverUrl}`,
    );
    process.stdout.write("\n");
    log(" ", dim("Run this command to request enrollment and start daemon:"));
    log(" ", dim(`  bb-app host-daemon join --server-url ${serverUrl}`));
    process.stdout.write("\n");
    process.exitCode = 1;
    return;
  }

  beginStep(
    enrollment.enrolled ? "Starting daemon" : "Enrolling and starting daemon",
  );

  const outputBuffer = createOutputBuffer();
  const daemonProcess = spawnManagedProcess({
    args: [context.daemonEntry],
    command: process.execPath,
    env: daemonEnv,
    outputBuffer,
  });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    process.stdout.write("\n");
    log(dim("●"), "Shutting down");
    killProcessIfRunning(daemonProcess, signal);
  };

  const removeSignalForwarding = installTerminationSignalForwarding(shutdown);

  try {
    try {
      await waitForHealth({
        childProcess: daemonProcess,
        url: `http://localhost:${context.daemonPort}/health`,
      });
    } catch {
      endStep(red("✗"), "Host daemon failed to start");
      log(" ", dim(`lock: ${context.daemonLockDir}`));
      log(" ", dim(`logs: ${context.logDir}/`));
      outputBuffer.flush();
      process.exitCode = daemonProcess.exitCode ?? 1;
      return;
    }

    endStep(green("✓"), "Host daemon running");

    process.stdout.write("\n");
    log(green("●"), bold("bb host-daemon is ready"));
    process.stdout.write("\n");
    log(" ", formatReadyOutputRow("server", cyan(serverUrl)));
    log(" ", formatReadyOutputRow("daemon", String(context.daemonPort)));
    log(" ", formatReadyOutputRow("data", context.dataDir));
    log(" ", formatReadyOutputRow("logs", `${context.logDir}/`));
    log(" ", formatReadyOutputRow("lock", context.daemonLockFile));
    log(
      " ",
      formatReadyOutputRow("auth", join(context.dataDir, HOST_AUTH_FILE_NAME)),
    );
    process.stdout.write("\n");
    log(" ", dim("Press Ctrl+C to stop"));

    outputBuffer.flush();
    process.exitCode = toExitCode(await waitForProcessExit(daemonProcess));
  } finally {
    removeSignalForwarding();
  }
}

export async function runBbHostDaemon(
  cliArgs: string[] = process.argv.slice(2),
): Promise<void> {
  const parsedArgs = parseLauncherArgs(cliArgs);
  if (parsedArgs.options.help) {
    process.stdout.write(`bb-host-daemon

Usage:
  bb-host-daemon [--server-url <url>]
  bb-host-daemon join --server-url <url>
`);
    return;
  }

  const context = await resolveBbAppRuntimeContext({
    entrypointUrl: import.meta.url,
    env: process.env,
    homeDir: homedir(),
    options: parsedArgs.options,
    serverUrlMode: "managed",
  });
  assertBbAppArtifacts(context);
  await runHostDaemonOnly(context, parsedArgs.positionals, parsedArgs.options);
}

function installTerminationSignalForwarding(
  callback: (signal: NodeJS.Signals) => void,
): () => void {
  const sigintHandler = (): void => callback("SIGINT");
  const sigtermHandler = (): void => callback("SIGTERM");
  process.on("SIGINT", sigintHandler);
  process.on("SIGTERM", sigtermHandler);

  return () => {
    process.off("SIGINT", sigintHandler);
    process.off("SIGTERM", sigtermHandler);
  };
}

export function isMainModule(args: IsMainModuleArgs): boolean {
  if (args.entrypointPath === undefined) {
    return false;
  }

  const modulePath = fileURLToPath(args.moduleUrl);
  try {
    return realpathSync(args.entrypointPath) === realpathSync(modulePath);
  } catch {
    return resolve(args.entrypointPath) === resolve(modulePath);
  }
}

function printBbAppHelp(): void {
  process.stdout.write(`bb-app

Usage:
  bb-app [--data-dir <path>] [--server-port <port>] [--host-daemon-port <port>]
  bb-app start
  bb-app host-daemon [--server-url <url>]
  bb-app host-daemon join --server-url <url>

CLI:
  npx --package bb-app bb <command>
`);
}

export async function runBbApp(
  cliArgs: string[] = process.argv.slice(2),
): Promise<void> {
  const parsedArgs = parseLauncherArgs(cliArgs);

  if (parsedArgs.options.help) {
    printBbAppHelp();
    return;
  }

  const command = resolveBbAppCommand(parsedArgs.positionals);
  if (command.kind === "help") {
    printBbAppHelp();
    return;
  }
  if (command.kind === "invalid") {
    process.stderr.write(`Unknown bb-app command: ${command.command}\n\n`);
    printBbAppHelp();
    process.exitCode = 1;
    return;
  }

  const context = await resolveBbAppRuntimeContext({
    entrypointUrl: import.meta.url,
    env: process.env,
    homeDir: homedir(),
    options: parsedArgs.options,
    serverUrlMode: command.kind === "host-daemon" ? "managed" : "local",
  });
  assertBbAppArtifacts(context);

  if (command.kind === "host-daemon") {
    await runHostDaemonOnly(context, command.args, parsedArgs.options);
    return;
  }

  const outputBuffer = createOutputBuffer();
  const sharedEnv = createSharedEnv(context);

  process.stdout.write(`\n  ${bold("bb")}\n\n`);

  if (existsSync(context.daemonLockDir)) {
    log(yellow("!"), "Daemon lock is held - another instance may be running");
    log(" ", dim(`lock: ${context.daemonLockDir}`));
    log(
      " ",
      dim("Remove it manually if the previous process exited uncleanly."),
    );
    process.stdout.write("\n");
  }

  beginStep("Starting server");

  const serverProcess = spawnManagedProcess({
    args: [context.serverEntry],
    command: process.execPath,
    env: sharedEnv,
    outputBuffer,
  });

  let shuttingDown = false;
  let daemonProcess: ChildProcess | null = null;

  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    process.stdout.write("\n");
    log(dim("●"), "Shutting down");
    if (daemonProcess !== null) {
      killProcessIfRunning(daemonProcess, signal);
    }
    killProcessIfRunning(serverProcess, signal);
  };

  const removeSignalForwarding = installTerminationSignalForwarding(shutdown);

  try {
    try {
      await waitForHealth({
        childProcess: serverProcess,
        url: `${context.serverUrl}/health`,
      });
    } catch {
      endStep(red("✗"), "Server failed to start (health check timed out)");
      log(" ", dim(`Check logs: ${context.logDir}/`));
      outputBuffer.flush();
      shutdown("SIGTERM");
      return;
    }

    endStep(green("✓"), `Server listening on ${cyan(context.serverUrl)}`);

    beginStep("Starting host daemon");
    const autoJoinEnv = await maybeAddAutoJoinEnv({
      dataDir: context.dataDir,
      env: sharedEnv,
      serverUrl: context.serverUrl,
    });

    daemonProcess = spawnManagedProcess({
      args: [context.daemonEntry],
      command: process.execPath,
      env: createDaemonEnv(context, autoJoinEnv),
      outputBuffer,
    });

    try {
      await waitForHealth({
        childProcess: daemonProcess,
        url: `http://localhost:${context.daemonPort}/health`,
      });
    } catch {
      endStep(red("✗"), "Host daemon failed to start");
      log(" ", dim(`lock: ${context.daemonLockDir}`));
      log(" ", dim(`logs: ${context.logDir}/`));
      outputBuffer.flush();
      shutdown("SIGTERM");
      return;
    }

    endStep(green("✓"), "Host daemon running");

    process.stdout.write("\n");
    log(green("●"), bold("bb is ready"));
    process.stdout.write("\n");
    log(" ", formatReadyOutputRow("app", cyan(context.serverUrl)));
    log(" ", formatReadyOutputRow("daemon", String(context.daemonPort)));
    log(" ", formatReadyOutputRow("data", context.dataDir));
    log(" ", formatReadyOutputRow("db", context.dbPath));
    log(" ", formatReadyOutputRow("logs", `${context.logDir}/`));
    log(" ", formatReadyOutputRow("lock", context.daemonLockFile));
    process.stdout.write("\n");
    log(" ", dim("Press Ctrl+C to stop"));

    outputBuffer.flush();
    const firstExit = await Promise.race([
      waitForNamedProcessExit({
        childProcess: serverProcess,
        processName: "server",
      }),
      waitForNamedProcessExit({
        childProcess: daemonProcess,
        processName: "daemon",
      }),
    ]);

    if (firstExit.processName === "server") {
      killProcessIfRunning(daemonProcess, firstExit.result.signal ?? "SIGTERM");
    } else {
      killProcessIfRunning(serverProcess, firstExit.result.signal ?? "SIGTERM");
    }

    process.exitCode = toExitCode(firstExit.result);
  } catch (error) {
    shutdown("SIGTERM");
    throw error;
  } finally {
    removeSignalForwarding();
  }
}
