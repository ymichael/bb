import { execFile, spawn } from "node:child_process";
import { existsSync as pathExistsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";
import type { ChildProcessByStdio } from "node:child_process";
import {
  bold, cyan, dim, green, yellow,
  log,
} from "../lib/script-helpers.js";

const DEFAULT_TMP_BB_PATTERN = "/tmp/bb-*";
const DEFAULT_ARCHIVE_CONCURRENCY = 25;
const DEFAULT_PROGRESS_INTERVAL = 100;
const ARCHIVE_TIMEOUT_MS = 5 * 60 * 1000;
const SQLITE_FIELD_SEPARATOR = "\u001f";
const MACOS_CODEX_BIN = "/Applications/Codex.app/Contents/Resources/codex";
const CODEX_STATE_DB_FILE_PATTERN = /^state_(\d+)\.sqlite$/;

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonObject
  | JsonValue[];

interface JsonObject {
  [key: string]: JsonValue;
}

interface ArchiveTmpBbSessionsOptions {
  codexBin: string;
  codexHome: string;
  concurrency: number;
  dryRun: boolean;
  pattern: string;
  yes: boolean;
}

interface ParseArchiveTmpBbSessionsArgsResult {
  help: boolean;
  options: ArchiveTmpBbSessionsOptions;
}

interface ParsedOptionValue {
  nextIndex: number;
  value: string;
}

interface ExecTextResult {
  stderr: string;
  stdout: string;
}

interface MatchingThreadPreview {
  cwd: string;
  id: string;
  updatedAt: string;
}

interface CodexStateDbCandidate {
  path: string;
  version: number;
}

interface ArchiveProgress {
  processed: number;
  total: number;
}

interface ArchiveThreadsViaAppServerArgs {
  codexBin: string;
  codexHome: string;
  concurrency: number;
  onProgress: (progress: ArchiveProgress) => void;
  onStderr: (chunk: string) => void;
  progressInterval: number;
  threadIds: string[];
  timeoutMs: number;
}

interface ArchiveFailure {
  message: string;
  threadId: string;
}

interface ArchiveThreadsViaAppServerResult {
  failed: number;
  failures: ArchiveFailure[];
  succeeded: number;
}

interface AppServerMessage {
  id?: string;
  method: string;
  params?: JsonValue;
}

interface AppServerError {
  message: string;
}

interface AppServerResponse {
  error?: AppServerError;
  id: string;
}

interface SettleState {
  settled: boolean;
}

function expandHomePath(pathValue: string, homeDirectory: string): string {
  if (pathValue === "~") {
    return homeDirectory;
  }

  if (pathValue.startsWith("~/")) {
    return join(homeDirectory, pathValue.slice(2));
  }

  return pathValue;
}

function resolvePathOption(pathValue: string, homeDirectory: string): string {
  return resolve(expandHomePath(pathValue, homeDirectory));
}

function resolveDefaultCodexHome(
  env: NodeJS.ProcessEnv,
  homeDirectory: string,
): string {
  const configuredHome = env.CODEX_HOME?.trim();
  if (configuredHome && configuredHome.length > 0) {
    return resolvePathOption(configuredHome, homeDirectory);
  }

  return join(homeDirectory, ".codex");
}

function resolveDefaultCodexBin(
  env: NodeJS.ProcessEnv,
  homeDirectory: string,
): string {
  const configuredBin = env.CODEX_BIN?.trim();
  if (configuredBin && configuredBin.length > 0) {
    return expandHomePath(configuredBin, homeDirectory);
  }

  if (pathExistsSync(MACOS_CODEX_BIN)) {
    return MACOS_CODEX_BIN;
  }

  return "codex";
}

function readOptionValue(
  argv: string[],
  index: number,
  optionName: string,
): ParsedOptionValue {
  const currentArg = argv[index] ?? "";
  const equalsPrefix = `${optionName}=`;
  if (currentArg.startsWith(equalsPrefix)) {
    const value = currentArg.slice(equalsPrefix.length);
    if (value.length === 0) {
      throw new Error(`Missing value for ${optionName}`);
    }
    return { nextIndex: index, value };
  }

  const nextValue = argv[index + 1];
  if (!nextValue || nextValue.startsWith("--")) {
    throw new Error(`Missing value for ${optionName}`);
  }

  return { nextIndex: index + 1, value: nextValue };
}

function parsePositiveInteger(value: string, optionName: string): number {
  const parsedValue = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsedValue) || parsedValue <= 0) {
    throw new Error(`${optionName} must be a positive integer`);
  }

  return parsedValue;
}

