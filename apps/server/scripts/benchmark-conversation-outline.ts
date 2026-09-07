import { performance } from "node:perf_hooks";
import {
  createConnection,
  getLatestStoredConversationOutlineSequence,
  getLatestThreadSequence,
  getThread,
  listStoredConversationOutlineEventRows,
  type DbConnection,
} from "@bb/db";
import { threadConversationOutlineResponseSchema } from "@bb/server-contract";
import { Hono } from "hono";
import { registerThreadDataRoutes } from "../src/routes/threads/data.js";
import { buildThreadConversationOutline } from "../src/services/threads/timeline.js";
import type { AppDeps } from "../src/types.js";
import { createTestAppHarness } from "../test/helpers/test-app.js";

type SqliteParameter = string | number | bigint | Buffer | null;

interface CapturedStatement {
  params: SqliteParameter[];
  sql: string;
}

interface QueryPlanRow {
  detail: string;
}

interface ThreadEventStatsRow {
  eventCount: number;
  payloadBytes: number;
}

interface TableRow {
  name: string;
}

function parsePositiveInteger(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function summarize(values: readonly number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction: number) =>
    sorted[Math.ceil(sorted.length * fraction) - 1] ?? 0;
  return {
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    maxMs: sorted.at(-1) ?? 0,
  };
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function summarizeRounded(values: readonly number[]) {
  const summary = summarize(values);
  return {
    p50Ms: round(summary.p50Ms),
    p95Ms: round(summary.p95Ms),
    maxMs: round(summary.maxMs),
  };
}

function captureOutlineQuery(
  db: DbConnection,
  threadId: string,
): CapturedStatement {
  const captured: CapturedStatement[] = [];
  const raw = db.$client;
  const originalPrepare = raw.prepare.bind(raw);
  Object.defineProperty(raw, "prepare", {
    configurable: true,
    writable: true,
    value: (source: string) => {
      const statement = originalPrepare(source);
      const originalAll = statement.all.bind(statement);
      statement.all = (...params: unknown[]) => {
        captured.push({
          params: params as SqliteParameter[],
          sql: source,
        });
        return originalAll(...params);
      };
      return statement;
    },
  });
  try {
    listStoredConversationOutlineEventRows(db, {
      sequenceStart: 0,
      threadId,
    });
  } finally {
    Object.defineProperty(raw, "prepare", {
      configurable: true,
      writable: true,
      value: originalPrepare,
    });
  }
  const outline = captured.find((statement) =>
    statement.sql.includes("union all"),
  );
  if (outline === undefined) {
    throw new Error("Conversation outline query was not captured");
  }
  return outline;
}

function explainQueryPlan(
  db: DbConnection,
  statement: CapturedStatement,
): string[] {
  return db.$client
    .prepare<SqliteParameter[], QueryPlanRow>(
      `EXPLAIN QUERY PLAN ${statement.sql}`,
    )
    .all(...statement.params)
    .map((row) => row.detail);
}

function createRouteApp(deps: AppDeps) {
  const app = new Hono();
  registerThreadDataRoutes(app, deps);
  return app;
}

function hasStoredOutlineTable(db: DbConnection): boolean {
  return (
    db.$client
      .prepare<[], TableRow>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'thread_conversation_outlines'",
      )
      .get() !== undefined
  );
}

function deleteStoredOutline(db: DbConnection, threadId: string): void {
  if (!hasStoredOutlineTable(db)) {
    return;
  }
  db.$client
    .prepare("DELETE FROM thread_conversation_outlines WHERE thread_id = ?")
    .run(threadId);
}

async function readOutline(
  app: ReturnType<typeof createRouteApp>,
  threadId: string,
) {
  const startedAt = performance.now();
  const response = await app.request(
    `/threads/${threadId}/conversation-outline`,
  );
  const durationMs = performance.now() - startedAt;
  if (!response.ok) {
    throw new Error(`Outline route returned ${response.status}`);
  }
  const outline = threadConversationOutlineResponseSchema.parse(
    await response.json(),
  );
  return { durationMs, outline };
}

async function readOutlineWithTimerDelay(
  app: ReturnType<typeof createRouteApp>,
  threadId: string,
) {
  const timerStartedAt = performance.now();
  const delayPromise = new Promise<number>((resolve) => {
    setTimeout(() => resolve(performance.now() - timerStartedAt), 0);
  });
  const result = await readOutline(app, threadId);
  return { ...result, timerDelayMs: await delayPromise };
}

