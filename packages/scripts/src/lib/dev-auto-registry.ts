import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveConfiguredDataDir } from "@bb/config/data-dir";
import { DEFAULTS } from "@bb/config/defaults";
import {
  DEFAULT_DEV_AUTO_FIRST_SLOT,
  DEFAULT_DEV_AUTO_MAX_SLOT,
  type DevAutoPortTuple,
  type DevAutoSlot,
  type DevAutoStackAssignment,
  type ProbePortAvailability,
  findAvailableDevAutoSlot,
} from "./dev-auto-ports.js";

export interface DevAutoReservation extends DevAutoStackAssignment {
  createdAt: string;
  dataDir: string;
  ownerPid: number;
  repoRoot: string;
  updatedAt: string;
}

export interface DevAutoRegistryFile {
  reservations: DevAutoReservation[];
  version: number;
}

export interface DevAutoRegistryPaths {
  lockDir: string;
  registryDir: string;
  registryPath: string;
}

export interface ResolveDevAutoDevDataDirArgs {
  env?: NodeJS.ProcessEnv;
}

export interface ResolveDevAutoRegistryPathsArgs {
  devDataDir: string;
}

export interface ResolveDevAutoStackDataDirArgs {
  devDataDir: string;
  slot: DevAutoSlot;
}

export interface AcquireDevAutoRegistryLockArgs {
  maxWaitMs?: number;
  now?: DevAutoNow;
  ownerPid?: number;
  paths: DevAutoRegistryPaths;
  retryDelayMs?: number;
  sleep?: DevAutoSleep;
  staleLockMs?: number;
  token?: string;
}

export interface DevAutoRegistryLock {
  paths: DevAutoRegistryPaths;
  release(): Promise<void>;
  token: string;
}

export interface LoadDevAutoRegistryArgs {
  paths: DevAutoRegistryPaths;
}

export interface SaveDevAutoRegistryArgs {
  paths: DevAutoRegistryPaths;
  registry: DevAutoRegistryFile;
}

export interface PruneStaleDevAutoReservationsArgs {
  isProcessAlive?: DevAutoProcessAliveChecker;
  registry: DevAutoRegistryFile;
}

export interface PruneStaleDevAutoReservationsResult {
  prunedReservations: DevAutoReservation[];
  registry: DevAutoRegistryFile;
}

export interface ReserveDevAutoStackArgs {
  devDataDir?: string;
  env?: NodeJS.ProcessEnv;
  firstSlot?: DevAutoSlot;
  isProcessAlive?: DevAutoProcessAliveChecker;
  maxSlot?: DevAutoSlot;
  now?: DevAutoNow;
  ownerPid: number;
  probePort?: ProbePortAvailability;
  repoRoot: string;
}

export interface RemoveDevAutoReservationArgs {
  devDataDir?: string;
  env?: NodeJS.ProcessEnv;
  reservation: DevAutoReservation;
}

export interface DevAutoStackEnvironment {
  BB_DATABASE_URL: string;
  BB_DATA_DIR: string;
  BB_DEV_APP_PORT: string;
  BB_DEV_AUTO_SLOT: string;
  BB_DEV_AUTO_STACK_ID: string;
  BB_DEV_ENV_PORT: string;
  BB_HOST_DAEMON_PORT: string;
  BB_SERVER_PORT: string;
  BB_SERVER_URL: string;
}

export interface RenderDevAutoEnvFileArgs {
  stackEnv: DevAutoStackEnvironment;
}

export interface WriteDevAutoEnvFileArgs {
  envFilePath: string;
  stackEnv: DevAutoStackEnvironment;
}

export type DevAutoNow = () => number;
export type DevAutoSleep = (delayMs: number) => Promise<void>;
export type DevAutoProcessAliveChecker = (pid: number) => boolean;

type JsonRecord = Record<string, unknown>;
type DevAutoEnvFileKey = keyof DevAutoStackEnvironment;

const DEV_AUTO_REGISTRY_VERSION = 1;
const DEV_AUTO_REGISTRY_DIR_NAME = "dev-auto";
const DEV_AUTO_REGISTRY_FILE_NAME = "reservations.json";
const DEV_AUTO_REGISTRY_LOCK_DIR_NAME = "reservations.lock";
const DEV_AUTO_LOCK_TOKEN_FILE_NAME = "owner-token";
const DEV_AUTO_STACKS_DIR_NAME = "stacks";
const DEV_AUTO_LOCK_STALE_MS = 120_000;
const DEV_AUTO_LOCK_MAX_WAIT_MS = 5_000;
const DEV_AUTO_LOCK_RETRY_DELAY_MS = 50;
const DEV_AUTO_ENV_FILE_KEYS: DevAutoEnvFileKey[] = [
  "BB_DATA_DIR",
  "BB_DATABASE_URL",
  "BB_SERVER_URL",
  "BB_SERVER_PORT",
  "BB_HOST_DAEMON_PORT",
  "BB_DEV_APP_PORT",
  "BB_DEV_ENV_PORT",
  "BB_DEV_AUTO_STACK_ID",
  "BB_DEV_AUTO_SLOT",
];

