/** Provider integration tests using createAgentRuntime. */

import { describe, expect, it } from "vitest";
import {
  cleanup,
  createTestRuntime,
  getThreadText,
  newThreadId,
  resolveRuntimeOptions,
  turnCompletedCount,
  waitForThreadTurnCompleted,
  waitForTurnCompletedCount,
} from "./test/runtime-integration-harness.js";

const CODEX_CONCURRENT_TURN_TIMEOUT_MS = 60_000;

describe.concurrent("cross-provider and multi-thread scenarios", () => {
  // Multi-thread: single provider, single runtime
  describe.concurrent("multi-thread scenarios", () => {
    it("runs multiple threads on the same codex runtime", async () => {
      const ctx = createTestRuntime("codex");
      try {
        const threadA = newThreadId();
        const threadB = newThreadId();
        const options = await resolveRuntimeOptions({
          ctx,
          providerId: "codex",
          preset: "full",
        });

        await ctx.runtime.startThread({
          environmentId: "env-1",
          threadId: threadA,
          projectId: "test-project",
          providerId: "codex",
          options,
        });

        await ctx.runtime.startThread({
          environmentId: "env-1",
          threadId: threadB,
          projectId: "test-project",
          providerId: "codex",
          options,
        });

        // Run turns concurrently
        await Promise.all([
          ctx.runtime.runTurn({
            threadId: threadA,
            input: [{ type: "text", text: "Reply with exactly: THREAD_A_OK" }],
            options,
          }),
          ctx.runtime.runTurn({
            threadId: threadB,
            input: [{ type: "text", text: "Reply with exactly: THREAD_B_OK" }],
            options,
          }),
        ]);

        await Promise.all([
          waitForThreadTurnCompleted({
            ctx,
            threadId: threadA,
            timeoutMs: CODEX_CONCURRENT_TURN_TIMEOUT_MS,
            label: "thread A turn/completed",
          }),
          waitForThreadTurnCompleted({
            ctx,
            threadId: threadB,
            timeoutMs: CODEX_CONCURRENT_TURN_TIMEOUT_MS,
            label: "thread B turn/completed",
          }),
        ]);

        expect(turnCompletedCount(ctx.events)).toBeGreaterThanOrEqual(2);
        expect(getThreadText(ctx.events, threadA)).toContain("THREAD_A_OK");
        expect(getThreadText(ctx.events, threadB)).toContain("THREAD_B_OK");
      } finally {
        await ctx.runtime.shutdown();
        cleanup(ctx);
      }
    }, 90_000);
  });

  // Multi-provider: single runtime
  describe.concurrent("multi-provider scenarios", () => {
    it("uses multiple providers in a single runtime", async () => {
      const ctx = createTestRuntime("codex");
      try {
        const codexThread = newThreadId();
        const claudeThread = newThreadId();
        const codexOptions = await resolveRuntimeOptions({
          ctx,
          providerId: "codex",
          preset: "full",
        });
        const claudeOptions = await resolveRuntimeOptions({
          ctx,
          providerId: "claude-code",
          preset: "full",
        });

        await ctx.runtime.startThread({
          environmentId: "env-1",
          threadId: codexThread,
          projectId: "test-project",
          providerId: "codex",
          options: codexOptions,
        });

        await ctx.runtime.startThread({
          environmentId: "env-1",
          threadId: claudeThread,
          projectId: "test-project",
          providerId: "claude-code",
          options: claudeOptions,
        });

        // Run turns concurrently on both providers
        await Promise.all([
          ctx.runtime.runTurn({
            threadId: codexThread,
            input: [{ type: "text", text: "Reply with exactly: CODEX_OK" }],
            options: codexOptions,
          }),
          ctx.runtime.runTurn({
            threadId: claudeThread,
            input: [{ type: "text", text: "Reply with exactly: CLAUDE_OK" }],
            options: claudeOptions,
          }),
        ]);

        await waitForTurnCompletedCount({
          ctx,
          count: 2,
          timeoutMs: 45_000,
          label: "both providers turn/completed",
        });

        // Verify events came from both threads
        const codexEvents = ctx.events.filter(
          (e) => "threadId" in e && e.threadId === codexThread,
        );
        const claudeEvents = ctx.events.filter(
          (e) => "threadId" in e && e.threadId === claudeThread,
        );
        expect(codexEvents.length).toBeGreaterThan(0);
        expect(claudeEvents.length).toBeGreaterThan(0);
      } finally {
        await ctx.runtime.shutdown();
        cleanup(ctx);
      }
    }, 45_000);
  });
});

