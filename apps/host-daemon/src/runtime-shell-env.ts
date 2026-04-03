import fs from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentRuntimeOptions } from "@bb/agent-runtime";

const DEFAULT_BB_EXECUTABLE_DIRECTORY_NAME = "bin";
const DEFAULT_BB_EXECUTABLE_NAME = "bb";
const BB_EXECUTABLE_DIRECTORY_MODE = 0o700;
const BB_EXECUTABLE_FILE_MODE = 0o755;
const EXECUTABLE_PERMISSION_MASK = 0o111;

interface PrepareRuntimeShellEnvOptions {
  dataDir: string;
  localApiPort: number;
  serverUrl: string;
  inheritedPath?: string;
  nodeExecutablePath?: string;
  cliPackageManifestPath?: string;
}

interface EnsureDaemonManagedBbExecutableOptions {
  dataDir: string;
  nodeExecutablePath: string;
  cliPackageManifestPath?: string;
}

interface DaemonManagedBbExecutable {
  executableDirectoryPath: string;
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

function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
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

async function isDirectlyExecutable(cliEntryPath: string): Promise<boolean> {
  const stats = await fs.stat(cliEntryPath);
  return (
    stats.isFile() && (stats.mode & EXECUTABLE_PERMISSION_MASK) !== 0
  );
}

async function ensureDaemonManagedBbExecutable(
  options: EnsureDaemonManagedBbExecutableOptions,
): Promise<DaemonManagedBbExecutable> {
  const executableDirectoryPath = join(
    options.dataDir,
    DEFAULT_BB_EXECUTABLE_DIRECTORY_NAME,
  );
  const executablePath = join(
    executableDirectoryPath,
    DEFAULT_BB_EXECUTABLE_NAME,
  );
  const cliPackageManifestPath =
    options.cliPackageManifestPath ?? getDefaultCliPackageManifestPath();
  const cliEntryPath = await resolveCliEntryPath(cliPackageManifestPath);

  await fs.mkdir(executableDirectoryPath, {
    recursive: true,
    mode: BB_EXECUTABLE_DIRECTORY_MODE,
  });
  await fs.chmod(executableDirectoryPath, BB_EXECUTABLE_DIRECTORY_MODE);
  await fs.rm(executablePath, { recursive: true, force: true });

  if (await isDirectlyExecutable(cliEntryPath)) {
    await fs.symlink(cliEntryPath, executablePath);
  } else {
    const shimScript = `#!/bin/sh
exec ${quoteShellArgument(options.nodeExecutablePath)} ${quoteShellArgument(cliEntryPath)} "$@"
`;
    await fs.writeFile(executablePath, shimScript, {
      encoding: "utf8",
      mode: BB_EXECUTABLE_FILE_MODE,
    });
    await fs.chmod(executablePath, BB_EXECUTABLE_FILE_MODE);
  }

  return {
    executableDirectoryPath,
  };
}

function prependPath(
  executableDirectoryPath: string,
  inheritedPath?: string,
): string {
  return inheritedPath
    ? `${executableDirectoryPath}:${inheritedPath}`
    : executableDirectoryPath;
}

export async function prepareRuntimeShellEnv(
  options: PrepareRuntimeShellEnvOptions,
): Promise<NonNullable<AgentRuntimeOptions["shellEnv"]>> {
  const bbExecutable = await ensureDaemonManagedBbExecutable({
    dataDir: options.dataDir,
    nodeExecutablePath: options.nodeExecutablePath ?? process.execPath,
    cliPackageManifestPath: options.cliPackageManifestPath,
  });

  return {
    PATH: prependPath(
      bbExecutable.executableDirectoryPath,
      options.inheritedPath ?? process.env.PATH,
    ),
    BB_SERVER_URL: options.serverUrl,
    BB_HOST_DAEMON_PORT: String(options.localApiPort),
  };
}
