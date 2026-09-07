import fs from "node:fs";
import path from "node:path";
import {
  buildThreadEventRow,
  parseStoredThreadEvent,
  reasoningLevelSchema,
  threadEventTypeSchema,
  threadOriginKindSchema,
  threadScope,
  threadStatusSchema,
  threadVisibilitySchema,
  turnScope,
} from "@bb/domain";
import type {
  ThreadEventRow,
  ThreadEventScope,
  ThreadEventScopeKind,
} from "@bb/domain";
import { z } from "zod";

const corpusScopeKindSchema = z.enum(["thread", "turn"]);
const corpusScopeKindCoversDomain: ThreadEventScopeKind extends z.infer<
  typeof corpusScopeKindSchema
>
  ? z.infer<typeof corpusScopeKindSchema> extends ThreadEventScopeKind
    ? true
    : false
  : false = true;
void corpusScopeKindCoversDomain;

export const PROVIDER_CORPUS_DIR_ENV = "BB_PROVIDER_CORPUS_DIR";

const corpusPathSegmentSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "must be one safe path segment");

const corpusManifestThreadSchema = z.object({
  id: corpusPathSegmentSchema,
  provider: corpusPathSegmentSchema,
  events: z.number().int().nonnegative(),
  reasons: z.array(z.string().min(1)),
});

const corpusManifestSchema = z.object({
  providers: z.array(z.string().min(1)),
  threads: z.array(corpusManifestThreadSchema),
});

const corpusThreadRowSchema = z.object({
  id: corpusPathSegmentSchema,
  provider_id: corpusPathSegmentSchema,
  title: z.string().nullable(),
  status: threadStatusSchema,
  created_at: z.number().int(),
  updated_at: z.number().int(),
  archived_at: z.number().int().nullable(),
  deleted_at: z.number().int().nullable(),
  parent_thread_id: z.string().nullable(),
  origin_kind: threadOriginKindSchema.nullable(),
  visibility: threadVisibilitySchema,
  model_override: z.string().nullable(),
  reasoning_level_override: reasoningLevelSchema.nullable(),
});

const corpusMetaSchema = z.object({
  thread: corpusThreadRowSchema,
  features: z.record(z.string(), z.union([z.number(), z.string()])),
  reasons: z.array(z.string().min(1)),
  event_rows: z.number().int().nonnegative(),
});

const corpusEventRowSchema = z.object({
  id: z.string().min(1),
  thread_id: z.string().min(1),
  environment_id: z.string().nullable(),
  scope_kind: corpusScopeKindSchema,
  turn_id: z.string().nullable(),
  provider_thread_id: z.string().nullable(),
  sequence: z.number().int().nonnegative(),
  type: threadEventTypeSchema,
  item_id: z.string().nullable(),
  item_kind: z.string().nullable(),
  data: z.string(),
  created_at: z.number().int(),
  parent_tool_call_id: z.string().nullable(),
});

export type CorpusManifestThread = z.infer<typeof corpusManifestThreadSchema>;

export interface CorpusThreadRow {
  id: string;
  providerId: string;
  title: string | null;
  status: z.infer<typeof threadStatusSchema>;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  deletedAt: number | null;
  parentThreadId: string | null;
  originKind: z.infer<typeof threadOriginKindSchema> | null;
  visibility: z.infer<typeof threadVisibilitySchema>;
  modelOverride: string | null;
  reasoningLevelOverride: z.infer<typeof reasoningLevelSchema> | null;
}

export interface CorpusStoredEventRow {
  id: string;
  threadId: string;
  environmentId: string | null;
  scopeKind: ThreadEventScopeKind;
  turnId: string | null;
  providerThreadId: string | null;
  sequence: number;
  type: z.infer<typeof threadEventTypeSchema>;
  itemId: string | null;
  itemKind: string | null;
  data: string;
  createdAt: number;
  parentToolCallId: string | null;
}

export interface CorpusThread {
  id: string;
  provider: string;
  reasons: string[];
  features: Record<string, number | string>;
  thread: CorpusThreadRow;
  eventRows: CorpusStoredEventRow[];
  events: ThreadEventRow[];
}

export interface ListCorpusThreadsArgs {
  provider?: string;
  reasons?: readonly string[];
}

export function resolveProviderCorpusDir(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const value = env[PROVIDER_CORPUS_DIR_ENV];
  if (value === undefined || value.trim().length === 0) {
    return null;
  }
  return path.resolve(value);
}

export function corpusAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  const dir = resolveProviderCorpusDir(env);
  return dir !== null && fs.existsSync(path.join(dir, "manifest.json"));
}

function requireProviderCorpusDir(): string {
  const dir = resolveProviderCorpusDir();
  if (dir === null) {
    throw new Error(
      `${PROVIDER_CORPUS_DIR_ENV} is not set; guard the suite with corpusAvailable()`,
    );
  }
  return dir;
}

