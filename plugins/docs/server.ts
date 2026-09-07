import { watch } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseMarkdownDocument } from "./markdown-document.js";
import {
  defineRpcContract,
  type BbPluginApi,
  type PluginCliContext,
  type PluginRpcHandlers,
} from "@get-bb/plugin-sdk";
import { z } from "zod";

const DEFAULT_DIR = "~/Notes";
const PREVIEW_LENGTH = 100;
const MAX_TREE_ENTRIES = 5_000;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const SYNC_STATE_FILE = ".bb-docs-state.json";
const SYNC_STATE_VERSION = 1;

class CliUsageError extends Error {}

const DOCS_CLI_USAGE =
  "Usage: bb docs <vaults|vault-add|vault-remove|list|read|pull|status|push|write|mkdir|move|remove>";
const DOCS_STATUS_USAGE =
  "bb docs status [workspace-dir] [--delete] [--diff] [--workspace-host <id>] [--json]";
const DOCS_STATUS_HELP = [
  `Usage: ${DOCS_STATUS_USAGE}`,
  "",
  "Exit 0: no changes.",
  "Exit 1: the status operation failed.",
  "Exit 2: the command usage is not valid.",
  "Exit 3: local and remote changes conflict.",
  "Exit 4: changes present.",
  "",
  "Exit 4 is a successful status result. Review the output, then run bb docs push separately.",
].join("\n");

const CLI_OPTIONS_BY_COMMAND: Record<string, ReadonlySet<string>> = {
  vaults: new Set(["--json"]),
  "vault-add": new Set(["--json"]),
  "vault-remove": new Set(["--json"]),
  list: new Set(["--vault", "--json"]),
  read: new Set(["--vault", "--json"]),
  pull: new Set([
    "--vault",
    "--into",
    "--workspace-host",
    "--json",
    "--all",
    "--folder",
  ]),
  status: new Set([
    "--vault",
    "--workspace-host",
    "--json",
    "--delete",
    "--diff",
  ]),
  push: new Set([
    "--vault",
    "--workspace-host",
    "--json",
    "--delete",
    "--dry-run",
    "--diff",
  ]),
  write: new Set(["--vault", "--content", "--json"]),
  mkdir: new Set(["--vault", "--json"]),
  move: new Set(["--vault", "--json"]),
  remove: new Set(["--vault", "--recursive", "--json"]),
};

interface VaultWatcher {
  close(): void;
  on(event: "error", listener: () => void): void;
}

type WatchVault = (rootPath: string, onChange: () => void) => VaultWatcher;

const watchNativeVault: WatchVault = (rootPath, onChange) => {
  const watcher = watch(rootPath, { recursive: true }, onChange);
  return {
    close: () => watcher.close(),
    on: (event, listener) => {
      watcher.on(event, listener);
    },
  };
};

interface VaultEntry {
  kind: "file" | "directory";
  path: string;
}

interface NoteSummary {
  path: string;
  title: string;
  preview: string;
  modifiedAtMs: number;
}

interface ResolvedOpenerFile {
  path: string;
  rootPath: string;
  hostId: string | null;
}

const vaultIdSchema = z.string().min(1).optional();
const vaultSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    hostId: z.string().min(1).nullable(),
    rootPath: z.string().min(1),
  })
  .strict();
const vaultPathSchema = z.string().transform((value, context) => {
  try {
    return requireVaultPath(value);
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : String(error),
    });
    return z.NEVER;
  }
});
const vaultDirectorySchema = z
  .union([z.literal(""), vaultPathSchema])
  .optional();
const openerSourceSchema = z
  .object({
    kind: z.enum(["workspace", "host", "thread-storage"]),
    threadId: z.string().nullable(),
    environmentId: z.string().nullable(),
    projectId: z.string().nullable(),
    experimental_hostId: z.string().min(1).optional(),
  })
  .strict();
const fileReadSchema = z
  .object({
    path: z.string(),
    content: z.string(),
    contentEncoding: z.enum(["base64", "utf8"]),
    mimeType: z.string().optional(),
    sizeBytes: z.number().int().nonnegative(),
    modifiedAtMs: z.number().nonnegative().optional(),
    sha256: z.string(),
  })
  .strict();
const fileWriteSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("written"),
      sha256: z.string(),
      sizeBytes: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("conflict"),
      currentSha256: z.string().nullable(),
    })
    .strict(),
]);
const previewSchema = z
  .object({
    baseUrl: z.string().min(1),
    expiresAtMs: z.number().nonnegative(),
  })
  .strict();
const hostSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    type: z.literal("persistent"),
    status: z.enum(["connected", "disconnected"]),
    maxPermissionMode: z.enum(["full", "auto", "accept-edits"]),
    lastSeenAt: z.number().nullable(),
    lastRejectedProtocolVersion: z.number().int().positive().nullable(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .strict();
const pathResultSchema = z.object({ path: z.string().min(1) }).strict();
const okResultSchema = z.object({ ok: z.literal(true) }).strict();
const syncScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all") }).strict(),
  z.object({ kind: z.literal("file"), path: vaultPathSchema }).strict(),
  z.object({ kind: z.literal("folder"), path: vaultPathSchema }).strict(),
]);
const syncStateEntrySchema = z
  .object({
    remotePath: vaultPathSchema,
    localPath: vaultPathSchema,
    sha256: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
    contentEncoding: z.enum(["base64", "utf8"]),
    mimeType: z.string().nullable(),
    modifiedAtMs: z.number().nonnegative().nullable(),
  })
  .strict();
const syncStateSchema = z
  .object({
    schemaVersion: z.literal(SYNC_STATE_VERSION),
    vault: z
      .object({ id: z.string().min(1), name: z.string().min(1) })
      .strict(),
    scope: syncScopeSchema,
    pulledAt: z.iso.datetime(),
    entries: z.array(syncStateEntrySchema).max(MAX_TREE_ENTRIES),
    directories: z.array(vaultPathSchema).max(MAX_TREE_ENTRIES),
  })
  .strict();
const syncSnapshotEntrySchema = syncStateEntrySchema.extend({
  content: z.string(),
});
const syncWriteSchema = z
  .object({
    path: vaultPathSchema,
    content: z.string(),
    contentEncoding: z.enum(["base64", "utf8"]),
    expectedSha256: z.string().nullable(),
  })
  .strict();
const syncDeleteSchema = z
  .object({ path: vaultPathSchema, expectedSha256: z.string().min(1) })
  .strict();

type Vault = z.infer<typeof vaultSchema>;
type SyncScope = z.infer<typeof syncScopeSchema>;
type SyncStateEntry = z.infer<typeof syncStateEntrySchema>;
type SyncState = z.infer<typeof syncStateSchema>;
type SyncFile = z.infer<typeof syncSnapshotEntrySchema>;
type OpenerSource = z.infer<typeof openerSourceSchema>;

