import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import readline from "node:readline/promises";
import { DEFAULTS } from "../packages/config/dist/defaults.js";
import {
  bold, cyan, dim, green, yellow,
  log, endStep,
} from "./lib/script-helpers.mjs";

const defaultDataDir = resolve(homedir(), DEFAULTS.dataDir.prod);
const defaultDevDataDir = resolve(homedir(), DEFAULTS.dataDir.dev);
const defaultDevDaemonDataDir = resolve(homedir(), `${DEFAULTS.dataDir.dev}-host-daemon`);

function resolveDataDir() {
  const preferred = process.env.BB_DATA_DIR?.trim();
  if (preferred) {
    return resolve(preferred.startsWith("~/")
      ? resolve(homedir(), preferred.slice(2))
      : preferred);
  }
  return defaultDataDir;
}

function uniquePaths(paths) {
  return [...new Set(paths.map((path) => resolve(path)))];
}

function ensureSafeTargets(targets) {
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

async function confirmReset(targets) {
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

async function main() {
  const args = new Set(process.argv.slice(2));

  if (args.has("--help") || args.has("-h")) {
    process.stdout.write(`
  ${bold("bb reset")}

  ${dim("Usage")}
    node scripts/reset-bb-data.mjs [--all] [--yes]

  ${dim("Options")}
    --all   Remove prod, dev, and dev daemon data directories
    --yes   Skip the interactive confirmation prompt

  ${dim("Notes")}
    Removes bb-managed state directories (${dim("~/.bb")}, ${dim("~/.bb-dev")}, ${dim("~/.bb-dev-host-daemon")}).
    Does not touch provider auth/config managed by other tools.
    Respects BB_DATA_DIR for single-directory resets.
\n`);
    return;
  }

  process.stdout.write(`\n  ${bold("bb reset")}\n`);

  const targets = args.has("--all")
    ? uniquePaths([defaultDataDir, defaultDevDataDir, defaultDevDaemonDataDir, resolveDataDir()])
    : [resolveDataDir()];

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
    rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
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

void main().catch((error) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
