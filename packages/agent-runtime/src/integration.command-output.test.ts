/** Provider integration tests for completed command output normalization. */

import { describe, expect, it } from "vitest";
import {
  cleanup,
  createApprovalResolution,
  createTestRuntime,
  getCompletedCommandOutputs,
  newThreadId,
  resolveRuntimeOptions,
  turnCompletedCountForThread,
  waitForRuntimeCondition,
} from "./test/runtime-integration-harness.js";

const providers = ["codex", "claude-code", "pi"];

function createDelayedOutputPrompt(): string {
  return (
    "Run this shell command exactly once from the current working directory: " +
    "`printf 'FIRST\\n'; sleep 1; printf 'SECOND\\n'; sleep 1; printf 'THIRD\\n'`. " +
    "Preserve the full command output, then reply with exactly DONE."
  );
}

for (const providerId of providers) {
  describe.concurrent(`${providerId} provider command output`, () => {
    it("preserves delayed command output on the completed command item", async () => {
      const ctx = createTestRuntime(providerId, {
        onInteractiveRequest: createApprovalResolution,
      });

      try {
        const threadId = newThreadId();
        const options = await resolveRuntimeOptions({
          ctx,
          providerId,
          preset: "full",
        });

        await ctx.runtime.startThread({
          environmentId: "env-1",
          threadId,
          projectId: "test-project",
          providerId,
          options,
          instructions:
            "When the user asks you to run an exact shell command, use your shell or command execution tool and preserve command output.",
        });

        await ctx.runtime.runTurn({
          threadId,
          options,
          input: [{ type: "text", text: createDelayedOutputPrompt() }],
        });

        await waitForRuntimeCondition({
          ctx,
          threadId,
          predicate: () => {
            const outputs = getCompletedCommandOutputs(ctx.events);
            return (
              (outputs.includes("FIRST") &&
                outputs.includes("SECOND") &&
                outputs.includes("THIRD")) ||
              turnCompletedCountForThread(ctx.events, threadId) > 0
            );
          },
          timeoutMs: 90_000,
          label: "delayed command output or turn/completed",
        });

        const outputs = getCompletedCommandOutputs(ctx.events);
        expect(outputs).toContain("FIRST");
        expect(outputs).toContain("SECOND");
        expect(outputs).toContain("THIRD");
      } finally {
        await ctx.runtime.shutdown();
        cleanup(ctx);
      }
    }, 95_000);
  });
}
