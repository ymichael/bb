import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { DbConnection } from "../../src/connection.js";
import { createEventId } from "../../src/ids.js";
import { noopNotifier } from "../../src/notifier.js";
import type { DbNotifier } from "../../src/notifier.js";
import {
  COMPLETED_EVENT_OUTPUT_RETAINED_HEAD_CHARS,
  COMPLETED_EVENT_OUTPUT_RETAINED_TAIL_CHARS,
  COMPLETED_EVENT_OUTPUT_TRUNCATION_THRESHOLD_CHARS,
  DEFAULT_DESTROYED_ENVIRONMENT_EVENT_DETACH_BATCH_SIZE,
  DESTROYED_ENVIRONMENT_TTL_MS,
  pruneClosedSessions,
  pruneDestroyedEnvironments,
  sweepManagedEnvironments,
  truncateCompletedEventItemOutputs,
} from "../../src/data/sweeps.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createProject } from "../../src/data/projects.js";
import {
  createThread,
  archiveThread,
  markThreadDeleted,
} from "../../src/data/threads.js";
import {
  createEnvironment,
  updateEnvironmentMetadata,
} from "../../src/data/environments.js";
import { openSession } from "../../src/data/sessions.js";
import {
  environments,
  events,
  hostDaemonSessions,
  threads,
} from "../../src/schema.js";
import { createMigratedConnection } from "../helpers/migrated-connection.js";

function setup() {
  const db = createMigratedConnection();
  const host = upsertHost(db, noopNotifier, {
    name: "test-host",
    type: "persistent",
  });
  const { project } = createProject(db, noopNotifier, {
    name: "test-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/test" },
  });
  return { db, host, project };
}

interface InsertCompletedItemEventArgs {
  createdAt: number;
  db: DbConnection;
  item: object;
  itemId: string;
  itemKind: "commandExecution" | "toolCall" | "webFetch" | "webSearch";
  sequence: number;
  threadId: string;
}

function insertCompletedItemEvent(args: InsertCompletedItemEventArgs): string {
  const id = createEventId();
  args.db
    .insert(events)
    .values({
      id,
      threadId: args.threadId,
      scopeKind: "turn",
      turnId: "turn_1",
      providerThreadId: "provider-thread-1",
      sequence: args.sequence,
      type: "item/completed",
      itemId: args.itemId,
      itemKind: args.itemKind,
      data: JSON.stringify({
        item: args.item,
        providerThreadId: "provider-thread-1",
        threadId: args.threadId,
        type: "item/completed",
      }),
      createdAt: args.createdAt,
    })
    .run();
  return id;
}

