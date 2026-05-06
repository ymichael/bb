import Database from "better-sqlite3";
import {
  createDebouncedCallbackScheduler,
  canonicalizeProducerEventPayload,
  hostDaemonProducerEventIdSchema,
  threadEventSchema,
  type HostDaemonProducerEventId,
  type ThreadEvent,
} from "@bb/domain";
import {
  HOST_DAEMON_PROTOCOL_VERSION,
  type HostDaemonEventBatchResponse,
  type HostDaemonEventEnvelope,
  type HostDaemonRejectedEvent,
} from "@bb/host-daemon-contract";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { HostDaemonLogger } from "./logger.js";

const DEFAULT_DEBOUNCE_MS = 100;
const DEFAULT_MAX_WAIT_MS = 500;
const EVENT_SPOOL_SCHEMA_VERSION = 1;
const EVENT_SPOOL_FILE_NAME = "event-spool.sqlite";
const MAX_CONSECUTIVE_NO_PROGRESS_FLUSHES = 3;
const PRODUCER_EVENT_ID_ALPHABET = "23456789abcdefghijkmnpqrstuvwxyz";

interface EventSpoolRow {
  localOrder: number;
  producerEventId: string;
  threadId: string;
  eventType: string;
  payloadJson: string;
  payloadHash: string;
  createdAt: string;
  lastPostAttemptAt: string | null;
  postAttemptCount: number;
}

interface TableInfoRow {
  cid: number;
  dflt_value: string | null;
  name: string;
  notnull: number;
  pk: number;
  type: string;
}

interface TableNameRow {
  name: string;
}

interface ExpectedColumn {
  dfltValue: string | null;
  name: string;
  notnull: number;
  pk: number;
  type: string;
}

interface SnapshotAttemptResult {
  events: BufferedEvent[];
  producerEventIds: HostDaemonProducerEventId[];
}

interface SettlePostedBatchArgs {
  acceptedEvents: HostDaemonEventBatchResponse["acceptedEvents"];
  rejectedEvents: HostDaemonEventBatchResponse["rejectedEvents"];
  sentProducerEventIds: readonly HostDaemonProducerEventId[];
}

interface SettlePostedBatchResult {
  deletedCount: number;
  rejectedEvents: HostDaemonRejectedEvent[];
}

interface CreateBufferedEventRecordArgs {
  input: BufferedEventInput;
  producerEventId: HostDaemonProducerEventId;
  createdAt: string;
}

interface BufferedEventLogSummary {
  eventType: string;
  localOrder: number;
  payloadHash: string;
  producerEventId: HostDaemonProducerEventId;
  threadId: string;
}

interface RejectedEventLogSummary {
  producerEventId: HostDaemonProducerEventId;
  reason: HostDaemonRejectedEvent["reason"];
  threadId: string;
}

export interface BufferedEventInput {
  threadId: string;
  event: ThreadEvent;
}

export interface BufferedEvent extends HostDaemonEventEnvelope {
  createdAt: string;
  localOrder: number;
  payloadHash: string;
}

export interface EventPostAcceptedResult {
  acceptedEvents: HostDaemonEventBatchResponse["acceptedEvents"];
  rejectedEvents: HostDaemonEventBatchResponse["rejectedEvents"];
  kind: "accepted";
}

export type EventPostResult = EventPostAcceptedResult;

export interface CreateEventBufferOptions {
  dataDir: string;
  logger: Pick<HostDaemonLogger, "error" | "warn">;
  postEvents: (events: HostDaemonEventEnvelope[]) => Promise<EventPostResult>;
  createProducerEventId?: () => HostDaemonProducerEventId;
  debounceMs?: number;
  maxWaitMs?: number;
  now?: () => number;
}

export interface EventBuffer {
  /**
   * Buffered events are retained durably until the server acknowledges them.
   * This buffer is intentionally uncapped: during outages we prefer host-local
   * storage pressure and retry backoff over silently dropping daemon events.
   */
  push(event: BufferedEventInput): BufferedEvent;
  flush(): Promise<void>;
  depth(): number;
  snapshot(): BufferedEvent[];
  dispose(): Promise<void>;
}

export class EventBufferDisposedError extends Error {
  constructor() {
    super("Cannot push to disposed event buffer");
    this.name = "EventBufferDisposedError";
  }
}

