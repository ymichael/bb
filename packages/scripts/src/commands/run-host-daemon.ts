import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HOST_AUTH_FILE_NAME,
  HOST_ID_FILE_NAME,
} from "@bb/host-daemon-contract";
import {
  createHostJoinResponseSchema,
  createPublicApiClient,
} from "@bb/server-contract";
import { resolveConfiguredDataDir } from "@bb/config/data-dir";
import { DEFAULTS } from "@bb/config/defaults";
import { hostDaemonEntrypointConfig } from "@bb/config/host-daemon-entrypoint";
import { hostDaemonConfig } from "@bb/config/host-daemon";
import type { HostDaemonRuntimeEnvironment } from "../lib/host-daemon-runtime.js";
import { toHostDaemonProcessEnv } from "../lib/host-daemon-runtime.js";
import {
  type HostMode,
  resolveNodeEnvironment,
  resolveScriptMode,
} from "../lib/script-config.js";
import { runScriptProcess } from "../lib/process-helpers.js";
import { waitForServerHealth } from "../lib/wait-for-server-health.js";

const commandDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(commandDir, "..", "..");
const repoRoot = resolve(packageRoot, "..", "..");
const DEV_AUTO_JOIN_DATA_DIR_NAME = `${DEFAULTS.dataDir.dev}-host-daemon`;

function resolveMode(): HostMode {
  return resolveScriptMode();
}

function shouldAutoJoin(): boolean {
  return process.argv.includes("--auto-join");
}

export function resolveDefaultDataDirName(mode: HostMode, autoJoin: boolean): string {
  if (mode === "dev" && autoJoin) {
    return DEV_AUTO_JOIN_DATA_DIR_NAME;
  }
  return mode === "dev" ? DEFAULTS.dataDir.dev : DEFAULTS.dataDir.prod;
}

function resolveDataDir(mode: HostMode, autoJoin: boolean): string {
  return resolveConfiguredDataDir({
    defaultDirName: resolveDefaultDataDirName(mode, autoJoin),
  });
}

function buildEnv(
  mode: HostMode,
  autoJoin: boolean,
): HostDaemonRuntimeEnvironment {
  return {
    ...hostDaemonEntrypointConfig,
    BB_DATA_DIR: resolveDataDir(mode, autoJoin),
    BB_SERVER_URL: hostDaemonConfig.BB_SERVER_URL,
    NODE_ENV: resolveNodeEnvironment(mode),
  };
}

async function pathExists(pathToCheck: string): Promise<boolean> {
  try {
    await access(pathToCheck);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function readPersistedHostId(dataDir: string): Promise<string | null> {
  try {
    const value = (await readFile(join(dataDir, HOST_ID_FILE_NAME), "utf8")).trim();
    return value.length > 0 ? value : null;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function maybeAddAutoJoinEnv(
  env: HostDaemonRuntimeEnvironment,
  autoJoin: boolean,
): Promise<HostDaemonRuntimeEnvironment> {
  if (!autoJoin || env.BB_HOST_ENROLL_KEY) {
    return env;
  }

  if (await pathExists(join(env.BB_DATA_DIR, HOST_AUTH_FILE_NAME))) {
    return env;
  }

  await waitForServerHealth(env.BB_SERVER_URL);
  const requestedHostId =
    env.BB_HOST_ID?.trim() || (await readPersistedHostId(env.BB_DATA_DIR));

  const client = createPublicApiClient(env.BB_SERVER_URL);
  const response = await client.hosts.join.$post({
    json: requestedHostId ? { hostId: requestedHostId } : {},
  });

  if (response.status !== 201) {
    const detail = await response.text();
    throw new Error(
      `Failed to request host join material: ${response.status} ${response.statusText}${detail ? ` - ${detail}` : ""}`,
    );
  }

  const joinResponse = createHostJoinResponseSchema.parse(await response.json());
  if (requestedHostId && joinResponse.hostId !== requestedHostId) {
    throw new Error(
      `Join response host ID ${joinResponse.hostId} does not match persisted host ID ${requestedHostId}`,
    );
  }

  return {
    ...env,
    BB_HOST_ENROLL_KEY: joinResponse.joinCode,
    BB_HOST_ID: joinResponse.hostId,
  };
}

export async function main(): Promise<void> {
  const mode = resolveMode();
  const autoJoin = shouldAutoJoin();
  const env = await maybeAddAutoJoinEnv(buildEnv(mode, autoJoin), autoJoin);
  process.exitCode = await runScriptProcess({
    args: ["apps/host-daemon/dist/index.js"],
    command: process.execPath,
    cwd: repoRoot,
    env: toHostDaemonProcessEnv(env),
    stdio: "inherit",
  });
}

if (
  process.argv[1] != null &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void main().catch((error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
