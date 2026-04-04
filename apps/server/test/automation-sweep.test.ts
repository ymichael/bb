import { eq } from "drizzle-orm";
import {
  createAutomation,
  deleteProjectSource,
  getAutomation,
  hostDaemonCommands,
  listProjectSources,
  threads,
} from "@bb/db";
import { describe, expect, it } from "vitest";
import { sweepDueAutomations } from "../src/services/automation-sweep.js";
import { waitForQueuedCommand } from "./helpers/commands.js";
import {
  seedEnvironment,
  seedHost,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "./helpers/seed.js";
import { createTestAppHarness } from "./helpers/test-app.js";

describe("automation sweep", () => {
  it("creates a thread through the shared creation path for due automations", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-automation-run",
      });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/automation-reuse-environment",
      });
      const now = Date.now();
      const automation = createAutomation(harness.db, harness.hub, {
        projectId: project.id,
        name: "Daily automation",
        enabled: true,
        triggerType: "schedule",
        triggerConfig: JSON.stringify({
          triggerType: "schedule",
          cron: "0 8 * * *",
          timezone: "UTC",
        }),
        action: JSON.stringify({
          actionType: "scheduled-thread",
          threadRequest: {
            providerId: "codex",
            model: "gpt-5",
            input: [{ type: "text", text: "Run the automation" }],
            environment: {
              type: "reuse",
              environmentId: environment.id,
            },
          },
        }),
        autoArchive: false,
        nextRunAt: now - 1,
      });

      await sweepDueAutomations(harness.deps, { now });

      const createdThreads = harness.db
        .select()
        .from(threads)
        .where(eq(threads.automationId, automation.id))
        .all();
      expect(createdThreads).toHaveLength(1);
      expect(createdThreads[0]).toMatchObject({
        automationId: automation.id,
        environmentId: environment.id,
        projectId: project.id,
        status: "active",
      });

      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" &&
          command.threadId === createdThreads[0]?.id,
      );
      expect(queued.command).toMatchObject({
        environmentId: environment.id,
        projectId: project.id,
      });

      const updatedAutomation = getAutomation(harness.db, automation.id);
      expect(updatedAutomation?.lastRunAt).toBeGreaterThanOrEqual(now);
      expect(updatedAutomation?.runCount).toBe(1);
      expect(updatedAutomation?.nextRunAt).toBeGreaterThan(now);
    } finally {
      await harness.cleanup();
    }
  });

  it("continues processing later due automations when one has an invalid stored schedule", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-automation-invalid-config",
      });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/automation-invalid-config-environment",
      });
      const now = Date.now();
      createAutomation(harness.db, harness.hub, {
        projectId: project.id,
        name: "Broken automation",
        enabled: true,
        triggerType: "schedule",
        triggerConfig: JSON.stringify({
          triggerType: "schedule",
          cron: "0 8 * * *",
          timezone: "Mars/Olympus",
        }),
        action: JSON.stringify({
          actionType: "scheduled-thread",
          threadRequest: {
            providerId: "codex",
            model: "gpt-5",
            input: [{ type: "text", text: "Should be skipped" }],
            environment: {
              type: "reuse",
              environmentId: environment.id,
            },
          },
        }),
        autoArchive: false,
        nextRunAt: now - 2,
      });
      const runnableAutomation = createAutomation(harness.db, harness.hub, {
        projectId: project.id,
        name: "Runnable automation",
        enabled: true,
        triggerType: "schedule",
        triggerConfig: JSON.stringify({
          triggerType: "schedule",
          cron: "0 8 * * *",
          timezone: "UTC",
        }),
        action: JSON.stringify({
          actionType: "scheduled-thread",
          threadRequest: {
            providerId: "codex",
            model: "gpt-5",
            input: [{ type: "text", text: "Should still run" }],
            environment: {
              type: "reuse",
              environmentId: environment.id,
            },
          },
        }),
        autoArchive: false,
        nextRunAt: now - 1,
      });

      await sweepDueAutomations(harness.deps, { now });

      expect(
        harness.db
          .select()
          .from(threads)
          .where(eq(threads.automationId, runnableAutomation.id))
          .all(),
      ).toHaveLength(1);
      expect(getAutomation(harness.db, runnableAutomation.id)?.runCount).toBe(1);
    } finally {
      await harness.cleanup();
    }
  });

  it("advances due automations without creating threads when the host is offline", async () => {
    const harness = await createTestAppHarness();
    try {
      const host = seedHost(harness.deps, {
        id: "host-automation-offline",
      });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/automation-offline-environment",
      });
      const now = Date.now();
      const automation = createAutomation(harness.db, harness.hub, {
        projectId: project.id,
        name: "Offline automation",
        enabled: true,
        triggerType: "schedule",
        triggerConfig: JSON.stringify({
          triggerType: "schedule",
          cron: "0 8 * * *",
          timezone: "UTC",
        }),
        action: JSON.stringify({
          actionType: "scheduled-thread",
          threadRequest: {
            providerId: "codex",
            model: "gpt-5",
            input: [{ type: "text", text: "Run offline automation" }],
            environment: {
              type: "reuse",
              environmentId: environment.id,
            },
          },
        }),
        autoArchive: false,
        nextRunAt: now - 1,
      });

      await sweepDueAutomations(harness.deps, { now });

      expect(
        harness.db
          .select()
          .from(threads)
          .where(eq(threads.automationId, automation.id))
          .all(),
      ).toHaveLength(0);
      expect(harness.db.select().from(hostDaemonCommands).all()).toHaveLength(0);

      const updatedAutomation = getAutomation(harness.db, automation.id);
      expect(updatedAutomation?.lastRunAt).toBeGreaterThanOrEqual(now);
      expect(updatedAutomation?.runCount).toBe(1);
      expect(updatedAutomation?.nextRunAt).toBeGreaterThan(now);
    } finally {
      await harness.cleanup();
    }
  });

  it("skips creating a new thread when the automation already has an open thread", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-automation-dedupe",
      });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/automation-dedupe-environment",
      });
      const now = Date.now();
      const automation = createAutomation(harness.db, harness.hub, {
        projectId: project.id,
        name: "Deduped automation",
        enabled: true,
        triggerType: "schedule",
        triggerConfig: JSON.stringify({
          triggerType: "schedule",
          cron: "0 8 * * *",
          timezone: "UTC",
        }),
        action: JSON.stringify({
          actionType: "scheduled-thread",
          threadRequest: {
            providerId: "codex",
            model: "gpt-5",
            input: [{ type: "text", text: "Run deduped automation" }],
            environment: {
              type: "reuse",
              environmentId: environment.id,
            },
          },
        }),
        autoArchive: false,
        nextRunAt: now - 1,
      });
      const existingThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
        title: "Existing automation thread",
      });
      harness.db.update(threads)
        .set({ automationId: automation.id })
        .where(eq(threads.id, existingThread.id))
        .run();

      await sweepDueAutomations(harness.deps, { now });

      expect(
        harness.db
          .select()
          .from(threads)
          .where(eq(threads.automationId, automation.id))
          .all(),
      ).toHaveLength(1);
      expect(harness.db.select().from(hostDaemonCommands).all()).toHaveLength(0);

      const updatedAutomation = getAutomation(harness.db, automation.id);
      expect(updatedAutomation?.runCount).toBe(1);
      expect(updatedAutomation?.lastRunAt).toBeGreaterThanOrEqual(now);
    } finally {
      await harness.cleanup();
    }
  });

  it("creates a new thread after the previous automation thread is archived", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-automation-archived-run",
      });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/automation-archived-environment",
      });
      const now = Date.now();
      const automation = createAutomation(harness.db, harness.hub, {
        projectId: project.id,
        name: "Archived automation",
        enabled: true,
        triggerType: "schedule",
        triggerConfig: JSON.stringify({
          triggerType: "schedule",
          cron: "0 8 * * *",
          timezone: "UTC",
        }),
        action: JSON.stringify({
          actionType: "scheduled-thread",
          threadRequest: {
            providerId: "codex",
            model: "gpt-5",
            input: [{ type: "text", text: "Run archived automation" }],
            environment: {
              type: "reuse",
              environmentId: environment.id,
            },
          },
        }),
        autoArchive: false,
        nextRunAt: now - 1,
      });
      const archivedThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
        title: "Archived automation thread",
      });
      harness.db.update(threads)
        .set({
          archivedAt: now - 10,
          automationId: automation.id,
        })
        .where(eq(threads.id, archivedThread.id))
        .run();

      await sweepDueAutomations(harness.deps, { now });

      const createdThreads = harness.db
        .select()
        .from(threads)
        .where(eq(threads.automationId, automation.id))
        .all();
      expect(createdThreads).toHaveLength(2);
      expect(createdThreads.filter((thread) => thread.archivedAt === null)).toHaveLength(1);
    } finally {
      await harness.cleanup();
    }
  });

  it("restores the automation schedule when thread creation fails", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-automation-rollback",
      });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const now = Date.now();
      const automation = createAutomation(harness.db, harness.hub, {
        projectId: project.id,
        name: "Rollback automation",
        enabled: true,
        triggerType: "schedule",
        triggerConfig: JSON.stringify({
          triggerType: "schedule",
          cron: "0 8 * * *",
          timezone: "UTC",
        }),
        action: JSON.stringify({
          actionType: "scheduled-thread",
          threadRequest: {
            providerId: "codex",
            model: "gpt-5",
            input: [{ type: "text", text: "Retry automation creation" }],
            environment: {
              type: "host",
              hostId: host.id,
              workspace: { type: "managed-clone" },
            },
          },
        }),
        autoArchive: false,
        nextRunAt: now - 1,
      });
      const source = listProjectSources(harness.db, project.id)[0];
      if (!source || source.type !== "local_path") {
        throw new Error("Expected a local project source");
      }
      deleteProjectSource(harness.db, harness.hub, source.id);

      await sweepDueAutomations(harness.deps, { now });

      expect(
        harness.db
          .select()
          .from(threads)
          .where(eq(threads.automationId, automation.id))
          .all(),
      ).toHaveLength(0);
      expect(harness.db.select().from(hostDaemonCommands).all()).toHaveLength(0);
      expect(getAutomation(harness.db, automation.id)).toMatchObject({
        lastRunAt: null,
        nextRunAt: automation.nextRunAt,
        runCount: 0,
      });
    } finally {
      await harness.cleanup();
    }
  });
});
