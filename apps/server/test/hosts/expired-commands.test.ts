import { getHostOperation, queueCommand } from "@bb/db";
import { describe, expect, it } from "vitest";
import {
  advanceSandboxRuntimeMaterialSync,
  requestSandboxRuntimeMaterialSync,
} from "../../src/services/hosts/sandbox-runtime-material.js";
import { handleExpiredCommands } from "../../src/services/hosts/expired-commands.js";
import { createTestAppHarness } from "../helpers/test-app.js";
import {
  seedEnvironment,
  seedHost,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";

describe("expired commands", () => {
  it.each([
    {
      type: "environment.destroy" as const,
      buildPayload: (args: {
        environmentId: string;
        threadId: string;
        workspacePath: string;
        workspaceProvisionType: string;
      }) => ({
        type: "environment.destroy" as const,
        environmentId: args.environmentId,
        workspaceContext: {
          workspacePath: args.workspacePath,
          workspaceProvisionType: args.workspaceProvisionType,
        },
      }),
    },
    {
      type: "environment.provision" as const,
      buildPayload: (args: {
        environmentId: string;
        threadId: string;
        workspacePath: string;
        workspaceProvisionType: string;
      }) => ({
        type: "environment.provision" as const,
        environmentId: args.environmentId,
        initiator: null,
        workspaceProvisionType: "unmanaged" as const,
        path: args.workspacePath,
      }),
    },
    {
      type: "thread.start" as const,
      buildPayload: (args: {
        environmentId: string;
        threadId: string;
        workspacePath: string;
        workspaceProvisionType: string;
      }) => ({
        type: "thread.start" as const,
        environmentId: args.environmentId,
        threadId: args.threadId,
        eventSequence: 1,
        input: [{ type: "text" as const, text: "hello" }],
        workspaceContext: {
          workspacePath: args.workspacePath,
          workspaceProvisionType: args.workspaceProvisionType,
        },
        projectId: "proj_test",
        providerId: "codex",
        options: {
          model: "gpt-5",
          reasoningLevel: "medium" as const,
          permissionMode: "full" as const,
          permissionEscalation: "ask" as const,
          serviceTier: "default" as const,
        },
        instructions: "instructions",
        dynamicTools: [],
        instructionMode: "append" as const,
      }),
    },
    {
      type: "thread.stop" as const,
      buildPayload: (args: {
        environmentId: string;
        threadId: string;
        workspacePath: string;
        workspaceProvisionType: string;
      }) => ({
        type: "thread.stop" as const,
        environmentId: args.environmentId,
        threadId: args.threadId,
      }),
    },
  ])("reports expired $type results with the original command type", async ({ type, buildPayload }) => {
    const harness = await createTestAppHarness();
    try {
      const host = seedHost(harness.deps, { id: `host-expired-${type}` });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: `/tmp/${type.replace(".", "-")}`,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "created",
      });
      const command = queueCommand(harness.db, harness.hub, {
        hostId: host.id,
        type,
        payload: JSON.stringify(buildPayload({
          environmentId: environment.id,
          threadId: thread.id,
          workspacePath: environment.path ?? `/tmp/${thread.id}`,
          workspaceProvisionType: environment.workspaceProvisionType,
        })),
      });

      const resultPromise = harness.hub.waitForCommandResult(command.id, 1_000);
      await handleExpiredCommands(harness.deps, {
        commandIds: [command.id],
      });

      await expect(resultPromise).resolves.toMatchObject({
        commandId: command.id,
        errorCode: "command_expired",
        errorMessage: "Command expired after retry",
        ok: false,
        type,
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("marks runtime material sync operations failed when their command expires", async () => {
    const harness = await createTestAppHarness({
      githubPat: "test-github-pat",
      openAiApiKey: "test-openai-key",
    });
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-expired-runtime-sync",
        type: "ephemeral",
      });
      await requestSandboxRuntimeMaterialSync(harness.deps, {
        hostId: host.id,
      });
      const commandId = advanceSandboxRuntimeMaterialSync(harness.deps, {
        hostId: host.id,
      });
      if (!commandId) {
        throw new Error("Expected runtime sync command to be queued");
      }

      const resultPromise = harness.hub.waitForCommandResult(commandId, 1_000);
      await handleExpiredCommands(harness.deps, {
        commandIds: [commandId],
      });

      await expect(resultPromise).resolves.toMatchObject({
        commandId,
        errorCode: "command_expired",
        errorMessage: "Command expired after retry",
        ok: false,
        type: "host.sync_runtime_material",
      });
      expect(getHostOperation(harness.db, {
        hostId: host.id,
        kind: "sync_runtime_material",
      })).toMatchObject({
        commandId,
        failureReason: "Command expired after retry",
        state: "failed",
      });
    } finally {
      await harness.cleanup();
    }
  });
});
