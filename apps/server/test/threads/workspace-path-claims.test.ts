import { archiveThread, markThreadDeleted, unarchiveThread } from "@bb/db";
import { describe, expect, it } from "vitest";
import { unmanagedAttachRefusal } from "../../src/services/threads/workspace-path-claims.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

const HOST_DATA_DIR = "/home/agent/.bb";

describe("unmanagedAttachRefusal", () => {
  it("still refuses a foreign managed workspace when the host data dir is unknown", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, { id: "host-claims" });
      const { project: owner } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        name: "Owner",
      });
      seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: owner.id,
        path: "/tmp/owned-worktree",
        managed: true,
        workspaceProvisionType: "managed-worktree",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        name: "Other",
        path: "/tmp/other",
      });

      expect(
        unmanagedAttachRefusal(harness.deps.db, {
          checksOutBranch: false,
          dataDir: null,
          hostId: host.id,
          path: "/tmp/owned-worktree",
          projectId: project.id,
        }),
      ).toMatchObject({ reason: "foreign-managed" });
    });
  });

  it("allows an ordinary directory when the host data dir is unknown", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, { id: "host-claims-ok" });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/plain",
      });

      expect(
        unmanagedAttachRefusal(harness.deps.db, {
          checksOutBranch: false,
          dataDir: null,
          hostId: host.id,
          path: `${HOST_DATA_DIR}/worktrees/env_other/repo`,
          projectId: project.id,
        }),
      ).toBeNull();
    });
  });

  it("lets a project attach to a managed path it already owns", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, { id: "host-claims-own" });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        name: "Owner",
      });
      const ownPath = `${HOST_DATA_DIR}/worktrees/env_own/repo`;
      seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: ownPath,
        managed: true,
        workspaceProvisionType: "managed-worktree",
      });

      expect(
        unmanagedAttachRefusal(harness.deps.db, {
          checksOutBranch: false,
          dataDir: HOST_DATA_DIR,
          hostId: host.id,
          path: ownPath,
          projectId: project.id,
        }),
      ).toBeNull();
    });
  });

  it.each([
    { status: "starting", visibility: "visible" },
    { status: "idle", visibility: "visible" },
    { status: "active", visibility: "hidden" },
  ] as const)(
    "blocks a $visibility $status thread only for branch checkout",
    async ({ status, visibility }) => {
      await withTestHarness(async (harness) => {
        const { host } = seedHostSession(harness.deps, {
          id: `host-claims-busy-${status}`,
        });
        const sharedPath = `/tmp/busy-shared-${status}`;
        const { project: busy } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
          name: "Busy",
          path: sharedPath,
        });
        const busyEnvironment = seedEnvironment(harness.deps, {
          hostId: host.id,
          projectId: busy.id,
          path: sharedPath,
        });
        seedThread(harness.deps, {
          projectId: busy.id,
          environmentId: busyEnvironment.id,
          status,
          visibility,
        });
        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
          name: "Joiner",
          path: sharedPath,
        });

        const args = {
          dataDir: HOST_DATA_DIR,
          hostId: host.id,
          path: sharedPath,
          projectId: project.id,
        };
        expect(
          unmanagedAttachRefusal(harness.deps.db, {
            ...args,
            checksOutBranch: false,
          }),
        ).toBeNull();
        expect(
          unmanagedAttachRefusal(harness.deps.db, {
            ...args,
            checksOutBranch: true,
          }),
        ).toMatchObject({ reason: "live-thread" });
      });
    },
  );

  it("releases archived and deleted claims but restores an unarchived claim", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-claims-archived",
      });
      const sharedPath = "/tmp/archived-shared";
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        name: "Archived",
        path: sharedPath,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: sharedPath,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      const args = {
        checksOutBranch: true,
        dataDir: HOST_DATA_DIR,
        hostId: host.id,
        path: sharedPath,
        projectId: project.id,
      };

      archiveThread(harness.deps.db, harness.deps.hub, thread.id);
      expect(unmanagedAttachRefusal(harness.deps.db, args)).toBeNull();

      unarchiveThread(harness.deps.db, harness.deps.hub, thread.id);
      expect(unmanagedAttachRefusal(harness.deps.db, args)).toMatchObject({
        reason: "live-thread",
      });

      markThreadDeleted(harness.deps.db, harness.deps.hub, {
        threadId: thread.id,
      });
      expect(unmanagedAttachRefusal(harness.deps.db, args)).toBeNull();
    });
  });
});
