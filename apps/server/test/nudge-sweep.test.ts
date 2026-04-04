import { eq } from "drizzle-orm";
import {
  createManagerThreadNudge,
  getManagerThreadNudge,
  hostDaemonCommands,
  threads,
} from "@bb/db";
import { describe, expect, it } from "vitest";
import { sweepDueNudges } from "../src/services/nudge-sweep.js";
import { appendClientTurnEvent } from "../src/services/thread-events.js";
import {
  reportQueuedCommandError,
  waitForQueuedCommand,
} from "./helpers/commands.js";
import {
  seedEnvironment,
  seedEvent,
  seedHost,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "./helpers/seed.js";
import { createTestAppHarness } from "./helpers/test-app.js";

type TestHarness = Awaited<ReturnType<typeof createTestAppHarness>>;

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
    data: {},
  });
  appendClientTurnEvent(args.harness.deps, {
    threadId: thread.id,
    environmentId: args.environmentId,
    type: "client/thread/start",
    input: [{ type: "text", text: "Bootstrap manager" }],
    execution: {
      model: "gpt-5",
      reasoningLevel: "medium",
      sandboxMode: "danger-full-access",
      serviceTier: "default",
      source: "client/thread/start",
    },
    initiator: "user",
    requestMethod: "thread/start",
    source: "spawn",
  });
  return thread;
}

describe("nudge sweep", () => {
  it("queues turn.run for due manager nudges", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-nudge-run",
      });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
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
          command.type === "host.read_file" &&
          command.path === preferencesPath,
      );
      expect(readPreferences.command.type).toBe("host.read_file");
      const preferencesResponse = await reportQueuedCommandError(harness, readPreferences, {
        errorCode: "ENOENT",
        errorMessage: "File not found",
      });
      expect(preferencesResponse.status).toBe(200);

      await sweepPromise;

      const queuedTurnRun = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.run" &&
          command.threadId === thread.id,
      );
      expect(queuedTurnRun.command.input).toEqual([
        {
          type: "text",
          text: "[bb system] Scheduled nudge: daily-recap. Check ASYNC.md.",
        },
      ]);
      expect(
        harness.db
          .select()
          .from(threads)
          .where(eq(threads.id, thread.id))
          .get()?.status,
      ).toBe("active");

      const updatedNudge = getManagerThreadNudge(harness.db, nudge.id);
      expect(updatedNudge?.lastFiredAt).toBe(now);
      expect(updatedNudge?.nextFireAt).toBeGreaterThan(now);
    } finally {
      await harness.cleanup();
    }
  });

  it("skips due nudges that already have a pending turn.run command", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-nudge-pending",
      });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
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

      harness.db.insert(hostDaemonCommands)
        .values({
          id: "cmd_pending_turn_run",
          hostId: host.id,
          sessionId: session.id,
          cursor: 1,
          type: "turn.run",
          payload: JSON.stringify({
            type: "turn.run",
            environmentId: environment.id,
            threadId: thread.id,
            eventSequence: 2,
            input: [{ type: "text", text: "Existing pending nudge" }],
            options: {
              model: "gpt-5",
              reasoningLevel: "medium",
              sandboxMode: "danger-full-access",
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
            },
          }),
          state: "pending",
          retryCount: 0,
          createdAt: now,
        })
        .run();

      await sweepDueNudges(harness.deps, { now });

      expect(harness.db.select().from(hostDaemonCommands).all()).toHaveLength(1);
      const updatedNudge = getManagerThreadNudge(harness.db, nudge.id);
      expect(updatedNudge?.lastFiredAt).toBe(now);
      expect(updatedNudge?.nextFireAt).toBeGreaterThan(now);
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
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
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
      harness.db.update(threads)
        .set({ archivedAt: now, updatedAt: now })
        .where(eq(threads.id, thread.id))
        .run();

      await sweepDueNudges(harness.deps, { now });

      expect(getManagerThreadNudge(harness.db, nudge.id)).toBeNull();
      expect(harness.db.select().from(hostDaemonCommands).all()).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });

  it("advances due nudges without queueing work when the thread is not idle", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-nudge-non-idle",
      });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/nudge-non-idle-environment",
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
        name: "non-idle-check",
        cron: "0 8 * * *",
        timezone: "UTC",
        enabled: true,
        nextFireAt: now - 1,
      });
      harness.db.update(threads)
        .set({ status: "active", updatedAt: now })
        .where(eq(threads.id, thread.id))
        .run();

      await sweepDueNudges(harness.deps, { now });

      expect(harness.db.select().from(hostDaemonCommands).all()).toHaveLength(0);
      expect(getManagerThreadNudge(harness.db, nudge.id)).toMatchObject({
        lastFiredAt: now,
      });
      expect(getManagerThreadNudge(harness.db, nudge.id)?.nextFireAt).toBeGreaterThan(now);
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
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
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

      expect(harness.db.select().from(hostDaemonCommands).all()).toHaveLength(0);
      const updatedNudge = getManagerThreadNudge(harness.db, nudge.id);
      expect(updatedNudge?.lastFiredAt).toBe(now);
      expect(updatedNudge?.nextFireAt).toBeGreaterThan(now);
    } finally {
      await harness.cleanup();
    }
  });
});
