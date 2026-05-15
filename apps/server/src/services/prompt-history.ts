import {
  createPromptHistoryEntry,
  listQueuedThreadMessages,
  listStoredProjectPromptHistoryRows,
  listStoredThreadPromptHistoryRows,
  type DbQueryConnection,
  type QueuedThreadMessageRow,
  type StoredPromptHistoryEntryRow,
} from "@bb/db";
import {
  promptInputSchema,
  takeVisiblePromptHistoryEntries,
  type PromptHistoryEntry,
  type PromptHistoryScope,
  type Thread,
  type ThreadTurnInitiator,
  type TurnRequestTarget,
} from "@bb/domain";
import { z } from "zod";
import { toThreadQueuedMessage } from "./threads/thread-queued-messages.js";
import type { AppDeps, ServerLogger } from "../types.js";

const storedPromptHistoryInputSchema = z.array(promptInputSchema).min(1);

interface PromptHistoryArgs {
  limit: number;
}

interface ProjectPromptHistoryArgs extends PromptHistoryArgs {
  projectId: string;
}

interface ThreadPromptHistoryArgs extends PromptHistoryArgs {
  threadId: string;
}

type PromptHistoryServiceDeps = Pick<AppDeps, "db" | "logger">;
type PromptHistoryEntryInput = PromptHistoryEntry["input"];
type PromptHistoryScopeThread = Pick<
  Thread,
  "automationId" | "parentThreadId" | "type"
>;
type PromptHistoryRecordThread = Pick<
  Thread,
  "automationId" | "id" | "parentThreadId" | "projectId" | "type"
>;

interface PromptHistoryRecordDeps {
  db: DbQueryConnection;
}

type InternalPromptHistoryEntryState = "accepted" | "queued";

interface InternalPromptHistoryEntry extends PromptHistoryEntry {
  state: InternalPromptHistoryEntryState;
}

type PromptHistoryRowLogContext = Record<string, number | string>;

interface ResolveAcceptedPromptHistoryScopeArgs {
  initiator: ThreadTurnInitiator;
  target: TurnRequestTarget;
  thread: PromptHistoryScopeThread;
}

interface RecordAcceptedPromptHistoryEntryArgs {
  initiator: ThreadTurnInitiator;
  input: PromptHistoryEntryInput;
  requestSequence: number;
  target: TurnRequestTarget;
  thread: PromptHistoryRecordThread;
}

interface BuildPromptHistoryEntriesArgs<TRow> {
  buildEntry: (row: TRow) => InternalPromptHistoryEntry;
  describeRow: (row: TRow) => PromptHistoryRowLogContext;
  logger: ServerLogger;
  rows: readonly TRow[];
}

function parseStoredPromptHistoryInput(
  row: StoredPromptHistoryEntryRow,
): PromptHistoryEntryInput {
  const input = JSON.parse(row.input);
  return storedPromptHistoryInputSchema.parse(input);
}

function buildAcceptedPromptHistoryEntry(
  row: StoredPromptHistoryEntryRow,
): InternalPromptHistoryEntry {
  return {
    id: row.id,
    createdAt: row.createdAt,
    input: parseStoredPromptHistoryInput(row),
    state: "accepted",
  };
}

function buildQueuedPromptHistoryEntry(
  row: QueuedThreadMessageRow,
): InternalPromptHistoryEntry {
  const queuedMessage = toThreadQueuedMessage(row);
  return {
    id: `queued-message:${queuedMessage.id}`,
    createdAt: queuedMessage.createdAt,
    input: queuedMessage.content,
    state: "queued",
  };
}

function comparePromptHistoryEntries(
  left: InternalPromptHistoryEntry,
  right: InternalPromptHistoryEntry,
): number {
  if (left.createdAt !== right.createdAt) {
    return right.createdAt - left.createdAt;
  }
  if (left.state !== right.state) {
    // Keep queued messages ahead of accepted rows on timestamp ties so recall
    // prefers the still-editable queued version.
    return left.state === "queued" ? -1 : 1;
  }
  return right.id.localeCompare(left.id);
}

