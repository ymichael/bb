import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";

export type BbRuntimeMode = "dev" | "prod";

interface DevPortSet {
  appPort: number;
  cloudPort: number;
  cloudWorkerPort: number;
  hostDaemonPort: number;
  serverPort: number;
}

export interface DevInstanceConfig {
  dataDir: string;
  homeDir: string;
  instanceId: string;
  ports: DevPortSet;
  repoRoot: string;
  serverUrl: string;
}

interface ResolveDevInstanceConfigArgs {
  homeDir: string;
  repoRoot: string;
}

interface DevProcessEnvArgs {
  baseEnv: NodeJS.ProcessEnv;
  config: DevInstanceConfig;
}

interface ResolveInheritedDevSkillsRootPathsArgs {
  homeDir: string;
  repoRoot: string;
}

interface ParseDataDirEnvValueArgs {
  homeDir: string;
  rawDataDir: string;
}

interface ResolveConfiguredDataDirArgs {
  defaultDataDir: string;
  env: NodeJS.ProcessEnv;
  homeDir: string;
}

interface ResolveProdDataDirArgs {
  homeDir: string;
}

interface ResolveRuntimeDataDirArgs {
  env: NodeJS.ProcessEnv;
  homeDir: string;
  mode: BbRuntimeMode;
  repoRoot?: string;
}

interface ResolveDataDirDatabasePathArgs {
  dataDir: string;
}

interface ParsePortValueArgs {
  name: string;
  rawPort: string;
}

interface ValidatePortNumberArgs {
  name: string;
  value: number;
}

interface ResolvePortFromEnvArgs {
  defaultPort: number;
  env: NodeJS.ProcessEnv;
  name: string;
}

const BB_PROD_DATA_DIR_NAME = ".bb";
const BB_DEV_DATA_ROOT_DIR = ".bb-dev";
export const BB_PROD_SERVER_PORT = 38886;
export const BB_PROD_HOST_DAEMON_PORT = 38887;
export const BB_LOOPBACK_HOST = "127.0.0.1";
const BB_SQLITE_DATABASE_FILE_NAME = "bb.db";

const DEV_HASH_LENGTH = 12;
const DEV_PORT_BUCKETS = 8_000;
const DEV_APP_PORT_BASE = 11_000;
const DEV_SERVER_PORT_BASE = 19_000;
const DEV_HOST_DAEMON_PORT_BASE = 27_000;
const DEV_CLOUD_PORT_BASE = 35_000;
const DEV_CLOUD_WORKER_PORT_BASE = 43_000;
const THREAD_CONTEXT_ENV_KEYS: readonly string[] = [
  "BB_ENVIRONMENT_ID",
  "BB_THREAD_ID",
  "BB_THREAD_STORAGE",
];

const MANAGED_WORKTREE_DIR_NAME = "worktrees";

function createRepoRootHash(repoRootPath: string): string {
  return createHash("sha256").update(repoRootPath).digest("hex");
}

function sanitizeInstanceLabel(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^[._-]+|[._-]+$/gu, "");
  return sanitized.length > 0 ? sanitized : "worktree";
}

function resolveRepoRootLabel(args: ResolveDevInstanceConfigArgs): string {
  const homeRelativePath = relative(args.homeDir, args.repoRoot);
  if (
    homeRelativePath.length > 0 &&
    !homeRelativePath.startsWith("../") &&
    !homeRelativePath.startsWith("..\\") &&
    homeRelativePath !== ".." &&
    !isAbsolute(homeRelativePath)
  ) {
    return homeRelativePath;
  }

  return args.repoRoot;
}

function resolveInstanceId(args: ResolveDevInstanceConfigArgs): string {
  const hash = createRepoRootHash(args.repoRoot);
  const label = resolveRepoRootLabel(args);
  return `${sanitizeInstanceLabel(label)}-${hash.slice(0, DEV_HASH_LENGTH)}`;
}

function resolvePortOffset(repoRootPath: string): number {
  const hash = createRepoRootHash(repoRootPath);
  return Number.parseInt(hash.slice(0, 8), 16) % DEV_PORT_BUCKETS;
}

function reservePackagedAppPorts(port: number): number {
  if (port === BB_PROD_SERVER_PORT) return 59_000;
  if (port === BB_PROD_HOST_DAEMON_PORT) return 59_001;
  return port;
}