describe("truncateCompletedEventItemOutputs", () => {
  it("truncates old large completed item outputs with metadata", () => {
    const { db, project } = setup();
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      status: "idle",
    });
    const now = Date.now();
    const staleCreatedAt = now - 10_000;
    const freshCreatedAt = now;
    const createdBefore = now - 5_000;
    const commandOutput =
      "command-head-" +
      "a".repeat(COMPLETED_EVENT_OUTPUT_TRUNCATION_THRESHOLD_CHARS) +
      "-command-tail";
    const toolResult =
      "tool-head-" +
      "b".repeat(COMPLETED_EVENT_OUTPUT_TRUNCATION_THRESHOLD_CHARS) +
      "-tool-tail";
    const webSearchResultText =
      "search-head-" +
      "c".repeat(COMPLETED_EVENT_OUTPUT_TRUNCATION_THRESHOLD_CHARS) +
      "-search-tail";
    const webFetchResultText =
      "fetch-head-" +
      "d".repeat(COMPLETED_EVENT_OUTPUT_TRUNCATION_THRESHOLD_CHARS) +
      "-fetch-tail";
    const smallOutput = "short output";

    const commandEventId = insertCompletedItemEvent({
      createdAt: staleCreatedAt,
      db,
      item: {
        type: "commandExecution",
        id: "cmd-item",
        command: "rg large",
        cwd: "/tmp/project",
        status: "completed",
        approvalStatus: null,
        aggregatedOutput: commandOutput,
      },
      itemId: "cmd-item",
      itemKind: "commandExecution",
      sequence: 1,
      threadId: thread.id,
    });
    const toolEventId = insertCompletedItemEvent({
      createdAt: staleCreatedAt,
      db,
      item: {
        type: "toolCall",
        id: "tool-item",
        tool: "Read",
        status: "completed",
        result: toolResult,
      },
      itemId: "tool-item",
      itemKind: "toolCall",
      sequence: 2,
      threadId: thread.id,
    });
    const freshEventId = insertCompletedItemEvent({
      createdAt: freshCreatedAt,
      db,
      item: {
        type: "commandExecution",
        id: "fresh-item",
        command: "rg fresh",
        cwd: "/tmp/project",
        status: "completed",
        approvalStatus: null,
        aggregatedOutput: commandOutput,
      },
      itemId: "fresh-item",
      itemKind: "commandExecution",
      sequence: 3,
      threadId: thread.id,
    });
    const webSearchEventId = insertCompletedItemEvent({
      createdAt: staleCreatedAt,
      db,
      item: {
        type: "webSearch",
        id: "web-search-item",
        queries: ["retention policy"],
        resultText: webSearchResultText,
      },
      itemId: "web-search-item",
      itemKind: "webSearch",
      sequence: 4,
      threadId: thread.id,
    });
    const webFetchEventId = insertCompletedItemEvent({
      createdAt: staleCreatedAt,
      db,
      item: {
        type: "webFetch",
        id: "web-fetch-item",
        url: "https://example.com/large",
        prompt: null,
        pattern: null,
        resultText: webFetchResultText,
      },
      itemId: "web-fetch-item",
      itemKind: "webFetch",
      sequence: 5,
      threadId: thread.id,
    });
    const smallEventId = insertCompletedItemEvent({
      createdAt: staleCreatedAt,
      db,
      item: {
        type: "commandExecution",
        id: "small-item",
        command: "pwd",
        cwd: "/tmp/project",
        status: "completed",
        approvalStatus: null,
        aggregatedOutput: smallOutput,
      },
      itemId: "small-item",
      itemKind: "commandExecution",
      sequence: 6,
      threadId: thread.id,
    });

    const result = truncateCompletedEventItemOutputs(db, {
      createdBefore,
      limit: 10,
      truncatedAt: now,
    });

    expect(result).toEqual({
      commandExecutionOutputs: 1,
      toolCallResults: 1,
      webFetchResultTexts: 1,
      webSearchResultTexts: 1,
    });

    const commandData = JSON.parse(
      db.select().from(events).where(eq(events.id, commandEventId)).get()
        ?.data ?? "{}",
    );
    expect(commandData.item.aggregatedOutput).not.toBe(commandOutput);
    expect(commandData.item.aggregatedOutput).toContain(
      "output truncated by retention policy",
    );
    expect(commandData.item.aggregatedOutput.startsWith(commandOutput.slice(0, COMPLETED_EVENT_OUTPUT_RETAINED_HEAD_CHARS))).toBe(true);
    expect(commandData.item.aggregatedOutput.endsWith(commandOutput.slice(-COMPLETED_EVENT_OUTPUT_RETAINED_TAIL_CHARS))).toBe(true);
    expect(commandData.item.truncation.aggregatedOutput).toEqual({
      originalLength: commandOutput.length,
      retainedHeadLength: COMPLETED_EVENT_OUTPUT_RETAINED_HEAD_CHARS,
      retainedTailLength: COMPLETED_EVENT_OUTPUT_RETAINED_TAIL_CHARS,
      truncatedAt: now,
    });

    const toolData = JSON.parse(
      db.select().from(events).where(eq(events.id, toolEventId)).get()?.data ??
        "{}",
    );
    expect(toolData.item.result).not.toBe(toolResult);
    expect(toolData.item.result).toContain(
      "output truncated by retention policy",
    );
    expect(toolData.item.result.startsWith(toolResult.slice(0, COMPLETED_EVENT_OUTPUT_RETAINED_HEAD_CHARS))).toBe(true);
    expect(toolData.item.result.endsWith(toolResult.slice(-COMPLETED_EVENT_OUTPUT_RETAINED_TAIL_CHARS))).toBe(true);
    expect(toolData.item.truncation.result).toEqual({
      originalLength: toolResult.length,
      retainedHeadLength: COMPLETED_EVENT_OUTPUT_RETAINED_HEAD_CHARS,
      retainedTailLength: COMPLETED_EVENT_OUTPUT_RETAINED_TAIL_CHARS,
      truncatedAt: now,
    });

    const webSearchData = JSON.parse(
      db
        .select()
        .from(events)
        .where(eq(events.id, webSearchEventId))
        .get()?.data ?? "{}",
    );
    expect(webSearchData.item.resultText).not.toBe(webSearchResultText);
    expect(webSearchData.item.resultText).toContain(
      "output truncated by retention policy",
    );
    expect(
      webSearchData.item.resultText.startsWith(
        webSearchResultText.slice(0, COMPLETED_EVENT_OUTPUT_RETAINED_HEAD_CHARS),
      ),
    ).toBe(true);
    expect(
      webSearchData.item.resultText.endsWith(
        webSearchResultText.slice(-COMPLETED_EVENT_OUTPUT_RETAINED_TAIL_CHARS),
      ),
    ).toBe(true);
    expect(webSearchData.item.truncation.resultText).toEqual({
      originalLength: webSearchResultText.length,
      retainedHeadLength: COMPLETED_EVENT_OUTPUT_RETAINED_HEAD_CHARS,
      retainedTailLength: COMPLETED_EVENT_OUTPUT_RETAINED_TAIL_CHARS,
      truncatedAt: now,
    });

    const webFetchData = JSON.parse(
      db.select().from(events).where(eq(events.id, webFetchEventId)).get()
        ?.data ?? "{}",
    );
    expect(webFetchData.item.resultText).not.toBe(webFetchResultText);
    expect(webFetchData.item.resultText).toContain(
      "output truncated by retention policy",
    );
    expect(
      webFetchData.item.resultText.startsWith(
        webFetchResultText.slice(0, COMPLETED_EVENT_OUTPUT_RETAINED_HEAD_CHARS),
      ),
    ).toBe(true);
    expect(
      webFetchData.item.resultText.endsWith(
        webFetchResultText.slice(-COMPLETED_EVENT_OUTPUT_RETAINED_TAIL_CHARS),
      ),
    ).toBe(true);
    expect(webFetchData.item.truncation.resultText).toEqual({
      originalLength: webFetchResultText.length,
      retainedHeadLength: COMPLETED_EVENT_OUTPUT_RETAINED_HEAD_CHARS,
      retainedTailLength: COMPLETED_EVENT_OUTPUT_RETAINED_TAIL_CHARS,
      truncatedAt: now,
    });

    const freshData = JSON.parse(
      db.select().from(events).where(eq(events.id, freshEventId)).get()?.data ??
        "{}",
    );
    expect(freshData.item.aggregatedOutput).toBe(commandOutput);
    const smallData = JSON.parse(
      db.select().from(events).where(eq(events.id, smallEventId)).get()?.data ??
        "{}",
    );
    expect(smallData.item.aggregatedOutput).toBe(smallOutput);

    expect(
      truncateCompletedEventItemOutputs(db, {
        createdBefore,
        limit: 10,
        truncatedAt: now,
      }),
    ).toEqual({
      commandExecutionOutputs: 0,
      toolCallResults: 0,
      webFetchResultTexts: 0,
      webSearchResultTexts: 0,
    });
  });

  it("advances durable cursors past old small outputs", () => {
    const { db, project } = setup();
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      status: "idle",
    });
    const now = Date.now();
    const staleCreatedAt = now - 10_000;
    const createdBefore = now - 5_000;
    const largeOutput =
      "command-head-" +
      "a".repeat(COMPLETED_EVENT_OUTPUT_TRUNCATION_THRESHOLD_CHARS) +
      "-command-tail";

    insertCompletedItemEvent({
      createdAt: staleCreatedAt,
      db,
      item: {
        type: "commandExecution",
        id: "small-before-large",
        command: "pwd",
        cwd: "/tmp/project",
        status: "completed",
        approvalStatus: null,
        aggregatedOutput: "small output",
      },
      itemId: "small-before-large",
      itemKind: "commandExecution",
      sequence: 1,
      threadId: thread.id,
    });
    const largeEventId = insertCompletedItemEvent({
      createdAt: staleCreatedAt + 1,
      db,
      item: {
        type: "commandExecution",
        id: "large-after-small",
        command: "cat large",
        cwd: "/tmp/project",
        status: "completed",
        approvalStatus: null,
        aggregatedOutput: largeOutput,
      },
      itemId: "large-after-small",
      itemKind: "commandExecution",
      sequence: 2,
      threadId: thread.id,
    });

    expect(
      truncateCompletedEventItemOutputs(db, {
        createdBefore,
        limit: 1,
        truncatedAt: now,
      }).commandExecutionOutputs,
    ).toBe(0);
    expect(
      truncateCompletedEventItemOutputs(db, {
        createdBefore,
        limit: 1,
        truncatedAt: now,
      }).commandExecutionOutputs,
    ).toBe(1);

    const largeData = JSON.parse(
      db.select().from(events).where(eq(events.id, largeEventId)).get()?.data ??
        "{}",
    );
    expect(largeData.item.truncation.aggregatedOutput).toEqual({
      originalLength: largeOutput.length,
      retainedHeadLength: COMPLETED_EVENT_OUTPUT_RETAINED_HEAD_CHARS,
      retainedTailLength: COMPLETED_EVENT_OUTPUT_RETAINED_TAIL_CHARS,
      truncatedAt: now,
    });
  });
});