function toPromptHistoryEntry(
  entry: InternalPromptHistoryEntry,
): PromptHistoryEntry {
  return {
    id: entry.id,
    createdAt: entry.createdAt,
    input: entry.input,
  };
}

function buildPromptHistoryEntries<TRow>({
  buildEntry,
  describeRow,
  logger,
  rows,
}: BuildPromptHistoryEntriesArgs<TRow>): InternalPromptHistoryEntry[] {
  const entries: InternalPromptHistoryEntry[] = [];

  for (const row of rows) {
    try {
      entries.push(buildEntry(row));
    } catch (error) {
      logger.warn(
        {
          ...describeRow(row),
          err: error,
        },
        "Skipping malformed prompt history row",
      );
    }
  }

  return entries;
}

function resolveAcceptedPromptHistoryScope(
  args: ResolveAcceptedPromptHistoryScopeArgs,
): PromptHistoryScope | null {
  if (args.initiator !== "user") {
    return null;
  }

  if (args.target.kind !== "thread-start") {
    return "thread";
  }

  if (
    args.thread.type !== "standard" ||
    args.thread.parentThreadId !== null ||
    args.thread.automationId !== null
  ) {
    return null;
  }

  return "project";
}

function buildVisibleThreadPromptHistory(
  queuedEntries: readonly InternalPromptHistoryEntry[],
  acceptedEntries: readonly InternalPromptHistoryEntry[],
  limit: number,
): PromptHistoryEntry[] {
  const mergedEntries = [...queuedEntries, ...acceptedEntries].sort(
    comparePromptHistoryEntries,
  );
  return takeVisiblePromptHistoryEntries({
    entries: mergedEntries,
    limit,
  }).map(toPromptHistoryEntry);
}

export function listProjectPromptHistory(
  deps: PromptHistoryServiceDeps,
  args: ProjectPromptHistoryArgs,
): PromptHistoryEntry[] {
  const acceptedEntries = buildPromptHistoryEntries({
    rows: listStoredProjectPromptHistoryRows(deps.db, {
      projectId: args.projectId,
      limit: args.limit,
    }),
    logger: deps.logger,
    buildEntry: buildAcceptedPromptHistoryEntry,
    describeRow: (row) => ({
      entryId: row.id,
      requestSequence: row.requestSequence,
      threadId: row.threadId,
    }),
  });

  return takeVisiblePromptHistoryEntries({
    entries: acceptedEntries,
    limit: args.limit,
  }).map(toPromptHistoryEntry);
}

export function listThreadPromptHistory(
  deps: PromptHistoryServiceDeps,
  args: ThreadPromptHistoryArgs,
): PromptHistoryEntry[] {
  const queuedEntries = buildPromptHistoryEntries({
    rows: listQueuedThreadMessages(deps.db, args.threadId),
    logger: deps.logger,
    buildEntry: buildQueuedPromptHistoryEntry,
    describeRow: (row) => ({
      queuedMessageId: row.id,
      threadId: row.threadId,
    }),
  });
  const acceptedEntries = buildPromptHistoryEntries({
    rows: listStoredThreadPromptHistoryRows(deps.db, {
      threadId: args.threadId,
      limit: args.limit,
    }),
    logger: deps.logger,
    buildEntry: buildAcceptedPromptHistoryEntry,
    describeRow: (row) => ({
      entryId: row.id,
      requestSequence: row.requestSequence,
      threadId: row.threadId,
    }),
  });

  return buildVisibleThreadPromptHistory(
    queuedEntries,
    acceptedEntries,
    args.limit,
  );
}

export function recordAcceptedPromptHistoryEntry(
  deps: PromptHistoryRecordDeps,
  args: RecordAcceptedPromptHistoryEntryArgs,
): boolean {
  const scope = resolveAcceptedPromptHistoryScope({
    initiator: args.initiator,
    target: args.target,
    thread: args.thread,
  });
  if (scope === null) {
    return false;
  }

  createPromptHistoryEntry(deps.db, {
    projectId: args.thread.projectId,
    threadId: args.thread.id,
    scope,
    requestSequence: args.requestSequence,
    input: args.input,
  });
  return true;
}
