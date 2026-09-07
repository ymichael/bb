import { describe, expect, it } from "vitest";
import {
  getThreadEvents,
  getThreadOutput,
  sendTextMessage,
} from "../helpers/api.js";
import { waitForThreadStatus } from "../helpers/assertions.js";
import {
  createProjectFixture,
  createReadyHostThread,
} from "../helpers/fixtures.js";
import { createIntegrationHarness } from "../helpers/harness.js";
import {
  assertProviderPrerequisites,
  expectNonEmptyOutput,
  resolveExecutionOptions,
  TEST_TIMEOUT_MS,
  TURN_TIMEOUT_MS,
} from "./provider-smoke-harness.js";

describe("real provider concurrency integration", () => {
  it.concurrent(
    "runs codex and claude-code concurrently in separate environments",
    async () => {
      await assertProviderPrerequisites("codex");
      await assertProviderPrerequisites("claude-code");

      const harness = await createIntegrationHarness();

      try {
        const codexExecution = await resolveExecutionOptions({
          harness,
          providerId: "codex",
        });
        const claudeExecution = await resolveExecutionOptions({
          harness,
          providerId: "claude-code",
        });
        const project = await createProjectFixture(harness, {
          name: "Real Concurrent Providers",
        });
        const codexThread = await createReadyHostThread(harness, {
          execution: codexExecution,
          projectId: project.id,
          providerId: "codex",
          timeoutMs: TURN_TIMEOUT_MS,
          workspace: { type: "managed-worktree" },
        });
        const claudeThread = await createReadyHostThread(harness, {
          execution: claudeExecution,
          projectId: project.id,
          providerId: "claude-code",
          timeoutMs: TURN_TIMEOUT_MS,
          workspace: { type: "managed-worktree" },
        });

        await Promise.all([
          sendTextMessage(harness.api, codexThread.thread.id, {
            execution: codexExecution,
            text: "Reply with a short hello from Codex.",
          }),
          sendTextMessage(harness.api, claudeThread.thread.id, {
            execution: claudeExecution,
            text: "Reply with a short hello from Claude.",
          }),
        ]);

        await Promise.all([
          waitForThreadStatus(
            harness.api,
            codexThread.thread.id,
            "idle",
            TURN_TIMEOUT_MS,
          ),
          waitForThreadStatus(
            harness.api,
            claudeThread.thread.id,
            "idle",
            TURN_TIMEOUT_MS,
          ),
        ]);

        expectNonEmptyOutput(
          await getThreadOutput(harness.api, codexThread.thread.id),
          "codex concurrent output",
        );
        expectNonEmptyOutput(
          await getThreadOutput(harness.api, claudeThread.thread.id),
          "claude concurrent output",
        );
        expect(
          (await getThreadEvents(harness.api, codexThread.thread.id)).every(
            (event) => event.threadId === codexThread.thread.id,
          ),
        ).toBe(true);
        expect(
          (await getThreadEvents(harness.api, claudeThread.thread.id)).every(
            (event) => event.threadId === claudeThread.thread.id,
          ),
        ).toBe(true);
      } finally {
        await harness.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