function resolvePorts(repoRootPath: string): DevPortSet {
  const offset = resolvePortOffset(repoRootPath);
  return {
    appPort: DEV_APP_PORT_BASE + offset,
    cloudPort: reservePackagedAppPorts(DEV_CLOUD_PORT_BASE + offset),
    cloudWorkerPort: DEV_CLOUD_WORKER_PORT_BASE + offset,
    hostDaemonPort: DEV_HOST_DAEMON_PORT_BASE + offset,
    serverPort: DEV_SERVER_PORT_BASE + offset,
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

export function resolveRuntimeMode(
  nodeEnv: string | undefined = process.env.NODE_ENV,
): BbRuntimeMode {
  return nodeEnv === "production" ? "prod" : "dev";
}

export function resolveProdDataDir(args: ResolveProdDataDirArgs): string {
  return join(args.homeDir, BB_PROD_DATA_DIR_NAME);
}

export function parseDataDirEnvValue(args: ParseDataDirEnvValueArgs): string {
  const trimmedDataDir = args.rawDataDir.trim();
  if (trimmedDataDir.length === 0) {
    throw new Error("BB_DATA_DIR must not be empty");
  }

  return expandHomeDirectory(trimmedDataDir, args.homeDir);
}

export function resolveConfiguredDataDir(
  args: ResolveConfiguredDataDirArgs,
): string {
  const rawDataDir = args.env.BB_DATA_DIR;
  if (rawDataDir === undefined) {
    return args.defaultDataDir;
  }

  return parseDataDirEnvValue({
    homeDir: args.homeDir,
    rawDataDir,
  });
}

export function resolveDevInstanceConfig(
  args: ResolveDevInstanceConfigArgs,
): DevInstanceConfig {
  const instanceId = resolveInstanceId(args);
  const dataDir = join(args.homeDir, BB_DEV_DATA_ROOT_DIR, instanceId);
  const ports = resolvePorts(args.repoRoot);
  const serverUrl = `http://${BB_LOOPBACK_HOST}:${ports.serverPort}`;
  return {
    dataDir,
    homeDir: args.homeDir,
    instanceId,
    ports,
    repoRoot: args.repoRoot,
    serverUrl,
  };
}

export function resolveCurrentDevInstanceConfig(
  repoRoot: string,
): DevInstanceConfig {
  return resolveDevInstanceConfig({
    homeDir: homedir(),
    repoRoot,
  });
}

export function resolveInheritedDevSkillsRootPaths(
  args: ResolveInheritedDevSkillsRootPathsArgs,
): string[] {
  const roots = [join(resolveProdDataDir({ homeDir: args.homeDir }), "skills")];
  const segments = resolve(args.repoRoot).split(/[\\/]+/u);
  const worktreesIndex = segments.lastIndexOf(MANAGED_WORKTREE_DIR_NAME);
  if (worktreesIndex <= 0) {
    return roots;
  }

  const parentDataDir = segments.slice(0, worktreesIndex).join("/");
  if (parentDataDir.length === 0) {
    return roots;
  }

  return Array.from(new Set([join(parentDataDir, "skills"), ...roots]));
}

export function resolveRuntimeDataDir(args: ResolveRuntimeDataDirArgs): string {
  if (args.env.BB_DATA_DIR !== undefined) {
    return parseDataDirEnvValue({
      homeDir: args.homeDir,
      rawDataDir: args.env.BB_DATA_DIR,
    });
  }

  if (args.mode === "prod") {
    return resolveProdDataDir({ homeDir: args.homeDir });
  }

  if (args.repoRoot === undefined) {
    throw new Error("repoRoot is required to resolve development BB_DATA_DIR");
  }

  return resolveDevInstanceConfig({
    homeDir: args.homeDir,
    repoRoot: args.repoRoot,
  }).dataDir;
}

export function resolveDataDirDatabasePath(
  args: ResolveDataDirDatabasePathArgs,
): string {
  return join(args.dataDir, BB_SQLITE_DATABASE_FILE_NAME);
}

export function parsePortValue(args: ParsePortValueArgs): number {
  const port = Number(args.rawPort);
  if (String(port) !== args.rawPort) {
    throw new Error(`${args.name} must be a valid TCP port`);
  }

  return validatePortNumber({
    name: args.name,
    value: port,
  });
}

export function validatePortNumber(args: ValidatePortNumberArgs): number {
  if (Number.isInteger(args.value) && args.value >= 1 && args.value <= 65_535) {
    return args.value;
  }

  throw new Error(`${args.name} must be a valid TCP port`);
}

export function resolvePortFromEnv(args: ResolvePortFromEnvArgs): number {
  const rawPort = args.env[args.name];
  if (rawPort === undefined) {
    return args.defaultPort;
  }

  return parsePortValue({
    name: args.name,
    rawPort,
  });
}

export function stripThreadContextEnv(
  baseEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  for (const key of THREAD_CONTEXT_ENV_KEYS) {
    delete env[key];
  }
  return env;
}

export function toDevProcessEnv(args: DevProcessEnvArgs): NodeJS.ProcessEnv {
  const env = stripThreadContextEnv(args.baseEnv);
  const inheritedSkillsRootPaths = resolveInheritedDevSkillsRootPaths({
    homeDir: args.config.homeDir,
    repoRoot: args.config.repoRoot,
  });
  return {
    ...env,
    BB_DATA_DIR: args.config.dataDir,
    BB_DEV_APP_PORT: String(args.config.ports.appPort),
    BB_DEV_CONNECT_BASE_URL: `http://bb.localhost:${args.config.ports.cloudPort}`,
    BB_HOST_DAEMON_PORT: String(args.config.ports.hostDaemonPort),
    BB_INHERITED_SKILLS_ROOTS: inheritedSkillsRootPaths.join(delimiter),
    BB_SERVER_PORT: String(args.config.ports.serverPort),
    BB_SERVER_URL: args.config.serverUrl,
    NODE_ENV: "development",
  };
}

export function resolveCurrentDevProcessEnv(
  repoRoot: string,
  baseEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return toDevProcessEnv({
    baseEnv,
    config: resolveCurrentDevInstanceConfig(repoRoot),
  });
}
