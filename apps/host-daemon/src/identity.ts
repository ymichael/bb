import { randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { HOST_ID_FILE_NAME } from "@bb/host-daemon-contract";

const execFile = promisify(execFileCallback);

type ExecFileResult = {
  stdout?: string | Buffer;
  stderr?: string | Buffer;
};

export type ExecFileFn = (
  file: string,
  args?: readonly string[],
) => Promise<ExecFileResult>;

export interface HostIdentity {
  hostId: string;
  hostName: string;
}

interface ResolveHostIdOptions {
  dataDir: string;
  createId?: () => string;
  providedHostId?: string;
}

async function resolveHostId(options: ResolveHostIdOptions): Promise<string> {
  const hostIdPath = path.join(options.dataDir, HOST_ID_FILE_NAME);
  const existing = await readHostIdFile(hostIdPath);
  if (existing) {
    if (options.providedHostId && existing !== options.providedHostId) {
      throw new Error(
        `Configured BB_HOST_ID ${options.providedHostId} does not match persisted host ID ${existing}`,
      );
    }
    return existing;
  }
  return options.providedHostId ?? options.createId?.() ?? randomUUID();
}

// Writes the host ID file. Idempotent: if a value is already persisted and
// matches, this is a no-op. Callers must only invoke this once the host has
// been successfully enrolled — persisting earlier strands the daemon if
// enrollment fails, because the file then conflicts with any subsequent
// BB_HOST_ID provided on retry.
export async function persistHostId(options: {
  dataDir: string;
  hostId: string;
}): Promise<void> {
  await fs.mkdir(options.dataDir, { recursive: true });
  const hostIdPath = path.join(options.dataDir, HOST_ID_FILE_NAME);
  try {
    await fs.writeFile(hostIdPath, `${options.hostId}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return;
  } catch {
    // Fall through to validate any racing write below.
  }
  const racedValue = await readHostIdFile(hostIdPath);
  if (!racedValue) {
    throw new Error(`Failed to initialize host ID at ${hostIdPath}`);
  }
  if (racedValue !== options.hostId) {
    throw new Error(
      `Persisted host ID ${racedValue} does not match resolved host ID ${options.hostId}`,
    );
  }
}

export async function detectHostName(
  options: {
    platform?: NodeJS.Platform;
    execFile?: ExecFileFn;
    fallbackHostName?: () => string;
  } = {},
): Promise<string> {
  const platform = options.platform ?? process.platform;
  const exec = options.execFile ?? execFile;
  const fallbackHostName = options.fallbackHostName ?? os.hostname;

  const candidates: Array<[string, string[]]> =
    platform === "darwin"
      ? [
          ["scutil", ["--get", "ComputerName"]],
          ["hostname", []],
        ]
      : [["hostname", []]];

  for (const [command, args] of candidates) {
    const value = await tryReadCommandOutput(exec, command, args);
    if (value) {
      return value;
    }
  }

  const fallback = fallbackHostName().trim();
  return fallback || "unknown-host";
}

export async function loadHostIdentity(options: {
  dataDir: string;
  createId?: () => string;
  execFile?: ExecFileFn;
  fallbackHostName?: () => string;
  platform?: NodeJS.Platform;
  providedHostId?: string;
  providedHostName?: string;
}): Promise<HostIdentity> {
  await fs.mkdir(options.dataDir, { recursive: true });
  const [hostId, hostName] = await Promise.all([
    resolveHostId({
      dataDir: options.dataDir,
      createId: options.createId,
      providedHostId: options.providedHostId,
    }),
    options.providedHostName
      ? Promise.resolve(options.providedHostName)
      : detectHostName({
          platform: options.platform,
          execFile: options.execFile,
          fallbackHostName: options.fallbackHostName,
        }),
  ]);

  return { hostId, hostName };
}

async function readHostIdFile(hostIdPath: string): Promise<string | null> {
  try {
    const value = (await fs.readFile(hostIdPath, "utf8")).trim();
    return value || null;
  } catch (error) {
    const errorCode =
      error instanceof Error && "code" in error ? error.code : undefined;
    if (errorCode === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function tryReadCommandOutput(
  exec: ExecFileFn,
  command: string,
  args: readonly string[],
): Promise<string | null> {
  try {
    const result = await exec(command, args);
    const value = String(result.stdout ?? "").trim();
    return value || null;
  } catch {
    return null;
  }
}
