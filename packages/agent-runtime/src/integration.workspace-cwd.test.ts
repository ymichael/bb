/** Provider integration tests using createAgentRuntime. */

import {
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import {
  dirname,
  join,
} from "node:path";
import { describe, expect, it } from "vitest";
import {
  cleanup,
  createApprovalResolution,
  createTestRuntime,
  getCompletedCommandOutputs,
  getCompletedCommands,
  newThreadId,
  resolveDefaultModel,
  turnCompletedCountForThread,
  waitForRuntimeCondition,
} from "./test/runtime-integration-harness.js";

const providers = ["codex", "claude-code", "pi"];

for (const providerId of providers) {
  describe.concurrent(`${providerId} provider`, () => {

    it("starts turns in the workspace cwd and still allows cd outside it", async () => {
      const ctx = createTestRuntime(providerId, {
        onInteractiveRequest: createApprovalResolution,
      });
      const workspaceMarkerName = `workspace-marker-${randomUUID()}.txt`;
      const parentMarkerName = `parent-marker-${randomUUID()}.txt`;
      const workspaceToken = `WORKSPACE_${randomUUID()}`;
      const parentToken = `PARENT_${randomUUID()}`;
      const parentDir = dirname(ctx.tmpDir);
      const parentMarkerPath = join(parentDir, parentMarkerName);

      writeFileSync(join(ctx.tmpDir, workspaceMarkerName), workspaceToken, "utf8");
      writeFileSync(parentMarkerPath, parentToken, "utf8");

      try {
        const threadId = newThreadId();
        const model = await resolveDefaultModel(providerId, ctx);
        await ctx.runtime.startThread({
          environmentId: "env-1",
          threadId,
          projectId: "test-project",
          providerId,
          options: {
            model,
            serviceTier: "default",
            reasoningLevel: "medium",
            permissionMode: "full",
            permissionEscalation: null,
          },
          instructions:
            "When the user asks you to run exact shell commands, use your shell or command execution tool and preserve the command output.",
        });

        await ctx.runtime.runTurn({
          threadId,
          options: {
            model,
            serviceTier: "default",
            reasoningLevel: "medium",
            permissionMode: "full",
            permissionEscalation: null,
          },
          input: [{
            type: "text",
            text:
              `Run these two shell commands exactly as written, in order, from the current working directory: `
              + `\`pwd && cat ${workspaceMarkerName}\` and \`cd .. && pwd && cat ${parentMarkerName}\`. `
              + "Do not use absolute paths. After both commands finish, reply with exactly DONE.",
          }],
        });

        await waitForRuntimeCondition({
          ctx,
          threadId,
          predicate: () => {
            const outputs = getCompletedCommandOutputs(ctx.events);
            return (
              (
                outputs.includes(workspaceToken)
                && outputs.includes(parentToken)
              )
              || turnCompletedCountForThread(ctx.events, threadId) > 0
            );
          },
          timeoutMs: 60_000,
          label: "command outputs or turn/completed",
        });

        const outputs = getCompletedCommandOutputs(ctx.events);
        const commands = getCompletedCommands(ctx.events);
        expect(outputs).toContain(ctx.tmpDir);
        expect(outputs).toContain(parentDir);
        expect(outputs).toContain(workspaceToken);
        expect(outputs).toContain(parentToken);
        expect(commands.some((command) => command.includes(workspaceMarkerName))).toBe(true);
        expect(commands.some((command) => command.includes(parentMarkerName))).toBe(true);
        expect(commands.some((command) => command.includes("cd .."))).toBe(true);
      } finally {
        await ctx.runtime.shutdown();
        rmSync(parentMarkerPath, { force: true });
        cleanup(ctx);
      }
    }, 65_000);
  });
}
