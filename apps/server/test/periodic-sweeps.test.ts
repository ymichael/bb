import { describe, expect, it, vi } from "vitest";
import { getHost, requestEnvironmentCleanup, upsertHost } from "@bb/db";
import {
  runEphemeralHostCleanupSweep,
  runManagedEnvironmentArchiveCleanupSweep,
} from "../src/services/periodic-sweeps.js";
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
      requestEnvironmentCleanup(harness.db, harness.hub, firstEnvironment.id, {
        cleanupMode: "force",
        requestedAt: 123,
      });
      requestEnvironmentCleanup(harness.db, harness.hub, secondEnvironment.id, {
        cleanupMode: "force",
        requestedAt: 456,
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

  it("retries ephemeral host cleanup on later sweeps after an initial destroy failure", async () => {
    const harness = await createTestAppHarness();
    try {
      const host = upsertHost(harness.db, harness.hub, {
        externalId: "sandbox-periodic-ephemeral",
        id: "host-periodic-ephemeral",
        name: "Periodic Ephemeral Host",
        provider: "e2b",
        type: "ephemeral",
      });
      const cachedHost = {
        destroy: vi
          .fn()
          .mockRejectedValueOnce(new Error("cleanup failed"))
          .mockResolvedValueOnce(undefined),
        extendTimeout: vi.fn().mockResolvedValue(undefined),
        externalId: "sandbox-periodic-ephemeral",
        hostId: host.id,
        resume: vi.fn().mockResolvedValue(undefined),
        suspend: vi.fn().mockResolvedValue(undefined),
      };
      harness.deps.sandboxRegistry.set(host.id, cachedHost);

      await runEphemeralHostCleanupSweep(harness.deps, async (deps, hostId) => {
        const candidate = deps.sandboxRegistry.get(hostId);
        if (!candidate) {
          throw new Error("Expected cached ephemeral host");
        }
        await candidate.destroy();
        deps.sandboxRegistry.remove(hostId);
        upsertHost(deps.db, deps.hub, {
          destroyedAt: Date.now(),
          externalId: candidate.externalId,
          id: hostId,
          name: "Periodic Ephemeral Host",
          provider: "e2b",
          type: "ephemeral",
        });
      });

      expect(getHost(harness.db, host.id)?.destroyedAt).toBeNull();

      await runEphemeralHostCleanupSweep(harness.deps, async (deps, hostId) => {
        const candidate = deps.sandboxRegistry.get(hostId);
        if (!candidate) {
          throw new Error("Expected cached ephemeral host");
        }
        await candidate.destroy();
        deps.sandboxRegistry.remove(hostId);
        upsertHost(deps.db, deps.hub, {
          destroyedAt: Date.now(),
          externalId: candidate.externalId,
          id: hostId,
          name: "Periodic Ephemeral Host",
          provider: "e2b",
          type: "ephemeral",
        });
      });

      expect(cachedHost.destroy).toHaveBeenCalledTimes(2);
      expect(getHost(harness.db, host.id)).toMatchObject({
        destroyedAt: expect.any(Number),
      });
    } finally {
      await harness.cleanup();
    }
  });
});