function parseCodexStateDbCandidate(
  codexHome: string,
  fileName: string,
): CodexStateDbCandidate | null {
  const match = CODEX_STATE_DB_FILE_PATTERN.exec(fileName);
  if (!match) {
    return null;
  }

  const versionText = match[1];
  if (!versionText) {
    return null;
  }

  const version = Number.parseInt(versionText, 10);
  if (!Number.isSafeInteger(version) || version <= 0) {
    return null;
  }

  return {
    path: join(codexHome, fileName),
    version,
  };
}

export function resolveCodexStateDbPath(codexHome: string): string {
  let fileNames: string[];
  try {
    fileNames = readdirSync(codexHome);
  } catch {
    throw new Error(`Codex home directory not found: ${codexHome}`);
  }

  const candidates = fileNames
    .map((fileName) => parseCodexStateDbCandidate(codexHome, fileName))
    .filter((candidate) => candidate !== null)
    .sort((left, right) => right.version - left.version);
  const candidate = candidates[0];

  if (!candidate) {
    throw new Error(`No Codex state DB found in ${codexHome}`);
  }

  return candidate.path;
}

export function parseArchiveTmpBbSessionsArgs(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = homedir(),
): ParseArchiveTmpBbSessionsArgsResult {
  const options: ArchiveTmpBbSessionsOptions = {
    codexBin: resolveDefaultCodexBin(env, homeDirectory),
    codexHome: resolveDefaultCodexHome(env, homeDirectory),
    concurrency: DEFAULT_ARCHIVE_CONCURRENCY,
    dryRun: false,
    pattern: DEFAULT_TMP_BB_PATTERN,
    yes: false,
  };

  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";

    if (arg === "--") {
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }

    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    if (arg === "--yes" || arg === "-y") {
      options.yes = true;
      continue;
    }

    if (arg === "--pattern" || arg.startsWith("--pattern=")) {
      const parsedOption = readOptionValue(argv, index, "--pattern");
      options.pattern = parsedOption.value;
      index = parsedOption.nextIndex;
      continue;
    }

    if (arg === "--codex-home" || arg.startsWith("--codex-home=")) {
      const parsedOption = readOptionValue(argv, index, "--codex-home");
      options.codexHome = resolvePathOption(parsedOption.value, homeDirectory);
      index = parsedOption.nextIndex;
      continue;
    }

    if (arg === "--codex-bin" || arg.startsWith("--codex-bin=")) {
      const parsedOption = readOptionValue(argv, index, "--codex-bin");
      options.codexBin = expandHomePath(parsedOption.value, homeDirectory);
      index = parsedOption.nextIndex;
      continue;
    }

    if (arg === "--concurrency" || arg.startsWith("--concurrency=")) {
      const parsedOption = readOptionValue(argv, index, "--concurrency");
      options.concurrency = parsePositiveInteger(
        parsedOption.value,
        "--concurrency",
      );
      index = parsedOption.nextIndex;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  return { help, options };
}

export function renderHelpText(): string {
  return `
  ${bold("codex archive tmp bb sessions")}

  ${dim("Usage")}
    pnpm codex:archive-tmp-bb-sessions -- [--dry-run] [--yes]

  ${dim("Options")}
    --dry-run             Show matching sessions without archiving
    --yes, -y             Skip the interactive confirmation prompt
    --pattern <glob>      SQLite GLOB for session cwd values ${dim("(default: /tmp/bb-*)")}
    --codex-home <path>   Codex home directory ${dim("(default: $CODEX_HOME or ~/.codex)")}
    --codex-bin <path>    Codex CLI binary ${dim("(default: $CODEX_BIN, Codex.app, or codex on PATH)")}
    --concurrency <n>     App-server archive request concurrency ${dim("(default: 25)")}

  ${dim("Notes")}
    Archives Codex threads whose recorded cwd matches the pattern.
    Creates a backup of the active state_<n>.sqlite DB before modifying anything.
    Uses Codex app-server's thread/archive API so rollout files move to archived_sessions.
\n`;
}

export function escapeSqlString(value: string): string {
  return value.replaceAll("'", "''");
}

function quotedSqlString(value: string): string {
  return `'${escapeSqlString(value)}'`;
}

function buildWhereClause(pattern: string): string {
  return `archived=0 AND cwd GLOB ${quotedSqlString(pattern)}`;
}

export function buildMatchingThreadIdsSql(pattern: string): string {
  return `SELECT id FROM threads WHERE ${buildWhereClause(pattern)} ORDER BY updated_at DESC;`;
}

export function buildMatchingThreadPreviewSql(pattern: string): string {
  const separator = quotedSqlString(SQLITE_FIELD_SEPARATOR);
  return [
    "SELECT id ||",
    separator,
    "|| datetime(updated_at,'unixepoch','localtime') ||",
    separator,
    "|| cwd FROM threads WHERE",
    buildWhereClause(pattern),
    "ORDER BY updated_at DESC LIMIT 10;",
  ].join(" ");
}

export function parseThreadPreviewRows(output: string): MatchingThreadPreview[] {
  const trimmedOutput = output.trim();
  if (trimmedOutput.length === 0) {
    return [];
  }

  return trimmedOutput.split("\n").map((line) => {
    const fields = line.split(SQLITE_FIELD_SEPARATOR);
    const id = fields[0];
    const updatedAt = fields[1];
    const cwd = fields[2];

    if (!id || !updatedAt || !cwd) {
      throw new Error(`Unexpected sqlite preview row: ${line}`);
    }

    return { cwd, id, updatedAt };
  });
}

function execFileText(command: string, args: string[]): Promise<ExecTextResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      command,
      args,
      { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          rejectPromise(error);
          return;
        }

        resolvePromise({ stderr, stdout });
      },
    );
  });
}

