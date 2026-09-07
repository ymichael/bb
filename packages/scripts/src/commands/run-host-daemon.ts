import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BB_PROD_HOST_DAEMON_PORT,
  resolveCurrentDevInstanceConfig,
  resolvePortFromEnv,
  resolveRuntimeDataDir,
  resolveRuntimeMode,
  type BbRuntimeMode,
} from "@bb/config/runtime";
import { loadServerUrlValue } from "@bb/config/server-url";
import {
  HOST_AUTH_FILE_NAME,
  HOST_ID_FILE_NAME,
  hostDaemonEnrollKeyResponseSchema,
  type HostDaemonEnrollKeyRequest,
} from "@bb/host-daemon-contract";
import { loadHostDaemonEntrypointConfig } from "@bb/config/host-daemon-entrypoint";
import type { HostDaemonRuntimeEnvironment } from "../lib/host-daemon-runtime.js";
import { toHostDaemonProcessEnv } from "../lib/host-daemon-runtime.js";
import { pathExists } from "../lib/legacy-dev-data-migration.js";
import { resolveNodeEnvironment } from "../lib/script-config.js";
import { runScriptProcess } from "../lib/process-helpers.js";
import { waitForServerHealth } from "../lib/wait-for-server-health.js";

const commandDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(commandDir, "..", "..");
const repoRoot = resolve(packageRoot, "..", "..");

interface HostDaemonProcessCommand {
  args: string[];
  command: string;
}

interface CreateAutoJoinRequestArgs {
  requestedHostId: string | null;
}

interface ResolveHostDaemonPortArgs {
  mode: BbRuntimeMode;
  requiresExplicitPort: boolean;
}

function resolveHostDaemonPort(args: ResolveHostDaemonPortArgs): number {
  if (
    args.requiresExplicitPort &&
    process.env.BB_HOST_DAEMON_PORT === undefined
  ) {
    throw new Error(
      "BB_HOST_DAEMON_PORT is required when running a dev extra-host daemon without BB_DATA_DIR. Set it to a port distinct from pnpm dev's host daemon port.",
    );
  }

  return resolvePortFromEnv({
    defaultPort:
      args.mode === "dev"
        ? resolveCurrentDevInstanceConfig(repoRoot).ports.hostDaemonPort
        : BB_PROD_HOST_DAEMON_PORT,
    env: process.env,
    name: "BB_HOST_DAEMON_PORT",
  });
}

function ensureDevOverridePair(mode: BbRuntimeMode): void {
  if (mode !== "dev") {
    return;
  }

  const hasDataDirOverride = process.env.BB_DATA_DIR !== undefined;
  const hasServerUrlOverride = process.env.BB_SERVER_URL !== undefined;
  if (hasDataDirOverride !== hasServerUrlOverride) {
    throw new Error(
      "Dev host-daemon overrides must set both BB_DATA_DIR and BB_SERVER_URL, or neither.",
    );
  }
}

export function resolveHostDaemonRuntimeEnvironment(
  mode: BbRuntimeMode,
): HostDaemonRuntimeEnvironment {
  ensureDevOverridePair(mode);
  const usesDefaultDevExtraHost =
    mode === "dev" && process.env.BB_DATA_DIR === undefined;
  const devDataDirSuffix = usesDefaultDevExtraHost ? "extra-host" : undefined;
  const dataDir = resolveRuntimeDataDir({
    env: process.env,
    homeDir: homedir(),
    mode,
    repoRoot: mode === "dev" ? repoRoot : undefined,
  });
  const hostDaemonEntrypointConfig = loadHostDaemonEntrypointConfig();
  return {
    ...hostDaemonEntrypointConfig,
    BB_DATA_DIR:
      devDataDirSuffix === undefined
        ? dataDir
        : join(dataDir, devDataDirSuffix),
    BB_HOST_DAEMON_PORT: String(
      resolveHostDaemonPort({
        mode,
        requiresExplicitPort: usesDefaultDevExtraHost,
      }),
    ),
    BB_SERVER_URL: loadServerUrlValue({
      env: process.env,
      homeDir: homedir(),
      mode,
      repoRoot,
    }),
    NODE_ENV: resolveNodeEnvironment(mode),
  };
}

export function resolveHostDaemonProcessCommand(
  mode: BbRuntimeMode,
): HostDaemonProcessCommand {
  if (mode === "dev") {
    return {
      args: [
        "--conditions=source",
        "--import",
        "tsx",
        "apps/host-daemon/src/index.ts",
      ],
      command: process.execPath,
    };
  }

  return {
    args: ["apps/host-daemon/dist/index.js"],
    command: process.execPath,
  };
}

async function readPersistedHostId(dataDir: string): Promise<string | null> {
  try {
    const value = (
      await readFile(join(dataDir, HOST_ID_FILE_NAME), "utf8")
    ).trim();
    return value.length > 0 ? value : null;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function createAutoJoinRequest(
  args: CreateAutoJoinRequestArgs,
): HostDaemonEnrollKeyRequest {
  const request: HostDaemonEnrollKeyRequest = {};
  if (args.requestedHostId !== null) {
    request.hostId = args.requestedHostId;
  }
  return request;
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

  const response = await fetch(
    `${env.BB_SERVER_URL}/internal/hosts/enroll-key`,
    {
      body: JSON.stringify(createAutoJoinRequest({ requestedHostId })),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    },
  );

  if (response.status !== 201) {
    const detail = await response.text();
    throw new Error(
      `Failed to request host enroll key: ${response.status} ${response.statusText}${detail ? ` - ${detail}` : ""}`,
    );
  }

  const enrollKeyResponse = hostDaemonEnrollKeyResponseSchema.parse(
    await response.json(),
  );
  if (requestedHostId && enrollKeyResponse.hostId !== requestedHostId) {
    throw new Error(
      `Enroll key response host ID ${enrollKeyResponse.hostId} does not match persisted host ID ${requestedHostId}`,
    );
  }

  return {
    ...env,
    BB_HOST_ENROLL_KEY: enrollKeyResponse.enrollKey,
    BB_HOST_ID: enrollKeyResponse.hostId,
  };
}

async function main(): Promise<void> {
  const mode = resolveRuntimeMode();
  const autoJoin = process.argv.includes("--auto-join");
  const env = await maybeAddAutoJoinEnv(
    resolveHostDaemonRuntimeEnvironment(mode),
    autoJoin,
  );
  const daemonProcessCommand = resolveHostDaemonProcessCommand(mode);
  process.exitCode = await runScriptProcess({
    args: daemonProcessCommand.args,
    command: daemonProcessCommand.command,
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
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
