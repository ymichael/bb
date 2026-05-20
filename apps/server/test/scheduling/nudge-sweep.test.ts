import { and, eq } from "drizzle-orm";
import {
  createManagerThreadNudge,
  events,
  getManagerThreadNudge,
  hostDaemonCommands,
  threads,
  updateManagerThreadNudge,
  upsertThreadDynamicContextFileState,
} from "@bb/db";
import { threadScope, turnRequestEventDataSchema, turnScope } from "@bb/domain";
import { describe, expect, it } from "vitest";
import { sweepDueNudges } from "../../src/services/scheduling/nudge-sweep.js";
import { buildManagerToolReminderText } from "../../src/services/threads/manager-tool-reminder.js";
import { appendClientTurnEvent } from "../../src/services/threads/thread-events.js";
import {
  reportQueuedCommandError,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
  waitForQueuedCommandAfter,
} from "../helpers/commands.js";
import {
  seedEnvironment,
  seedEvent,
  seedHost,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { createTestAppHarness } from "../helpers/test-app.js";
import { MANAGER_PREFERENCES_FILE_KEY } from "../../src/services/threads/manager-dynamic-file-delivery.js";

type TestHarness = Awaited<ReturnType<typeof createTestAppHarness>>;

function managerToolReminderInput() {
  return {
    type: "text",
    text: buildManagerToolReminderText("codex"),
  };
}

function seedRunnableManagerThread(args: {
  environmentId: string;
  harness: TestHarness;
  projectId: string;
}) {
  const thread = seedThread(args.harness.deps, {
    projectId: args.projectId,
    environmentId: args.environmentId,
    status: "idle",
    type: "manager",
  });
  seedEvent(args.harness.deps, {
    threadId: thread.id,
    environmentId: args.environmentId,
    providerThreadId: "provider-manager-thread",
    sequence: 1,
    type: "thread/identity",
    scope: threadScope(),
    data: {},
  });
  appendClientTurnEvent(args.harness.deps, {
    threadId: thread.id,
    environmentId: args.environmentId,
    type: "client/turn/requested",
    input: [{ type: "text", text: "Bootstrap manager" }],
    target: { kind: "thread-start" },
    execution: {
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      source: "client/turn/requested",
    },
    initiator: "user",
    senderThreadId: null,
    requestMethod: "thread/start",
    source: "spawn",
  });
  return thread;
}

describe("nudge sweep", () => {
  it("queues turn.submit for due manager nudges", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-nudge-run",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/nudge-sweep-environment",
      });
      const thread = seedRunnableManagerThread({
        harness,
        environmentId: environment.id,
        projectId: project.id,
      });
      const now = Date.now();
      const nudge = createManagerThreadNudge(harness.db, harness.hub, {
        projectId: project.id,
        threadId: thread.id,
        name: "daily-recap",
        cron: "0 8 * * *",
        timezone: "UTC",
        enabled: true,
        nextFireAt: now - 1,
      });

      const sweepPromise = sweepDueNudges(harness.deps, { now });
      const preferencesPath = `/tmp/bb-host-data/${host.id}/thread-storage/${thread.id}/PREFERENCES.md`;
      const readPreferences = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "host.read_file" && command.path === preferencesPath,
      );
      expect(readPreferences.command.type).toBe("host.read_file");
      const preferencesResponse = await reportQueuedCommandError(
        harness,
        readPreferences,
        {
          errorCode: "ENOENT",
          errorMessage: "File not found",
        },
      );
      expect(preferencesResponse.status).toBe(200);

      await sweepPromise;

      const queuedTurnSubmit = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.submit" && command.threadId === thread.id,
      );
      if (queuedTurnSubmit.command.type !== "turn.submit") {
        throw new Error("Expected turn.submit command");
      }
      expect(queuedTurnSubmit.command.input).toEqual([
        {
          type: "text",
          text: "[bb system]\n\nScheduled nudge: daily-recap. Check ASYNC.md.",
        },
        managerToolReminderInput(),
      ]);
      expect(
        harness.db.select().from(threads).where(eq(threads.id, thread.id)).get()
          ?.status,
      ).toBe("active");

      const updatedNudge = getManagerThreadNudge(harness.db, nudge.id);
      expect(updatedNudge?.lastFiredAt).toBe(now);
      expect(updatedNudge?.nextFireAt).toBeGreaterThan(now);
    } finally {
      await harness.cleanup();
    }
  });

  it("prepends changed preferences to scheduled nudge turn events and commands", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-nudge-preferences-update",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/nudge-preferences-update-environment",
      });
      const thread = seedRunnableManagerThread({
        harness,
        environmentId: environment.id,
        projectId: project.id,
      });
      const now = Date.now();
      upsertThreadDynamicContextFileState(harness.db, {
        threadId: thread.id,
        fileKey: MANAGER_PREFERENCES_FILE_KEY,
        contentStatus: "present",
        contentHash: "previous-preferences-hash",
        shownAt: now - 1_000,
      });
      createManagerThreadNudge(harness.db, harness.hub, {
        projectId: project.id,
        threadId: thread.id,
        name: "daily-recap",
        cron: "0 8 * * *",
        timezone: "UTC",
        enabled: true,
        nextFireAt: now - 1,
      });

      const sweepPromise = sweepDueNudges(harness.deps, { now });
      const preferencesPath = `/tmp/bb-host-data/${host.id}/thread-storage/${thread.id}/PREFERENCES.md`;
      const readPreferences = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "host.read_file" && command.path === preferencesPath,
      );
      if (readPreferences.command.type !== "host.read_file") {
        throw new Error(`Expected host.read_file command`);
      }
      const preferencesResponse = await reportQueuedCommandSuccess(
        harness,
        { command: readPreferences.command, row: readPreferences.row },
        {
          path: preferencesPath,
          content: "# Preferences\n\n- updated by nudge\n",
          contentEncoding: "utf8",
          mimeType: "text/markdown",
          sizeBytes: "# Preferences\n\n- updated by nudge\n".length,
        },
      );
      expect(preferencesResponse.status).toBe(200);

      await sweepPromise;

      const queuedTurnSubmit = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.submit" && command.threadId === thread.id,
      );
      if (queuedTurnSubmit.command.type !== "turn.submit") {
        throw new Error("Expected turn.submit command");
      }
      expect(queuedTurnSubmit.command.input[0]).toEqual({
        type: "text",
        text: expect.stringContaining(
          "PREFERENCES.md has been updated. New contents:",
        ),
        visibility: "agent-only",
      });
      expect(queuedTurnSubmit.command.input[1]).toEqual({
        type: "text",
        text: "[bb system]\n\nScheduled nudge: daily-recap. Check ASYNC.md.",
      });
      expect(queuedTurnSubmit.command.input[1]).not.toHaveProperty(
        "visibility",
      );
      expect(queuedTurnSubmit.command.input[2]).toEqual(
        managerToolReminderInput(),
      );

      const turnRequestRow = harness.db
        .select({ data: events.data, type: events.type })
        .from(events)
        .where(eq(events.threadId, thread.id))
        .all()
        .filter((row) => row.type === "client/turn/requested")
        .at(-1);
      if (!turnRequestRow) {
        throw new Error("Expected client turn request event");
      }
      const turnRequest = turnRequestEventDataSchema.parse(
        JSON.parse(turnRequestRow.data),
      );
      expect(turnRequest.input[0]).toEqual(queuedTurnSubmit.command.input[0]);
      expect(turnRequest.input[1]).toEqual(queuedTurnSubmit.command.input[1]);
    } finally {
      await harness.cleanup();
    }
  });

  it("skips due nudges that already have a pending turn.submit command", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-nudge-pending",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/nudge-pending-environment",
      });
      const thread = seedRunnableManagerThread({
        harness,
        environmentId: environment.id,
        projectId: project.id,
      });
      const now = Date.now();
      const nudge = createManagerThreadNudge(harness.db, harness.hub, {
        projectId: project.id,
        threadId: thread.id,
        name: "deploy-check",
        cron: "0 8 * * *",
        timezone: "UTC",
        enabled: true,
        nextFireAt: now - 1,
      });

      harness.db
        .insert(hostDaemonCommands)
        .values({
          id: "cmd_pending_turn_submit",
          hostId: host.id,
          sessionId: session.id,
          cursor: 1,
          type: "turn.submit",
          payload: JSON.stringify({
            type: "turn.submit",
            environmentId: environment.id,
            threadId: thread.id,
            requestId: "creq_23456789ab",
            input: [{ type: "text", text: "Existing pending nudge" }],
            options: {
              model: "gpt-5",
              reasoningLevel: "medium",
              permissionMode: "full",
              serviceTier: "default",
              source: "client/turn/requested",
            },
            resumeContext: {
              workspaceContext: {
                workspacePath: environment.path,
                workspaceProvisionType: environment.workspaceProvisionType,
              },
              projectId: project.id,
              providerId: thread.providerId,
              providerThreadId: "provider-manager-thread",
              instructions: "manager instructions",
              dynamicTools: [],
              instructionMode: "append",
            },
            target: { mode: "start" },
          }),
          state: "pending",
          retryCount: 0,
          createdAt: now,
        })
        .run();

      await sweepDueNudges(harness.deps, { now });

      expect(harness.db.select().from(hostDaemonCommands).all()).toHaveLength(
        1,
      );
      const updatedNudge = getManagerThreadNudge(harness.db, nudge.id);
      expect(updatedNudge?.lastFiredAt).toBe(now);
      expect(updatedNudge?.nextFireAt).toBeGreaterThan(now);
    } finally {
      await harness.cleanup();
    }
  });

  it("skips due nudges that already have a pending native archive command", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-nudge-pending-native-archive",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/nudge-pending-native-archive-environment",
      });
      const thread = seedRunnableManagerThread({
        harness,
        environmentId: environment.id,
        projectId: project.id,
      });
      const now = Date.now();
      const nudge = createManagerThreadNudge(harness.db, harness.hub, {
        projectId: project.id,
        threadId: thread.id,
        name: "archive-sync-check",
        cron: "0 8 * * *",
        timezone: "UTC",
        enabled: true,
        nextFireAt: now - 1,
      });

      harness.db
        .insert(hostDaemonCommands)
        .values({
          id: "cmd_pending_native_archive",
          hostId: host.id,
          sessionId: session.id,
          cursor: 1,
          type: "thread.archive",
          payload: JSON.stringify({
            type: "thread.archive",
            environmentId: environment.id,
            threadId: thread.id,
            workspaceContext: {
              workspacePath: environment.path,
              workspaceProvisionType: environment.workspaceProvisionType,
            },
            providerId: thread.providerId,
            providerThreadId: "provider-manager-thread",
          }),
          state: "pending",
          retryCount: 0,
          createdAt: now,
        })
        .run();

      await sweepDueNudges(harness.deps, { now });

      expect(
        harness.db
          .select()
          .from(hostDaemonCommands)
          .where(eq(hostDaemonCommands.type, "turn.submit"))
          .all(),
      ).toHaveLength(0);
      expect(
        harness.db
          .select()
          .from(hostDaemonCommands)
          .where(eq(hostDaemonCommands.type, "thread.archive"))
          .all(),
      ).toHaveLength(1);
      const updatedNudge = getManagerThreadNudge(harness.db, nudge.id);
      expect(updatedNudge?.lastFiredAt).toBe(now);
      expect(updatedNudge?.nextFireAt).toBeGreaterThan(now);
    } finally {
      await harness.cleanup();
    }
  });

  it("ignores disabled nudges even if nextFireAt is in the past", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-nudge-disabled",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/nudge-disabled-environment",
      });
      const thread = seedRunnableManagerThread({
        harness,
        environmentId: environment.id,
        projectId: project.id,
      });
      const now = Date.now();
      const nudge = createManagerThreadNudge(harness.db, harness.hub, {
        projectId: project.id,
        threadId: thread.id,
        name: "disabled-check",
        cron: "0 8 * * *",
        timezone: "UTC",
        enabled: false,
        nextFireAt: now - 1,
      });

      await sweepDueNudges(harness.deps, { now });

      expect(harness.db.select().from(hostDaemonCommands).all()).toHaveLength(
        0,
      );
      expect(getManagerThreadNudge(harness.db, nudge.id)).toMatchObject({
        enabled: false,
        lastFiredAt: null,
        nextFireAt: now - 1,
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("deletes due nudges for archived threads", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-nudge-archived",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/nudge-archived-environment",
      });
      const thread = seedRunnableManagerThread({
        harness,
        environmentId: environment.id,
        projectId: project.id,
      });
      const now = Date.now();
      const nudge = createManagerThreadNudge(harness.db, harness.hub, {
        projectId: project.id,
        threadId: thread.id,
        name: "archived-check",
        cron: "0 8 * * *",
        timezone: "UTC",
        enabled: true,
        nextFireAt: now - 1,
      });
      harness.db
        .update(threads)
        .set({ archivedAt: now, updatedAt: now })
        .where(eq(threads.id, thread.id))
        .run();

      await sweepDueNudges(harness.deps, { now });

      expect(getManagerThreadNudge(harness.db, nudge.id)).toBeNull();
      expect(harness.db.select().from(hostDaemonCommands).all()).toHaveLength(
        0,
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("queues due nudges as auto submits when the manager is already active", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-nudge-active",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/nudge-active-environment",
      });
      const thread = seedRunnableManagerThread({
        harness,
        environmentId: environment.id,
        projectId: project.id,
      });
      const now = Date.now();
      const nudge = createManagerThreadNudge(harness.db, harness.hub, {
        projectId: project.id,
        threadId: thread.id,
        name: "active-check",
        cron: "0 8 * * *",
        timezone: "UTC",
        enabled: true,
        nextFireAt: now - 1,
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-manager-thread",
        sequence: 3,
        type: "turn/started",
        scope: turnScope("turn-active-nudge"),
        data: {},
      });
      harness.db
        .update(threads)
        .set({ status: "active", updatedAt: now })
        .where(eq(threads.id, thread.id))
        .run();

      const sweepPromise = sweepDueNudges(harness.deps, { now });
      const preferencesPath = `/tmp/bb-host-data/${host.id}/thread-storage/${thread.id}/PREFERENCES.md`;
      const readPreferences = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "host.read_file" && command.path === preferencesPath,
      );
      const preferencesResponse = await reportQueuedCommandError(
        harness,
        readPreferences,
        {
          errorCode: "ENOENT",
          errorMessage: "File not found",
        },
      );
      expect(preferencesResponse.status).toBe(200);

      await sweepPromise;

      const queuedTurnSubmit = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.submit" && command.threadId === thread.id,
      );
      expect(queuedTurnSubmit.command).toMatchObject({
        input: [
          {
            type: "text",
            text: "[bb system]\n\nScheduled nudge: active-check. Check ASYNC.md.",
          },
          managerToolReminderInput(),
        ],
        target: {
          mode: "auto",
          expectedTurnId: "turn-active-nudge",
        },
      });

      const clientRequests = harness.db
        .select()
        .from(events)
        .where(
          and(
            eq(events.threadId, thread.id),
            eq(events.type, "client/turn/requested"),
          ),
        )
        .orderBy(events.sequence)
        .all();
      const nudgeRequest = clientRequests[clientRequests.length - 1];
      if (!nudgeRequest) {
        throw new Error("Expected nudge client request event");
      }
      const nudgeRequestData = turnRequestEventDataSchema.parse(
        JSON.parse(nudgeRequest.data),
      );
      expect(nudgeRequestData.target).toEqual({
        kind: "auto",
        expectedTurnId: "turn-active-nudge",
      });
      expect(getManagerThreadNudge(harness.db, nudge.id)).toMatchObject({
        lastFiredAt: now,
      });
      expect(
        getManagerThreadNudge(harness.db, nudge.id)?.nextFireAt,
      ).toBeGreaterThan(now);
    } finally {
      await harness.cleanup();
    }
  });

  it("does not queue a stale start nudge when the thread becomes active during preparation", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-nudge-idle-active-race",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/nudge-idle-active-race-environment",
      });
      const thread = seedRunnableManagerThread({
        harness,
        environmentId: environment.id,
        projectId: project.id,
      });
      const now = Date.now();
      const nudge = createManagerThreadNudge(harness.db, harness.hub, {
        projectId: project.id,
        threadId: thread.id,
        name: "idle-active-race",
        cron: "0 8 * * *",
        timezone: "UTC",
        enabled: true,
        nextFireAt: now - 1,
      });

      const sweepPromise = sweepDueNudges(harness.deps, { now });
      const preferencesPath = `/tmp/bb-host-data/${host.id}/thread-storage/${thread.id}/PREFERENCES.md`;
      const readPreferences = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "host.read_file" && command.path === preferencesPath,
      );

      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-manager-thread",
        sequence: 3,
        type: "turn/started",
        scope: turnScope("turn-became-active"),
        data: {},
      });
      harness.db
        .update(threads)
        .set({ status: "active", updatedAt: now })
        .where(eq(threads.id, thread.id))
        .run();

      const preferencesResponse = await reportQueuedCommandError(
        harness,
        readPreferences,
        {
          errorCode: "ENOENT",
          errorMessage: "File not found",
        },
      );
      expect(preferencesResponse.status).toBe(200);

      await sweepPromise;

      expect(
        harness.db
          .select()
          .from(hostDaemonCommands)
          .where(eq(hostDaemonCommands.type, "turn.submit"))
          .all(),
      ).toHaveLength(0);
      expect(
        harness.db
          .select()
          .from(events)
          .where(
            and(
              eq(events.threadId, thread.id),
              eq(events.type, "client/turn/requested"),
            ),
          )
          .all(),
      ).toHaveLength(1);
      expect(getManagerThreadNudge(harness.db, nudge.id)).toMatchObject({
        lastFiredAt: null,
        nextFireAt: now - 1,
      });

      const retrySweepPromise = sweepDueNudges(harness.deps, { now: now + 1 });
      const retryReadPreferences = await waitForQueuedCommandAfter(
        harness,
        readPreferences.row.cursor,
        ({ command }) =>
          command.type === "host.read_file" && command.path === preferencesPath,
      );
      const retryPreferencesResponse = await reportQueuedCommandError(
        harness,
        retryReadPreferences,
        {
          errorCode: "ENOENT",
          errorMessage: "File not found",
        },
      );
      expect(retryPreferencesResponse.status).toBe(200);

      await retrySweepPromise;

      const queuedTurnSubmit = await waitForQueuedCommandAfter(
        harness,
        retryReadPreferences.row.cursor,
        ({ command }) =>
          command.type === "turn.submit" && command.threadId === thread.id,
      );
      expect(queuedTurnSubmit.command).toMatchObject({
        target: {
          mode: "auto",
          expectedTurnId: "turn-became-active",
        },
      });
      const clientRequests = harness.db
        .select()
        .from(events)
        .where(
          and(
            eq(events.threadId, thread.id),
            eq(events.type, "client/turn/requested"),
          ),
        )
        .orderBy(events.sequence)
        .all();
      const nudgeRequest = clientRequests[clientRequests.length - 1];
      if (!nudgeRequest) {
        throw new Error("Expected retry nudge client request event");
      }
      const nudgeRequestData = turnRequestEventDataSchema.parse(
        JSON.parse(nudgeRequest.data),
      );
      expect(nudgeRequestData.target).toEqual({
        kind: "auto",
        expectedTurnId: "turn-became-active",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("does not queue a stale active nudge when the active turn changes during preparation", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-nudge-active-race",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/nudge-active-race-environment",
      });
      const thread = seedRunnableManagerThread({
        harness,
        environmentId: environment.id,
        projectId: project.id,
      });
      const now = Date.now();
      const nudge = createManagerThreadNudge(harness.db, harness.hub, {
        projectId: project.id,
        threadId: thread.id,
        name: "active-race",
        cron: "0 8 * * *",
        timezone: "UTC",
        enabled: true,
        nextFireAt: now - 1,
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-manager-thread",
        sequence: 3,
        type: "turn/started",
        scope: turnScope("turn-original-active"),
        data: {},
      });
      harness.db
        .update(threads)
        .set({ status: "active", updatedAt: now })
        .where(eq(threads.id, thread.id))
        .run();

      const sweepPromise = sweepDueNudges(harness.deps, { now });
      const preferencesPath = `/tmp/bb-host-data/${host.id}/thread-storage/${thread.id}/PREFERENCES.md`;
      const readPreferences = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "host.read_file" && command.path === preferencesPath,
      );

      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-manager-thread",
        sequence: 4,
        type: "turn/started",
        scope: turnScope("turn-replaced-active"),
        data: {},
      });

      const preferencesResponse = await reportQueuedCommandError(
        harness,
        readPreferences,
        {
          errorCode: "ENOENT",
          errorMessage: "File not found",
        },
      );
      expect(preferencesResponse.status).toBe(200);

      await sweepPromise;

      expect(
        harness.db
          .select()
          .from(hostDaemonCommands)
          .where(eq(hostDaemonCommands.type, "turn.submit"))
          .all(),
      ).toHaveLength(0);
      expect(getManagerThreadNudge(harness.db, nudge.id)).toMatchObject({
        lastFiredAt: null,
        nextFireAt: now - 1,
      });

      const retrySweepPromise = sweepDueNudges(harness.deps, { now: now + 1 });
      const retryReadPreferences = await waitForQueuedCommandAfter(
        harness,
        readPreferences.row.cursor,
        ({ command }) =>
          command.type === "host.read_file" && command.path === preferencesPath,
      );
      const retryPreferencesResponse = await reportQueuedCommandError(
        harness,
        retryReadPreferences,
        {
          errorCode: "ENOENT",
          errorMessage: "File not found",
        },
      );
      expect(retryPreferencesResponse.status).toBe(200);

      await retrySweepPromise;

      const queuedTurnSubmit = await waitForQueuedCommandAfter(
        harness,
        retryReadPreferences.row.cursor,
        ({ command }) =>
          command.type === "turn.submit" && command.threadId === thread.id,
      );
      expect(queuedTurnSubmit.command).toMatchObject({
        target: {
          mode: "auto",
          expectedTurnId: "turn-replaced-active",
        },
      });
      const clientRequests = harness.db
        .select()
        .from(events)
        .where(
          and(
            eq(events.threadId, thread.id),
            eq(events.type, "client/turn/requested"),
          ),
        )
        .orderBy(events.sequence)
        .all();
      const nudgeRequest = clientRequests[clientRequests.length - 1];
      if (!nudgeRequest) {
        throw new Error("Expected retry nudge client request event");
      }
      const nudgeRequestData = turnRequestEventDataSchema.parse(
        JSON.parse(nudgeRequest.data),
      );
      expect(nudgeRequestData.target).toEqual({
        kind: "auto",
        expectedTurnId: "turn-replaced-active",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("advances due nudges without queueing work when the host is offline", async () => {
    const harness = await createTestAppHarness();
    try {
      const host = seedHost(harness.deps, {
        id: "host-nudge-offline",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/nudge-offline-environment",
      });
      const thread = seedRunnableManagerThread({
        harness,
        environmentId: environment.id,
        projectId: project.id,
      });
      const now = Date.now();
      const nudge = createManagerThreadNudge(harness.db, harness.hub, {
        projectId: project.id,
        threadId: thread.id,
        name: "offline-check",
        cron: "0 8 * * *",
        timezone: "UTC",
        enabled: true,
        nextFireAt: now - 1,
      });

      await sweepDueNudges(harness.deps, { now });

      expect(harness.db.select().from(hostDaemonCommands).all()).toHaveLength(
        0,
      );
      const updatedNudge = getManagerThreadNudge(harness.db, nudge.id);
      expect(updatedNudge?.lastFiredAt).toBe(now);
      expect(updatedNudge?.nextFireAt).toBeGreaterThan(now);
    } finally {
      await harness.cleanup();
    }
  });

  it("does not queue work after losing the optimistic-lock race", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-nudge-lost-race",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/nudge-lost-race-environment",
      });
      const thread = seedRunnableManagerThread({
        harness,
        environmentId: environment.id,
        projectId: project.id,
      });
      const now = Date.now();
      const nudge = createManagerThreadNudge(harness.db, harness.hub, {
        projectId: project.id,
        threadId: thread.id,
        name: "lost-race-check",
        cron: "0 8 * * *",
        timezone: "UTC",
        enabled: true,
        nextFireAt: now - 1,
      });

      const sweepPromise = sweepDueNudges(harness.deps, { now });
      const readPreferences = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "host.read_file" &&
          command.path ===
            `/tmp/bb-host-data/${host.id}/thread-storage/${thread.id}/PREFERENCES.md`,
      );

      const externallyAdvancedNextFireAt = now + 60_000;
      updateManagerThreadNudge(harness.db, harness.hub, nudge.id, {
        nextFireAt: externallyAdvancedNextFireAt,
      });

      const preferencesResponse = await reportQueuedCommandError(
        harness,
        readPreferences,
        {
          errorCode: "ENOENT",
          errorMessage: "File not found",
        },
      );
      expect(preferencesResponse.status).toBe(200);

      await sweepPromise;

      expect(
        harness.db
          .select()
          .from(hostDaemonCommands)
          .where(eq(hostDaemonCommands.type, "turn.submit"))
          .all(),
      ).toHaveLength(0);
      expect(getManagerThreadNudge(harness.db, nudge.id)).toMatchObject({
        lastFiredAt: null,
        nextFireAt: externallyAdvancedNextFireAt,
      });
    } finally {
      await harness.cleanup();
    }
  });
});
