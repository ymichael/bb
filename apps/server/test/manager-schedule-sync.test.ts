import {
  createManagerThreadNudge,
  listManagerThreadNudgesByThread,
} from "@bb/db";
import { describe, expect, it } from "vitest";
import { syncManagerThreadSchedules } from "../src/services/manager-schedule-sync.js";
import {
  reportQueuedCommandError,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "./helpers/commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "./helpers/seed.js";
import { createTestAppHarness } from "./helpers/test-app.js";

type TestHarness = Awaited<ReturnType<typeof createTestAppHarness>>;

interface SyncWithFileContentArgs {
  content: string;
  harness: TestHarness;
  hostId: string;
  threadId: string;
}

interface StartSyncArgs {
  harness: TestHarness;
  hostId: string;
  threadId: string;
}

interface SyncWithReadFileErrorArgs extends StartSyncArgs {
  errorCode: string;
  errorMessage: string;
}

async function startSync(
  args: StartSyncArgs,
) {
  const syncPromise = syncManagerThreadSchedules(args.harness.deps, {
    threadId: args.threadId,
  });
  const asyncPath = `/tmp/bb-host-data/${args.hostId}/thread-storage/${args.threadId}/ASYNC.md`;
  const queued = await waitForQueuedCommand(
    args.harness,
    ({ command }) =>
      command.type === "host.read_file" &&
      command.path === asyncPath,
  );
  return {
    asyncPath,
    queued,
    syncPromise,
  };
}

async function syncWithFileContent(
  args: SyncWithFileContentArgs,
): Promise<void> {
  const { asyncPath, queued, syncPromise } = await startSync(args);
  const response = await reportQueuedCommandSuccess(
    args.harness,
    queued,
    {
      path: asyncPath,
      content: args.content,
      contentEncoding: "utf8",
      mimeType: "text/markdown",
      sizeBytes: args.content.length,
    },
  );
  expect(response.status).toBe(200);
  await syncPromise;
}

async function syncWithReadFileError(
  args: SyncWithReadFileErrorArgs,
): Promise<void> {
  const { queued, syncPromise } = await startSync(args);
  const response = await reportQueuedCommandError(args.harness, queued, {
    errorCode: args.errorCode,
    errorMessage: args.errorMessage,
  });
  expect(response.status).toBe(200);
  await syncPromise;
}

describe("manager schedule sync", () => {
  it("reconciles valid ASYNC.md schedules by updating, removing, and creating nudges", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-manager-sync-valid",
      });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/manager-sync-valid",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
        type: "manager",
      });
      createManagerThreadNudge(harness.db, harness.hub, {
        projectId: project.id,
        threadId: thread.id,
        name: "daily-recap",
        cron: "0 8 * * *",
        timezone: "UTC",
        enabled: true,
        nextFireAt: Date.now() + 60_000,
      });
      createManagerThreadNudge(harness.db, harness.hub, {
        projectId: project.id,
        threadId: thread.id,
        name: "obsolete",
        cron: "0 9 * * *",
        timezone: "UTC",
        enabled: true,
        nextFireAt: Date.now() + 120_000,
      });

      await syncWithFileContent({
        content: [
          "---",
          "timezone: America/Los_Angeles",
          "schedules:",
          '  - cron: "0 10 * * 1-5"',
          "    name: daily-recap",
          '  - cron: "30 14 * * 2"',
          "    name: weekly-plan",
          "---",
          "",
          "# Schedules",
        ].join("\n"),
        harness,
        hostId: host.id,
        threadId: thread.id,
      });

      expect(listManagerThreadNudgesByThread(harness.db, thread.id)).toEqual([
        expect.objectContaining({
          name: "daily-recap",
          cron: "0 10 * * 1-5",
          timezone: "America/Los_Angeles",
          enabled: true,
        }),
        expect.objectContaining({
          name: "weekly-plan",
          cron: "30 14 * * 2",
          timezone: "America/Los_Angeles",
          enabled: true,
        }),
      ]);
    } finally {
      await harness.cleanup();
    }
  });

  it("deletes existing nudges when ASYNC.md has no frontmatter", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-manager-sync-delete",
      });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/manager-sync-delete",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
        type: "manager",
      });
      createManagerThreadNudge(harness.db, harness.hub, {
        projectId: project.id,
        threadId: thread.id,
        name: "daily-recap",
        cron: "0 8 * * *",
        timezone: "UTC",
        enabled: true,
        nextFireAt: Date.now() + 60_000,
      });

      await syncWithFileContent({
        content: "# No schedules here\n",
        harness,
        hostId: host.id,
        threadId: thread.id,
      });

      expect(listManagerThreadNudgesByThread(harness.db, thread.id)).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });

  it("leaves existing nudges unchanged when ASYNC.md frontmatter is malformed", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-manager-sync-malformed",
      });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/manager-sync-malformed",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
        type: "manager",
      });
      createManagerThreadNudge(harness.db, harness.hub, {
        projectId: project.id,
        threadId: thread.id,
        name: "existing-reminder",
        cron: "0 8 * * *",
        timezone: "UTC",
        enabled: true,
        nextFireAt: Date.now() + 60_000,
      });

      await syncWithFileContent({
        content: "---\nschedules: [\n---\n",
        harness,
        hostId: host.id,
        threadId: thread.id,
      });

      expect(
        listManagerThreadNudgesByThread(harness.db, thread.id).map((nudge) => nudge.name),
      ).toEqual(["existing-reminder"]);
    } finally {
      await harness.cleanup();
    }
  });

  it("leaves existing nudges unchanged when ASYNC.md uses a language-suffixed delimiter", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-manager-sync-js-delimiter",
      });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/manager-sync-js-delimiter",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
        type: "manager",
      });
      createManagerThreadNudge(harness.db, harness.hub, {
        projectId: project.id,
        threadId: thread.id,
        name: "existing-reminder",
        cron: "0 8 * * *",
        timezone: "UTC",
        enabled: true,
        nextFireAt: Date.now() + 60_000,
      });

      await syncWithFileContent({
        content: "---js\n({ schedules: [] })\n---\n",
        harness,
        hostId: host.id,
        threadId: thread.id,
      });

      expect(
        listManagerThreadNudgesByThread(harness.db, thread.id).map((nudge) => nudge.name),
      ).toEqual(["existing-reminder"]);
    } finally {
      await harness.cleanup();
    }
  });

  it("leaves existing nudges unchanged when ASYNC.md is too large to parse", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-manager-sync-oversized",
      });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/manager-sync-oversized",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
        type: "manager",
      });
      createManagerThreadNudge(harness.db, harness.hub, {
        projectId: project.id,
        threadId: thread.id,
        name: "keep-existing",
        cron: "0 8 * * *",
        timezone: "UTC",
        enabled: true,
        nextFireAt: Date.now() + 60_000,
      });
      const oversizedContent = `---\ntimezone: UTC\nschedules: []\n---\n${"a".repeat(256 * 1024)}`;

      await syncWithFileContent({
        content: oversizedContent,
        harness,
        hostId: host.id,
        threadId: thread.id,
      });

      expect(
        listManagerThreadNudgesByThread(harness.db, thread.id).map((nudge) => nudge.name),
      ).toEqual(["keep-existing"]);
    } finally {
      await harness.cleanup();
    }
  });

  it("uses the actual content byte length when the daemon under-reports file size", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-manager-sync-byte-length",
      });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/manager-sync-byte-length",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
        type: "manager",
      });
      createManagerThreadNudge(harness.db, harness.hub, {
        projectId: project.id,
        threadId: thread.id,
        name: "keep-existing",
        cron: "0 8 * * *",
        timezone: "UTC",
        enabled: true,
        nextFireAt: Date.now() + 60_000,
      });
      const oversizedContent = `---\ntimezone: UTC\nschedules: []\n---\n${"é".repeat(150 * 1024)}`;
      const { asyncPath, queued, syncPromise } = await startSync({
        harness,
        hostId: host.id,
        threadId: thread.id,
      });

      const response = await reportQueuedCommandSuccess(
        harness,
        queued,
        {
          path: asyncPath,
          content: oversizedContent,
          contentEncoding: "utf8",
          mimeType: "text/markdown",
          sizeBytes: 1,
        },
      );
      expect(response.status).toBe(200);
      await syncPromise;

      expect(
        listManagerThreadNudgesByThread(harness.db, thread.id).map((nudge) => nudge.name),
      ).toEqual(["keep-existing"]);
    } finally {
      await harness.cleanup();
    }
  });

  it("clears existing nudges when ASYNC.md does not exist", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-manager-sync-missing",
      });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/manager-sync-missing",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
        type: "manager",
      });
      createManagerThreadNudge(harness.db, harness.hub, {
        projectId: project.id,
        threadId: thread.id,
        name: "stale-reminder",
        cron: "0 8 * * *",
        timezone: "UTC",
        enabled: true,
        nextFireAt: Date.now() + 60_000,
      });

      await syncWithReadFileError({
        harness,
        hostId: host.id,
        threadId: thread.id,
        errorCode: "ENOENT",
        errorMessage: "File not found",
      });

      expect(listManagerThreadNudgesByThread(harness.db, thread.id)).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });

  it("skips invalid cron entries while still syncing valid ASYNC.md schedules", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-manager-sync-invalid-cron",
      });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/manager-sync-invalid-cron",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
        type: "manager",
      });

      await syncWithFileContent({
        content: [
          "---",
          "timezone: UTC",
          "schedules:",
          '  - cron: "not-a-cron"',
          "    name: broken",
          '  - cron: "0 8 * * 1-5"',
          "    name: valid-recap",
          "---",
        ].join("\n"),
        harness,
        hostId: host.id,
        threadId: thread.id,
      });

      expect(
        listManagerThreadNudgesByThread(harness.db, thread.id).map((nudge) => nudge.name),
      ).toEqual(["valid-recap"]);
    } finally {
      await harness.cleanup();
    }
  });

  it("keeps only the first twenty ASYNC.md schedules", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-manager-sync-limit",
      });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/manager-sync-limit",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
        type: "manager",
      });
      const schedules = Array.from({ length: 21 }, (_, index) => [
        `  - cron: "${index} 8 * * *"`,
        `    name: schedule-${index + 1}`,
      ].join("\n")).join("\n");

      await syncWithFileContent({
        content: [
          "---",
          "timezone: UTC",
          "schedules:",
          schedules,
          "---",
        ].join("\n"),
        harness,
        hostId: host.id,
        threadId: thread.id,
      });

      const nudges = listManagerThreadNudgesByThread(harness.db, thread.id);
      expect(nudges).toHaveLength(20);
      expect(nudges.map((nudge) => nudge.name)).not.toContain("schedule-21");
    } finally {
      await harness.cleanup();
    }
  });

  it("skips ASYNC.md schedules that run more often than every five minutes", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-manager-sync-min-interval",
      });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/manager-sync-min-interval",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
        type: "manager",
      });

      await syncWithFileContent({
        content: [
          "---",
          "timezone: UTC",
          "schedules:",
          '  - cron: "* * * * *"',
          "    name: too-frequent",
          '  - cron: "0 8 * * 1-5"',
          "    name: valid-recap",
          "---",
        ].join("\n"),
        harness,
        hostId: host.id,
        threadId: thread.id,
      });

      expect(
        listManagerThreadNudgesByThread(harness.db, thread.id).map((nudge) => nudge.name),
      ).toEqual(["valid-recap"]);
    } finally {
      await harness.cleanup();
    }
  });
});