const expectedOutboundEventColumns: ExpectedColumn[] = [
  {
    dfltValue: null,
    name: "localOrder",
    notnull: 0,
    pk: 1,
    type: "INTEGER",
  },
  {
    dfltValue: null,
    name: "producerEventId",
    notnull: 1,
    pk: 0,
    type: "TEXT",
  },
  {
    dfltValue: null,
    name: "threadId",
    notnull: 1,
    pk: 0,
    type: "TEXT",
  },
  {
    dfltValue: null,
    name: "eventType",
    notnull: 1,
    pk: 0,
    type: "TEXT",
  },
  {
    dfltValue: null,
    name: "payloadJson",
    notnull: 1,
    pk: 0,
    type: "TEXT",
  },
  {
    dfltValue: null,
    name: "payloadHash",
    notnull: 1,
    pk: 0,
    type: "TEXT",
  },
  {
    dfltValue: null,
    name: "createdAt",
    notnull: 1,
    pk: 0,
    type: "TEXT",
  },
  {
    dfltValue: null,
    name: "lastPostAttemptAt",
    notnull: 0,
    pk: 0,
    type: "TEXT",
  },
  {
    dfltValue: "0",
    name: "postAttemptCount",
    notnull: 1,
    pk: 0,
    type: "INTEGER",
  },
];

function isWaitingForApprovalItemEvent(event: ThreadEvent): boolean {
  if (event.type !== "item/started" && event.type !== "item/completed") {
    return false;
  }

  if (
    event.item.type !== "commandExecution" &&
    event.item.type !== "fileChange"
  ) {
    return false;
  }

  return event.item.approvalStatus === "waiting_for_approval";
}

export function shouldFlushThreadEventImmediately(event: ThreadEvent): boolean {
  if (event.type === "item/completed") {
    return true;
  }

  if (
    event.type === "turn/completed" ||
    event.type === "system/error" ||
    event.type === "system/thread/interrupted"
  ) {
    return true;
  }

  if (event.type === "provider/error") {
    return event.willRetry !== true;
  }

  return isWaitingForApprovalItemEvent(event);
}

function createHostDaemonProducerEventId(): HostDaemonProducerEventId {
  const bytes = randomBytes(20);
  let suffix = "";
  for (const byte of bytes) {
    suffix += PRODUCER_EVENT_ID_ALPHABET.charAt(
      byte % PRODUCER_EVENT_ID_ALPHABET.length,
    );
  }
  return hostDaemonProducerEventIdSchema.parse(`hdevt_${suffix}`);
}

function formatTimestamp(value: number): string {
  return new Date(value).toISOString();
}

function hashPayload(args: { event: ThreadEvent; threadId: string }): string {
  return createHash("sha256")
    .update(
      canonicalizeProducerEventPayload({
        event: args.event,
        protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
        threadId: args.threadId,
      }),
    )
    .digest("hex");
}

