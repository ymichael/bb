import {
  createManagerThreadNudge,
  listManagerThreadNudgesByThread,
} from "@bb/db";
import { describe, expect, it } from "vitest";
import { syncManagerThreadSchedules } from "../src/services/manager-schedule-sync.js";
import {
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

async function syncWithFileContent(
  args: SyncWithFileContentArgs,
): Promise<void> {
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

describe("manager schedule sync", () => {
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
});
