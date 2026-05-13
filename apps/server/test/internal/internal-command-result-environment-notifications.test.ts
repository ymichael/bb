import { queueCommand } from "@bb/db";
import type { HostDaemonCommandResultByType } from "@bb/host-daemon-contract";
import { describe, expect, it, vi } from "vitest";
import { internalAuthHeaders } from "../helpers/commands.js";
import { queueEnvironmentProvisionLifecycleCommand } from "../helpers/lifecycle-commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
} from "../helpers/seed.js";
import { createTestAppHarness } from "../helpers/test-app.js";

type WorkspaceMutationCommandType =
  | "workspace.commit"
  | "workspace.squash_merge";

type WorkspaceMutationResult =
  HostDaemonCommandResultByType[WorkspaceMutationCommandType];

interface WorkspaceMutationCase {
  commandType: WorkspaceMutationCommandType;
  name: string;
  result: WorkspaceMutationResult;
  toPayload: (args: {
    environmentId: string;
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
      commitSubject: "Squash branch",
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
        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
        });
        const environment = seedEnvironment(harness.deps, {
          hostId: host.id,
          projectId: project.id,
          path: `/tmp/${commandType}`,
          status: "ready",
        });
        const notifyEnvironmentSpy = vi.spyOn(harness.hub, "notifyEnvironment");
        const command = queueCommand(harness.db, harness.hub, {
          hostId: host.id,
          payload: toPayload({
            environmentId: environment.id,
            workspacePath: environment.path ?? "/tmp/test-environment",
          }),
          sessionId: session.id,
          type: commandType,
        });

        const response = await harness.app.request(
          "/internal/session/command-result",
          {
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
          },
        );

        expect(response.status).toBe(200);
        expect(notifyEnvironmentSpy).toHaveBeenCalledWith(environment.id, [
          "work-status-changed",
        ]);
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
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/provision-notify",
        status: "provisioning",
      });
      const notifyEnvironmentSpy = vi.spyOn(harness.hub, "notifyEnvironment");
      const command = queueEnvironmentProvisionLifecycleCommand(harness, {
        hostId: host.id,
        sessionId: session.id,
        environmentId: environment.id,
        command: {
          type: "environment.provision",
          environmentId: environment.id,
          initiator: null,
          path: "/tmp/provision-notify",
          workspaceProvisionType: "unmanaged",
        },
      });
      const result: HostDaemonCommandResultByType["environment.provision"] = {
        branchName: "bb/test",
        defaultBranch: "main",
        isGitRepo: true,
        isWorktree: false,
        path: "/tmp/provision-notify",
        transcript: [],
      };

      const response = await harness.app.request(
        "/internal/session/command-result",
        {
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
        },
      );

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
