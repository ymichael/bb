import fs from "node:fs/promises";
import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentRuntimeOptions } from "@bb/agent-runtime";

export interface ResolveLocalBbExecutableDirectoryOptions {
  cliPackageManifestPath?: string;
}

export interface PrepareRuntimeShellEnvOptions {
  bbExecutableDirectory: string;
  localApiPort: number;
  serverUrl: string;
  inheritedPath?: string;
}

function getDefaultCliPackageManifestPath(): string {
  return fileURLToPath(new URL("../../cli/package.json", import.meta.url));
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

function getCliBinPathFromManifest(
  manifestText: string,
  manifestPath: string,
): string {
  const parsed: unknown = JSON.parse(manifestText);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Invalid CLI package manifest at ${manifestPath}`);
  }

  const binValue = Reflect.get(parsed, "bin");
  if (typeof binValue === "string" && binValue.length > 0) {
    return binValue;
  }

  if (binValue && typeof binValue === "object") {
    const bbBinValue = Reflect.get(binValue, "bb");
    if (typeof bbBinValue === "string" && bbBinValue.length > 0) {
      return bbBinValue;
    }
  }

  throw new Error(
    `CLI package manifest at ${manifestPath} does not define a bb bin entry`,
  );
}

async function resolveCliEntryPath(
  cliPackageManifestPath: string,
): Promise<string> {
  const manifestText = await fs.readFile(cliPackageManifestPath, "utf8");
  const cliBinPath = getCliBinPathFromManifest(
    manifestText,
    cliPackageManifestPath,
  );
  const cliEntryPath = resolve(dirname(cliPackageManifestPath), cliBinPath);

  try {
    const stats = await fs.stat(cliEntryPath);
    if (!stats.isFile()) {
      throw new Error(`Resolved bb CLI entry is not a file: ${cliEntryPath}`);
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
  const resolvedCliPackageManifestPath =
    options.cliPackageManifestPath ?? getDefaultCliPackageManifestPath();
  const cliEntryPath = await resolveCliEntryPath(resolvedCliPackageManifestPath);

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
