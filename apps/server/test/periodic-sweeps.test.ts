import { describe, expect, it, vi } from "vitest";
import { runManagedEnvironmentArchiveCleanupSweep } from "../src/services/periodic-sweeps.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
} from "./helpers/seed.js";
import { createTestAppHarness } from "./helpers/test-app.js";

describe("periodic sweeps", () => {
  it("logs and continues when managed environment archive cleanup rejects", async () => {
    const harness = await createTestAppHarness();
    try {
      const loggerWarn = vi.fn();
      harness.deps.logger.warn = loggerWarn;

      const { host } = seedHostSession(harness.deps, {
        id: "host-periodic-sweep",
      });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const firstEnvironment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        managed: true,
        workspaceProvisionType: "managed-worktree",
        path: "/tmp/periodic-sweep-first",
      });
      const secondEnvironment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        managed: true,
        workspaceProvisionType: "managed-worktree",
        path: "/tmp/periodic-sweep-second",
      });

      const visitedEnvironmentIds: string[] = [];
      await runManagedEnvironmentArchiveCleanupSweep(
        harness.deps,
        async (_deps, args) => {
          if (!args.environmentId) {
            return;
          }
          visitedEnvironmentIds.push(args.environmentId);
          if (args.environmentId === firstEnvironment.id) {
            throw new Error("cleanup failed");
          }
        },
      );

      expect(visitedEnvironmentIds).toEqual([
        firstEnvironment.id,
        secondEnvironment.id,
      ]);
      expect(loggerWarn).toHaveBeenCalledTimes(1);
      expect(loggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({
          environmentId: firstEnvironment.id,
        }),
        "Managed environment archive cleanup sweep failed",
      );
    } finally {
      await harness.cleanup();
    }
  });
});
