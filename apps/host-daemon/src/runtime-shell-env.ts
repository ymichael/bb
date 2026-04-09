import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentRuntimeOptions } from "@bb/agent-runtime";

export interface ResolveLocalBbExecutableDirectoryOptions {
  cliExecutablePath?: string;
}

export interface PrepareRuntimeShellEnvOptions {
  bbExecutableDirectory: string;
  localApiPort: number;
  serverUrl: string;
  inheritedPath?: string;
}

function getDefaultCliExecutablePath(): string {
  return fileURLToPath(new URL("../../cli/bin/bb", import.meta.url));
}

function getErrorCode(error: unknown): string | undefined {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}

async function resolveCliEntryPath(
  cliExecutablePath: string,
): Promise<string> {
  const cliEntryPath = resolve(cliExecutablePath);

  try {
    const stats = await fs.stat(cliEntryPath);
    if (!stats.isFile()) {
      throw new Error(`Resolved bb CLI entry is not a file: ${cliEntryPath}`);
    }
    if (process.platform !== "win32") {
      try {
        await fs.access(cliEntryPath, fsConstants.X_OK);
      } catch (error) {
        if (getErrorCode(error) === "EACCES") {
          throw new Error(
            `Resolved bb CLI entry is not executable: ${cliEntryPath}. Build @bb/cli before starting the host daemon.`,
          );
        }
        throw error;
      }
    }
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      throw new Error(
        `Missing built bb CLI entry at ${cliEntryPath}. Build @bb/cli before starting the host daemon.`,
      );
    }
    throw error;
  }

  return cliEntryPath;
}

async function resolveBbExecutable(
  options: ResolveLocalBbExecutableDirectoryOptions = {},
): Promise<string> {
  const resolvedCliExecutablePath =
    options.cliExecutablePath ?? getDefaultCliExecutablePath();
  const cliEntryPath = await resolveCliEntryPath(resolvedCliExecutablePath);

  return dirname(cliEntryPath);
}

function prependPath(
  executableDirectoryPath: string,
  inheritedPath?: string,
): string {
  return inheritedPath
    ? `${executableDirectoryPath}${delimiter}${inheritedPath}`
    : executableDirectoryPath;
}

export async function resolveLocalBbExecutableDirectory(
  options: ResolveLocalBbExecutableDirectoryOptions = {},
): Promise<string> {
  return resolveBbExecutable(options);
}

export function prepareRuntimeShellEnv(
  options: PrepareRuntimeShellEnvOptions,
): NonNullable<AgentRuntimeOptions["shellEnv"]> {
  return {
    PATH: prependPath(
      options.bbExecutableDirectory,
      options.inheritedPath ?? process.env.PATH,
    ),
    BB_SERVER_URL: options.serverUrl,
    BB_HOST_DAEMON_PORT: String(options.localApiPort),
  };
}
