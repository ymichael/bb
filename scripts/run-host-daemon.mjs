import "../packages/config/dist/dotenv.js";
import { access, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS } from "../packages/config/dist/defaults.js";
import {
  HOST_AUTH_FILE_NAME,
  HOST_ID_FILE_NAME,
} from "../packages/host-daemon-contract/dist/index.js";
import { createHostJoinResponseSchema } from "../packages/server-contract/dist/index.js";
import { waitForServerHealth } from "./lib/wait-for-server-health.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

function resolveMode() {
  const modeFlagIndex = process.argv.indexOf("--mode");
  const modeValue =
    modeFlagIndex >= 0 ? process.argv[modeFlagIndex + 1] : undefined;
  if (modeValue === "dev" || modeValue === "prod") {
    return modeValue;
  }
  throw new Error('Expected "--mode dev" or "--mode prod"');
}

function shouldAutoJoin() {
  return process.argv.includes("--auto-join");
}

function resolveDataDir(mode) {
  return (
    process.env.BB_DATA_DIR ??
    join(homedir(), mode === "dev" ? DEFAULTS.dataDir.dev : DEFAULTS.dataDir.prod)
  );
}

function resolveServerUrl(mode) {
  return (
    process.env.BB_SERVER_URL ??
    (mode === "dev" ? DEFAULTS.serverUrl.dev : DEFAULTS.serverUrl.prod)
  );
}

function buildEnv(mode) {
  return {
    ...process.env,
    BB_DATA_DIR: resolveDataDir(mode),
    BB_SERVER_URL: resolveServerUrl(mode),
    NODE_ENV:
      process.env.NODE_ENV ??
      (mode === "dev" ? "development" : "production"),
  };
}

async function pathExists(pathToCheck) {
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

async function readPersistedHostId(dataDir) {
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

export async function maybeAddAutoJoinEnv(env, autoJoin) {
  if (!autoJoin || env.BB_HOST_ENROLL_KEY) {
    return env;
  }

  if (await pathExists(join(env.BB_DATA_DIR, HOST_AUTH_FILE_NAME))) {
    return env;
  }

  await waitForServerHealth(env.BB_SERVER_URL);
  const requestedHostId =
    env.BB_HOST_ID?.trim() || (await readPersistedHostId(env.BB_DATA_DIR));

  const response = await fetch(new URL("/api/v1/hosts/join", env.BB_SERVER_URL), {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      ...(requestedHostId ? { hostId: requestedHostId } : {}),
      hostType: "persistent",
    }),
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
    BB_HOST_TYPE: "persistent",
  };
}

const isDirectExecution =
  process.argv[1] != null &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

async function main() {
  const mode = resolveMode();
  const env = await maybeAddAutoJoinEnv(buildEnv(mode), shouldAutoJoin());
  const child = spawn(process.execPath, ["apps/host-daemon/dist/index.js"], {
    cwd: repoRoot,
    env,
    stdio: "inherit",
  });

  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));

  const exitCode = await new Promise((resolvePromise) => {
    child.once("exit", (code) => {
      resolvePromise(code ?? 1);
    });
  });
  process.exitCode = exitCode;
}

if (isDirectExecution) {
  void main().catch((error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