describe("pruneClosedSessions", () => {
  function openClosedSessionAt(args: {
    closedAt: number;
    db: DbConnection;
    hostId: string;
    instanceId: string;
  }): string {
    const session = openSession(args.db, {
      hostId: args.hostId,
      instanceId: args.instanceId,
      hostName: "test-host",
      hostType: "persistent",
      dataDir: "/tmp/test-host-data",
      protocolVersion: 1,
      heartbeatIntervalMs: 10_000,
      leaseTimeoutMs: 30_000,
    });
    args.db
      .update(hostDaemonSessions)
      .set({
        status: "closed",
        closedAt: args.closedAt,
        closeReason: "replaced",
        updatedAt: args.closedAt,
      })
      .where(eq(hostDaemonSessions.id, session.id))
      .run();
    return session.id;
  }

  it("deletes closed sessions older than the threshold", () => {
    const { db, host } = setup();
    const now = Date.now();

    const stale = openClosedSessionAt({
      closedAt: now - 10_000,
      db,
      hostId: host.id,
      instanceId: "inst-stale",
    });
    const fresh = openClosedSessionAt({
      closedAt: now - 1_000,
      db,
      hostId: host.id,
      instanceId: "inst-fresh",
    });
    const active = openSession(db, {
      hostId: host.id,
      instanceId: "inst-active",
      hostName: "test-host",
      hostType: "persistent",
      dataDir: "/tmp/test-host-data",
      protocolVersion: 1,
      heartbeatIntervalMs: 10_000,
      leaseTimeoutMs: 30_000,
    });

    expect(
      pruneClosedSessions(db, {
        closedBefore: now - 5_000,
        limit: 100,
      }),
    ).toEqual({ deleted: 1 });

    expect(
      db
        .select({ id: hostDaemonSessions.id })
        .from(hostDaemonSessions)
        .all()
        .map((row) => row.id)
        .sort(),
    ).toEqual([fresh, active.id].sort());
    expect(
      db
        .select()
        .from(hostDaemonSessions)
        .where(eq(hostDaemonSessions.id, stale))
        .get(),
    ).toBeUndefined();
  });

  it("never deletes the currently active session", () => {
    const { db, host } = setup();
    const now = Date.now();

    const active = openSession(db, {
      hostId: host.id,
      instanceId: "inst-active",
      hostName: "test-host",
      hostType: "persistent",
      dataDir: "/tmp/test-host-data",
      protocolVersion: 1,
      heartbeatIntervalMs: 10_000,
      leaseTimeoutMs: 30_000,
    });

    expect(
      pruneClosedSessions(db, {
        closedBefore: now + 60_000,
        limit: 100,
      }),
    ).toEqual({ deleted: 0 });
    expect(
      db
        .select()
        .from(hostDaemonSessions)
        .where(eq(hostDaemonSessions.id, active.id))
        .get()?.status,
    ).toBe("active");
  });

  it("honors the delete batch limit", () => {
    const { db, host } = setup();
    const now = Date.now();
    const closedAt = now - 10_000;

    for (const instanceId of ["inst-a", "inst-b", "inst-c"]) {
      openClosedSessionAt({ closedAt, db, hostId: host.id, instanceId });
    }

    expect(
      pruneClosedSessions(db, {
        closedBefore: now - 5_000,
        limit: 2,
      }),
    ).toEqual({ deleted: 2 });
    expect(
      db
        .select()
        .from(hostDaemonSessions)
        .where(eq(hostDaemonSessions.status, "closed"))
        .all(),
    ).toHaveLength(1);
  });
});

