import { randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export const HOST_ID_FILE_NAME = "host-id";

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

export async function readOrCreateHostId(options: {
  dataDir: string;
  createId?: () => string;
}): Promise<string> {
  await fs.mkdir(options.dataDir, { recursive: true });

  const hostIdPath = path.join(options.dataDir, HOST_ID_FILE_NAME);
  const existing = await readHostIdFile(hostIdPath);
  if (existing) {
    return existing;
  }

  const hostId = options.createId?.() ?? randomUUID();
  try {
    await fs.writeFile(hostIdPath, `${hostId}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    return hostId;
  } catch {
    const racedValue = await readHostIdFile(hostIdPath);
    if (racedValue) {
      return racedValue;
    }
    throw new Error(`Failed to initialize host ID at ${hostIdPath}`);
  }
}

export async function detectHostName(options: {
  platform?: NodeJS.Platform;
  execFile?: ExecFileFn;
  fallbackHostName?: () => string;
} = {}): Promise<string> {
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
}): Promise<HostIdentity> {
  const [hostId, hostName] = await Promise.all([
    readOrCreateHostId({
      dataDir: options.dataDir,
      createId: options.createId,
    }),
    detectHostName({
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
