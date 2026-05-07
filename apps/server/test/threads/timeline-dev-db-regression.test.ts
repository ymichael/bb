import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createConnection, getThread, type DbConnection } from "@bb/db";
import type { Thread } from "@bb/domain";
import type { TimelineRow } from "@bb/server-contract";
import {
  buildThreadTimeline,
  type ThreadTimelinePageRequest,
} from "../../src/services/threads/timeline.js";

interface DevDbSnapshot {
  cleanup: () => void;
  db: DbConnection;
}

interface ThreadTimelineBuildArgs {
  db: DbConnection;
  page: ThreadTimelinePageRequest;
  thread: Thread;
}

interface ReconstructThreadTimelineArgs {
  db: DbConnection;
  segmentLimit: number;
  thread: Thread;
}

const DEV_DB_PATH = process.env.BB_TIMELINE_DEV_DB;
const DEV_DB_THREAD_IDS = [
  "thr_eqm8uijebf",
  "thr_qfk8ksbxkk",
  "thr_pvp3c84xx4",
] as const;

function canRunDevDbRegression(): boolean {
  return DEV_DB_PATH !== undefined && existsSync(DEV_DB_PATH);
}

async function createDevDbSnapshot(sourcePath: string): Promise<DevDbSnapshot> {
  const sourceDb = createConnection(sourcePath);
  const snapshotDir = mkdtempSync(join(tmpdir(), "bb-timeline-dev-db-"));
  const snapshotPath = join(snapshotDir, "bb.db");
  let backupSucceeded = false;
  try {
    await sourceDb.$client.backup(snapshotPath);
    backupSucceeded = true;
  } finally {
    sourceDb.$client.close();
    if (!backupSucceeded) {
      rmSync(snapshotDir, { recursive: true, force: true });
    }
  }

  return {
    db: createConnection(snapshotPath),
    cleanup: () => {
      rmSync(snapshotDir, { recursive: true, force: true });
    },
  };
}

function requireDevThread(db: DbConnection, threadId: string): Thread {
  const thread = getThread(db, threadId);
  if (!thread) {
    throw new Error(`Expected dev DB thread ${threadId}`);
  }
  return thread;
}

function buildTimelinePage({ db, page, thread }: ThreadTimelineBuildArgs) {
  return buildThreadTimeline(db, thread, {
    isDevelopment: true,
    page,
    timelineViewMode: "standard",
  });
}

function buildFullTimeline(db: DbConnection, thread: Thread) {
  return buildTimelinePage({
    db,
    thread,
    page: {
      kind: "latest",
      segmentLimit: Number.MAX_SAFE_INTEGER,
    },
  });
}

function reconstructThreadTimelineByPages({
  db,
  segmentLimit,
  thread,
}: ReconstructThreadTimelineArgs): TimelineRow[] {
  const latestPage = buildTimelinePage({
    db,
    thread,
    page: {
      kind: "latest",
      segmentLimit,
    },
  });
  const rows = [...latestPage.rows];
  let olderCursor = latestPage.timelinePage.olderCursor;

  while (olderCursor !== null) {
    const olderPage = buildTimelinePage({
      db,
      thread,
      page: {
        kind: "older",
        beforeCursor: olderCursor,
        segmentLimit,
      },
    });
    rows.unshift(...olderPage.rows);
    olderCursor = olderPage.timelinePage.olderCursor;
  }

  return rows;
}

function countCompletedTurnSummaryRows(rows: readonly TimelineRow[]): number {
  return rows.filter(
    (row) =>
      row.kind === "turn" && row.status === "completed" && row.summaryCount > 0,
  ).length;
}

describe.skipIf(!canRunDevDbRegression())(
  "timeline pagination dev DB regressions",
  () => {
    it("reconstructs the important dev DB threads without row reordering", async () => {
      if (DEV_DB_PATH === undefined) {
        throw new Error("BB_TIMELINE_DEV_DB is required");
      }
      const snapshot = await createDevDbSnapshot(DEV_DB_PATH);
      try {
        for (const threadId of DEV_DB_THREAD_IDS) {
          const thread = requireDevThread(snapshot.db, threadId);
          const fullRows = buildFullTimeline(snapshot.db, thread).rows;
          const pagedRows = reconstructThreadTimelineByPages({
            db: snapshot.db,
            segmentLimit: 1,
            thread,
          });

          expect(
            pagedRows.map((row) => row.id),
            `${threadId} paged row order`,
          ).toEqual(fullRows.map((row) => row.id));
        }
      } finally {
        snapshot.db.$client.close();
        snapshot.cleanup();
      }
    }, 30_000);

    it("keeps the thr_eqm8uijebf first user before derived rows", async () => {
      if (DEV_DB_PATH === undefined) {
        throw new Error("BB_TIMELINE_DEV_DB is required");
      }
      const snapshot = await createDevDbSnapshot(DEV_DB_PATH);
      try {
        const thread = requireDevThread(snapshot.db, "thr_eqm8uijebf");
        const rows = reconstructThreadTimelineByPages({
          db: snapshot.db,
          segmentLimit: 1,
          thread,
        });
        const firstDerivedRowIndex = rows.findIndex(
          (row) => row.kind === "turn" || row.kind === "work",
        );

        expect(rows[0]).toMatchObject({
          kind: "conversation",
          role: "user",
        });
        expect(firstDerivedRowIndex).toBeGreaterThan(0);
      } finally {
        snapshot.db.$client.close();
        snapshot.cleanup();
      }
    }, 30_000);

    it("keeps completed turn summaries in the real summary-regression threads", async () => {
      if (DEV_DB_PATH === undefined) {
        throw new Error("BB_TIMELINE_DEV_DB is required");
      }
      const snapshot = await createDevDbSnapshot(DEV_DB_PATH);
      try {
        for (const threadId of ["thr_qfk8ksbxkk", "thr_pvp3c84xx4"]) {
          const thread = requireDevThread(snapshot.db, threadId);
          const rows = reconstructThreadTimelineByPages({
            db: snapshot.db,
            segmentLimit: 1,
            thread,
          });

          expect(
            countCompletedTurnSummaryRows(rows),
            `${threadId} completed summary rows`,
          ).toBeGreaterThan(0);
        }
      } finally {
        snapshot.db.$client.close();
        snapshot.cleanup();
      }
    }, 30_000);
  },
);