export const docsRpcContract = defineRpcContract({
  syncSnapshot: {
    input: z
      .object({ vaultId: vaultIdSchema, scope: syncScopeSchema })
      .strict(),
    output: z
      .object({
        vault: vaultSchema,
        scope: syncScopeSchema,
        files: z.array(syncSnapshotEntrySchema),
        directories: z.array(vaultPathSchema),
      })
      .strict(),
  },
  syncApply: {
    input: z
      .object({
        vaultId: vaultIdSchema,
        writes: z.array(syncWriteSchema).max(MAX_TREE_ENTRIES),
        deletes: z.array(syncDeleteSchema).max(MAX_TREE_ENTRIES),
        directories: z.array(vaultPathSchema).max(MAX_TREE_ENTRIES),
        deleteDirectories: z.array(vaultPathSchema).max(MAX_TREE_ENTRIES),
        dryRun: z.boolean(),
      })
      .strict(),
    output: z
      .object({
        outcome: z.enum(["applied", "conflict", "partial"]),
        written: z.array(syncStateEntrySchema),
        deleted: z.array(vaultPathSchema),
        createdDirectories: z.array(vaultPathSchema),
        deletedDirectories: z.array(vaultPathSchema),
        conflicts: z.array(
          z
            .object({
              path: vaultPathSchema,
              expectedSha256: z.string().nullable(),
              currentSha256: z.string().nullable(),
            })
            .strict(),
        ),
        errors: z.array(
          z.object({ path: z.string(), message: z.string() }).strict(),
        ),
      })
      .strict(),
  },
  listNotes: {
    input: z.object({ vaultId: vaultIdSchema }).strict(),
    output: z
      .object({
        vaults: z.array(vaultSchema),
        vault: vaultSchema,
        hosts: z.array(hostSchema),
        entries: z.array(
          z
            .object({
              kind: z.enum(["file", "directory"]),
              path: z.string(),
            })
            .strict(),
        ),
        entryOrder: z.array(z.string()),
        notes: z.array(
          z
            .object({
              path: z.string(),
              title: z.string(),
              preview: z.string(),
              modifiedAtMs: z.number().nonnegative(),
            })
            .strict(),
        ),
        truncated: z.boolean(),
        error: z.string().nullable(),
      })
      .strict(),
  },
  readNote: {
    input: z.object({ vaultId: vaultIdSchema, path: vaultPathSchema }).strict(),
    output: fileReadSchema,
  },
  saveNote: {
    input: z
      .object({
        vaultId: vaultIdSchema,
        path: vaultPathSchema,
        content: z.string(),
        expectedSha256: z.string().nullable().optional(),
      })
      .strict(),
    output: fileWriteSchema,
  },
  createNote: {
    input: z
      .object({
        vaultId: vaultIdSchema,
        parent: vaultDirectorySchema,
        name: z.string().optional(),
        content: z.string().optional(),
      })
      .strict(),
    output: pathResultSchema,
  },
  deletePath: {
    input: z
      .object({
        vaultId: vaultIdSchema,
        path: vaultPathSchema,
        recursive: z.boolean().optional(),
      })
      .strict(),
    output: okResultSchema,
  },
  createFolder: {
    input: z.object({ vaultId: vaultIdSchema, path: vaultPathSchema }).strict(),
    output: pathResultSchema,
  },
  reorderFiles: {
    input: z
      .object({
        vaultId: vaultIdSchema,
        parent: vaultDirectorySchema,
        paths: z.array(vaultPathSchema),
      })
      .strict(),
    output: z.object({ paths: z.array(vaultPathSchema) }).strict(),
  },
  movePath: {
    input: z
      .object({
        vaultId: vaultIdSchema,
        from: vaultPathSchema,
        to: vaultPathSchema,
      })
      .strict(),
    output: pathResultSchema,
  },
  renameToTitle: {
    input: z.object({ vaultId: vaultIdSchema, path: vaultPathSchema }).strict(),
    output: pathResultSchema,
  },
  createVault: {
    input: z
      .object({
        name: z.string().min(1),
        rootPath: z.string().min(1),
        hostId: z.string().min(1).optional(),
      })
      .strict(),
    output: vaultSchema,
  },
  removeVault: {
    input: z.object({ vaultId: z.string().min(1) }).strict(),
    output: okResultSchema,
  },
  uploadAttachment: {
    input: z
      .object({
        vaultId: vaultIdSchema,
        notePath: vaultPathSchema,
        content: z.string().min(1),
        name: z.string().min(1),
      })
      .strict(),
    output: z
      .object({
        path: z.string().min(1),
        markdownPath: z.string().min(1),
        result: fileWriteSchema,
      })
      .strict(),
  },
  preparePreview: {
    input: z.object({ vaultId: vaultIdSchema, path: vaultPathSchema }).strict(),
    output: previewSchema,
  },
  openFile: {
    input: z
      .object({ source: openerSourceSchema, path: z.string().min(1) })
      .strict(),
    output: z
      .object({
        file: fileReadSchema,
        preview: previewSchema,
        previewPath: z.string(),
      })
      .strict(),
  },
  saveOpenedFile: {
    input: z
      .object({
        source: openerSourceSchema,
        path: z.string().min(1),
        content: z.string(),
        expectedSha256: z.string().nullable().optional(),
      })
      .strict(),
    output: fileWriteSchema,
  },
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected an object");
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`"${field}" must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function expandHome(rawPath: string): string {
  if (rawPath === "~") return os.homedir();
  if (rawPath.startsWith("~/"))
    return path.join(os.homedir(), rawPath.slice(2));
  return rawPath;
}

function requireVaultPath(
  value: unknown,
  options?: { extension?: string },
): string {
  const raw = requireString(value, "path").replace(/\\/g, "/");
  if (raw.startsWith("/") || /^[a-zA-Z]:\//.test(raw) || raw.includes("\0")) {
    throw new Error(`Invalid vault path: ${raw}`);
  }
  const segments = raw.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.startsWith("."),
    )
  ) {
    throw new Error(`Invalid vault path: ${raw}`);
  }
  const normalized = path.posix.normalize(raw);
  if (
    options?.extension &&
    !normalized.toLowerCase().endsWith(options.extension)
  ) {
    throw new Error(`Path must end with ${options.extension}: ${normalized}`);
  }
  return normalized;
}

function requireOptionalDirectory(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  return requireVaultPath(value);
}

function requireThreadStoragePath(value: unknown): string {
  const raw = requireString(value, "path").replace(/\\/g, "/");
  if (
    path.posix.isAbsolute(raw) ||
    path.win32.isAbsolute(raw) ||
    raw.includes("\0") ||
    raw.split("/").includes("..")
  ) {
    throw new Error(`Invalid thread-storage path: ${raw}`);
  }
  return path.posix.normalize(raw);
}

function absolutePath(vault: Vault, relativePath: string): string {
  const parts = relativePath.split("/");
  return /^[a-zA-Z]:[\\/]/.test(vault.rootPath) ||
    vault.rootPath.startsWith("\\\\")
    ? path.win32.join(vault.rootPath, ...parts)
    : path.posix.join(vault.rootPath, ...parts);
}

function isAbsoluteHostPath(value: string): boolean {
  return path.posix.isAbsolute(value) || path.win32.isAbsolute(value);
}

function normalizeHostRoot(value: string): string {
  return path.win32.isAbsolute(value) && !path.posix.isAbsolute(value)
    ? path.win32.normalize(value)
    : path.posix.normalize(value);
}

function hostArgs(vault: Vault): { hostId?: string } {
  return vault.hostId ? { hostId: vault.hostId } : {};
}

function cleanLine(line: string): string {
  return line
    .replace(/^\s*#{1,6}\s+/, "")
    .replace(/^\s*>\s?/, "")
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/^\[[ xX]\]\s*/, "")
    .trim();
}

function markdownHeadingLevel(line: string): number | null {
  const match = line.match(/^\s{0,3}(#{1,6})(?:[\t ]+|$)/);
  return match ? match[1]!.length : null;
}

function summarizeMarkdown(
  content: string,
  fallback: string,
): { title: string; preview: string } {
  const document = parseMarkdownDocument(content);
  const lines = document.body.split("\n");
  const cleanedLines = lines.map(cleanLine);
  const firstContentIndex = cleanedLines.findIndex(
    (line) => line && !line.startsWith("::html{"),
  );
  const documentHeadingIndex = document.frontmatter
    ? lines.findIndex((line) => markdownHeadingLevel(line) === 1)
    : -1;
  const titleLineIndex = document.title
    ? -1
    : documentHeadingIndex >= 0
      ? documentHeadingIndex
      : firstContentIndex;
  const title = (
    document.title ??
    (titleLineIndex >= 0 ? cleanedLines[titleLineIndex] : null) ??
    fallback
  ).slice(0, 120);
  const firstHeadingIndex = lines.findIndex(
    (line) => markdownHeadingLevel(line) !== null,
  );
  const previewHeadingIndex =
    titleLineIndex >= 0
      ? titleLineIndex
      : firstHeadingIndex >= 0 && cleanedLines[firstHeadingIndex] === title
        ? firstHeadingIndex
        : -1;
  const preview = cleanedLines
    .filter(
      (line, index) =>
        index !== previewHeadingIndex &&
        line &&
        line !== title &&
        !line.startsWith("::html{"),
    )
    .join(" ")
    .slice(0, PREVIEW_LENGTH);
  return { title, preview };
}

function deriveTitle(content: string, fallback: string): string {
  return summarizeMarkdown(content, fallback).title;
}

function kebabCase(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
}

function sanitizeName(raw: string): string {
  return raw
    .replace(/\.(md|html?)$/i, "")
    .replace(/[/\\:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function parseVaultRow(value: unknown): Vault {
  const row = requireRecord(value);
  return {
    id: requireString(row.id, "id"),
    name: requireString(row.name, "name"),
    hostId: typeof row.host_id === "string" && row.host_id ? row.host_id : null,
    rootPath: requireString(row.root_path, "root_path"),
  };
}

function parseCli(argv: string[]): {
  command: string;
  positionals: string[];
  vaultId?: string;
  content?: string;
  into?: string;
  workspaceHostId?: string;
  recursive: boolean;
  json: boolean;
  all: boolean;
  folder: boolean;
  delete: boolean;
  dryRun: boolean;
  diff: boolean;
} {
  const command = argv[0] ?? "help";
  const allowedOptions = CLI_OPTIONS_BY_COMMAND[command];
  const positionals: string[] = [];
  let vaultId: string | undefined;
  let content: string | undefined;
  let recursive = false;
  let json = false;
  let all = false;
  let folder = false;
  let deleteFiles = false;
  let dryRun = false;
  let diff = false;
  let into: string | undefined;
  let workspaceHostId: string | undefined;
  const nextValue = (flag: string, index: number): string => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new CliUsageError(`${flag} requires a value`);
    }
    return value;
  };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg.startsWith("--") && allowedOptions && !allowedOptions.has(arg)) {
      throw new CliUsageError(`${arg} is not valid for bb docs ${command}`);
    }
    if (arg === "--vault") vaultId = nextValue(arg, index++);
    else if (arg === "--content") content = nextValue(arg, index++);
    else if (arg === "--into") into = nextValue(arg, index++);
    else if (arg === "--workspace-host")
      workspaceHostId = nextValue(arg, index++);
    else if (arg === "--recursive") recursive = true;
    else if (arg === "--json") json = true;
    else if (arg === "--all") all = true;
    else if (arg === "--folder") folder = true;
    else if (arg === "--delete") deleteFiles = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--diff") diff = true;
    else if (arg.startsWith("--"))
      throw new CliUsageError(`Unknown option: ${arg}`);
    else positionals.push(arg);
  }
  return {
    command,
    positionals,
    vaultId,
    content,
    into,
    workspaceHostId,
    recursive,
    json,
    all,
    folder,
    delete: deleteFiles,
    dryRun,
    diff,
  };
}

function validateCliPositionals(args: ReturnType<typeof parseCli>): void {
  const expected: Record<string, { minimum: number; maximum: number }> = {
    vaults: { minimum: 0, maximum: 0 },
    "vault-add": { minimum: 2, maximum: 3 },
    "vault-remove": { minimum: 1, maximum: 1 },
    list: { minimum: 0, maximum: 0 },
    read: { minimum: 1, maximum: 1 },
    status: { minimum: 0, maximum: 1 },
    push: { minimum: 0, maximum: 1 },
    write: { minimum: 1, maximum: 1 },
    mkdir: { minimum: 1, maximum: 1 },
    move: { minimum: 2, maximum: 2 },
    remove: { minimum: 1, maximum: 1 },
  };
  const range = expected[args.command];
  if (!range) return;
  if (
    args.positionals.length < range.minimum ||
    args.positionals.length > range.maximum
  ) {
    throw new CliUsageError(
      `bb docs ${args.command} received ${args.positionals.length} positional argument(s); expected ${
        range.minimum === range.maximum
          ? range.minimum
          : `${range.minimum}-${range.maximum}`
      }`,
    );
  }
}

function waitForDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

export default async function plugin(
  bb: BbPluginApi,
  watchVault: WatchVault = watchNativeVault,
) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS vaults (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      host_id TEXT,
      root_path TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS entry_order (
      vault_id TEXT NOT NULL,
      parent_path TEXT NOT NULL,
      child_path TEXT NOT NULL,
      position INTEGER NOT NULL,
      PRIMARY KEY (vault_id, parent_path, child_path)
    )`,
  ]);

  let seededDefaultVault = false;
  if (
    Number(db.prepare("SELECT COUNT(*) AS count FROM vaults").pluck().get()) ===
    0
  ) {
    const rootPath = path.resolve(expandHome(DEFAULT_DIR));
    db.prepare(
      "INSERT INTO vaults (id, name, host_id, root_path, created_at) VALUES (?, ?, NULL, ?, ?)",
    ).run("personal", "Personal", rootPath, Date.now());
    seededDefaultVault = true;
  }

  function listVaults(): Vault[] {
    return db
      .prepare(
        "SELECT id, name, host_id, root_path FROM vaults ORDER BY created_at, name",
      )
      .all()
      .map(parseVaultRow);
  }

  function getVault(vaultId?: string): Vault {
    const vaults = listVaults();
    const vault = vaultId
      ? vaults.find((candidate) => candidate.id === vaultId)
      : vaults[0];
    if (!vault)
      throw new Error(
        vaultId ? `Unknown vault: ${vaultId}` : "No vault configured",
      );
    return vault;
  }

  function listEntryOrder(vaultId: string): string[] {
    return db
      .prepare(
        "SELECT child_path FROM entry_order WHERE vault_id = ? ORDER BY parent_path, position",
      )
      .all(vaultId)
      .map((row) => requireString(requireRecord(row).child_path, "child_path"));
  }

  if (seededDefaultVault) {
    const vault = getVault("personal");
    try {
      await bb.sdk.files.mkdir({ path: vault.rootPath, recursive: true });
    } catch (error) {
      bb.log.warn(
        `could not create default vault: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function listEntries(
    vault: Vault,
  ): Promise<{ entries: VaultEntry[]; truncated: boolean }> {
    const result = await bb.sdk.files.listPaths({
      ...hostArgs(vault),
      path: vault.rootPath,
      includeFiles: true,
      includeDirectories: true,
      limit: MAX_TREE_ENTRIES,
    });
    return {
      entries: result.paths
        .filter(
          (entry) =>
            entry.kind === "directory" || /\.(md|html?)$/i.test(entry.path),
        )
        .map((entry) => ({
          kind: entry.kind,
          path: entry.path.replace(/\\/g, "/"),
        })),
      truncated: result.truncated,
    };
  }

  async function listNoteSummaries(
    vault: Vault,
    knownEntries?: VaultEntry[],
  ): Promise<NoteSummary[]> {
    const entries = knownEntries ?? (await listEntries(vault)).entries;
    const notes: NoteSummary[] = [];
    const markdownPaths = entries
      .filter((entry) => entry.kind === "file" && /\.md$/i.test(entry.path))
      .map((entry) => entry.path);
    for (const notePath of markdownPaths) {
      try {
        const file = await bb.sdk.files.read({
          ...hostArgs(vault),
          path: absolutePath(vault, notePath),
          rootPath: vault.rootPath,
        });
        const fallback = path.posix.basename(notePath).replace(/\.md$/i, "");
        const summary = summarizeMarkdown(file.content, fallback);
        notes.push({
          path: notePath,
          title: summary.title,
          preview: summary.preview,
          modifiedAtMs: file.modifiedAtMs ?? 0,
        });
      } catch {}
    }
    return notes.sort((a, b) => b.modifiedAtMs - a.modifiedAtMs);
  }

  async function notebookData(vaultId?: string) {
    const vault = getVault(vaultId);
    try {
      const [{ entries, truncated }, hosts] = await Promise.all([
        listEntries(vault),
        bb.sdk.hosts.list(),
      ]);
      const notes = await listNoteSummaries(vault, entries);
      return {
        vaults: listVaults(),
        vault,
        hosts,
        entries,
        entryOrder: listEntryOrder(vault.id),
        notes,
        truncated,
        error: null,
      };
    } catch (error) {
      return {
        vaults: listVaults(),
        vault,
        hosts: await bb.sdk.hosts.list().catch(() => []),
        entries: [],
        entryOrder: listEntryOrder(vault.id),
        notes: [],
        truncated: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async function readFile(vaultId: string | undefined, rawPath: unknown) {
    const vault = getVault(vaultId);
    const relativePath = requireVaultPath(rawPath);
    const file = await bb.sdk.files.read({
      ...hostArgs(vault),
      path: absolutePath(vault, relativePath),
      rootPath: vault.rootPath,
    });
    return { ...file, path: relativePath };
  }

  async function writeFile(args: {
    vaultId?: string;
    rawPath: unknown;
    content: unknown;
    contentEncoding?: "utf8" | "base64";
    expectedSha256?: unknown;
    createOnly?: boolean;
  }) {
    const vault = getVault(args.vaultId);
    const relativePath = requireVaultPath(args.rawPath);
    if (typeof args.content !== "string")
      throw new Error('"content" must be a string');
    const result = await bb.sdk.files.write({
      ...hostArgs(vault),
      path: absolutePath(vault, relativePath),
      rootPath: vault.rootPath,
      content: args.content,
      contentEncoding: args.contentEncoding ?? "utf8",
      createParents: true,
      ...(args.createOnly
        ? { expectedSha256: null }
        : args.expectedSha256 === null ||
            typeof args.expectedSha256 === "string"
          ? { expectedSha256: args.expectedSha256 }
          : {}),
    });
    if (result.outcome === "written") {
      bb.realtime.publish("vault-changed", { vaultId: vault.id });
    }
    return result;
  }

  async function resolveOpenerFile(
    source: OpenerSource,
    pathValue: unknown,
  ): Promise<ResolvedOpenerFile> {
    const filePath = requireString(pathValue, "path");
    if (source.kind === "host") {
      if (!isAbsoluteHostPath(filePath)) {
        throw new Error("Host file paths must be absolute");
      }
      const normalized = normalizeHostRoot(filePath);
      const pathApi = path.win32.isAbsolute(normalized)
        ? path.win32
        : path.posix;
      return {
        path: normalized,
        rootPath: pathApi.dirname(normalized),
        hostId: source.experimental_hostId ?? null,
      };
    }
    if (source.kind === "workspace" && source.environmentId) {
      const environment = await bb.sdk.environments.get({
        environmentId: source.environmentId,
      });
      if (!environment.path) {
        throw new Error("This environment has no workspace path");
      }
      return {
        path: path.join(environment.path, filePath),
        rootPath: environment.path,
        hostId: environment.hostId,
      };
    }
    if (source.kind === "workspace" && source.projectId) {
      const hostId =
        source.experimental_hostId ??
        (await bb.sdk.system.config()).primaryHostId;
      if (!hostId) {
        throw new Error("This project has no primary host");
      }
      const project = await bb.sdk.projects.get({
        projectId: source.projectId,
      });
      const matchingSources = project.sources.filter(
        (projectSource) => projectSource.hostId === hostId,
      );
      const [projectSource] = matchingSources;
      if (!projectSource) {
        throw new Error(
          source.experimental_hostId
            ? "This project has no workspace on the selected host"
            : "This project has no workspace on the primary host",
        );
      }
      if (matchingSources.length > 1) {
        throw new Error("This project has multiple workspaces on that host");
      }
      const rootPath = normalizeHostRoot(projectSource.path);
      if (!isAbsoluteHostPath(rootPath)) {
        throw new Error("This project has no absolute workspace path");
      }
      return {
        path: hostPathApi(rootPath).join(rootPath, ...filePath.split("/")),
        rootPath,
        hostId,
      };
    }
    if (source.kind === "thread-storage") {
      if (!source.threadId) {
        throw new Error("Thread-storage files require a thread ID");
      }
      const relativePath = requireThreadStoragePath(filePath);
      const storage = await bb.sdk.threads.storageLocation({
        threadId: source.threadId,
      });
      if (!isAbsoluteHostPath(storage.storageRootPath)) {
        throw new Error("This thread has no absolute storage path");
      }
      const rootPath = normalizeHostRoot(storage.storageRootPath);
      return {
        path: hostPathApi(rootPath).join(rootPath, ...relativePath.split("/")),
        rootPath,
        hostId: storage.hostId,
      };
    }
    throw new Error(
      "Docs can open workspace, host, and thread-storage files only",
    );
  }

  async function createNote(
    vaultId: string | undefined,
    input: Record<string, unknown>,
  ) {
    const vault = getVault(vaultId);
    const parent = requireOptionalDirectory(input.parent);
    const base =
      sanitizeName(typeof input.name === "string" ? input.name : "") ||
      "Untitled";
    const { entries } = await listEntries(vault);
    const existing = new Set(entries.map((entry) => entry.path.toLowerCase()));
    let relativePath = parent ? `${parent}/${base}.md` : `${base}.md`;
    let counter = 2;
    while (existing.has(relativePath.toLowerCase())) {
      relativePath = parent
        ? `${parent}/${base} ${counter}.md`
        : `${base} ${counter}.md`;
      counter += 1;
    }
    await writeFile({
      vaultId: vault.id,
      rawPath: relativePath,
      content: typeof input.content === "string" ? input.content : "",
      createOnly: true,
    });
    return { path: relativePath };
  }

  async function movePath(
    vaultId: string | undefined,
    fromValue: unknown,
    toValue: unknown,
  ) {
    const vault = getVault(vaultId);
    const from = requireVaultPath(fromValue);
    const to = requireVaultPath(toValue);
    await bb.sdk.files.move({
      ...hostArgs(vault),
      sourcePath: absolutePath(vault, from),
      destinationPath: absolutePath(vault, to),
      rootPath: vault.rootPath,
    });
    bb.realtime.publish("vault-changed", { vaultId: vault.id });
    return { path: to };
  }

  async function removePath(
    vaultId: string | undefined,
    rawPath: unknown,
    recursive = false,
  ): Promise<{ ok: true }> {
    const vault = getVault(vaultId);
    const relativePath = requireVaultPath(rawPath);
    await bb.sdk.files.remove({
      ...hostArgs(vault),
      path: absolutePath(vault, relativePath),
      rootPath: vault.rootPath,
      recursive,
    });
    bb.realtime.publish("vault-changed", { vaultId: vault.id });
    return { ok: true };
  }

  function scopeContains(scope: SyncScope, relativePath: string): boolean {
    if (scope.kind === "all") return true;
    if (scope.kind === "file") return relativePath === scope.path;
    return (
      relativePath === scope.path || relativePath.startsWith(`${scope.path}/`)
    );
  }

  function isMissingFileError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /\bENOENT\b|path does not exist|not found/i.test(message);
  }

  async function readExistingFile(
    vault: Vault,
    relativePath: string,
  ): Promise<Awaited<ReturnType<typeof bb.sdk.files.read>> | null> {
    try {
      return await bb.sdk.files.read({
        ...hostArgs(vault),
        path: absolutePath(vault, relativePath),
        rootPath: vault.rootPath,
      });
    } catch (error) {
      if (isMissingFileError(error)) return null;
      throw error;
    }
  }

  async function syncSnapshot(vaultId: string | undefined, scope: SyncScope) {
    const vault = getVault(vaultId);
    const normalizedScope: SyncScope =
      scope.kind === "all"
        ? scope
        : { kind: scope.kind, path: requireVaultPath(scope.path) };
    const files: SyncFile[] = [];
    const directories: string[] = [];
    if (normalizedScope.kind === "file") {
      const file = await readFile(vault.id, normalizedScope.path);
      files.push({
        remotePath: normalizedScope.path,
        localPath: normalizedScope.path,
        sha256: file.sha256,
        sizeBytes: file.sizeBytes,
        contentEncoding: file.contentEncoding,
        mimeType: file.mimeType ?? null,
        modifiedAtMs: file.modifiedAtMs ?? null,
        content: file.content,
      });
    } else {
      const result = await bb.sdk.files.listPaths({
        ...hostArgs(vault),
        path: vault.rootPath,
        includeFiles: true,
        includeDirectories: true,
        limit: MAX_TREE_ENTRIES,
      });
      if (result.truncated) {
        throw new Error(
          `Sync scope exceeds ${MAX_TREE_ENTRIES} entries; narrow the folder scope`,
        );
      }
      const accessible = result.paths
        .map((entry) => ({
          kind: entry.kind,
          path: entry.path.replace(/\\/g, "/"),
        }))
        .filter((entry) => {
          try {
            requireVaultPath(entry.path);
            return scopeContains(normalizedScope, entry.path);
          } catch {
            return false;
          }
        })
        .sort((left, right) => left.path.localeCompare(right.path));
      if (
        normalizedScope.kind === "folder" &&
        !accessible.some(
          (entry) =>
            entry.path === normalizedScope.path ||
            entry.path.startsWith(`${normalizedScope.path}/`),
        )
      ) {
        throw new Error(`Folder does not exist: ${normalizedScope.path}`);
      }
      for (const entry of accessible) {
        if (entry.kind === "directory") {
          directories.push(entry.path);
          continue;
        }
        const file = await readFile(vault.id, entry.path);
        files.push({
          remotePath: entry.path,
          localPath: entry.path,
          sha256: file.sha256,
          sizeBytes: file.sizeBytes,
          contentEncoding: file.contentEncoding,
          mimeType: file.mimeType ?? null,
          modifiedAtMs: file.modifiedAtMs ?? null,
          content: file.content,
        });
      }
    }
    const folded = new Map<string, string>();
    for (const entry of [
      ...directories,
      ...files.map((file) => file.localPath),
    ]) {
      const collision = folded.get(entry.toLowerCase());
      if (collision && collision !== entry) {
        throw new Error(
          `Vault paths ${JSON.stringify(collision)} and ${JSON.stringify(entry)} collide on case-insensitive filesystems`,
        );
      }
      folded.set(entry.toLowerCase(), entry);
    }
    return { vault, scope: normalizedScope, files, directories };
  }

  async function syncApply(input: {
    vaultId?: string;
    writes: Array<{
      path: string;
      content: string;
      contentEncoding: "base64" | "utf8";
      expectedSha256: string | null;
    }>;
    deletes: Array<{ path: string; expectedSha256: string }>;
    directories: string[];
    deleteDirectories: string[];
    dryRun: boolean;
  }) {
    const vault = getVault(input.vaultId);
    const writes = input.writes.map((write) => ({
      ...write,
      path: requireVaultPath(write.path),
    }));
    const deletes = input.deletes.map((deletion) => ({
      ...deletion,
      path: requireVaultPath(deletion.path),
    }));
    const directories = input.directories.map((directory) =>
      requireVaultPath(directory),
    );
    const deleteDirectories = input.deleteDirectories.map((directory) =>
      requireVaultPath(directory),
    );
    type SyncTreeEntry = {
      path: string;
      kind: "directory" | "file";
      operation: string;
    };
    const assertValidTree = (entries: SyncTreeEntry[], label: string): void => {
      const folded = new Map<string, SyncTreeEntry>();
      const files = new Set<string>();
      for (const entry of entries) {
        const key = entry.path.toLowerCase();
        const existing = folded.get(key);
        if (existing) {
          throw new Error(
            `${label} paths ${JSON.stringify(existing.path)} (${existing.operation}) and ${JSON.stringify(entry.path)} (${entry.operation}) collide`,
          );
        }
        folded.set(key, entry);
        if (entry.kind === "file") files.add(key);
      }
      for (const entry of entries) {
        const parts = entry.path.toLowerCase().split("/");
        for (let index = 1; index < parts.length; index += 1) {
          const ancestor = parts.slice(0, index).join("/");
          if (files.has(ancestor)) {
            throw new Error(
              `${label} path ${JSON.stringify(entry.path)} is nested beneath a file`,
            );
          }
        }
      }
    };
    assertValidTree(
      [
        ...writes.map((write) => ({
          path: write.path,
          kind: "file" as const,
          operation: "write",
        })),
        ...deletes.map((deletion) => ({
          path: deletion.path,
          kind: "file" as const,
          operation: "delete",
        })),
        ...directories.map((directory) => ({
          path: directory,
          kind: "directory" as const,
          operation: "create directory",
        })),
        ...deleteDirectories.map((directory) => ({
          path: directory,
          kind: "directory" as const,
          operation: "delete directory",
        })),
      ],
      "Sync request",
    );
    const currentListing = await bb.sdk.files.listPaths({
      ...hostArgs(vault),
      path: vault.rootPath,
      includeFiles: true,
      includeDirectories: true,
      limit: MAX_TREE_ENTRIES,
    });
    if (currentListing.truncated) {
      throw new Error(
        `Vault exceeds ${MAX_TREE_ENTRIES} entries; narrow the sync scope`,
      );
    }
    const currentEntries: SyncTreeEntry[] = currentListing.paths.map(
      (entry) => ({
        path: requireVaultPath(entry.path.replace(/\\/g, "/")),
        kind: entry.kind,
        operation: "existing vault entry",
      }),
    );
    assertValidTree(currentEntries, "Vault");
    const currentByPath = new Map(
      currentEntries.map((entry) => [entry.path, entry]),
    );
    const fileDeletes = new Set(deletes.map((deletion) => deletion.path));
    const directoryDeletes = new Set(deleteDirectories);
    const writePaths = new Set(writes.map((write) => write.path));
    for (const directory of deleteDirectories) {
      if (
        writes.some((write) => write.path.startsWith(`${directory}/`)) ||
        directories.some(
          (candidate) =>
            candidate === directory || candidate.startsWith(`${directory}/`),
        )
      ) {
        throw new Error(
          `Sync request both deletes ${JSON.stringify(directory)} and creates content beneath it`,
        );
      }
      const remainingChild = currentEntries.find(
        (entry) =>
          entry.path.startsWith(`${directory}/`) &&
          !fileDeletes.has(entry.path) &&
          !directoryDeletes.has(entry.path),
      );
      if (remainingChild) {
        throw new Error(
          `Directory ${JSON.stringify(directory)} is not empty; ${JSON.stringify(remainingChild.path)} is not scheduled for deletion`,
        );
      }
    }
    const futureEntries = currentEntries.filter((entry) => {
      if (entry.kind === "file") {
        return !fileDeletes.has(entry.path) && !writePaths.has(entry.path);
      }
      return !directoryDeletes.has(entry.path);
    });
    for (const directory of directories) {
      if (currentByPath.get(directory)?.kind !== "directory") {
        futureEntries.push({
          path: directory,
          kind: "directory",
          operation: "create directory",
        });
      }
    }
    for (const write of writes) {
      futureEntries.push({
        path: write.path,
        kind: "file",
        operation: "write",
      });
    }
    assertValidTree(futureEntries, "Resulting vault");
    const conflicts: Array<{
      path: string;
      expectedSha256: string | null;
      currentSha256: string | null;
    }> = [];
    for (const mutation of [...writes, ...deletes]) {
      const current = await readExistingFile(vault, mutation.path);
      if ((current?.sha256 ?? null) !== mutation.expectedSha256) {
        conflicts.push({
          path: mutation.path,
          expectedSha256: mutation.expectedSha256,
          currentSha256: current?.sha256 ?? null,
        });
      }
    }
    if (conflicts.length > 0) {
      return {
        outcome: "conflict" as const,
        written: [],
        deleted: [],
        createdDirectories: [],
        deletedDirectories: [],
        conflicts,
        errors: [],
      };
    }
    if (input.dryRun) {
      return {
        outcome: "applied" as const,
        written: [],
        deleted: [],
        createdDirectories: [],
        deletedDirectories: [],
        conflicts: [],
        errors: [],
      };
    }
    const written: SyncStateEntry[] = [];
    const deleted: string[] = [];
    const createdDirectories: string[] = [];
    const deletedDirectories: string[] = [];
    const errors: Array<{ path: string; message: string }> = [];
    for (const directory of [...directories].sort()) {
      if (currentByPath.get(directory)?.kind === "directory") continue;
      try {
        await bb.sdk.files.mkdir({
          ...hostArgs(vault),
          path: absolutePath(vault, directory),
          rootPath: vault.rootPath,
          recursive: true,
        });
        createdDirectories.push(directory);
      } catch (error) {
        errors.push({
          path: directory,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    for (const write of writes) {
      try {
        const result = await writeFile({
          vaultId: vault.id,
          rawPath: write.path,
          content: write.content,
          contentEncoding: write.contentEncoding,
          expectedSha256: write.expectedSha256,
          createOnly: write.expectedSha256 === null,
        });
        if (result.outcome === "conflict") {
          conflicts.push({
            path: write.path,
            expectedSha256: write.expectedSha256,
            currentSha256: result.currentSha256,
          });
          continue;
        }
        const refreshed = await readFile(vault.id, write.path);
        written.push({
          remotePath: write.path,
          localPath: write.path,
          sha256: refreshed.sha256,
          sizeBytes: refreshed.sizeBytes,
          contentEncoding: refreshed.contentEncoding,
          mimeType: refreshed.mimeType ?? null,
          modifiedAtMs: refreshed.modifiedAtMs ?? null,
        });
      } catch (error) {
        errors.push({
          path: write.path,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    for (const deletion of deletes) {
      try {
        const current = await readExistingFile(vault, deletion.path);
        if (current?.sha256 !== deletion.expectedSha256) {
          conflicts.push({
            path: deletion.path,
            expectedSha256: deletion.expectedSha256,
            currentSha256: current?.sha256 ?? null,
          });
          continue;
        }
        await removePath(vault.id, deletion.path, false);
        deleted.push(deletion.path);
      } catch (error) {
        errors.push({
          path: deletion.path,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    for (const directory of [...deleteDirectories].sort(
      (left, right) =>
        right.split("/").length - left.split("/").length ||
        right.localeCompare(left),
    )) {
      try {
        await removePath(vault.id, directory, false);
        deletedDirectories.push(directory);
      } catch (error) {
        if (isMissingFileError(error)) continue;
        errors.push({
          path: directory,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const appliedCount =
      written.length +
      deleted.length +
      createdDirectories.length +
      deletedDirectories.length;
    return {
      outcome:
        errors.length > 0 || (conflicts.length > 0 && appliedCount > 0)
          ? ("partial" as const)
          : conflicts.length > 0
            ? ("conflict" as const)
            : ("applied" as const),
      written,
      deleted,
      createdDirectories,
      deletedDirectories,
      conflicts,
      errors,
    };
  }

  const handlers: PluginRpcHandlers<typeof docsRpcContract> = {
    async syncSnapshot(input) {
      return syncSnapshot(input.vaultId, input.scope);
    },
    async syncApply(input) {
      return syncApply(input);
    },
    async listNotes(input) {
      return notebookData(input.vaultId);
    },
    async readNote(input) {
      return readFile(input.vaultId, input.path);
    },
    async saveNote(input) {
      return writeFile({
        vaultId: input.vaultId,
        rawPath: input.path,
        content: input.content,
        expectedSha256: input.expectedSha256,
      });
    },
    async createNote(input) {
      return createNote(input.vaultId, input);
    },
    async deletePath(input) {
      return removePath(input.vaultId, input.path, input.recursive === true);
    },
    async createFolder(input) {
      const vault = getVault(input.vaultId);
      const relativePath = requireVaultPath(input.path);
      await bb.sdk.files.mkdir({
        ...hostArgs(vault),
        path: absolutePath(vault, relativePath),
        rootPath: vault.rootPath,
        recursive: false,
      });
      bb.realtime.publish("vault-changed", { vaultId: vault.id });
      return { path: relativePath };
    },
    async reorderFiles(input) {
      const vault = getVault(input.vaultId);
      const parent = requireOptionalDirectory(input.parent);
      const paths = input.paths.map((value) => requireVaultPath(value));
      if (new Set(paths).size !== paths.length) {
        throw new Error('"paths" must not contain duplicates');
      }
      if (
        paths.some(
          (filePath) =>
            path.posix.dirname(filePath) !== (parent || ".") ||
            !/\.(md|html?)$/i.test(filePath),
        )
      ) {
        throw new Error('Every ordered path must be a file in "parent"');
      }
      const currentFiles = (await listEntries(vault)).entries
        .filter(
          (entry) =>
            entry.kind === "file" &&
            path.posix.dirname(entry.path) === (parent || "."),
        )
        .map((entry) => entry.path);
      if (
        paths.length !== currentFiles.length ||
        currentFiles.some((filePath) => !paths.includes(filePath))
      ) {
        throw new Error(
          "Files changed while reordering; refresh and try again",
        );
      }
      const replaceOrder = db.transaction(() => {
        db.prepare(
          "DELETE FROM entry_order WHERE vault_id = ? AND parent_path = ?",
        ).run(vault.id, parent);
        const insert = db.prepare(
          "INSERT INTO entry_order (vault_id, parent_path, child_path, position) VALUES (?, ?, ?, ?)",
        );
        paths.forEach((filePath, position) =>
          insert.run(vault.id, parent, filePath, position),
        );
      });
      replaceOrder();
      bb.realtime.publish("vault-changed", { vaultId: vault.id });
      return { paths };
    },
    async movePath(input) {
      return movePath(input.vaultId, input.from, input.to);
    },
    async renameToTitle(input) {
      const vaultId = input.vaultId;
      const currentPath = requireVaultPath(input.path, { extension: ".md" });
      const file = await readFile(vaultId, currentPath);
      if (parseMarkdownDocument(file.content).title) {
        return { path: currentPath };
      }
      const base = kebabCase(deriveTitle(file.content, ""));
      if (!base) return { path: currentPath };
      const parent = path.posix.dirname(currentPath);
      const desired = parent === "." ? `${base}.md` : `${parent}/${base}.md`;
      if (desired.toLowerCase() === currentPath.toLowerCase())
        return { path: currentPath };
      try {
        return await movePath(vaultId, currentPath, desired);
      } catch {
        return { path: currentPath };
      }
    },
    async createVault(input) {
      const name = requireString(input.name, "name");
      const rootPath = requireString(input.rootPath, "rootPath");
      if (!isAbsoluteHostPath(rootPath))
        throw new Error('"rootPath" must be absolute');
      const hostId = optionalString(input.hostId) ?? null;
      const resolvedRoot = normalizeHostRoot(rootPath);
      await bb.sdk.files.mkdir({
        ...(hostId ? { hostId } : {}),
        path: resolvedRoot,
        recursive: true,
      });
      const baseId = kebabCase(name) || "vault";
      const ids = new Set(listVaults().map((vault) => vault.id));
      let id = baseId;
      let counter = 2;
      while (ids.has(id)) id = `${baseId}-${counter++}`;
      db.prepare(
        "INSERT INTO vaults (id, name, host_id, root_path, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(id, name, hostId, resolvedRoot, Date.now());
      bb.realtime.publish("vault-changed", { vaultId: id });
      return getVault(id);
    },
    async removeVault(input) {
      const id = requireString(input.vaultId, "vaultId");
      if (listVaults().length <= 1)
        throw new Error("At least one vault is required");
      db.prepare("DELETE FROM entry_order WHERE vault_id = ?").run(id);
      db.prepare("DELETE FROM vaults WHERE id = ?").run(id);
      bb.realtime.publish("vault-changed", { vaultId: id });
      return { ok: true };
    },
    async uploadAttachment(input) {
      const vaultId = input.vaultId;
      const notePath = requireVaultPath(input.notePath, { extension: ".md" });
      const content = requireString(input.content, "content");
      const bytes = Buffer.from(content, "base64");
      if (bytes.length > MAX_ATTACHMENT_BYTES)
        throw new Error("Attachment exceeds 20 MB");
      const rawName = requireString(input.name, "name");
      const extension = path.extname(rawName).toLowerCase();
      const original =
        sanitizeName(path.basename(rawName, extension)) || "image";
      if (
        !new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]).has(
          extension,
        )
      ) {
        throw new Error("Unsupported image type");
      }
      const parent = path.posix.dirname(notePath);
      const attachment = `${original}-${Date.now().toString(36)}${extension}`;
      const relativePath =
        parent === "."
          ? `_attachments/${attachment}`
          : `${parent}/_attachments/${attachment}`;
      const result = await writeFile({
        vaultId,
        rawPath: relativePath,
        content,
        contentEncoding: "base64",
        createOnly: true,
      });
      return {
        path: relativePath,
        markdownPath: `./_attachments/${attachment}`,
        result,
      };
    },
    async preparePreview(input) {
      const vault = getVault(input.vaultId);
      const relativePath = requireVaultPath(input.path);
      await bb.sdk.files.read({
        ...hostArgs(vault),
        path: absolutePath(vault, relativePath),
        rootPath: vault.rootPath,
      });
      return bb.sdk.files.createPreview({
        ...hostArgs(vault),
        rootPath: vault.rootPath,
      });
    },
    async openFile(input) {
      const target = await resolveOpenerFile(input.source, input.path);
      const args = {
        ...(target.hostId ? { hostId: target.hostId } : {}),
        path: target.path,
        rootPath: target.rootPath,
      };
      const [file, preview] = await Promise.all([
        bb.sdk.files.read(args),
        bb.sdk.files.createPreview({
          ...(target.hostId ? { hostId: target.hostId } : {}),
          rootPath: target.rootPath,
        }),
      ]);
      const pathApi = path.win32.isAbsolute(target.rootPath)
        ? path.win32
        : path.posix;
      return {
        file,
        preview,
        previewPath: pathApi
          .relative(target.rootPath, target.path)
          .replace(/\\/g, "/"),
      };
    },
    async saveOpenedFile(input) {
      const target = await resolveOpenerFile(input.source, input.path);
      return bb.sdk.files.write({
        ...(target.hostId ? { hostId: target.hostId } : {}),
        path: target.path,
        rootPath: target.rootPath,
        content: input.content,
        ...(input.expectedSha256 === null ||
        typeof input.expectedSha256 === "string"
          ? { expectedSha256: input.expectedSha256 }
          : {}),
      });
    },
  };

  bb.rpc.register(docsRpcContract, handlers);

  async function readHttpInput<Schema extends z.ZodType>(
    context: Parameters<Parameters<BbPluginApi["http"]["route"]>[2]>[0],
    schema: Schema,
  ): Promise<
    { ok: true; value: z.output<Schema> } | { ok: false; response: Response }
  > {
    let input: unknown;
    try {
      input = await context.req.json();
    } catch {
      return {
        ok: false,
        response: context.json(
          {
            ok: false,
            error: {
              code: "invalid_json",
              message: "request body must be JSON",
            },
          },
          400,
        ),
      };
    }
    const result = await schema.safeParseAsync(input);
    if (result.success) return { ok: true, value: result.data };
    return {
      ok: false,
      response: context.json(
        {
          ok: false,
          error: {
            code: "invalid_input",
            message: "request input validation failed",
            issues: result.error.issues.map((issue) => ({
              message: issue.message,
              ...(issue.path.length > 0 ? { path: issue.path } : {}),
            })),
          },
        },
        400,
      ),
    };
  }

  bb.http.route(
    "POST",
    "/list",
    async (context) => {
      const input = await readHttpInput(
        context,
        docsRpcContract.listNotes.input,
      );
      if (!input.ok) return input.response;
      return context.json(await handlers.listNotes(input.value));
    },
    { auth: "token" },
  );

  function hostPathApi(
    rootPath: string,
  ): typeof path.posix | typeof path.win32 {
    return path.win32.isAbsolute(rootPath) && !path.posix.isAbsolute(rootPath)
      ? path.win32
      : path.posix;
  }

  function resolveHostPath(rootPath: string, candidate: string): string {
    if (isAbsoluteHostPath(candidate)) return normalizeHostRoot(candidate);
    return hostPathApi(rootPath).resolve(rootPath, candidate);
  }

  function localFilePath(rootPath: string, relativePath: string): string {
    return hostPathApi(rootPath).join(rootPath, ...relativePath.split("/"));
  }

  async function resolveWorkspaceHostId(
    args: ReturnType<typeof parseCli>,
    context: PluginCliContext,
  ): Promise<string | undefined> {
    if (args.workspaceHostId) return args.workspaceHostId;
    if (!context.threadId) return undefined;
    const thread = await bb.sdk.threads.get({ threadId: context.threadId });
    if (!thread.environmentId) return undefined;
    const environment = await bb.sdk.environments.get({
      environmentId: thread.environmentId,
    });
    return environment.hostId;
  }

  function workspaceFileArgs(hostId: string | undefined): { hostId?: string } {
    return hostId ? { hostId } : {};
  }

  async function readWorkspaceFile(
    rootPath: string,
    hostId: string | undefined,
    relativePath: string,
  ): Promise<Awaited<ReturnType<typeof bb.sdk.files.read>> | null> {
    try {
      return await bb.sdk.files.read({
        ...workspaceFileArgs(hostId),
        path: localFilePath(rootPath, relativePath),
        rootPath,
      });
    } catch (error) {
      if (isMissingFileError(error)) return null;
      throw error;
    }
  }

  async function readSyncState(
    rootPath: string,
    hostId: string | undefined,
  ): Promise<{
    state: SyncState;
    sha256: string;
  } | null> {
    const file = await readWorkspaceFile(rootPath, hostId, SYNC_STATE_FILE);
    if (!file) return null;
    if (file.contentEncoding !== "utf8") {
      throw new Error(`${SYNC_STATE_FILE} must be UTF-8 JSON`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(file.content);
    } catch {
      throw new Error(
        `${SYNC_STATE_FILE} is malformed; move this workspace aside and pull into a clean directory`,
      );
    }
    const result = syncStateSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `${SYNC_STATE_FILE} is invalid: ${z.prettifyError(result.error)}. Move this workspace aside and pull into a clean directory`,
      );
    }
    const remotePaths = result.data.entries.map((entry) => entry.remotePath);
    const localPaths = result.data.entries.map((entry) => entry.localPath);
    if (
      new Set(remotePaths).size !== remotePaths.length ||
      new Set(localPaths).size !== localPaths.length
    ) {
      throw new Error(`${SYNC_STATE_FILE} contains duplicate identities`);
    }
    if (
      result.data.entries.some(
        (entry) =>
          entry.localPath !== entry.remotePath ||
          !scopeContains(result.data.scope, entry.remotePath),
      ) ||
      result.data.directories.some(
        (directory) => !scopeContains(result.data.scope, directory),
      )
    ) {
      throw new Error(
        `${SYNC_STATE_FILE} contains an identity outside its declared scope`,
      );
    }
    return { state: result.data, sha256: file.sha256 };
  }

  async function writeSyncState(
    rootPath: string,
    hostId: string | undefined,
    state: SyncState,
    expectedSha256: string | null,
  ): Promise<void> {
    const result = await bb.sdk.files.write({
      ...workspaceFileArgs(hostId),
      path: localFilePath(rootPath, SYNC_STATE_FILE),
      rootPath,
      content: `${JSON.stringify(state, null, 2)}\n`,
      createParents: true,
      expectedSha256,
    });
    if (result.outcome === "conflict") {
      throw new Error(
        `${SYNC_STATE_FILE} changed concurrently; remote changes were left intact and the workspace can be recovered by rerunning pull`,
      );
    }
  }

  function stateFromSnapshot(snapshot: {
    vault: Vault;
    scope: SyncScope;
    files: SyncFile[];
    directories: string[];
  }): SyncState {
    return {
      schemaVersion: SYNC_STATE_VERSION,
      vault: { id: snapshot.vault.id, name: snapshot.vault.name },
      scope: snapshot.scope,
      pulledAt: new Date().toISOString(),
      entries: snapshot.files.map(({ content: _content, ...entry }) => entry),
      directories: snapshot.directories,
    };
  }

  function sameScope(left: SyncScope, right: SyncScope): boolean {
    return (
      left.kind === right.kind &&
      (left.kind === "all" ||
        (right.kind !== "all" && left.path === right.path))
    );
  }

  function parsePullScope(args: ReturnType<typeof parseCli>): SyncScope {
    if (args.all && (args.folder || args.positionals.length > 0)) {
      throw new CliUsageError(
        "--all cannot be combined with a path or --folder",
      );
    }
    if (args.all) return { kind: "all" };
    const scopePath = args.positionals[0];
    if (!scopePath) {
      throw new CliUsageError("pull requires <path> or --all");
    }
    if (args.positionals.length > 1) {
      throw new CliUsageError("pull accepts only one vault path");
    }
    return {
      kind: args.folder ? "folder" : "file",
      path: requireVaultPath(scopePath),
    };
  }

  function simpleDiff(remotePath: string, base: string, local: string): string {
    if (base === local) return "";
    const before = base.split("\n");
    const after = local.split("\n");
    let prefix = 0;
    while (
      prefix < before.length &&
      prefix < after.length &&
      before[prefix] === after[prefix]
    )
      prefix += 1;
    let suffix = 0;
    while (
      suffix < before.length - prefix &&
      suffix < after.length - prefix &&
      before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
    )
      suffix += 1;
    const removed = before.slice(prefix, before.length - suffix);
    const added = after.slice(prefix, after.length - suffix);
    return [
      `--- a/${remotePath}`,
      `+++ b/${remotePath}`,
      `@@ -${prefix + 1},${removed.length} +${prefix + 1},${added.length} @@`,
      ...removed.map((line) => `-${line}`),
      ...added.map((line) => `+${line}`),
    ].join("\n");
  }

  async function runPull(
    args: ReturnType<typeof parseCli>,
    context: PluginCliContext,
  ) {
    const scope = parsePullScope(args);
    const snapshot = await syncSnapshot(args.vaultId, scope);
    const cwd = context.cwd ?? process.cwd();
    const rootPath = resolveHostPath(
      cwd,
      args.into ?? `docs-${snapshot.vault.id}`,
    );
    const hostId = await resolveWorkspaceHostId(args, context);
    const existing = await readSyncState(rootPath, hostId);
    if (
      existing &&
      (existing.state.vault.id !== snapshot.vault.id ||
        !sameScope(existing.state.scope, snapshot.scope))
    ) {
      throw new Error(
        `${SYNC_STATE_FILE} belongs to a different vault or scope; choose another --into directory`,
      );
    }
    const oldEntries = new Map(
      existing?.state.entries.map((entry) => [entry.remotePath, entry]) ?? [],
    );
    const remoteEntries = new Map(
      snapshot.files.map((entry) => [entry.remotePath, entry]),
    );
    const remoteDirectories = new Set(snapshot.directories);
    const removedDirectories =
      existing?.state.directories.filter(
        (directory) => !remoteDirectories.has(directory),
      ) ?? [];
    const writes: Array<{
      file: SyncFile;
      expectedSha256: string | null;
    }> = [];
    const deletes: Array<{ path: string; expectedSha256: string }> = [];
    const conflicts: Array<{ path: string; reason: string }> = [];
    for (const remote of snapshot.files) {
      const base = oldEntries.get(remote.remotePath);
      const local = await readWorkspaceFile(rootPath, hostId, remote.localPath);
      if (!base) {
        if (!local) writes.push({ file: remote, expectedSha256: null });
        else if (local.sha256 !== remote.sha256)
          conflicts.push({
            path: remote.localPath,
            reason: "untracked local file differs from the vault",
          });
        continue;
      }
      if (!local) {
        if (remote.sha256 !== base.sha256)
          conflicts.push({
            path: remote.localPath,
            reason: "locally deleted while the vault file also changed",
          });
        continue;
      }
      if (local.sha256 === remote.sha256) continue;
      if (local.sha256 === base.sha256) {
        writes.push({ file: remote, expectedSha256: local.sha256 });
      } else if (remote.sha256 !== base.sha256) {
        conflicts.push({
          path: remote.localPath,
          reason: "both local and vault copies changed",
        });
      }
    }
    for (const base of oldEntries.values()) {
      if (remoteEntries.has(base.remotePath)) continue;
      const local = await readWorkspaceFile(rootPath, hostId, base.localPath);
      if (!local) continue;
      if (local.sha256 === base.sha256)
        deletes.push({ path: base.localPath, expectedSha256: local.sha256 });
      else
        conflicts.push({
          path: base.localPath,
          reason: "vault file was deleted while the local copy changed",
        });
    }
    if (conflicts.length > 0) {
      return {
        outcome: "conflict" as const,
        rootPath,
        vaultId: snapshot.vault.id,
        scope: snapshot.scope,
        written: [],
        deleted: [],
        deletedDirectories: [],
        conflicts,
      };
    }
    const written: string[] = [];
    const deleted: string[] = [];
    const deletedDirectories: string[] = [];
    try {
      await bb.sdk.files.mkdir({
        ...workspaceFileArgs(hostId),
        path: rootPath,
        recursive: true,
      });
      for (const directory of snapshot.directories) {
        await bb.sdk.files.mkdir({
          ...workspaceFileArgs(hostId),
          path: localFilePath(rootPath, directory),
          rootPath,
          recursive: true,
        });
      }
      for (const write of writes) {
        const result = await bb.sdk.files.write({
          ...workspaceFileArgs(hostId),
          path: localFilePath(rootPath, write.file.localPath),
          rootPath,
          content: write.file.content,
          contentEncoding: write.file.contentEncoding,
          createParents: true,
          expectedSha256: write.expectedSha256,
        });
        if (result.outcome === "conflict") {
          throw new Error(
            `Local file changed during pull: ${write.file.localPath}; rerun pull to recover`,
          );
        }
        written.push(write.file.localPath);
      }
      for (const deletion of deletes) {
        const current = await readWorkspaceFile(
          rootPath,
          hostId,
          deletion.path,
        );
        if (current?.sha256 !== deletion.expectedSha256) {
          throw new Error(
            `Local file changed during pull: ${deletion.path}; rerun pull to recover`,
          );
        }
        await bb.sdk.files.remove({
          ...workspaceFileArgs(hostId),
          path: localFilePath(rootPath, deletion.path),
          rootPath,
          recursive: false,
        });
        deleted.push(deletion.path);
      }
      for (const directory of [...removedDirectories].sort(
        (left, right) =>
          right.split("/").length - left.split("/").length ||
          right.localeCompare(left),
      )) {
        try {
          await bb.sdk.files.remove({
            ...workspaceFileArgs(hostId),
            path: localFilePath(rootPath, directory),
            rootPath,
            recursive: false,
          });
          deletedDirectories.push(directory);
        } catch (error) {
          if (!isMissingFileError(error)) throw error;
        }
      }
      await writeSyncState(
        rootPath,
        hostId,
        stateFromSnapshot(snapshot),
        existing?.sha256 ?? null,
      );
    } catch (error) {
      return {
        outcome: "partial" as const,
        rootPath,
        vaultId: snapshot.vault.id,
        scope: snapshot.scope,
        written,
        deleted,
        deletedDirectories,
        conflicts: [],
        errors: [
          {
            message: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
    return {
      outcome: "pulled" as const,
      rootPath,
      vaultId: snapshot.vault.id,
      scope: snapshot.scope,
      written,
      deleted,
      deletedDirectories,
      conflicts: [],
    };
  }

  async function runPushPlan(
    args: ReturnType<typeof parseCli>,
    context: PluginCliContext,
    apply: boolean,
  ) {
    const cwd = context.cwd ?? process.cwd();
    const defaultVault = getVault(args.vaultId);
    const rootPath = resolveHostPath(
      cwd,
      args.positionals[0] ?? args.into ?? `docs-${defaultVault.id}`,
    );
    if (args.positionals.length > 1) {
      throw new Error("push/status accepts only one workspace directory");
    }
    const hostId = await resolveWorkspaceHostId(args, context);
    const existing = await readSyncState(rootPath, hostId);
    if (!existing) {
      throw new Error(
        `${SYNC_STATE_FILE} was not found; run bb docs pull first`,
      );
    }
    if (args.vaultId && args.vaultId !== existing.state.vault.id) {
      throw new Error(
        `Workspace belongs to vault ${existing.state.vault.id}, not ${args.vaultId}`,
      );
    }
    const snapshot = await syncSnapshot(
      existing.state.vault.id,
      existing.state.scope,
    );
    const listing = await bb.sdk.files.listPaths({
      ...workspaceFileArgs(hostId),
      path: rootPath,
      includeFiles: true,
      includeDirectories: true,
      limit: MAX_TREE_ENTRIES,
    });
    if (listing.truncated) {
      throw new Error(
        `Local workspace exceeds ${MAX_TREE_ENTRIES} entries; narrow the pull scope`,
      );
    }
    const localPaths = listing.paths
      .map((entry) => ({
        kind: entry.kind,
        path: entry.path.replace(/\\/g, "/"),
      }))
      .filter((entry) => entry.path !== SYNC_STATE_FILE)
      .filter((entry) => {
        try {
          requireVaultPath(entry.path);
          return true;
        } catch {
          return false;
        }
      });
    const localFiles = new Map<
      string,
      Awaited<ReturnType<typeof bb.sdk.files.read>>
    >();
    for (const entry of localPaths) {
      if (entry.kind !== "file") continue;
      const file = await readWorkspaceFile(rootPath, hostId, entry.path);
      if (file) localFiles.set(entry.path, file);
    }
    const baseByLocal = new Map(
      existing.state.entries.map((entry) => [entry.localPath, entry]),
    );
    const remoteByPath = new Map(
      snapshot.files.map((entry) => [entry.remotePath, entry]),
    );
    const writes: Array<{
      path: string;
      content: string;
      contentEncoding: "base64" | "utf8";
      expectedSha256: string | null;
    }> = [];
    const deletes: Array<{ path: string; expectedSha256: string }> = [];
    const conflicts: Array<{ path: string; reason: string }> = [];
    const warnings: Array<{ path: string; reason: string }> = [];
    const diffs: string[] = [];
    const localFolded = new Map<string, string>();
    for (const entry of localPaths) {
      const collision = localFolded.get(entry.path.toLowerCase());
      if (collision && collision !== entry.path) {
        conflicts.push({
          path: entry.path,
          reason: `local path collides with ${collision} on case-insensitive filesystems`,
        });
      }
      localFolded.set(entry.path.toLowerCase(), entry.path);
    }
    for (const [localPath, local] of localFiles) {
      if (!scopeContains(existing.state.scope, localPath)) {
        conflicts.push({
          path: localPath,
          reason: "local file is outside the pulled scope",
        });
        continue;
      }
      const base = baseByLocal.get(localPath);
      const remotePath = base?.remotePath ?? requireVaultPath(localPath);
      const remote = remoteByPath.get(remotePath);
      if (!base) {
        if (remote && remote.sha256 !== local.sha256) {
          conflicts.push({
            path: remotePath,
            reason: "new local file collides with a vault file",
          });
        } else if (!remote) {
          writes.push({
            path: remotePath,
            content: local.content,
            contentEncoding: local.contentEncoding,
            expectedSha256: null,
          });
        }
        continue;
      }
      if (!remote) {
        conflicts.push({
          path: remotePath,
          reason: "vault file was deleted after pull",
        });
        continue;
      }
      if (local.sha256 === remote.sha256) continue;
      if (local.sha256 === base.sha256 && remote.sha256 !== base.sha256) {
        conflicts.push({
          path: remotePath,
          reason: "vault file changed after pull",
        });
      } else if (
        local.sha256 !== base.sha256 &&
        remote.sha256 === base.sha256
      ) {
        writes.push({
          path: remotePath,
          content: local.content,
          contentEncoding: local.contentEncoding,
          expectedSha256: base.sha256,
        });
        if (
          args.diff &&
          local.contentEncoding === "utf8" &&
          remote.contentEncoding === "utf8"
        ) {
          diffs.push(simpleDiff(remotePath, remote.content, local.content));
        }
      } else {
        conflicts.push({
          path: remotePath,
          reason: "both local and vault copies changed",
        });
      }
    }
    for (const base of existing.state.entries) {
      if (localFiles.has(base.localPath)) continue;
      const remote = remoteByPath.get(base.remotePath);
      if (!remote) continue;
      if (!args.delete) {
        warnings.push({
          path: base.remotePath,
          reason: "local deletion ignored; pass --delete to remove from vault",
        });
      } else if (remote.sha256 !== base.sha256) {
        conflicts.push({
          path: base.remotePath,
          reason: "locally deleted while the vault file also changed",
        });
      } else {
        deletes.push({ path: base.remotePath, expectedSha256: base.sha256 });
      }
    }
    for (const remote of snapshot.files) {
      const tracked = existing.state.entries.some(
        (entry) => entry.remotePath === remote.remotePath,
      );
      const matchingLocal = localFiles.has(remote.localPath);
      if (!tracked && !matchingLocal) {
        conflicts.push({
          path: remote.remotePath,
          reason: "new vault file is not present locally; pull before pushing",
        });
      }
    }
    const discoveredLocalDirectories = localPaths
      .filter((entry) => entry.kind === "directory")
      .map((entry) => entry.path);
    const localDirectories = discoveredLocalDirectories.filter((directory) =>
      scopeContains(existing.state.scope, directory),
    );
    for (const directory of discoveredLocalDirectories) {
      const structuralAncestor =
        existing.state.scope.kind !== "all" &&
        existing.state.scope.path.startsWith(`${directory}/`);
      if (
        !scopeContains(existing.state.scope, directory) &&
        !structuralAncestor
      ) {
        conflicts.push({
          path: directory,
          reason: "local directory is outside the pulled scope",
        });
      }
    }
    const localDirectorySet = new Set(localDirectories);
    const remoteDirectorySet = new Set(snapshot.directories);
    const trackedDirectorySet = new Set(existing.state.directories);
    const createDirectories: string[] = [];
    const deleteDirectories: string[] = [];
    for (const directory of localDirectories) {
      if (
        trackedDirectorySet.has(directory) &&
        !remoteDirectorySet.has(directory)
      ) {
        conflicts.push({
          path: directory,
          reason: "vault directory was deleted after pull",
        });
      } else if (!remoteDirectorySet.has(directory)) {
        createDirectories.push(directory);
      }
    }
    for (const directory of existing.state.directories) {
      if (
        localDirectorySet.has(directory) ||
        !remoteDirectorySet.has(directory)
      )
        continue;
      if (
        existing.state.scope.kind === "folder" &&
        directory === existing.state.scope.path
      ) {
        warnings.push({
          path: directory,
          reason:
            "pulled folder root deletion ignored; pull its parent or the whole vault to delete it",
        });
      } else if (!args.delete) {
        warnings.push({
          path: directory,
          reason:
            "local directory deletion ignored; pass --delete to remove it from the vault",
        });
      } else {
        deleteDirectories.push(directory);
      }
    }
    for (const directory of snapshot.directories) {
      if (
        !trackedDirectorySet.has(directory) &&
        !localDirectorySet.has(directory)
      ) {
        conflicts.push({
          path: directory,
          reason:
            "new vault directory is not present locally; pull before pushing",
        });
      }
    }
    const plan = {
      rootPath,
      vaultId: existing.state.vault.id,
      scope: existing.state.scope,
      writes: writes.map((write) => write.path),
      deletes: deletes.map((deletion) => deletion.path),
      directories: createDirectories,
      deleteDirectories,
      conflicts,
      warnings,
      diffs: diffs.filter(Boolean),
    };
    if (!apply || args.dryRun || conflicts.length > 0) {
      return {
        outcome:
          conflicts.length > 0 ? ("conflict" as const) : ("planned" as const),
        ...plan,
      };
    }
    const applied = await syncApply({
      vaultId: existing.state.vault.id,
      writes,
      deletes,
      directories: createDirectories,
      deleteDirectories,
      dryRun: false,
    });
    if (applied.outcome !== "applied") {
      return { outcome: applied.outcome, ...plan, applied };
    }
    const refreshed = await syncSnapshot(
      existing.state.vault.id,
      existing.state.scope,
    );
    await writeSyncState(
      rootPath,
      hostId,
      stateFromSnapshot(refreshed),
      existing.sha256,
    );
    return { outcome: "pushed" as const, ...plan, applied };
  }

  function stringArray(value: unknown): string[] {
    return Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string")
      : [];
  }

  function formatSyncHumanOutput(command: string, result: unknown): string {
    if (!isRecord(result)) return JSON.stringify(result, null, 2);
    if (command === "pull") {
      if (result.outcome === "conflict") {
        return `Pull stopped: ${Array.isArray(result.conflicts) ? result.conflicts.length : 0} conflict(s). No files were changed.\n${JSON.stringify(result.conflicts, null, 2)}`;
      }
      if (result.outcome === "partial") {
        return `Pull partially completed in ${String(result.rootPath)}. The prior manifest remains valid; rerun pull to recover safely.\n${JSON.stringify(result.errors, null, 2)}`;
      }
      return `Pulled ${stringArray(result.written).length} file(s) into ${String(result.rootPath)}${stringArray(result.deleted).length > 0 ? `; removed ${stringArray(result.deleted).length} remotely deleted file(s)` : ""}${stringArray(result.deletedDirectories).length > 0 ? `; removed ${stringArray(result.deletedDirectories).length} remotely deleted director${stringArray(result.deletedDirectories).length === 1 ? "y" : "ies"}` : ""}.`;
    }
    if (command === "status" || command === "push") {
      const writes = stringArray(result.writes);
      const deletes = stringArray(result.deletes);
      const directories = stringArray(result.directories);
      const deleteDirectories = stringArray(result.deleteDirectories);
      const warnings = Array.isArray(result.warnings) ? result.warnings : [];
      const conflicts = Array.isArray(result.conflicts) ? result.conflicts : [];
      const lines = [
        `Docs workspace: ${String(result.rootPath)}`,
        `Vault: ${String(result.vaultId)}`,
        `Changes: ${writes.length} write(s), ${deletes.length} file deletion(s), ${directories.length} directory creation(s), ${deleteDirectories.length} directory deletion(s), ${warnings.length} warning(s), ${conflicts.length} conflict(s)`,
      ];
      if (writes.length > 0) lines.push(`Write:\n  ${writes.join("\n  ")}`);
      if (deletes.length > 0) lines.push(`Delete:\n  ${deletes.join("\n  ")}`);
      if (directories.length > 0)
        lines.push(`Create directories:\n  ${directories.join("\n  ")}`);
      if (deleteDirectories.length > 0)
        lines.push(`Delete directories:\n  ${deleteDirectories.join("\n  ")}`);
      if (warnings.length > 0)
        lines.push(`Warnings:\n${JSON.stringify(warnings, null, 2)}`);
      if (conflicts.length > 0)
        lines.push(`Conflicts:\n${JSON.stringify(conflicts, null, 2)}`);
      const diffs = stringArray(result.diffs);
      if (diffs.length > 0) lines.push(diffs.join("\n\n"));
      if (result.outcome === "pushed") lines.push("Push completed.");
      else if (result.outcome === "planned")
        lines.push(
          command === "push"
            ? "Dry run only; no remote changes were made."
            : "No remote changes were made.",
        );
      else if (result.outcome === "partial")
        lines.push("Push partially completed; rerun status to recover safely.");
      else if (result.outcome === "conflict")
        lines.push(
          "No push changes were made; pull and merge the conflicts first.",
        );
      return lines.join("\n");
    }
    return JSON.stringify(result, null, 2);
  }
  bb.http.route(
    "POST",
    "/read",
    async (context) => {
      const input = await readHttpInput(
        context,
        docsRpcContract.readNote.input,
      );
      if (!input.ok) return input.response;
      return context.json(await handlers.readNote(input.value));
    },
    { auth: "token" },
  );
  bb.http.route(
    "POST",
    "/write",
    async (context) => {
      const input = await readHttpInput(
        context,
        docsRpcContract.saveNote.input,
      );
      if (!input.ok) return input.response;
      return context.json(await handlers.saveNote(input.value));
    },
    { auth: "token" },
  );
  bb.http.route(
    "POST",
    "/mkdir",
    async (context) => {
      const input = await readHttpInput(
        context,
        docsRpcContract.createFolder.input,
      );
      if (!input.ok) return input.response;
      return context.json(await handlers.createFolder(input.value));
    },
    { auth: "token" },
  );
  bb.http.route(
    "POST",
    "/move",
    async (context) => {
      const input = await readHttpInput(
        context,
        docsRpcContract.movePath.input,
      );
      if (!input.ok) return input.response;
      return context.json(await handlers.movePath(input.value));
    },
    { auth: "token" },
  );
  bb.http.route(
    "POST",
    "/remove",
    async (context) => {
      const input = await readHttpInput(
        context,
        docsRpcContract.deletePath.input,
      );
      if (!input.ok) return input.response;
      return context.json(await handlers.deletePath(input.value));
    },
    { auth: "token" },
  );
  bb.http.route(
    "POST",
    "/sync/snapshot",
    async (context) => {
      const input = await readHttpInput(
        context,
        docsRpcContract.syncSnapshot.input,
      );
      if (!input.ok) return input.response;
      return context.json(await handlers.syncSnapshot(input.value));
    },
    { auth: "token" },
  );
  bb.http.route(
    "POST",
    "/sync/apply",
    async (context) => {
      const input = await readHttpInput(
        context,
        docsRpcContract.syncApply.input,
      );
      if (!input.ok) return input.response;
      return context.json(await handlers.syncApply(input.value));
    },
    { auth: "token" },
  );

  bb.cli.register({
    name: "docs",
    summary: "Discover and safely sync Docs vaults",
    commands: [
      {
        name: "vaults",
        summary: "List configured vaults",
        usage: "bb docs vaults [--json]",
      },
      {
        name: "vault-add",
        summary: "Add a vault",
        usage: "bb docs vault-add <name> <absolute-root> [host-id]",
      },
      {
        name: "vault-remove",
        summary: "Remove a vault configuration",
        usage: "bb docs vault-remove <id>",
      },
      {
        name: "list",
        summary: "List notes and folders",
        usage: "bb docs list [--vault <id>] [--json]",
      },
      {
        name: "read",
        summary: "Read a file",
        usage: "bb docs read <path> [--vault <id>]",
      },
      {
        name: "pull",
        summary: "Pull one file, a folder subtree, or a whole vault",
        usage:
          "bb docs pull <path> [--folder] | --all [--vault <id>] [--into <dir>] [--workspace-host <id>] [--json]",
      },
      {
        name: "status",
        summary: "Show local edits, conflicts, and ignored deletions",
        usage: DOCS_STATUS_USAGE,
      },
      {
        name: "push",
        summary: "Safely push local edits using optimistic concurrency",
        usage:
          "bb docs push [workspace-dir] [--delete] [--dry-run] [--diff] [--workspace-host <id>] [--json]",
      },
      {
        name: "write",
        summary: "Deprecated: write a UTF-8 file directly",
        usage: "bb docs write <path> --content <text> [--vault <id>]",
      },
      {
        name: "mkdir",
        summary: "Deprecated: create a folder directly",
        usage: "bb docs mkdir <path> [--vault <id>]",
      },
      {
        name: "move",
        summary: "Deprecated: move a path directly",
        usage: "bb docs move <from> <to> [--vault <id>]",
      },
      {
        name: "remove",
        summary: "Deprecated: remove a file or directory directly",
        usage: "bb docs remove <path> [--vault <id>] [--recursive]",
      },
    ],
    async run(argv, context) {
      const wantsJson = argv.includes("--json");
      if (
        argv.length === 0 ||
        argv[0] === "help" ||
        argv[0] === "--help" ||
        argv[0] === "-h"
      ) {
        return { exitCode: 0, stdout: DOCS_CLI_USAGE };
      }
      if (
        argv[0] === "status" &&
        (argv[1] === "help" || argv[1] === "--help" || argv[1] === "-h")
      ) {
        return { exitCode: 0, stdout: DOCS_STATUS_HELP };
      }
      try {
        const args = parseCli(argv);
        validateCliPositionals(args);
        let result: unknown;
        let exitCode = 0;
        let warning = "";
        if (args.command === "vaults") result = listVaults();
        else if (args.command === "vault-add")
          result = await handlers.createVault({
            name: args.positionals[0],
            rootPath: args.positionals[1],
            hostId: args.positionals[2],
          });
        else if (args.command === "vault-remove")
          result = await handlers.removeVault({ vaultId: args.positionals[0] });
        else if (args.command === "list")
          result = await notebookData(args.vaultId);
        else if (args.command === "read")
          result = await readFile(args.vaultId, args.positionals[0]);
        else if (args.command === "pull") {
          result = await runPull(args, context);
          if (isRecord(result) && result.outcome === "conflict") exitCode = 3;
          else if (isRecord(result) && result.outcome === "partial")
            exitCode = 1;
        } else if (args.command === "status") {
          result = await runPushPlan(args, context, false);
          if (isRecord(result) && result.outcome === "conflict") exitCode = 3;
          else if (
            isRecord(result) &&
            ((Array.isArray(result.writes) && result.writes.length > 0) ||
              (Array.isArray(result.deletes) && result.deletes.length > 0) ||
              (Array.isArray(result.directories) &&
                result.directories.length > 0) ||
              (Array.isArray(result.deleteDirectories) &&
                result.deleteDirectories.length > 0) ||
              (Array.isArray(result.warnings) && result.warnings.length > 0))
          )
            exitCode = 4;
        } else if (args.command === "push") {
          result = await runPushPlan(args, context, true);
          if (
            isRecord(result) &&
            (result.outcome === "conflict" || result.outcome === "partial")
          )
            exitCode = result.outcome === "conflict" ? 3 : 1;
        } else if (args.command === "write") {
          if (args.content === undefined)
            throw new CliUsageError("write requires --content <text>");
          result = await writeFile({
            vaultId: args.vaultId,
            rawPath: args.positionals[0],
            content: args.content,
          });
          warning =
            "Deprecated: direct Docs mutations will be removed; use bb docs pull, edit local files, then bb docs push.";
        } else if (args.command === "mkdir") {
          result = await handlers.createFolder({
            vaultId: args.vaultId,
            path: args.positionals[0],
          });
          warning =
            "Deprecated: direct Docs mutations will be removed; use bb docs pull, edit local files, then bb docs push.";
        } else if (args.command === "move") {
          result = await movePath(
            args.vaultId,
            args.positionals[0],
            args.positionals[1],
          );
          warning =
            "Deprecated: direct Docs mutations will be removed; use bb docs pull, edit local files, then bb docs push.";
        } else if (args.command === "remove") {
          result = await removePath(
            args.vaultId,
            args.positionals[0],
            args.recursive,
          );
          warning =
            "Deprecated: direct Docs mutations will be removed; use bb docs pull, edit local files, then bb docs push --delete.";
        } else {
          return {
            exitCode: 2,
            stderr: DOCS_CLI_USAGE,
          };
        }
        const output =
          args.command === "read" &&
          !args.json &&
          isRecord(result) &&
          typeof result.content === "string"
            ? result.content
            : args.json
              ? JSON.stringify(result, null, 2)
              : formatSyncHumanOutput(args.command, result);
        return {
          exitCode,
          stdout: output,
          ...(warning ? { stderr: warning } : {}),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const usageError = error instanceof CliUsageError;
        return {
          exitCode: usageError ? 2 : 1,
          ...(wantsJson
            ? {
                stdout: JSON.stringify(
                  {
                    outcome: "error",
                    error: {
                      code: usageError ? "usage_error" : "operation_failed",
                      message,
                    },
                  },
                  null,
                  2,
                ),
              }
            : { stderr: message }),
        };
      }
    },
  });

  bb.ui.registerMentionProvider({
    id: "note",
    label: "Docs",
    async search({ query }) {
      const needle = query.trim().toLowerCase();
      const matches = [];
      for (const vault of listVaults()) {
        for (const note of await listNoteSummaries(vault)) {
          if (
            needle &&
            !`${vault.name} ${note.title} ${note.preview} ${note.path}`
              .toLowerCase()
              .includes(needle)
          )
            continue;
          matches.push({
            id: `${vault.id}:${note.path}`,
            title: note.title,
            subtitle: `${vault.name} · ${note.preview || note.path}`,
            icon: "FileText",
          });
          if (matches.length === 25) return matches;
        }
      }
      return matches;
    },
    async resolve(itemId) {
      const separator = itemId.indexOf(":");
      if (separator < 1) throw new Error("Invalid note mention");
      const vaultId = itemId.slice(0, separator);
      const relativePath = itemId.slice(separator + 1);
      const file = await readFile(vaultId, relativePath);
      return {
        context: `Docs document (${vaultId}/${relativePath}):\n\n${file.content}`,
      };
    },
  });

  bb.background.service("watch-vaults", {
    async start(signal) {
      const watchers = new Map<string, VaultWatcher>();
      const retryNative = new Set<string>();
      let debounce: NodeJS.Timeout | null = null;
      let previous = "";
      try {
        while (!signal.aborted) {
          const vaults = listVaults();
          const localIds = new Set(
            vaults.filter((vault) => !vault.hostId).map((vault) => vault.id),
          );
          for (const [vaultId, watcher] of watchers) {
            if (!localIds.has(vaultId)) {
              watcher.close();
              watchers.delete(vaultId);
            }
          }
          for (const vault of vaults) {
            if (vault.hostId || watchers.has(vault.id)) continue;
            try {
              const watcher = watchVault(vault.rootPath, () => {
                if (debounce) clearTimeout(debounce);
                debounce = setTimeout(() => {
                  bb.realtime.publish("vault-changed", {
                    vaultId: vault.id,
                  });
                }, 250);
              });
              watcher.on("error", () => {
                watcher.close();
                watchers.delete(vault.id);
                retryNative.add(vault.id);
              });
              watchers.set(vault.id, watcher);
              retryNative.delete(vault.id);
            } catch (error) {
              if (!retryNative.has(vault.id)) {
                bb.log.warn(
                  `cannot watch ${vault.rootPath}; using polling: ${error instanceof Error ? error.message : String(error)}`,
                );
              }
              retryNative.add(vault.id);
            }
          }

          const snapshots: string[] = [];
          for (const vault of vaults) {
            if (watchers.has(vault.id)) continue;
            try {
              const { entries } = await listEntries(vault);
              const notes = await listNoteSummaries(vault, entries);
              snapshots.push(
                JSON.stringify({
                  id: vault.id,
                  entries: entries.map(
                    (entry) => `${entry.kind}:${entry.path}`,
                  ),
                  notes: notes.map(
                    (note) => `${note.path}:${note.modifiedAtMs}`,
                  ),
                }),
              );
            } catch {
              snapshots.push(`${vault.id}:offline`);
            }
          }
          const next = snapshots.join("\n");
          if (previous && previous !== next) {
            bb.realtime.publish("vault-changed", {});
          }
          previous = next;
          await waitForDelay(10_000, signal);
        }
      } finally {
        if (debounce) clearTimeout(debounce);
        for (const watcher of watchers.values()) watcher.close();
      }
    },
  });
}