describe.concurrent("multi-provider resume scenarios", () => {
  // Matrix test: multiple threads, multiple providers, with resume
  it("handles multiple threads across providers with resume", async () => {
    // Runtime 1: start threads on codex and claude-code, remember different words
    const ctx1 = createTestRuntime("codex");
    const codexThreadId1 = newThreadId();
    const claudeThreadId1 = newThreadId();
    let codexProviderThreadId: string | undefined;
    let claudeProviderThreadId: string | undefined;
    let ctx1Shutdown = false;

    try {
      const codexOptions = await resolveRuntimeOptions({
        ctx: ctx1,
        providerId: "codex",
        preset: "full",
      });
      const claudeOptions = await resolveRuntimeOptions({
        ctx: ctx1,
        providerId: "claude-code",
        preset: "full",
      });
      const [codexStart, claudeStart] = await Promise.all([
        ctx1.runtime.startThread({
          environmentId: "env-1",
          threadId: codexThreadId1,
          projectId: "test-project",
          providerId: "codex",
          options: codexOptions,
        }),
        ctx1.runtime.startThread({
          environmentId: "env-1",
          threadId: claudeThreadId1,
          projectId: "test-project",
          providerId: "claude-code",
          options: claudeOptions,
        }),
      ]);

      codexProviderThreadId = codexStart.providerThreadId || undefined;
      claudeProviderThreadId = claudeStart.providerThreadId || undefined;

      // Run turns concurrently: codex remembers APPLE, claude-code remembers ORANGE
      await Promise.all([
        ctx1.runtime.runTurn({
          threadId: codexThreadId1,
          input: [
            {
              type: "text",
              text: "Remember the fruit APPLE. Just confirm you will remember it.",
            },
          ],
          options: codexOptions,
        }),
        ctx1.runtime.runTurn({
          threadId: claudeThreadId1,
          input: [
            {
              type: "text",
              text: "Remember the fruit ORANGE. Just confirm you will remember it.",
            },
          ],
          options: claudeOptions,
        }),
      ]);

      await waitForTurnCompletedCount({
        ctx: ctx1,
        count: 2,
        timeoutMs: 45_000,
        label: "both threads turn/completed",
      });

      // Capture providerThreadIds from identity events if needed
      if (!codexProviderThreadId) {
        const identityEvent = ctx1.events.find(
          (e) =>
            e.type === "thread/identity" &&
            "threadId" in e &&
            e.threadId === codexThreadId1,
        );
        if (identityEvent && identityEvent.type === "thread/identity") {
          codexProviderThreadId = identityEvent.providerThreadId;
        }
      }
      if (!claudeProviderThreadId) {
        const identityEvent = ctx1.events.find(
          (e) =>
            e.type === "thread/identity" &&
            "threadId" in e &&
            e.threadId === claudeThreadId1,
        );
        if (identityEvent && identityEvent.type === "thread/identity") {
          claudeProviderThreadId = identityEvent.providerThreadId;
        }
      }

      await ctx1.runtime.shutdown();
      ctx1Shutdown = true;

      // Runtime 2: resume both threads in the same workspace.
      const ctx2 = createTestRuntime("codex", { workspacePath: ctx1.tmpDir });
      const codexThreadId2 = newThreadId();
      const claudeThreadId2 = newThreadId();

      try {
        await Promise.all([
          ctx2.runtime.resumeThread({
            environmentId: "env-1",
            threadId: codexThreadId2,
            providerThreadId: codexProviderThreadId,
            providerId: "codex",
            options: codexOptions,
          }),
          ctx2.runtime.resumeThread({
            environmentId: "env-1",
            threadId: claudeThreadId2,
            providerThreadId: claudeProviderThreadId,
            providerId: "claude-code",
            options: claudeOptions,
          }),
        ]);

        await Promise.all([
          ctx2.runtime.runTurn({
            threadId: codexThreadId2,
            input: [
              {
                type: "text",
                text: "What fruit did I ask you to remember? Reply with just the fruit name.",
              },
            ],
            options: codexOptions,
          }),
          ctx2.runtime.runTurn({
            threadId: claudeThreadId2,
            input: [
              {
                type: "text",
                text: "What fruit did I ask you to remember? Reply with just the fruit name.",
              },
            ],
            options: claudeOptions,
          }),
        ]);

        await waitForTurnCompletedCount({
          ctx: ctx2,
          count: 2,
          timeoutMs: 45_000,
          label: "both resumed threads turn/completed",
        });

        const codexText = getThreadText(
          ctx2.events,
          codexThreadId2,
        ).toUpperCase();
        const claudeText = getThreadText(
          ctx2.events,
          claudeThreadId2,
        ).toUpperCase();
        expect(codexText).toContain("APPLE");
        expect(claudeText).toContain("ORANGE");
      } finally {
        await ctx2.runtime.shutdown();
        cleanup(ctx2);
      }
    } finally {
      if (!ctx1Shutdown) {
        await ctx1.runtime.shutdown();
      }
      cleanup(ctx1);
    }
  }, 90_000);
});
