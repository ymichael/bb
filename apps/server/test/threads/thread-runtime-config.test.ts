import { eq } from "drizzle-orm";
import { hostDaemonSessions } from "@bb/db";
import { describe, expect, it } from "vitest";
import { resolveThreadRuntimeCommandConfig } from "../../src/services/threads/thread-runtime-config.js";
import {
  reportQueuedCommandError,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { createTestAppHarness } from "../helpers/test-app.js";

describe("thread runtime config", () => {
  it("uses the project root as cwd and a host data-dir workspace for managers", async () => {
    const harness = await createTestAppHarness();
    try {
      const hostId = "host-runtime";
      seedHostSession(harness.deps, { id: hostId });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId,
        path: "/tmp/runtime-project-root",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId,
        projectId: project.id,
        path: "/tmp/runtime-project-root",
      });
      const managerThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        type: "manager",
      });

      const runtimeConfig = await resolveThreadRuntimeCommandConfig(harness.deps, {
        thread: managerThread,
        environment: {
          hostId: environment.hostId,
          id: environment.id,
          path: environment.path,
          workspaceProvisionType: environment.workspaceProvisionType,
        },
        isThreadCreation: true,
      });

      expect(runtimeConfig.instructions).toContain(
        "Project root: `/tmp/runtime-project-root`",
      );
      expect(runtimeConfig.instructions).toContain(
        `Thread storage: \`/tmp/bb-host-data/${hostId}/thread-storage/${managerThread.id}\``,
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("reads manager preferences from the thread storage on the host", async () => {
    const harness = await createTestAppHarness();
    try {
      const hostId = "host-runtime-preferences";
      seedHostSession(harness.deps, { id: hostId });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId,
        path: "/tmp/runtime-project-root",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId,
        projectId: project.id,
        path: "/tmp/runtime-project-root",
      });
      const managerThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        type: "manager",
      });
      const threadStoragePath = `/tmp/bb-host-data/${hostId}/thread-storage/${managerThread.id}`;
      const preferencesPath = `${threadStoragePath}/PREFERENCES.md`;

      const runtimeConfigPromise = resolveThreadRuntimeCommandConfig(harness.deps, {
        thread: managerThread,
        environment: {
          hostId: environment.hostId,
          id: environment.id,
          path: environment.path,
          workspaceProvisionType: environment.workspaceProvisionType,
        },
      });

      const queued = await waitForQueuedCommand(
        harness,
        (candidate) =>
          candidate.command.type === "host.read_file" &&
          candidate.command.path === preferencesPath,
      );
      if (queued.command.type !== "host.read_file") {
        throw new Error(`Expected host.read_file, got ${queued.command.type}`);
      }
      expect(queued.command.rootPath).toBe(threadStoragePath);

      const response = await reportQueuedCommandSuccess(
        harness,
        { command: queued.command, row: queued.row },
        {
          path: preferencesPath,
          content: "# Preferences\n\n- terse updates\n",
          contentEncoding: "utf8",
          mimeType: "text/markdown",
          sizeBytes: "# Preferences\n\n- terse updates\n".length,
        },
      );
      expect(response.status).toBe(200);

      const runtimeConfig = await runtimeConfigPromise;
      expect(runtimeConfig.instructions).toContain(
        "Project root: `/tmp/runtime-project-root`",
      );
      expect(runtimeConfig.instructions).toContain(
        `Thread storage: \`${threadStoragePath}\``,
      );
      expect(runtimeConfig.instructions).toContain("# Preferences");
      expect(runtimeConfig.instructions).toContain("terse updates");
    } finally {
      await harness.cleanup();
    }
  });

  it("treats missing manager preferences as an empty thread storage", async () => {
    const harness = await createTestAppHarness();
    try {
      const hostId = "host-runtime-missing-preferences";
      seedHostSession(harness.deps, { id: hostId });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId,
        path: "/tmp/runtime-project-root",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId,
        projectId: project.id,
        path: "/tmp/runtime-project-root",
      });
      const managerThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        type: "manager",
      });
      const threadStoragePath = `/tmp/bb-host-data/${hostId}/thread-storage/${managerThread.id}`;
      const preferencesPath = `${threadStoragePath}/PREFERENCES.md`;

      const runtimeConfigPromise = resolveThreadRuntimeCommandConfig(harness.deps, {
        thread: managerThread,
        environment: {
          hostId: environment.hostId,
          id: environment.id,
          path: environment.path,
          workspaceProvisionType: environment.workspaceProvisionType,
        },
      });

      const queued = await waitForQueuedCommand(
        harness,
        (candidate) =>
          candidate.command.type === "host.read_file" &&
          candidate.command.path === preferencesPath,
      );
      if (queued.command.type !== "host.read_file") {
        throw new Error(`Expected host.read_file, got ${queued.command.type}`);
      }
      expect(queued.command.rootPath).toBe(threadStoragePath);
      const response = await reportQueuedCommandError(harness, queued, {
        errorCode: "ENOENT",
        errorMessage: `Path does not exist: ${preferencesPath}`,
      });
      expect(response.status).toBe(200);

      const runtimeConfig = await runtimeConfigPromise;
      expect(runtimeConfig.instructions).toContain("(file does not exist)");
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects manager runtime config when the active session has no data directory", async () => {
    const harness = await createTestAppHarness();
    try {
      const { session } = seedHostSession(harness.deps, {
        id: "host-runtime-missing-data-dir",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: session.hostId,
        path: "/tmp/runtime-project-root",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: session.hostId,
        projectId: project.id,
        path: "/tmp/runtime-project-root",
      });
      const managerThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        type: "manager",
      });
      harness.db.update(hostDaemonSessions)
        .set({ dataDir: null })
        .where(eq(hostDaemonSessions.id, session.id))
        .run();

      await expect(
        resolveThreadRuntimeCommandConfig(harness.deps, {
          thread: managerThread,
          environment: {
            hostId: environment.hostId,
            id: environment.id,
            path: environment.path,
            workspaceProvisionType: environment.workspaceProvisionType,
          },
          isThreadCreation: true,
        }),
      ).rejects.toThrow("Connected host session did not report its data directory");
    } finally {
      await harness.cleanup();
    }
  });
});