function buildBackupPath(dbPath: string): string {
  const timestamp = new Date()
    .toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(/\.\d{3}Z$/, "Z");
  return `${dbPath}.backup-${timestamp}-archive-tmp-bb`;
}

async function runSqlite(dbPath: string, sql: string): Promise<string> {
  const result = await execFileText("sqlite3", [dbPath, sql]);
  return result.stdout;
}

async function readMatchingThreadIds(
  dbPath: string,
  pattern: string,
): Promise<string[]> {
  const output = await runSqlite(dbPath, buildMatchingThreadIdsSql(pattern));
  const trimmedOutput = output.trim();
  if (trimmedOutput.length === 0) {
    return [];
  }

  return trimmedOutput.split("\n");
}

async function readMatchingThreadPreviews(
  dbPath: string,
  pattern: string,
): Promise<MatchingThreadPreview[]> {
  const output = await runSqlite(dbPath, buildMatchingThreadPreviewSql(pattern));
  return parseThreadPreviewRows(output);
}

async function backupCodexStateDb(dbPath: string): Promise<string> {
  const backupPath = buildBackupPath(dbPath);
  await runSqlite(dbPath, `.backup ${quotedSqlString(backupPath)}`);
  return backupPath;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAppServerError(value: JsonObject): AppServerError {
  const message = value.message;
  if (typeof message === "string") {
    return { message };
  }

  return { message: JSON.stringify(value) };
}

function parseAppServerResponse(line: string): AppServerResponse | null {
  const parsedValue: JsonValue = JSON.parse(line);
  if (!isJsonObject(parsedValue)) {
    return null;
  }

  const id = parsedValue.id;
  if (typeof id !== "string") {
    return null;
  }

  const error = parsedValue.error;
  if (isJsonObject(error)) {
    return { error: parseAppServerError(error), id };
  }

  return { id };
}

function settleArchivePromise(
  state: SettleState,
  child: ChildProcessByStdio<Writable, Readable, Readable>,
  settle: () => void,
): void {
  if (state.settled) {
    return;
  }

  state.settled = true;
  child.kill("SIGTERM");
  settle();
}

export function archiveThreadsViaAppServer(
  args: ArchiveThreadsViaAppServerArgs,
): Promise<ArchiveThreadsViaAppServerResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      args.codexBin,
      ["app-server", "--listen", "stdio://"],
      {
        env: {
          ...process.env,
          CODEX_HOME: args.codexHome,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const state: SettleState = { settled: false };
    const threadIds = args.threadIds;
    const inFlight = new Map<string, string>();
    const failures: ArchiveFailure[] = [];
    let completed = 0;
    let failed = 0;
    let initialized = false;
    let nextThreadIndex = 0;
    let requestId = 2;
    let stdoutBuffer = "";

    child.stdin?.setDefaultEncoding("utf8");

    const timeout = setTimeout(() => {
      settleArchivePromise(state, child, () => {
        rejectPromise(
          new Error(
            `Timed out after archiving ${completed} of ${threadIds.length}; ${failed} failed.`,
          ),
        );
      });
    }, args.timeoutMs);

    const send = (message: AppServerMessage): void => {
      if (!child.stdin) {
        throw new Error("Codex app-server stdin is not available.");
      }
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    const finishIfComplete = (): void => {
      if (completed + failed !== threadIds.length || inFlight.size > 0) {
        return;
      }

      clearTimeout(timeout);
      settleArchivePromise(state, child, () => {
        resolvePromise({
          failed,
          failures,
          succeeded: completed,
        });
      });
    };

    const sendArchiveRequests = (): void => {
      if (!initialized) {
        return;
      }

      while (
        inFlight.size < args.concurrency &&
        nextThreadIndex < threadIds.length
      ) {
        const threadId = threadIds[nextThreadIndex] ?? "";
        const archiveRequestId = String(requestId);
        requestId += 1;
        nextThreadIndex += 1;
        inFlight.set(archiveRequestId, threadId);
        send({
          id: archiveRequestId,
          method: "thread/archive",
          params: { threadId },
        });
      }

      finishIfComplete();
    };

    const reportProgress = (): void => {
      const processed = completed + failed;
      if (
        processed === threadIds.length ||
        processed % args.progressInterval === 0
      ) {
        args.onProgress({ processed, total: threadIds.length });
      }
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdoutBuffer += chunk.toString();
      let newlineIndex = stdoutBuffer.indexOf("\n");

      while (newlineIndex >= 0) {
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        newlineIndex = stdoutBuffer.indexOf("\n");

        if (line.length === 0) {
          continue;
        }

        const response = parseAppServerResponse(line);
        if (!response) {
          continue;
        }

        if (response.id === "1") {
          initialized = true;
          send({ method: "initialized" });
          sendArchiveRequests();
          continue;
        }

        const threadId = inFlight.get(response.id);
        if (!threadId) {
          continue;
        }

        inFlight.delete(response.id);
        if (response.error) {
          failed += 1;
          failures.push({ message: response.error.message, threadId });
        } else {
          completed += 1;
        }

        reportProgress();
        sendArchiveRequests();
      }
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      args.onStderr(chunk.toString());
    });

    child.once("error", (error) => {
      clearTimeout(timeout);
      settleArchivePromise(state, child, () => {
        rejectPromise(error);
      });
    });

    child.once("exit", (code, signal) => {
      if (state.settled) {
        return;
      }

      clearTimeout(timeout);
      rejectPromise(
        new Error(`Codex app-server exited early: code=${code ?? "null"} signal=${signal ?? "null"}`),
      );
    });

    send({
      id: "1",
      method: "initialize",
      params: {
        capabilities: { experimentalApi: true },
        clientInfo: {
          name: "archive-tmp-bb-sessions",
          title: "archive tmp bb sessions",
          version: "0",
        },
      },
    });
  });
}

