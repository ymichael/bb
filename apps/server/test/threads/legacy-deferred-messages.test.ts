import { sql } from "drizzle-orm";
import { listEvents, listQueuedThreadMessages, markThreadDeleted } from "@bb/db";
import { describe, expect, it } from "vitest";
import { deliverLegacyDeferredThreadMessages } from "../../src/services/threads/legacy-deferred-messages.js";
import { toThreadQueuedMessage } from "../../src/services/threads/thread-queued-messages.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const WORKSPACE_PATH = "/tmp/legacy-deferred-project";

// Migration 0111 renames the old table into place, so a freshly migrated
// database already carries it (empty); IF NOT EXISTS covers a harness that
// ran the backfill once and dropped it.
function createLegacyTable(harness: TestAppHarness): void {
  harness.db.run(
    sql`CREATE TABLE IF NOT EXISTS deferred_thread_messages_legacy (
      id text PRIMARY KEY,
      thread_id text NOT NULL,
      kind text NOT NULL,
      payload text NOT NULL,
      created_at integer NOT NULL
    )`,
  );
}

function insertLegacyRow(
  harness: TestAppHarness,
  args: { id: string; threadId: string; kind: string; payload: unknown },
): void {
  harness.db.run(
    sql`INSERT INTO deferred_thread_messages_legacy (id, thread_id, kind, payload, created_at)
        VALUES (${args.id}, ${args.threadId}, ${args.kind}, ${JSON.stringify(args.payload)}, ${Date.now()})`,
  );
}

function legacyTableExists(harness: TestAppHarness): boolean {
  return (
    harness.db.get<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'deferred_thread_messages_legacy'`,
    ) !== undefined
  );
}

function seedIdleThread(harness: TestAppHarness, hostId: string) {
  const { host } = seedHostSession(harness.deps, { id: hostId });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: WORKSPACE_PATH,
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: WORKSPACE_PATH,
  });
  const thread = seedThread(harness.deps, {
    environmentId: environment.id,
    projectId: project.id,
    status: "active",
  });
  seedThreadRuntimeState(harness.deps, {
    environmentId: environment.id,
    inputText: "Original turn",
    providerThreadId: `provider-${hostId}`,
    threadId: thread.id,
  });
  return thread;
}

describe("deliverLegacyDeferredThreadMessages", () => {
  it("drops the empty renamed table and is a no-op ever after", async () => {
    await withTestHarness(async (harness) => {
      // A fresh database's migrations rename the (empty) old table into
      // place; the first startup clears it away and later ones find nothing.
      expect(legacyTableExists(harness)).toBe(true);
      await deliverLegacyDeferredThreadMessages(harness.deps);
      expect(legacyTableExists(harness)).toBe(false);
      await deliverLegacyDeferredThreadMessages(harness.deps);
    });
  });

  it("delivers held sends through today's checkpoint and drops the table", async () => {
    await withTestHarness(async (harness) => {
      const thread = seedIdleThread(harness, "host-legacy");
      createLegacyTable(harness);
      insertLegacyRow(harness, {
        id: "dfr_1",
        threadId: thread.id,
        kind: "send",
        payload: {
          kind: "send",
          request: {
            input: [
              { type: "text", text: "The held follow-up", mentions: [] },
            ],
            // A mode value today's schema does not know: the message must
            // survive it, since the words are what the migration protects.
            mode: "defer-legacy",
          },
        },
      });

      await deliverLegacyDeferredThreadMessages(harness.deps);

      // The thread is active, so the checkpoint queued the message behind the
      // running turn — the same landing an ordinary send gets. `auto` mode
      // steers a running turn, so assert on whichever the harness produced:
      // either a queued row carrying the text, or a dispatched request.
      const queuedTexts = listQueuedThreadMessages(harness.db, thread.id)
        .map(toThreadQueuedMessage)
        .flatMap((row) => row.content)
        .flatMap((block) => (block.type === "text" ? [block.text] : []));
      const requestTexts = listEvents(harness.db, { threadId: thread.id })
        .filter((event) => event.type === "client/turn/requested")
        .map((event) => event.data);
      expect(
        queuedTexts.includes("The held follow-up") ||
          requestTexts.some((data) => data.includes("The held follow-up")),
      ).toBe(true);
      expect(legacyTableExists(harness)).toBe(false);
    });
  });

  it("keeps an unrecognized payload and the table for the next startup", async () => {
    await withTestHarness(async (harness) => {
      const thread = seedIdleThread(harness, "host-legacy-bad");
      createLegacyTable(harness);
      insertLegacyRow(harness, {
        id: "dfr_bad",
        threadId: thread.id,
        kind: "mystery",
        payload: { kind: "mystery" },
      });

      await deliverLegacyDeferredThreadMessages(harness.deps);

      expect(legacyTableExists(harness)).toBe(true);
      expect(
        harness.db.get<{ id: string }>(
          sql`SELECT id FROM deferred_thread_messages_legacy WHERE id = 'dfr_bad'`,
        ),
      ).toBeDefined();
    });
  });

  it("resolves a row whose thread is gone without delivering anything", async () => {
    await withTestHarness(async (harness) => {
      const thread = seedIdleThread(harness, "host-legacy-gone");
      createLegacyTable(harness);
      insertLegacyRow(harness, {
        id: "dfr_gone",
        threadId: thread.id,
        kind: "send",
        payload: {
          kind: "send",
          request: {
            input: [{ type: "text", text: "Nobody home", mentions: [] }],
            mode: "steer",
          },
        },
      });
      markThreadDeleted(harness.db, harness.deps.hub, { threadId: thread.id });

      await deliverLegacyDeferredThreadMessages(harness.deps);

      expect(legacyTableExists(harness)).toBe(false);
      expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
    });
  });
});