describe("sweepManagedEnvironments", () => {
  it("returns retiring managed environments with zero non-archived threads", () => {
    const { db, host, project } = setup();

    const env = createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      path: "/tmp/env",
      managed: true,
      workspaceProvisionType: "managed-worktree",
      status: "retiring",
    });

    const candidates1 = sweepManagedEnvironments(db);
    expect(candidates1).toHaveLength(1);
    expect(candidates1[0]!.id).toBe(env.id);
  });

  it("does not return environments with non-archived threads", () => {
    const { db, host, project } = setup();

    const env = createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      path: "/tmp/env",
      managed: true,
      workspaceProvisionType: "managed-worktree",
      status: "retiring",
    });

    createThread(db, noopNotifier, {
      projectId: project.id,
      environmentId: env.id,
      providerId: "codex",
      status: "idle",
    });

    const candidates = sweepManagedEnvironments(db);
    expect(candidates).toHaveLength(0);
  });

  it("returns environment after all threads are archived", () => {
    const { db, host, project } = setup();

    const env = createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      path: "/tmp/env",
      managed: true,
      workspaceProvisionType: "managed-worktree",
      status: "retiring",
    });

    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      environmentId: env.id,
      providerId: "codex",
      status: "idle",
    });

    expect(sweepManagedEnvironments(db)).toHaveLength(0);

    archiveThread(db, noopNotifier, thread.id);

    const candidates = sweepManagedEnvironments(db);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.id).toBe(env.id);
  });

  it("treats soft-deleted threads as non-live when selecting cleanup candidates", () => {
    const { db, host, project } = setup();

    const env = createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      path: "/tmp/env",
      managed: true,
      workspaceProvisionType: "managed-worktree",
      status: "retiring",
    });

    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      environmentId: env.id,
      providerId: "codex",
      status: "idle",
    });

    markThreadDeleted(db, noopNotifier, { threadId: thread.id });

    const candidates = sweepManagedEnvironments(db);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.id).toBe(env.id);
  });

  it("does not return unmanaged environments", () => {
    const { db, host, project } = setup();

    createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      path: "/tmp/env",
      managed: false,
      workspaceProvisionType: "unmanaged",
      status: "retiring",
    });

    const candidates = sweepManagedEnvironments(db);
    expect(candidates).toHaveLength(0);
  });

  it("does not return destroying environments from the retiring sweep", () => {
    const { db, host, project } = setup();

    const env = createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      path: "/tmp/env",
      managed: true,
      workspaceProvisionType: "managed-worktree",
      status: "destroying",
    });

    const candidates = sweepManagedEnvironments(db);
    expect(candidates).toHaveLength(0);
    expect(env.status).toBe("destroying");
  });
});