async function confirmArchive(
  options: ArchiveTmpBbSessionsOptions,
  previews: MatchingThreadPreview[],
  total: number,
): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Interactive confirmation requires a TTY. Re-run with --yes to confirm.");
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    process.stdout.write("\n");
    log(yellow("!"), `This will archive ${bold(String(total))} Codex session(s) matching ${cyan(options.pattern)}.`);
    log(" ", `${dim("Codex home:")} ${options.codexHome}`);
    process.stdout.write("\n");
    for (const preview of previews) {
      log(" ", `${dim(preview.updatedAt)}  ${preview.id}  ${dim(preview.cwd)}`);
    }
    if (total > previews.length) {
      log(" ", dim(`...and ${total - previews.length} more`));
    }
    process.stdout.write("\n");
    const answer = await rl.question(`  ${dim("?")}  Type ${bold('"archive"')} to continue: `);
    return answer.trim() === "archive";
  } finally {
    rl.close();
  }
}

function ensureCodexStateDbExists(dbPath: string): void {
  if (!pathExistsSync(dbPath)) {
    throw new Error(`Codex state DB not found: ${dbPath}`);
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const parsedArgs = parseArchiveTmpBbSessionsArgs(argv);
  if (parsedArgs.help) {
    process.stdout.write(renderHelpText());
    return;
  }

  const options = parsedArgs.options;
  const dbPath = resolveCodexStateDbPath(options.codexHome);
  ensureCodexStateDbExists(dbPath);

  process.stdout.write(`\n  ${bold("codex archive tmp bb sessions")}\n\n`);

  const threadIds = await readMatchingThreadIds(dbPath, options.pattern);
  const previews = await readMatchingThreadPreviews(dbPath, options.pattern);

  if (threadIds.length === 0) {
    log(green("●"), `No unarchived Codex sessions matched ${cyan(options.pattern)}`);
    process.stdout.write("\n");
    return;
  }

  log(dim("●"), `Found ${bold(String(threadIds.length))} unarchived Codex session(s) matching ${cyan(options.pattern)}`);

  if (options.dryRun) {
    for (const preview of previews) {
      log(" ", `${dim(preview.updatedAt)}  ${preview.id}  ${dim(preview.cwd)}`);
    }
    if (threadIds.length > previews.length) {
      log(" ", dim(`...and ${threadIds.length - previews.length} more`));
    }
    process.stdout.write("\n");
    return;
  }

  const proceed = options.yes
    ? true
    : await confirmArchive(options, previews, threadIds.length);
  if (!proceed) {
    process.stdout.write("\n");
    log(dim("●"), "Archive cancelled");
    process.stdout.write("\n");
    return;
  }

  const backupPath = await backupCodexStateDb(dbPath);
  log(green("✓"), `Backed up ${cyan(dbPath)} to ${cyan(backupPath)}`);

  const archiveResult = await archiveThreadsViaAppServer({
    codexBin: options.codexBin,
    codexHome: options.codexHome,
    concurrency: options.concurrency,
    onProgress(progress) {
      log(dim("●"), `Archived ${progress.processed}/${progress.total}`);
    },
    onStderr(chunk) {
      const trimmedChunk = chunk.trim();
      if (trimmedChunk.length > 0) {
        process.stderr.write(`${trimmedChunk}\n`);
      }
    },
    progressInterval: DEFAULT_PROGRESS_INTERVAL,
    threadIds,
    timeoutMs: ARCHIVE_TIMEOUT_MS,
  });

  if (archiveResult.failed > 0) {
    process.stdout.write("\n");
    for (const failure of archiveResult.failures.slice(0, 10)) {
      log(yellow("!"), `${failure.threadId}: ${failure.message}`);
    }
    if (archiveResult.failures.length > 10) {
      log(yellow("!"), `${archiveResult.failures.length - 10} additional failure(s) omitted`);
    }
    throw new Error(
      `Archived ${archiveResult.succeeded} session(s), ${archiveResult.failed} failed.`,
    );
  }

  process.stdout.write("\n");
  log(green("●"), `Archived ${bold(String(archiveResult.succeeded))} Codex session(s)`);
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
