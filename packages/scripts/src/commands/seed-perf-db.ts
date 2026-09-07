import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection, migrate } from "@bb/db";
import {
  resolveCurrentDevInstanceConfig,
  resolveDataDirDatabasePath,
  resolveProdDataDir,
} from "@bb/config/runtime";
import { HOST_ID_FILE_NAME } from "@bb/host-daemon-contract";
import { seedPerfFixture } from "../lib/seed-perf-fixture.js";
import { bold, cyan, dim, green, log, endStep } from "../lib/script-helpers.js";

const commandDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(commandDir, "..", "..", "..", "..");

interface SeedCommandArgs {
  dataDir: string | null;
  eventCount: number;
  projectCount: number;
  randomSeed: number;
  reset: boolean;
  threadCount: number;
}

function renderHelpText(): string {
  return `
  ${bold("bb seed-perf-db")}

  Seed a large, realistic BB database for performance testing.

  ${dim("Usage")}
    pnpm seed:perf [-- options]

  ${dim("Options")}
    --data-dir <path>  Target data dir (default: this checkout's dev data dir)
    --projects <n>     Project count (default: 12)
    --threads <n>      Thread count (default: 1200)
    --events <n>       Approximate total event rows (default: 400000)
    --seed <n>         Deterministic random seed (default: 1)
    --reset            Delete the existing database file before seeding

  ${dim("Notes")}
    The command refuses to touch the production data dir (~/.bb).
    Without --reset the fixture is added to the existing database.
    Start the dev app once before seeding so the fixture attaches to
    the real local host; otherwise a synthetic offline host is used.
\n`;
}

function parsePositiveInteger(name: string, rawValue: string): number {
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function parseArgs(argv: string[]): SeedCommandArgs | null {
  const args: SeedCommandArgs = {
    dataDir: null,
    eventCount: 400_000,
    projectCount: 12,
    randomSeed: 1,
    reset: false,
    threadCount: 1_200,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const readValue = (): string => {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error(`${argument} requires a value`);
      }
      index += 1;
      return value;
    };
    switch (argument) {
      case "--":
        break;
      case "--help":
      case "-h":
        return null;
      case "--data-dir":
        args.dataDir = resolve(readValue());
        break;
      case "--projects":
        args.projectCount = parsePositiveInteger("--projects", readValue());
        break;
      case "--threads":
        args.threadCount = parsePositiveInteger("--threads", readValue());
        break;
      case "--events":
        args.eventCount = parsePositiveInteger("--events", readValue());
        break;
      case "--seed":
        args.randomSeed = parsePositiveInteger("--seed", readValue());
        break;
      case "--reset":
        args.reset = true;
        break;
      default:
        throw new Error(`Unknown option: ${argument}`);
    }
  }
  return args;
}

function resolveTargetDataDir(args: SeedCommandArgs): string {
  if (args.dataDir !== null) {
    return args.dataDir;
  }
  return resolveCurrentDevInstanceConfig(repoRoot).dataDir;
}

function readSeedHostId(dataDir: string): string {
  const hostIdPath = join(dataDir, HOST_ID_FILE_NAME);
  if (existsSync(hostIdPath)) {
    const hostId = readFileSync(hostIdPath, "utf8").trim();
    if (hostId.length > 0) {
      return hostId;
    }
  }
  return "host_seedfixture";
}

async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  if (args === null) {
    process.stdout.write(renderHelpText());
    return;
  }

  const dataDir = resolveTargetDataDir(args);
  const prodDataDir = resolveProdDataDir({ homeDir: homedir() });
  if (resolve(dataDir) === resolve(prodDataDir)) {
    throw new Error(
      `Refusing to seed the production data dir (${prodDataDir}). Pass a dev data dir with --data-dir.`,
    );
  }

  process.stdout.write(`\n  ${bold("bb seed-perf-db")}\n\n`);
  log(dim("●"), `data dir ${cyan(dataDir)}`);

  mkdirSync(dataDir, { recursive: true });
  const databasePath = resolveDataDirDatabasePath({ dataDir });
  if (args.reset) {
    for (const suffix of ["", "-shm", "-wal"]) {
      rmSync(`${databasePath}${suffix}`, { force: true });
    }
    rmSync(join(dataDir, "auth.json"), { force: true });
    log(dim("●"), "removed the existing database file and host credentials");
  }

  const hostId = readSeedHostId(dataDir);
  log(dim("●"), `host ${cyan(hostId)}`);

  const startedAt = Date.now();
  const db = createConnection(databasePath);
  try {
    migrate(db);
    const result = seedPerfFixture(db, {
      hostId,
      workspacesRootPath: join(dataDir, "seed-workspaces"),
      projectCount: args.projectCount,
      threadCount: args.threadCount,
      eventCount: args.eventCount,
      randomSeed: args.randomSeed,
      onProgress: (message) => log(dim("○"), dim(message)),
    });
    db.$client.pragma("wal_checkpoint(TRUNCATE)");
    for (const workspacePath of result.projectWorkspacePaths) {
      if (existsSync(join(workspacePath, ".git"))) {
        continue;
      }
      mkdirSync(workspacePath, { recursive: true });
      try {
        execFileSync("git", ["init", "--quiet", "--initial-branch=main"], {
          cwd: workspacePath,
          stdio: "ignore",
        });
      } catch {
        log(dim("●"), `git init failed for ${workspacePath}; left a plain dir`);
      }
    }
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    endStep(
      green("✓"),
      `seeded ${bold(String(result.projectIds.length))} projects, ${bold(
        String(result.threadIds.length),
      )} threads, ${bold(String(result.eventRowCount))} events in ${seconds}s`,
    );
    log(
      dim("●"),
      `search segments: ${result.searchSegmentRowCount}, prompt history: ${result.promptHistoryRowCount}`,
    );
    process.stdout.write("\n");
  } finally {
    db.$client.close();
  }
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