function sleepMs(delayMs: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, delayMs);
  });
}

function getErrorCode(error: unknown): string | undefined {
  if (!isJsonRecord(error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringProperty(record: JsonRecord, propertyName: string): string {
  const value = record[propertyName];
  if (typeof value !== "string") {
    throw new Error(`Invalid dev:auto registry property ${propertyName}`);
  }
  return value;
}

function readIntegerProperty(record: JsonRecord, propertyName: string): number {
  const value = record[propertyName];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`Invalid dev:auto registry property ${propertyName}`);
  }
  return value;
}

function parsePortTuple(value: unknown): DevAutoPortTuple {
  if (!isJsonRecord(value)) {
    throw new Error("Invalid dev:auto registry ports");
  }

  return {
    appPort: readIntegerProperty(value, "appPort"),
    devEnvPort: readIntegerProperty(value, "devEnvPort"),
    hostDaemonPort: readIntegerProperty(value, "hostDaemonPort"),
    serverPort: readIntegerProperty(value, "serverPort"),
  };
}

function parseReservation(value: unknown): DevAutoReservation {
  if (!isJsonRecord(value)) {
    throw new Error("Invalid dev:auto registry reservation");
  }

  return {
    createdAt: readStringProperty(value, "createdAt"),
    dataDir: readStringProperty(value, "dataDir"),
    ownerPid: readIntegerProperty(value, "ownerPid"),
    ports: parsePortTuple(value.ports),
    repoRoot: readStringProperty(value, "repoRoot"),
    slot: readIntegerProperty(value, "slot"),
    stackId: readStringProperty(value, "stackId"),
    updatedAt: readStringProperty(value, "updatedAt"),
  };
}

function parseRegistryFile(value: unknown): DevAutoRegistryFile {
  if (!isJsonRecord(value)) {
    throw new Error("Invalid dev:auto registry file");
  }

  const version = readIntegerProperty(value, "version");
  if (version !== DEV_AUTO_REGISTRY_VERSION) {
    throw new Error(`Unsupported dev:auto registry version ${version}`);
  }

  if (!Array.isArray(value.reservations)) {
    throw new Error("Invalid dev:auto registry reservations");
  }

  return {
    reservations: value.reservations.map(parseReservation),
    version,
  };
}

function isExpectedMissingFileError(error: unknown): boolean {
  return getErrorCode(error) === "ENOENT";
}

function isLockAlreadyExistsError(error: unknown): boolean {
  return getErrorCode(error) === "EEXIST";
}

function createEmptyRegistry(): DevAutoRegistryFile {
  return {
    reservations: [],
    version: DEV_AUTO_REGISTRY_VERSION,
  };
}

function resolveNowIso(now: DevAutoNow | undefined): string {
  return new Date(now ? now() : Date.now()).toISOString();
}

function quoteShellValue(value: string): string {
  return `'${value.replace(/'/gu, `'\"'\"'`)}'`;
}

function createDevAutoServerUrl(ports: DevAutoPortTuple): string {
  return `http://127.0.0.1:${ports.serverPort}`;
}

function createDatabasePath(dataDir: string): string {
  return join(dataDir, "bb.db");
}

function createRegistryPaths(devDataDir: string): DevAutoRegistryPaths {
  const registryDir = join(devDataDir, DEV_AUTO_REGISTRY_DIR_NAME);
  return {
    lockDir: join(registryDir, DEV_AUTO_REGISTRY_LOCK_DIR_NAME),
    registryDir,
    registryPath: join(registryDir, DEV_AUTO_REGISTRY_FILE_NAME),
  };
}

function createStackDataDir(args: ResolveDevAutoStackDataDirArgs): string {
  return join(args.devDataDir, DEV_AUTO_STACKS_DIR_NAME, `slot-${args.slot}`);
}

async function writeJsonFileAtomically(
  args: SaveDevAutoRegistryArgs,
): Promise<void> {
  await mkdir(args.paths.registryDir, { recursive: true });
  const tempPath = join(
    dirname(args.paths.registryPath),
    `${DEV_AUTO_REGISTRY_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`,
  );

  try {
    await writeFile(
      tempPath,
      `${JSON.stringify(args.registry, null, 2)}\n`,
      "utf8",
    );
    await rename(tempPath, args.paths.registryPath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

async function isLockStale(
  args: AcquireDevAutoRegistryLockArgs,
): Promise<boolean> {
  const now = args.now ?? Date.now;
  const staleLockMs = args.staleLockMs ?? DEV_AUTO_LOCK_STALE_MS;

  try {
    const lockStat = await stat(args.paths.lockDir);
    return now() - lockStat.mtimeMs > staleLockMs;
  } catch (error) {
    if (isExpectedMissingFileError(error)) {
      return false;
    }
    throw error;
  }
}

async function readLockToken(
  paths: DevAutoRegistryPaths,
): Promise<string | null> {
  try {
    return (
      await readFile(join(paths.lockDir, DEV_AUTO_LOCK_TOKEN_FILE_NAME), "utf8")
    ).trim();
  } catch (error) {
    if (isExpectedMissingFileError(error)) {
      return null;
    }
    throw error;
  }
}

async function removeStaleLock(
  args: AcquireDevAutoRegistryLockArgs,
): Promise<void> {
  if (await isLockStale(args)) {
    await rm(args.paths.lockDir, { force: true, recursive: true });
  }
}

async function createLock(
  args: AcquireDevAutoRegistryLockArgs,
  token: string,
): Promise<void> {
  await mkdir(args.paths.registryDir, { recursive: true });
  await mkdir(args.paths.lockDir);
  try {
    await writeFile(
      join(args.paths.lockDir, DEV_AUTO_LOCK_TOKEN_FILE_NAME),
      token,
      {
        encoding: "utf8",
        flag: "wx",
      },
    );
    const nowMs = args.now ? args.now() : Date.now();
    await utimes(args.paths.lockDir, nowMs / 1000, nowMs / 1000);
  } catch (error) {
    await rm(args.paths.lockDir, { force: true, recursive: true });
    throw error;
  }
}

export function resolveDevAutoDevDataDir(
  args: ResolveDevAutoDevDataDirArgs = {},
): string {
  return resolveConfiguredDataDir({
    defaultDirName: DEFAULTS.dataDir.dev,
    env: args.env,
  });
}

export function resolveDevAutoRegistryPaths(
  args: ResolveDevAutoRegistryPathsArgs,
): DevAutoRegistryPaths {
  return createRegistryPaths(args.devDataDir);
}

export function resolveDevAutoStackDataDir(
  args: ResolveDevAutoStackDataDirArgs,
): string {
  return createStackDataDir(args);
}

export async function acquireDevAutoRegistryLock(
  args: AcquireDevAutoRegistryLockArgs,
): Promise<DevAutoRegistryLock> {
  const now = args.now ?? Date.now;
  const sleep = args.sleep ?? sleepMs;
  const maxWaitMs = args.maxWaitMs ?? DEV_AUTO_LOCK_MAX_WAIT_MS;
  const retryDelayMs = args.retryDelayMs ?? DEV_AUTO_LOCK_RETRY_DELAY_MS;
  const startedAt = now();
  const token = args.token ?? `${args.ownerPid ?? process.pid}:${randomUUID()}`;

  while (true) {
    try {
      await createLock(args, token);
      return {
        paths: args.paths,
        token,
        async release(): Promise<void> {
          await releaseDevAutoRegistryLock({
            paths: args.paths,
            token,
          });
        },
      };
    } catch (error) {
      if (!isLockAlreadyExistsError(error)) {
        throw error;
      }

      await removeStaleLock(args);
      if (now() - startedAt >= maxWaitMs) {
        throw new Error(
          `Timed out waiting for dev:auto registry lock at ${args.paths.lockDir}`,
        );
      }
      await sleep(retryDelayMs);
    }
  }
}

export interface ReleaseDevAutoRegistryLockArgs {
  paths: DevAutoRegistryPaths;
  token: string;
}

export async function releaseDevAutoRegistryLock(
  args: ReleaseDevAutoRegistryLockArgs,
): Promise<void> {
  const token = await readLockToken(args.paths);
  if (token === args.token) {
    await rm(args.paths.lockDir, { force: true, recursive: true });
  }
}

export async function loadDevAutoRegistry(
  args: LoadDevAutoRegistryArgs,
): Promise<DevAutoRegistryFile> {
  try {
    const raw = await readFile(args.paths.registryPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return parseRegistryFile(parsed);
  } catch (error) {
    if (isExpectedMissingFileError(error)) {
      return createEmptyRegistry();
    }
    throw error;
  }
}

export async function saveDevAutoRegistry(
  args: SaveDevAutoRegistryArgs,
): Promise<void> {
  await writeJsonFileAtomically(args);
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = getErrorCode(error);
    if (code === "EPERM") {
      return true;
    }
    return false;
  }
}

export function pruneStaleDevAutoReservations(
  args: PruneStaleDevAutoReservationsArgs,
): PruneStaleDevAutoReservationsResult {
  const processAlive = args.isProcessAlive ?? isProcessAlive;
  const reservations: DevAutoReservation[] = [];
  const prunedReservations: DevAutoReservation[] = [];

  for (const reservation of args.registry.reservations) {
    if (processAlive(reservation.ownerPid)) {
      reservations.push(reservation);
    } else {
      prunedReservations.push(reservation);
    }
  }

  return {
    prunedReservations,
    registry: {
      reservations,
      version: args.registry.version,
    },
  };
}

export async function reserveDevAutoStack(
  args: ReserveDevAutoStackArgs,
): Promise<DevAutoReservation> {
  const devDataDir =
    args.devDataDir ?? resolveDevAutoDevDataDir({ env: args.env });
  const paths = resolveDevAutoRegistryPaths({ devDataDir });
  const lock = await acquireDevAutoRegistryLock({
    now: args.now,
    ownerPid: args.ownerPid,
    paths,
  });

  try {
    const loadedRegistry = await loadDevAutoRegistry({ paths });
    const pruned = pruneStaleDevAutoReservations({
      isProcessAlive: args.isProcessAlive,
      registry: loadedRegistry,
    });
    const reservedSlots = new Set<DevAutoSlot>(
      pruned.registry.reservations.map((reservation) => reservation.slot),
    );
    const assignment = await findAvailableDevAutoSlot({
      firstSlot: args.firstSlot ?? DEFAULT_DEV_AUTO_FIRST_SLOT,
      maxSlot: args.maxSlot ?? DEFAULT_DEV_AUTO_MAX_SLOT,
      probePort: args.probePort,
      reservedSlots,
    });
    const dataDir = resolveDevAutoStackDataDir({
      devDataDir,
      slot: assignment.slot,
    });
    const nowIso = resolveNowIso(args.now);
    const reservation: DevAutoReservation = {
      ...assignment,
      createdAt: nowIso,
      dataDir,
      ownerPid: args.ownerPid,
      repoRoot: args.repoRoot,
      updatedAt: nowIso,
    };

    await mkdir(dataDir, { recursive: true });
    await saveDevAutoRegistry({
      paths,
      registry: {
        reservations: [...pruned.registry.reservations, reservation],
        version: pruned.registry.version,
      },
    });

    return reservation;
  } finally {
    await lock.release();
  }
}

export async function removeDevAutoReservation(
  args: RemoveDevAutoReservationArgs,
): Promise<void> {
  const devDataDir =
    args.devDataDir ?? resolveDevAutoDevDataDir({ env: args.env });
  const paths = resolveDevAutoRegistryPaths({ devDataDir });
  const lock = await acquireDevAutoRegistryLock({
    ownerPid: process.pid,
    paths,
  });

  try {
    const registry = await loadDevAutoRegistry({ paths });
    const reservations = registry.reservations.filter((reservation) => {
      return !(
        reservation.stackId === args.reservation.stackId &&
        reservation.ownerPid === args.reservation.ownerPid &&
        reservation.repoRoot === args.reservation.repoRoot
      );
    });

    if (reservations.length === registry.reservations.length) {
      return;
    }

    await saveDevAutoRegistry({
      paths,
      registry: {
        reservations,
        version: registry.version,
      },
    });
  } finally {
    await lock.release();
  }
}

export function createDevAutoStackEnvironment(
  reservation: DevAutoReservation,
): DevAutoStackEnvironment {
  return {
    BB_DATABASE_URL: createDatabasePath(reservation.dataDir),
    BB_DATA_DIR: reservation.dataDir,
    BB_DEV_APP_PORT: String(reservation.ports.appPort),
    BB_DEV_AUTO_SLOT: String(reservation.slot),
    BB_DEV_AUTO_STACK_ID: reservation.stackId,
    BB_DEV_ENV_PORT: String(reservation.ports.devEnvPort),
    BB_HOST_DAEMON_PORT: String(reservation.ports.hostDaemonPort),
    BB_SERVER_PORT: String(reservation.ports.serverPort),
    BB_SERVER_URL: createDevAutoServerUrl(reservation.ports),
  };
}

export function renderDevAutoEnvFile(args: RenderDevAutoEnvFileArgs): string {
  const lines = DEV_AUTO_ENV_FILE_KEYS.map((key) => {
    return `export ${key}=${quoteShellValue(args.stackEnv[key])}`;
  });
  return `${lines.join("\n")}\n`;
}

export async function writeDevAutoEnvFile(
  args: WriteDevAutoEnvFileArgs,
): Promise<void> {
  await mkdir(dirname(args.envFilePath), { recursive: true });
  await writeFile(
    args.envFilePath,
    renderDevAutoEnvFile({ stackEnv: args.stackEnv }),
    "utf8",
  );
}