async function main(): Promise<void> {
  const [databasePath, threadId, coldValue, warmValue, rawValue] =
    process.argv.slice(2);
  if (databasePath === undefined || threadId === undefined) {
    throw new Error(
      "Usage: benchmark-conversation-outline.ts <database-path> <thread-id> [cold-iterations] [warm-iterations] [raw-iterations]",
    );
  }
  const coldIterations = parsePositiveInteger(coldValue ?? "20", "cold");
  const warmIterations = parsePositiveInteger(warmValue ?? "100", "warm");
  const rawIterations = parsePositiveInteger(rawValue ?? "20", "raw");
  const db = createConnection(databasePath);
  const harness = await createTestAppHarness();

  try {
    const thread = getThread(db, threadId);
    if (thread === null) {
      throw new Error(`Thread ${threadId} does not exist`);
    }
    const deps: AppDeps = { ...harness.deps, db };
    const eventStats = db.$client
      .prepare<[string], ThreadEventStatsRow>(
        "SELECT COUNT(*) AS eventCount, COALESCE(SUM(length(data)), 0) AS payloadBytes FROM events WHERE thread_id = ?",
      )
      .get(threadId);
    if (eventStats === undefined) {
      throw new Error("Thread event statistics were not returned");
    }
    const maxSeq = getLatestThreadSequence(db, { threadId });
    const outlineSequence = getLatestStoredConversationOutlineSequence(db, {
      threadId,
    });

    const queryDurations: number[] = [];
    let selectedRows = listStoredConversationOutlineEventRows(db, {
      sequenceStart: 0,
      threadId,
    });
    for (let index = 0; index < rawIterations; index += 1) {
      const startedAt = performance.now();
      selectedRows = listStoredConversationOutlineEventRows(db, {
        sequenceStart: 0,
        threadId,
      });
      queryDurations.push(performance.now() - startedAt);
    }

    const buildDurations: number[] = [];
    let built = buildThreadConversationOutline(db, thread, { maxSeq });
    for (let index = 0; index < rawIterations; index += 1) {
      const startedAt = performance.now();
      built = buildThreadConversationOutline(db, thread, { maxSeq });
      buildDurations.push(performance.now() - startedAt);
    }

    const coldDurations: number[] = [];
    const coldTimerDelays: number[] = [];
    for (let index = 0; index < coldIterations; index += 1) {
      deleteStoredOutline(db, threadId);
      const result = await readOutlineWithTimerDelay(
        createRouteApp(deps),
        threadId,
      );
      coldDurations.push(result.durationMs);
      coldTimerDelays.push(result.timerDelayMs);
    }

    deleteStoredOutline(db, threadId);
    const warmApp = createRouteApp(deps);
    await readOutline(warmApp, threadId);
    const warmDurations: number[] = [];
    for (let index = 0; index < warmIterations; index += 1) {
      warmDurations.push((await readOutline(warmApp, threadId)).durationMs);
    }

    deleteStoredOutline(db, threadId);
    await readOutline(createRouteApp(deps), threadId);
    const reopenedDurations: number[] = [];
    const reopenedTimerDelays: number[] = [];
    for (let index = 0; index < coldIterations; index += 1) {
      const result = await readOutlineWithTimerDelay(
        createRouteApp(deps),
        threadId,
      );
      reopenedDurations.push(result.durationMs);
      reopenedTimerDelays.push(result.timerDelayMs);
    }

    const statement = captureOutlineQuery(db, threadId);
    console.log(
      JSON.stringify(
        {
          databasePath,
          thread: {
            id: thread.id,
            status: thread.status,
            eventCount: eventStats.eventCount,
            payloadBytes: eventStats.payloadBytes,
            maxSeq,
            outlineSequence,
          },
          outline: {
            itemCount: built.items.length,
            responseBytes: Buffer.byteLength(JSON.stringify(built)),
          },
          iterations: {
            cold: coldIterations,
            warm: warmIterations,
            raw: rawIterations,
          },
          definitions: {
            cold: "fresh in-process route cache, no durable outline, warm SQLite and OS page caches",
            warm: "same route instance after one priming outline read",
            reopened:
              "fresh in-process route cache after one stable outline read",
          },
          route: {
            cold: summarizeRounded(coldDurations),
            warm: summarizeRounded(warmDurations),
            reopened: summarizeRounded(reopenedDurations),
          },
          timerDelay: {
            cold: summarizeRounded(coldTimerDelays),
            reopened: summarizeRounded(reopenedTimerDelays),
          },
          rawQuery: {
            selectedRows: selectedRows.length,
            selectedPayloadBytes: selectedRows.reduce(
              (sum, row) => sum + Buffer.byteLength(row.data),
              0,
            ),
            timing: summarizeRounded(queryDurations),
            plan: explainQueryPlan(db, statement),
          },
          rawBuild: summarizeRounded(buildDurations),
        },
        null,
        2,
      ),
    );
  } finally {
    db.$client.close();
    await harness.cleanup();
    harness.db.$client.close();
  }
}

await main();
