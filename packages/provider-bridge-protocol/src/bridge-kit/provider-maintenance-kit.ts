import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type {
  ProviderInstallationCommand,
  ProviderInstallationSource,
  ProviderInstallationStatus,
  ProviderInstallationVerification,
} from "../provider-maintenance.js";

const execFileAsync = promisify(execFile);

const CLI_PROBE_TIMEOUT_MS = 5_000;
const INSTALLATION_CHECK_TIMEOUT_MS = 15_000;

export async function resolveExecutablePath(
  command: string,
): Promise<string | null> {
  if (path.isAbsolute(command)) {
    try {
      await access(command, fsConstants.X_OK);
      return command;
    } catch {
      return null;
    }
  }
  try {
    const lookup = process.platform === "win32" ? "where" : "which";
    const { stdout } = await execFileAsync(lookup, [command], {
      timeout: CLI_PROBE_TIMEOUT_MS,
    });
    return (
      stdout
        .split(/\r?\n/u)
        .find((line) => line.trim())
        ?.trim() ?? null
    );
  } catch {
    return null;
  }
}

export async function commandOutput(
  command: string,
  args: readonly string[],
): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(command, [...args], {
      timeout: INSTALLATION_CHECK_TIMEOUT_MS,
    });
    return `${stdout}\n${stderr}`.trim();
  } catch {
    return null;
  }
}

export function versionFrom(value: string | null): string | null {
  return (
    value?.match(/\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/u)?.[1] ?? null
  );
}

export async function readCliVersion(command: string): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(command, ["--version"], {
      timeout: CLI_PROBE_TIMEOUT_MS,
    });
    return (
      `${stdout}\n${stderr}`.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/u)?.[0] ??
      null
    );
  } catch {
    return null;
  }
}

export function compareVersions(left: string, right: string): number {
  const parse = (value: string) => {
    const match = value.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u);
    return match === null
      ? { core: [0, 0, 0], prerelease: null }
      : {
          core: [Number(match[1]), Number(match[2]), Number(match[3])],
          prerelease: match[4] ?? null,
        };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const delta = (a.core[index] ?? 0) - (b.core[index] ?? 0);
    if (delta !== 0) return delta;
  }
  if (a.prerelease === null && b.prerelease !== null) return 1;
  if (a.prerelease !== null && b.prerelease === null) return -1;
  if (a.prerelease !== null && b.prerelease !== null) {
    return a.prerelease.localeCompare(b.prerelease);
  }
  return 0;
}

export function npmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

export function formatCommand(
  command: string,
  args: readonly string[],
): string {
  return [command, ...args]
    .map((part) =>
      /^[A-Za-z0-9_./:@+-]+$/u.test(part)
        ? part
        : `'${part.replace(/'/gu, "'\\''")}'`,
    )
    .join(" ");
}

export function npmGlobalInstallCommand(
  npmPackage: string,
): ProviderInstallationCommand {
  const command = npmCommand();
  const args = ["install", "-g", `${npmPackage}@latest`];
  return { command, args, displayCommand: formatCommand(command, args) };
}

export async function npmLatestVersion(
  npmPackage: string,
): Promise<string | null> {
  return versionFrom(
    await commandOutput(npmCommand(), ["view", npmPackage, "version"]),
  );
}

export interface NpmGlobalPackageProbe {
  npmBin: string | null;
  npmGlobalPackageVersion: string | null;
}

export async function probeNpmGlobalPackage(
  npmPackage: string,
): Promise<NpmGlobalPackageProbe> {
  const npm = npmCommand();
  const [prefixOutput, listOutput] = await Promise.all([
    commandOutput(npm, ["prefix", "-g"]),
    commandOutput(npm, ["list", "-g", npmPackage, "--depth=0", "--json"]),
  ]);
  const npmPrefix = firstLine(prefixOutput);
  return {
    npmBin:
      npmPrefix === null
        ? null
        : process.platform === "win32"
          ? npmPrefix
          : path.join(npmPrefix, "bin"),
    npmGlobalPackageVersion: npmGlobalPackageVersion(listOutput, npmPackage),
  };
}

function firstLine(value: string | null): string | null {
  return (
    value
      ?.split(/\r?\n/u)
      .map((line) => line.trim())
      .find(Boolean) ?? null
  );
}

function npmGlobalPackageVersion(
  value: string | null,
  npmPackage: string,
): string | null {
  if (value === null) return null;
  try {
    const parsed = z
      .object({
        dependencies: z
          .record(z.string(), z.object({ version: z.string().min(1) }))
          .default({}),
      })
      .safeParse(JSON.parse(value));
    return parsed.success
      ? (parsed.data.dependencies[npmPackage]?.version ?? null)
      : null;
  } catch {
    return null;
  }
}

function pathIsInside(child: string, parent: string): boolean {
  const relativePath = path.relative(path.resolve(parent), path.resolve(child));
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

export function npmGlobalInstallSource(args: {
  installed: boolean;
  executablePath: string | null;
  npmBin: string | null;
}): ProviderInstallationSource {
  return !args.installed
    ? "notInstalled"
    : args.executablePath !== null &&
        args.npmBin !== null &&
        pathIsInside(args.executablePath, args.npmBin)
      ? "npmGlobal"
      : "external";
}

export function installationVerification(
  status: Pick<ProviderInstallationStatus, "currentVersion" | "latestVersion">,
  action: "install" | "update",
): ProviderInstallationVerification {
  return action === "install"
    ? { kind: "installed" }
    : status.latestVersion !== null
      ? { kind: "version_at_least", version: status.latestVersion }
      : {
          kind: "version_changed",
          previousVersion: status.currentVersion ?? "unknown",
        };
}

export function downloadedInstallerCommand(
  url: string,
): ProviderInstallationCommand {
  const script = [
    'tmp=$(mktemp "${TMPDIR:-/tmp}/provider-installation.XXXXXX")',
    "trap 'rm -f \"$tmp\"' EXIT",
    `curl -fsSL ${url} -o "$tmp"`,
    'bash "$tmp"',
  ].join(" && ");
  return { command: "sh", args: ["-c", script], displayCommand: script };
}

export function clampPercent(value: number): number {
  return Math.min(
    100,
    Math.max(0, Math.round(Number.isFinite(value) ? value : 0)),
  );
}
