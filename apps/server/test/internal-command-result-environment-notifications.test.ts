import {
  queueCommand,
} from "@bb/db";
import type {
  HostDaemonCommandResultByType,
} from "@bb/host-daemon-contract";
import { describe, expect, it, vi } from "vitest";
import { internalAuthHeaders } from "./helpers/commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "./helpers/seed.js";
import { createTestAppHarness } from "./helpers/test-app.js";

type WorkspaceMutationCommandType =
  | "workspace.commit"
  | "workspace.squash_merge"
  | "workspace.checkpoint"
  | "workspace.promote"
  | "workspace.demote";

type WorkspaceMutationResult =
  HostDaemonCommandResultByType[WorkspaceMutationCommandType];

interface WorkspaceMutationCase {
  commandType: WorkspaceMutationCommandType;
  name: string;
  result: WorkspaceMutationResult;
  toPayload: (args: {
    environmentId: string;
    threadId: string;
    workspacePath: string;
  }) => string;
}

const WORKSPACE_MUTATION_CASES: WorkspaceMutationCase[] = [
  {
    commandType: "workspace.commit",
    name: "workspace.commit",
    result: {
      commitSha: "abc123",
      commitSubject: "Save changes",
    },
    toPayload: ({ environmentId, workspacePath }) =>
      JSON.stringify({
        type: "workspace.commit",
        environmentId,
        workspaceContext: {
          workspacePath,
          workspaceProvisionType: "unmanaged",
        },
        message: "Save changes",
      }),
  },
  {
    commandType: "workspace.squash_merge",
    name: "workspace.squash_merge",
    result: {
      commitSha: "def456",
      merged: true,
    },
    toPayload: ({ environmentId, workspacePath }) =>
      JSON.stringify({
        type: "workspace.squash_merge",
        environmentId,
        workspaceContext: {
          workspacePath,
          workspaceProvisionType: "unmanaged",
        },
        commitMessage: "Squash branch",
        targetBranch: "main",
      }),
  },
  {
    commandType: "workspace.checkpoint",
    name: "workspace.checkpoint",
    result: {
      branchName: "bb/test",
      commitSha: "ghi789",
      remoteName: "origin",
    },
    toPayload: ({ environmentId, workspacePath }) =>
      JSON.stringify({
        type: "workspace.checkpoint",
        environmentId,
        workspaceContext: {
          workspacePath,
          workspaceProvisionType: "unmanaged",
        },
        commitMessage: "Checkpoint",
      }),
  },
  {
    commandType: "workspace.promote",
    name: "workspace.promote",
    result: {
      ok: true,
    },
    toPayload: ({ environmentId, threadId, workspacePath }) =>
      JSON.stringify({
        type: "workspace.promote",
        environmentId,
        workspaceContext: {
          workspacePath,
          workspaceProvisionType: "unmanaged",
        },
        primaryPath: "/tmp/test-project",
        threadId,
      }),
  },
  {
    commandType: "workspace.demote",
    name: "workspace.demote",
    result: {
      ok: true,
    },
    toPayload: ({ environmentId, threadId, workspacePath }) =>
      JSON.stringify({
        type: "workspace.demote",
        environmentId,
        workspaceContext: {
          workspacePath,
          workspaceProvisionType: "unmanaged",
        },
        defaultBranch: "main",
        envBranch: "bb/test",
        primaryPath: "/tmp/test-project",
        threadId,
      }),
  },
];

describe("internal command result environment notifications", () => {
  it.each(WORKSPACE_MUTATION_CASES)(
    "emits work-status-changed for successful $name results",
    async ({ commandType, result, toPayload }) => {
      const harness = await createTestAppHarness();
      try {
        const { host, session } = seedHostSession(harness.deps, {
          id: `host-${commandType}`,
        });
        const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
        const environment = seedEnvironment(harness.deps, {
          hostId: host.id,
          projectId: project.id,
          path: `/tmp/${commandType}`,
          status: "ready",
        });
        const thread = seedThread(harness.deps, {
          environmentId: environment.id,
          projectId: project.id,
          status: "idle",
        });
        const notifyEnvironmentSpy = vi.spyOn(harness.hub, "notifyEnvironment");
        const command = queueCommand(harness.db, harness.hub, {
          hostId: host.id,
          payload: toPayload({
            environmentId: environment.id,
            threadId: thread.id,
            workspacePath: environment.path ?? "/tmp/test-environment",
          }),
          sessionId: session.id,
          type: commandType,
        });

        const response = await harness.app.request("/internal/session/command-result", {
          body: JSON.stringify({
            commandId: command.id,
            completedAt: Date.now(),
            cursor: command.cursor,
            ok: true,
            result,
            sessionId: session.id,
            type: commandType,
          }),
          headers: internalAuthHeaders(harness),
          method: "POST",
        });

        expect(response.status).toBe(200);
        expect(notifyEnvironmentSpy).toHaveBeenCalledWith(
          environment.id,
          ["work-status-changed"],
        );
      } finally {
        await harness.cleanup();
      }
    },
  );

  it("emits status-changed and work-status-changed for successful environment.provision results", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-provision-notify",
      });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/provision-notify",
        status: "provisioning",
      });
      const notifyEnvironmentSpy = vi.spyOn(harness.hub, "notifyEnvironment");
      const command = queueCommand(harness.db, harness.hub, {
        hostId: host.id,
        payload: JSON.stringify({
          type: "environment.provision",
          environmentId: environment.id,
          path: "/tmp/provision-notify",
          workspaceProvisionType: "unmanaged",
        }),
        sessionId: session.id,
        type: "environment.provision",
      });
      const result: HostDaemonCommandResultByType["environment.provision"] = {
        branchName: "bb/test",
        defaultBranch: "main",
        isGitRepo: true,
        isWorktree: false,
        path: "/tmp/provision-notify",
        ranSetup: false,
      };

      const response = await harness.app.request("/internal/session/command-result", {
        body: JSON.stringify({
          commandId: command.id,
          completedAt: Date.now(),
          cursor: command.cursor,
          ok: true,
          result,
          sessionId: session.id,
          type: "environment.provision",
        }),
        headers: internalAuthHeaders(harness),
        method: "POST",
      });

      expect(response.status).toBe(200);
      expect(notifyEnvironmentSpy.mock.calls).toContainEqual([
        environment.id,
        ["status-changed"],
      ]);
      expect(notifyEnvironmentSpy.mock.calls).toContainEqual([
        environment.id,
        ["work-status-changed"],
      ]);
    } finally {
      await harness.cleanup();
    }
  });
});
