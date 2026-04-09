import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  bold, cyan, dim, green, yellow,
  log, endStep,
} from "../lib/script-helpers.js";
import {
  DEFAULTS,
  resolveDataDir as resolveConfiguredDataDir,
  resolveModeFromNodeEnvironment,
} from "@bb/config/runtime";

type HostMode = "dev" | "prod";

interface NamedDataDirs {
  defaultDataDir: string;
  defaultDevDaemonDataDir: string;
  defaultDevDataDir: string;
}

function resolveMode(): HostMode {
  return resolveModeFromNodeEnvironment() === "development" ? "dev" : "prod";
}

function resolveNamedDataDirs(): NamedDataDirs {
  return {
    defaultDataDir: resolveConfiguredDataDir({ defaultDirName: DEFAULTS.dataDir.prod }),
    defaultDevDaemonDataDir: resolveConfiguredDataDir({
      defaultDirName: `${DEFAULTS.dataDir.dev}-host-daemon`,
    }),
    defaultDevDataDir: resolveConfiguredDataDir({ defaultDirName: DEFAULTS.dataDir.dev }),
  };
}

export function resolveResetDataDir(mode: HostMode): string {
  const dataDirs = resolveNamedDataDirs();
  return mode === "dev" ? dataDirs.defaultDevDataDir : dataDirs.defaultDataDir;
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map((pathValue) => resolve(pathValue)))];
}

export function resolveResetTargets(args: Set<string>): string[] {
  const dataDirs = resolveNamedDataDirs();
  const mode = resolveMode();

  if (args.has("--all")) {
    return uniquePaths([
      dataDirs.defaultDataDir,
      dataDirs.defaultDevDataDir,
      dataDirs.defaultDevDaemonDataDir,
      resolveResetDataDir(mode),
    ]);
  }

  return [resolveResetDataDir(mode)];
}

function ensureSafeTargets(targets: string[]): void {
  const home = resolve(homedir());
  for (const target of targets) {
    if (!isAbsolute(target)) {
      throw new Error(`Refusing to remove non-absolute path: ${target}`);
    }
    if (target === "/" || target === home || target.length < home.length + 2) {
      throw new Error(`Refusing to remove unsafe path: ${target}`);
    }
  }
}

export function renderHelpText(): string {
  return `
  ${bold("bb reset")}

  ${dim("Usage")}
    pnpm reset -- [--all] [--yes]

  ${dim("Options")}
    --all   Remove prod, dev, and dev daemon data directories
    --yes   Skip the interactive confirmation prompt

  ${dim("Notes")}
    Removes bb-managed state directories (${dim("~/.bb")}, ${dim("~/.bb-dev")}, ${dim("~/.bb-dev-host-daemon")}).
    Does not touch provider auth/config managed by other tools.
    Respects BB_DATA_DIR for single-directory resets.
\n`;
}

async function confirmReset(targets: string[]): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Interactive confirmation requires a TTY. Re-run with --yes to confirm.");
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    process.stdout.write("\n");
    log(yellow("!"), "This will permanently delete bb-managed local data at:");
    for (const target of targets) {
      log(" ", dim(target));
    }
    process.stdout.write("\n");
    log(" ", dim("Provider auth/config managed outside bb will be left untouched."));
    process.stdout.write("\n");
    const answer = await rl.question(`  ${dim("?")}  Type ${bold('"reset"')} to continue: `);
    return answer.trim() === "reset";
  } finally {
    rl.close();
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = new Set(argv);

  if (args.has("--help") || args.has("-h")) {
    process.stdout.write(renderHelpText());
    return;
  }

  process.stdout.write(`\n  ${bold("bb reset")}\n`);

  const targets = resolveResetTargets(args);
  ensureSafeTargets(targets);

  const proceed = args.has("--yes") ? true : await confirmReset(targets);
  if (!proceed) {
    process.stdout.write("\n");
    log(dim("●"), "Reset cancelled");
    process.stdout.write("\n");
    return;
  }

  process.stdout.write("\n");

  let removedCount = 0;
  for (const target of targets) {
    if (!existsSync(target)) {
      endStep(dim("–"), `${dim("skip")}  ${target} ${dim("(not found)")}`);
      continue;
    }
    rmSync(target, { force: true, maxRetries: 3, recursive: true, retryDelay: 100 });
    endStep(green("✓"), `${cyan(target)}`);
    removedCount += 1;
  }

  process.stdout.write("\n");

  if (removedCount === 0) {
    log(dim("●"), "No bb-managed data directories were present");
  } else {
    log(green("●"), bold("Reset complete"));
  }

  process.stdout.write("\n");
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