function readJsonFile(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function listCorpusThreads(
  args: ListCorpusThreadsArgs = {},
): CorpusManifestThread[] {
  const dir = requireProviderCorpusDir();
  const manifest = corpusManifestSchema.parse(
    readJsonFile(path.join(dir, "manifest.json")),
  );
  return manifest.threads.filter((thread) => {
    if (args.provider !== undefined && thread.provider !== args.provider) {
      return false;
    }
    if (
      args.reasons !== undefined &&
      !args.reasons.some((reason) => thread.reasons.includes(reason))
    ) {
      return false;
    }
    return true;
  });
}

function toCorpusThreadRow(
  row: z.infer<typeof corpusThreadRowSchema>,
): CorpusThreadRow {
  return {
    id: row.id,
    providerId: row.provider_id,
    title: row.title,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
    deletedAt: row.deleted_at,
    parentThreadId: row.parent_thread_id,
    originKind: row.origin_kind,
    visibility: row.visibility,
    modelOverride: row.model_override,
    reasoningLevelOverride: row.reasoning_level_override,
  };
}

function toCorpusStoredEventRow(
  row: z.infer<typeof corpusEventRowSchema>,
): CorpusStoredEventRow {
  return {
    id: row.id,
    threadId: row.thread_id,
    environmentId: row.environment_id,
    scopeKind: row.scope_kind,
    turnId: row.turn_id,
    providerThreadId: row.provider_thread_id,
    sequence: row.sequence,
    type: row.type,
    itemId: row.item_id,
    itemKind: row.item_kind,
    data: row.data,
    createdAt: row.created_at,
    parentToolCallId: row.parent_tool_call_id,
  };
}

function toStoredEventScope(row: CorpusStoredEventRow): ThreadEventScope {
  if (row.scopeKind === "thread") {
    return threadScope();
  }
  if (row.turnId === null) {
    throw new Error(
      `Corpus event ${row.id} (#${row.sequence}, ${row.type}) has turn scope without turn_id`,
    );
  }
  return turnScope(row.turnId);
}

export function decodeCorpusStoredEventRow(
  row: CorpusStoredEventRow,
): ThreadEventRow {
  const scope = toStoredEventScope(row);
  const data: unknown = JSON.parse(row.data);
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(
      `Corpus event ${row.id} (#${row.sequence}, ${row.type}) has malformed data`,
    );
  }
  const event = parseStoredThreadEvent({
    type: row.type,
    data: z.record(z.string(), z.unknown()).parse(data),
    threadId: row.threadId,
    providerThreadId: row.providerThreadId,
    scope,
  });
  return buildThreadEventRow({
    id: row.id,
    scope,
    threadId: row.threadId,
    seq: row.sequence,
    createdAt: row.createdAt,
    event,
  });
}

function sameStringSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    [...left].sort().join("\0") === [...right].sort().join("\0")
  );
}

export function loadCorpusThread(threadId: string): CorpusThread {
  const dir = requireProviderCorpusDir();
  const entry = listCorpusThreads().find((thread) => thread.id === threadId);
  if (entry === undefined) {
    throw new Error(`Corpus thread ${threadId} is not in manifest.json`);
  }
  const threadDir = path.join(dir, "threads", entry.provider, entry.id);
  const meta = corpusMetaSchema.parse(
    readJsonFile(path.join(threadDir, "meta.json")),
  );
  if (meta.thread.id !== entry.id) {
    throw new Error(
      `Corpus thread ${threadId}: meta.json names thread ${meta.thread.id}`,
    );
  }
  if (meta.thread.provider_id !== entry.provider) {
    throw new Error(
      `Corpus thread ${threadId}: meta.json names provider ${meta.thread.provider_id}; manifest says ${entry.provider}`,
    );
  }
  if (!sameStringSet(meta.reasons, entry.reasons)) {
    throw new Error(
      `Corpus thread ${threadId}: meta.json reasons [${meta.reasons.join(", ")}] differ from manifest [${entry.reasons.join(", ")}]`,
    );
  }
  const ndjson = fs.readFileSync(path.join(threadDir, "events.ndjson"), "utf8");
  const eventRows: CorpusStoredEventRow[] = [];
  for (const line of ndjson.split("\n")) {
    if (line.length === 0) {
      continue;
    }
    const row = toCorpusStoredEventRow(
      corpusEventRowSchema.parse(JSON.parse(line)),
    );
    if (row.threadId !== entry.id) {
      throw new Error(
        `Corpus thread ${threadId}: event ${row.id} (#${row.sequence}) belongs to thread ${row.threadId}`,
      );
    }
    eventRows.push(row);
  }
  if (
    eventRows.length !== meta.event_rows ||
    eventRows.length !== entry.events
  ) {
    throw new Error(
      `Corpus thread ${threadId} has ${eventRows.length} event rows; meta.json says ${meta.event_rows}, manifest says ${entry.events}`,
    );
  }
  return {
    id: meta.thread.id,
    provider: meta.thread.provider_id,
    reasons: meta.reasons,
    features: meta.features,
    thread: toCorpusThreadRow(meta.thread),
    eventRows,
    events: eventRows.map((row) => decodeCorpusStoredEventRow(row)),
  };
}