function toPostEvent(event: BufferedEvent): HostDaemonEventEnvelope {
  return {
    producerEventId: event.producerEventId,
    threadId: event.threadId,
    event: event.event,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readUserVersion(db: Database.Database): number {
  const rows = db.pragma("user_version");
  if (!Array.isArray(rows)) {
    throw new Error("Event spool schema version returned unexpected rows");
  }
  const row = rows[0];
  if (
    !isRecord(row) ||
    !("user_version" in row) ||
    typeof row.user_version !== "number"
  ) {
    throw new Error("Event spool schema version could not be read");
  }
  return row.user_version;
}

function runIntegrityCheck(db: Database.Database): void {
  const rows = db.pragma("integrity_check");
  if (!Array.isArray(rows)) {
    throw new Error("Event spool integrity check returned unexpected rows");
  }
  if (rows.length !== 1) {
    throw new Error("Event spool integrity check returned unexpected rows");
  }
  const row = rows[0];
  if (
    !isRecord(row) ||
    !("integrity_check" in row) ||
    typeof row.integrity_check !== "string"
  ) {
    throw new Error("Event spool integrity check returned unexpected shape");
  }
  if (row.integrity_check !== "ok") {
    throw new Error(
      `Event spool integrity check failed: ${row.integrity_check}`,
    );
  }
}

function createSchema(db: Database.Database): void {
  const createSchemaTransaction = db.transaction(() => {
    db.exec(`
      CREATE TABLE outbound_events (
        localOrder INTEGER PRIMARY KEY AUTOINCREMENT,
        producerEventId TEXT NOT NULL UNIQUE,
        threadId TEXT NOT NULL,
        eventType TEXT NOT NULL,
        payloadJson TEXT NOT NULL,
        payloadHash TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        lastPostAttemptAt TEXT,
        postAttemptCount INTEGER NOT NULL DEFAULT 0
      );
    `);
    db.pragma(`user_version = ${EVENT_SPOOL_SCHEMA_VERSION}`);
  });
  createSchemaTransaction();
}

function outboundEventsTableExists(db: Database.Database): boolean {
  const row = db
    .prepare<
      [],
      TableNameRow
    >("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'outbound_events'")
    .get();
  return row !== undefined;
}

function validateSchema(db: Database.Database): void {
  const schemaVersion = readUserVersion(db);
  if (schemaVersion !== EVENT_SPOOL_SCHEMA_VERSION) {
    throw new Error(
      `Event spool schema version mismatch: expected ${EVENT_SPOOL_SCHEMA_VERSION}, got ${schemaVersion}`,
    );
  }

  const rows = db
    .prepare<[], TableInfoRow>("PRAGMA table_info(outbound_events)")
    .all();
  if (rows.length !== expectedOutboundEventColumns.length) {
    throw new Error(
      "Event spool schema mismatch: outbound_events columns differ",
    );
  }

  for (const [index, expected] of expectedOutboundEventColumns.entries()) {
    const actual = rows[index];
    if (
      actual === undefined ||
      actual.name !== expected.name ||
      actual.type.toUpperCase() !== expected.type ||
      actual.notnull !== expected.notnull ||
      actual.pk !== expected.pk ||
      actual.dflt_value !== expected.dfltValue
    ) {
      throw new Error(`Event spool schema mismatch at column ${expected.name}`);
    }
  }
}

function openSpoolDatabase(dataDir: string): Database.Database {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, EVENT_SPOOL_FILE_NAME));
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = FULL");
    runIntegrityCheck(db);

    const schemaVersion = readUserVersion(db);
    if (schemaVersion === 0) {
      if (outboundEventsTableExists(db)) {
        throw new Error(
          "Event spool schema mismatch: outbound_events exists with schema version 0",
        );
      }
      createSchema(db);
    }
    validateSchema(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function toBufferedEvent(row: EventSpoolRow): BufferedEvent {
  const producerEventId = hostDaemonProducerEventIdSchema.parse(
    row.producerEventId,
  );
  const event = threadEventSchema.parse(JSON.parse(row.payloadJson));
  if (event.type !== row.eventType) {
    throw new Error("Event spool payload type does not match eventType");
  }
  if (event.threadId !== row.threadId) {
    throw new Error("Event spool payload threadId does not match row threadId");
  }
  const expectedHash = hashPayload({
    event,
    threadId: row.threadId,
  });
  if (row.payloadHash !== expectedHash) {
    throw new Error("Event spool payload hash mismatch");
  }
  return {
    createdAt: row.createdAt,
    event,
    localOrder: row.localOrder,
    payloadHash: row.payloadHash,
    producerEventId,
    threadId: row.threadId,
  };
}

function summarizeBufferedEvents(
  events: readonly BufferedEvent[],
): BufferedEventLogSummary[] {
  return events.map((event) => ({
    eventType: event.event.type,
    localOrder: event.localOrder,
    payloadHash: event.payloadHash,
    producerEventId: event.producerEventId,
    threadId: event.threadId,
  }));
}

function summarizeRejectedEvents(
  events: readonly HostDaemonRejectedEvent[],
): RejectedEventLogSummary[] {
  return events.map((event) => ({
    producerEventId: event.producerEventId,
    reason: event.reason,
    threadId: event.threadId,
  }));
}

export function createEventBuffer(
  options: CreateEventBufferOptions,
): EventBuffer {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const now = options.now ?? Date.now;
  const createProducerEventId =
    options.createProducerEventId ?? createHostDaemonProducerEventId;
  const db = openSpoolDatabase(options.dataDir);

  const selectPendingRows = db.prepare<[], EventSpoolRow>(`
    SELECT
      localOrder,
      producerEventId,
      threadId,
      eventType,
      payloadJson,
      payloadHash,
      createdAt,
      lastPostAttemptAt,
      postAttemptCount
    FROM outbound_events
    ORDER BY localOrder ASC
  `);
  const countPendingRows = db.prepare<[], { count: number }>(`
    SELECT COUNT(*) AS count
    FROM outbound_events
  `);
  const insertEvent = db.prepare<
    [string, string, string, string, string, string],
    never
  >(`
    INSERT INTO outbound_events (
      producerEventId,
      threadId,
      eventType,
      payloadJson,
      payloadHash,
      createdAt
    )
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const selectEventByProducerId = db.prepare<
    [HostDaemonProducerEventId],
    EventSpoolRow
  >(`
    SELECT
      localOrder,
      producerEventId,
      threadId,
      eventType,
      payloadJson,
      payloadHash,
      createdAt,
      lastPostAttemptAt,
      postAttemptCount
    FROM outbound_events
    WHERE producerEventId = ?
  `);
  const updatePostAttempt = db.prepare<[string, number], never>(`
    UPDATE outbound_events
    SET
      lastPostAttemptAt = ?,
      postAttemptCount = postAttemptCount + 1
    WHERE localOrder = ?
  `);
  const deleteByProducerEventId = db.prepare<
    [HostDaemonProducerEventId],
    never
  >(`
    DELETE FROM outbound_events
    WHERE producerEventId = ?
  `);

  let disposed = false;
  let flushPromise: Promise<boolean> | null = null;
  let disposePromise: Promise<void> | null = null;
  let consecutiveNoProgressFlushes = 0;
  const flushScheduler = createDebouncedCallbackScheduler({
    debounceMs,
    maxWaitMs,
    onFlush: () => {
      void flush().catch((error) => {
        options.logger.error(
          { err: error },
          "event flush failed closed after protocol inconsistency",
        );
      });
    },
  });

  const insertEventTransaction = db.transaction(
    (args: CreateBufferedEventRecordArgs): BufferedEvent => {
      const event = threadEventSchema.parse(args.input.event);
      if (event.threadId !== args.input.threadId) {
        throw new Error(
          "Buffered event threadId does not match payload threadId",
        );
      }
      const payloadJson = JSON.stringify(event);
      const payloadHash = hashPayload({
        event,
        threadId: args.input.threadId,
      });
      insertEvent.run(
        args.producerEventId,
        args.input.threadId,
        event.type,
        payloadJson,
        payloadHash,
        args.createdAt,
      );
      const row = selectEventByProducerId.get(args.producerEventId);
      if (row === undefined) {
        throw new Error("Event spool insert did not create a readable row");
      }
      return toBufferedEvent(row);
    },
  );

  const snapshotPostAttemptTransaction = db.transaction(
    (): SnapshotAttemptResult => {
      // Validate every stored row before posting. One corrupt row fails the
      // whole spool so the daemon cannot silently drop or reorder local events.
      const rows = selectPendingRows.all();
      const attemptedAt = formatTimestamp(now());
      const events: BufferedEvent[] = [];
      const producerEventIds: HostDaemonProducerEventId[] = [];
      for (const row of rows) {
        updatePostAttempt.run(attemptedAt, row.localOrder);
        const event = toBufferedEvent({
          ...row,
          lastPostAttemptAt: attemptedAt,
          postAttemptCount: row.postAttemptCount + 1,
        });
        events.push(event);
        producerEventIds.push(event.producerEventId);
      }
      return {
        events,
        producerEventIds,
      };
    },
  );

  const settlePostedBatchTransaction = db.transaction(
    (args: SettlePostedBatchArgs): SettlePostedBatchResult => {
      const sentProducerEventIds = new Set(args.sentProducerEventIds);
      const settledProducerEventIds = new Set<HostDaemonProducerEventId>();
      for (const event of args.acceptedEvents) {
        if (!sentProducerEventIds.has(event.producerEventId)) {
          throw new Error(
            `Event spool received acknowledgement for unsent producerEventId: ${event.producerEventId}`,
          );
        }
        settledProducerEventIds.add(event.producerEventId);
      }

      for (const event of args.rejectedEvents) {
        if (!sentProducerEventIds.has(event.producerEventId)) {
          throw new Error(
            `Event spool received rejection for unsent producerEventId: ${event.producerEventId}`,
          );
        }
        if (settledProducerEventIds.has(event.producerEventId)) {
          throw new Error(
            `Event spool received conflicting settlement for producerEventId: ${event.producerEventId}`,
          );
        }
        settledProducerEventIds.add(event.producerEventId);
      }

      let deletedCount = 0;
      for (const producerEventId of settledProducerEventIds) {
        deletedCount += deleteByProducerEventId.run(producerEventId).changes;
      }
      if (deletedCount !== settledProducerEventIds.size) {
        throw new Error(
          "Event spool settlement referenced an already-deleted event",
        );
      }
      return {
        deletedCount,
        rejectedEvents: [...args.rejectedEvents],
      };
    },
  );

  function scheduleFlush(): void {
    if (disposed) {
      return;
    }
    flushScheduler.schedule();
  }

  function flushImmediately(): void {
    if (disposed) {
      return;
    }
    flushScheduler.flush();
  }

  function push(input: BufferedEventInput): BufferedEvent {
    if (disposed) {
      throw new EventBufferDisposedError();
    }
    const event = insertEventTransaction({
      createdAt: formatTimestamp(now()),
      input,
      producerEventId: createProducerEventId(),
    });

    if (shouldFlushThreadEventImmediately(input.event)) {
      flushImmediately();
    } else {
      scheduleFlush();
    }

    return event;
  }

  async function flush(): Promise<void> {
    while (!disposed) {
      if (flushPromise) {
        const madeProgress = await flushPromise;
        if (!madeProgress) {
          return;
        }
        continue;
      }

      const snapshot = snapshotPostAttemptTransaction();
      if (snapshot.events.length === 0) {
        return;
      }

      flushPromise = (async (): Promise<boolean> => {
        try {
          let postResult: EventPostResult;
          try {
            postResult = await options.postEvents(
              snapshot.events.map(toPostEvent),
            );
          } catch (error) {
            options.logger.warn(
              {
                err: error,
                bufferDepth: snapshot.events.length,
              },
              "event flush failed, will retry",
            );
            scheduleFlush();
            return false;
          }
          const settledResult = settlePostedBatchTransaction({
            acceptedEvents: postResult.acceptedEvents,
            rejectedEvents: postResult.rejectedEvents,
            sentProducerEventIds: snapshot.producerEventIds,
          });
          if (settledResult.rejectedEvents.length > 0) {
            options.logger.warn(
              {
                rejectedEvents: summarizeRejectedEvents(
                  settledResult.rejectedEvents,
                ),
              },
              "event flush discarded rejected events",
            );
          }
          if (settledResult.deletedCount === 0) {
            consecutiveNoProgressFlushes++;
            const logContext = {
              bufferDepth: snapshot.events.length,
              events: summarizeBufferedEvents(snapshot.events),
              noProgressCount: consecutiveNoProgressFlushes,
              noProgressLimit: MAX_CONSECUTIVE_NO_PROGRESS_FLUSHES,
            };
            if (
              consecutiveNoProgressFlushes >=
              MAX_CONSECUTIVE_NO_PROGRESS_FLUSHES
            ) {
              options.logger.error(
                logContext,
                "event flush made no progress; failing closed",
              );
              throw new Error(
                `Event spool flush made no progress after ${consecutiveNoProgressFlushes} attempts`,
              );
            }
            options.logger.warn(logContext, "event flush made no progress");
            scheduleFlush();
            return false;
          }
          consecutiveNoProgressFlushes = 0;
          return depth() > 0;
        } finally {
          flushPromise = null;
        }
      })();

      const madeProgress = await flushPromise;
      if (!madeProgress) {
        return;
      }
    }
  }

  function depth(): number {
    return countPendingRows.get()?.count ?? 0;
  }

  function snapshot(): BufferedEvent[] {
    // Snapshot parsing is intentionally all-or-nothing; fail closed rather than
    // posting a partial view of a locally corrupted durable spool.
    return selectPendingRows.all().map(toBufferedEvent);
  }

  async function dispose(): Promise<void> {
    if (disposePromise) {
      return disposePromise;
    }

    disposed = true;
    flushScheduler.dispose();
    disposePromise = (async () => {
      try {
        if (flushPromise) {
          await flushPromise;
        }
      } finally {
        db.close();
      }
    })();
    return disposePromise;
  }

  return {
    push,
    flush,
    depth,
    snapshot,
    dispose,
  };
}