describe("pruneDestroyedEnvironments", () => {
  it("resumes event detachment from persisted progress before notifying deletion", () => {
    const { db, host, project } = setup();
    const now = Date.now();
    const environment = createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      path: "/tmp/destroyed-with-event-history",
      managed: true,
      workspaceProvisionType: "managed-worktree",
      status: "destroyed",
    });
    db.update(environments)
      .set({ updatedAt: now - 8 * 24 * 60 * 60_000 })
      .where(eq(environments.id, environment.id))
      .run();
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      environmentId: environment.id,
      providerId: "codex",
      status: "idle",
    });
    const eventIds = ["event-prune-c", "event-prune-a", "event-prune-b"];
    for (const [index, id] of eventIds.entries()) {
      db.insert(events)
        .values({
          id,
          threadId: thread.id,
          environmentId: environment.id,
          scopeKind: "thread",
          sequence: index + 1,
          type: "thread/started",
          data: JSON.stringify({ position: index + 1 }),
          createdAt: now,
        })
        .run();
    }
    const initialNotifier: DbNotifier = {
      notifyThread: vi.fn(),
      notifyEnvironment: vi.fn(),
      notifyHost: vi.fn(),
      notifyProject: vi.fn(),
      notifySystem: vi.fn(),
    };
    const args = {
      updatedBefore: now - DESTROYED_ENVIRONMENT_TTL_MS,
      eventBatchSize: 2,
      limit: 1,
    };

    expect(pruneDestroyedEnvironments(db, initialNotifier, args)).toEqual({
      deleted: 0,
      detachedEvents: 2,
    });
    expect(
      db
        .select({ environmentId: events.environmentId })
        .from(events)
        .where(eq(events.threadId, thread.id))
        .orderBy(events.sequence)
        .all()
        .map((row) => row.environmentId),
    ).toEqual([null, null, environment.id]);
    expect(initialNotifier.notifyEnvironment).not.toHaveBeenCalled();

    const restartedNotifier: DbNotifier = {
      notifyThread: vi.fn(),
      notifyEnvironment: vi.fn(),
      notifyHost: vi.fn(),
      notifyProject: vi.fn(),
      notifySystem: vi.fn(),
    };
    expect(pruneDestroyedEnvironments(db, restartedNotifier, args)).toEqual({
      deleted: 0,
      detachedEvents: 1,
    });
    expect(pruneDestroyedEnvironments(db, restartedNotifier, args)).toEqual({
      deleted: 1,
      detachedEvents: 0,
    });
    expect(restartedNotifier.notifyEnvironment).toHaveBeenCalledTimes(1);
    expect(restartedNotifier.notifyEnvironment).toHaveBeenCalledWith(
      environment.id,
      ["environment-deleted"],
    );
    expect(
      db
        .select({
          data: events.data,
          environmentId: events.environmentId,
          id: events.id,
        })
        .from(events)
        .where(eq(events.threadId, thread.id))
        .orderBy(events.sequence)
        .all(),
    ).toEqual(
      eventIds.map((id, index) => ({
        data: JSON.stringify({ position: index + 1 }),
        environmentId: null,
        id,
      })),
    );
    expect(pruneDestroyedEnvironments(db, restartedNotifier, args)).toEqual({
      deleted: 0,
      detachedEvents: 0,
    });
    expect(restartedNotifier.notifyEnvironment).toHaveBeenCalledTimes(1);
  });

  it("hard-deletes stale destroyed environments after the retention window", () => {
    const { db, host, project } = setup();
    const now = Date.now();

    const staleEnvironment = createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      path: "/tmp/stale-destroyed",
      managed: true,
      workspaceProvisionType: "managed-worktree",
      status: "destroyed",
    });
    const freshEnvironment = createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      path: "/tmp/fresh-destroyed",
      managed: true,
      workspaceProvisionType: "managed-worktree",
      status: "destroyed",
    });

    db.update(environments)
      .set({ updatedAt: now - 8 * 24 * 60 * 60_000 })
      .where(eq(environments.id, staleEnvironment.id))
      .run();

    const spy: DbNotifier = {
      notifyThread: vi.fn(),
      notifyEnvironment: vi.fn(),
      notifyHost: vi.fn(),
      notifyProject: vi.fn(),
      notifySystem: vi.fn(),
    };

    const result = pruneDestroyedEnvironments(db, spy, {
      updatedBefore: now - DESTROYED_ENVIRONMENT_TTL_MS,
      eventBatchSize: DEFAULT_DESTROYED_ENVIRONMENT_EVENT_DETACH_BATCH_SIZE,
      limit: 10,
    });
    expect(result.deleted).toBe(1);
    expect(
      db
        .select()
        .from(environments)
        .all()
        .map((row) => row.id),
    ).toEqual([freshEnvironment.id]);
    expect(spy.notifyEnvironment).toHaveBeenCalledWith(staleEnvironment.id, [
      "environment-deleted",
    ]);
  });

  it("does not hard-delete stale destroying environments", () => {
    const { db, host, project } = setup();
    const now = Date.now();

    const staleEnvironment = createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      path: "/tmp/stale-destroying",
      managed: true,
      workspaceProvisionType: "managed-worktree",
      status: "destroying",
    });

    db.update(environments)
      .set({ updatedAt: now - 8 * 24 * 60 * 60_000 })
      .where(eq(environments.id, staleEnvironment.id))
      .run();

    const spy: DbNotifier = {
      notifyThread: vi.fn(),
      notifyEnvironment: vi.fn(),
      notifyHost: vi.fn(),
      notifyProject: vi.fn(),
      notifySystem: vi.fn(),
    };

    const result = pruneDestroyedEnvironments(db, spy, {
      updatedBefore: now - DESTROYED_ENVIRONMENT_TTL_MS,
      eventBatchSize: DEFAULT_DESTROYED_ENVIRONMENT_EVENT_DETACH_BATCH_SIZE,
      limit: 10,
    });
    expect(result.deleted).toBe(0);
    expect(
      db.select().from(environments).where(eq(environments.id, staleEnvironment.id)).get()
        ?.status,
    ).toBe("destroying");
    expect(spy.notifyEnvironment).not.toHaveBeenCalled();
  });

  it("a metadata write on a destroyed environment restarts its retention clock", () => {
    const { db, host, project } = setup();
    const now = Date.now();

    const environment = createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      path: "/tmp/destroyed-then-renamed",
      managed: true,
      workspaceProvisionType: "managed-worktree",
      status: "destroyed",
    });
    db.update(environments)
      .set({ updatedAt: now - 8 * 24 * 60 * 60_000 })
      .where(eq(environments.id, environment.id))
      .run();

    updateEnvironmentMetadata(db, noopNotifier, environment.id, {
      name: "renamed",
    });

    const result = pruneDestroyedEnvironments(db, noopNotifier, {
      updatedBefore: now - DESTROYED_ENVIRONMENT_TTL_MS,
      eventBatchSize: DEFAULT_DESTROYED_ENVIRONMENT_EVENT_DETACH_BATCH_SIZE,
      limit: 10,
    });
    expect(result).toEqual({ deleted: 0, detachedEvents: 0 });
    expect(
      db
        .select({ status: environments.status })
        .from(environments)
        .where(eq(environments.id, environment.id))
        .get()?.status,
    ).toBe("destroyed");
  });

  it("advances the oldest stale destroyed environments first and honors the batch limit", () => {
    const { db, host, project } = setup();
    const now = Date.now();
    const day = 24 * 60 * 60_000;

    function createDestroyedEnvironment(path: string, ageMs: number) {
      const environment = createEnvironment(db, noopNotifier, {
        projectId: project.id,
        hostId: host.id,
        path,
        managed: true,
        workspaceProvisionType: "managed-worktree",
        status: "destroyed",
      });
      db.update(environments)
        .set({ updatedAt: now - ageMs })
        .where(eq(environments.id, environment.id))
        .run();
      return environment;
    }

    const nineDaysOld = createDestroyedEnvironment("/tmp/destroyed-9d", 9 * day);
    const tenDaysOld = createDestroyedEnvironment("/tmp/destroyed-10d", 10 * day);
    const eightDaysOld = createDestroyedEnvironment("/tmp/destroyed-8d", 8 * day);
    const fresh = createDestroyedEnvironment("/tmp/destroyed-fresh", 0);
    const oldestThread = createThread(db, noopNotifier, {
      projectId: project.id,
      environmentId: tenDaysOld.id,
      providerId: "codex",
      status: "idle",
    });
    db.insert(events)
      .values({
        id: "event-oldest-environment",
        threadId: oldestThread.id,
        environmentId: tenDaysOld.id,
        scopeKind: "thread",
        sequence: 1,
        type: "thread/started",
        data: "{}",
        createdAt: now,
      })
      .run();

    const spy: DbNotifier = {
      notifyThread: vi.fn(),
      notifyEnvironment: vi.fn(),
      notifyHost: vi.fn(),
      notifyProject: vi.fn(),
      notifySystem: vi.fn(),
    };
    const args = {
      updatedBefore: now - DESTROYED_ENVIRONMENT_TTL_MS,
      eventBatchSize: DEFAULT_DESTROYED_ENVIRONMENT_EVENT_DETACH_BATCH_SIZE,
      limit: 2,
    };
    const remainingIds = () =>
      db
        .select({ id: environments.id })
        .from(environments)
        .orderBy(environments.updatedAt)
        .all()
        .map((row) => row.id);

    expect(pruneDestroyedEnvironments(db, spy, { ...args, limit: 0 })).toEqual({
      deleted: 0,
      detachedEvents: 0,
    });
    expect(spy.notifyEnvironment).not.toHaveBeenCalled();
    expect(remainingIds()).toHaveLength(4);

    expect(pruneDestroyedEnvironments(db, spy, args)).toEqual({
      deleted: 1,
      detachedEvents: 1,
    });
    expect(remainingIds()).toEqual([
      tenDaysOld.id,
      eightDaysOld.id,
      fresh.id,
    ]);
    expect(vi.mocked(spy.notifyEnvironment).mock.calls).toEqual([
      [nineDaysOld.id, ["environment-deleted"]],
    ]);

    expect(pruneDestroyedEnvironments(db, spy, args)).toEqual({
      deleted: 2,
      detachedEvents: 0,
    });
    expect(remainingIds()).toEqual([fresh.id]);
    expect(spy.notifyEnvironment).toHaveBeenCalledTimes(3);
    expect(vi.mocked(spy.notifyEnvironment).mock.calls).toEqual([
      [nineDaysOld.id, ["environment-deleted"]],
      [tenDaysOld.id, ["environment-deleted"]],
      [eightDaysOld.id, ["environment-deleted"]],
    ]);

    expect(pruneDestroyedEnvironments(db, spy, args)).toEqual({
      deleted: 0,
      detachedEvents: 0,
    });
    expect(remainingIds()).toEqual([fresh.id]);
  });

  it("nulls event and thread environment pointers only for the pruned environment", () => {
    const { db, host, project } = setup();
    const now = Date.now();

    function createDestroyedEnvironmentWithThread(path: string, updatedAt: number) {
      const environment = createEnvironment(db, noopNotifier, {
        projectId: project.id,
        hostId: host.id,
        path,
        managed: true,
        workspaceProvisionType: "managed-worktree",
        status: "destroyed",
      });
      db.update(environments)
        .set({ updatedAt })
        .where(eq(environments.id, environment.id))
        .run();
      const thread = createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
        status: "idle",
        environmentId: environment.id,
      });
      const eventId = createEventId();
      db.insert(events)
        .values({
          id: eventId,
          threadId: thread.id,
          environmentId: environment.id,
          scopeKind: "thread",
          sequence: 1,
          type: "thread/started",
          data: JSON.stringify({ type: "thread/started", threadId: thread.id }),
          createdAt: now,
        })
        .run();
      return { environment, thread, eventId };
    }

    const stale = createDestroyedEnvironmentWithThread(
      "/tmp/stale-with-thread",
      now - 8 * 24 * 60 * 60_000,
    );
    const fresh = createDestroyedEnvironmentWithThread(
      "/tmp/fresh-with-thread",
      now,
    );

    const result = pruneDestroyedEnvironments(db, noopNotifier, {
      updatedBefore: now - DESTROYED_ENVIRONMENT_TTL_MS,
      eventBatchSize: DEFAULT_DESTROYED_ENVIRONMENT_EVENT_DETACH_BATCH_SIZE,
      limit: 10,
    });
    expect(result).toEqual({ deleted: 0, detachedEvents: 1 });

    expect(
      pruneDestroyedEnvironments(db, noopNotifier, {
        updatedBefore: now - DESTROYED_ENVIRONMENT_TTL_MS,
        eventBatchSize: DEFAULT_DESTROYED_ENVIRONMENT_EVENT_DETACH_BATCH_SIZE,
        limit: 10,
      }),
    ).toEqual({ deleted: 1, detachedEvents: 0 });

    const environmentPointer = (table: typeof threads | typeof events, id: string) =>
      db
        .select({ environmentId: table.environmentId })
        .from(table)
        .where(eq(table.id, id))
        .get()?.environmentId;

    expect(environmentPointer(threads, stale.thread.id)).toBeNull();
    expect(environmentPointer(events, stale.eventId)).toBeNull();
    expect(environmentPointer(threads, fresh.thread.id)).toBe(fresh.environment.id);
    expect(environmentPointer(events, fresh.eventId)).toBe(fresh.environment.id);
    expect(
      db.select({ id: environments.id }).from(environments).all().map((row) => row.id),
    ).toEqual([fresh.environment.id]);
  });
});
