/** Provider integration tests using createAgentRuntime. */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { requireThreadEventScopeTurnId } from "@bb/domain";
import {
  cleanup,
  createTestRuntime,
  expectInputAcceptedCount,
  findInputAcceptedForThread,
  findLatestTurnStartedForThread,
  getAgentText,
  getAgentTextAfterIndex,
  getEventsForThread,
  getStreamedText,
  getInputAcceptedEvents,
  hasInputAcceptedForThread,
  newThreadId,
  resolveProviderThreadId,
  resolveRuntimeOptions,
  turnCompletedCount,
  turnCompletedCountForThread,
  turnStartedCountForThread,
  waitForRuntimeCondition,
  waitForThreadTurnCompleted,
  waitForThreadTurnCompletedCount,
  waitForThreadTurnStarted,
  waitForToolCallBeforeTurnCompletion,
} from "./test/runtime-integration-harness.js";

const providers = ["codex", "claude-code", "pi"];

for (const providerId of providers) {
  describe.concurrent(`${providerId} provider`, () => {
    // 1. Lists models
    it("lists models", async () => {
      const ctx = createTestRuntime(providerId);
      try {
        const models = await ctx.runtime.listModels({ providerId });
        expect(models.length).toBeGreaterThan(0);
        for (const model of models) {
          expect(model.id).toBeTruthy();
          expect(model.model).toBeTruthy();
          expect(model.displayName).toBeTruthy();
          expect(model.supportedReasoningEfforts.length).toBeGreaterThan(0);
        }
        expect(models.some((m) => m.isDefault)).toBe(true);
      } finally {
        await ctx.runtime.shutdown();
        cleanup(ctx);
      }
    });

    // 2. Starts a thread and runs a single turn
    it("starts a thread and runs a single turn", async () => {
      const ctx = createTestRuntime(providerId);
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
        });

        await ctx.runtime.runTurn({
          threadId,
          clientRequestSequence: 1,
          options,
          input: [{ type: "text", text: "Reply with exactly: PONG" }],
        });

        await waitForThreadTurnCompleted({
          ctx,
          threadId,
          timeoutMs: 30_000,
          label: "turn/completed",
        });

        expect(ctx.events.some((e) => e.type === "turn/started")).toBe(true);
        expect(ctx.events.some((e) => e.type === "turn/completed")).toBe(true);
        expectInputAcceptedCount(ctx.events, 1);

        // Should have some content (agent message or streamed text)
        const text = getAgentText(ctx.events) || getStreamedText(ctx.events);
        expect(text.length).toBeGreaterThan(0);
      } finally {
        await ctx.runtime.shutdown();
        cleanup(ctx);
      }
    });

    // 3. Handles a follow-up turn in the same session
    it("handles a follow-up turn in the same session", async () => {
      const ctx = createTestRuntime(providerId);
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
        });

        // Turn 1
        await ctx.runtime.runTurn({
          threadId,
          clientRequestSequence: 1,
          input: [{ type: "text", text: "Say hello in one word." }],
          options,
        });

        await waitForThreadTurnCompletedCount({
          ctx,
          threadId,
          count: 1,
          timeoutMs: 30_000,
          label: "first turn/completed",
        });

        // Turn 2
        await ctx.runtime.runTurn({
          threadId,
          clientRequestSequence: 2,
          input: [{ type: "text", text: "Now say goodbye in one word." }],
          options,
        });

        await waitForThreadTurnCompletedCount({
          ctx,
          threadId,
          count: 2,
          timeoutMs: 30_000,
          label: "second turn/completed",
        });

        const turnStarts = ctx.events.filter((e) => e.type === "turn/started");
        const turnEnds = ctx.events.filter((e) => e.type === "turn/completed");
        expect(turnStarts.length).toBeGreaterThanOrEqual(2);
        expect(turnEnds.length).toBeGreaterThanOrEqual(2);
        expectInputAcceptedCount(ctx.events, 2);
      } finally {
        await ctx.runtime.shutdown();
        cleanup(ctx);
      }
    });

    // 4. Steers an active turn.
    it("steers an active turn", async () => {
      const ctx = createTestRuntime(providerId);
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
        });

        await ctx.runtime.runTurn({
          threadId,
          clientRequestSequence: 1,
          input: [
            {
              type: "text",
              text:
                "Write a detailed 20 section essay about the history of computing " +
                "with four sentences per section.",
            },
          ],
          options,
        });

        await waitForThreadTurnStarted({
          ctx,
          threadId,
          timeoutMs: 30_000,
          label: "turn/started before steer",
        });

        const activeTurn = findLatestTurnStartedForThread(ctx.events, threadId);
        if (!activeTurn) {
          throw new Error("Expected active turn before steering");
        }
        const activeTurnId = requireThreadEventScopeTurnId({
          type: activeTurn.type,
          scope: activeTurn.scope,
        });
        const steerText = `STEER_${providerId}_${randomUUID()}`;
        await ctx.runtime.steerTurn({
          threadId,
          expectedTurnId: activeTurnId,
          clientRequestSequence: 2,
          input: [{ type: "text", text: steerText }],
          options,
        });

        await waitForRuntimeCondition({
          ctx,
          threadId,
          predicate: () => hasInputAcceptedForThread(ctx.events, threadId, 2),
          timeoutMs: 30_000,
          label: "steer input accepted",
        });

        const steerInputAccepted = findInputAcceptedForThread(
          ctx.events,
          threadId,
          2,
        );
        expect(steerInputAccepted?.type).toBe("turn/input/accepted");
        if (steerInputAccepted?.type !== "turn/input/accepted") {
          throw new Error("Expected steer input accepted event");
        }
        expect(
          requireThreadEventScopeTurnId({
            type: steerInputAccepted.type,
            scope: steerInputAccepted.scope,
          }),
        ).toBe(activeTurnId);

        await ctx.runtime.stopThread({ threadId });
      } finally {
        await ctx.runtime.shutdown();
        cleanup(ctx);
      }
    }, 90_000);

    // 5. Stops an active turn and recovers with a resumed session.
    it("stops an active turn and recovers with a follow-up", async () => {
      const ctx = createTestRuntime(providerId);
      try {
        const threadId = newThreadId();
        const options = await resolveRuntimeOptions({
          ctx,
          providerId,
          preset: "full",
        });
        const startResult = await ctx.runtime.startThread({
          environmentId: "env-1",
          threadId,
          projectId: "test-project",
          providerId,
          options,
        });

        await ctx.runtime.runTurn({
          threadId,
          clientRequestSequence: 1,
          input: [
            {
              type: "text",
              text:
                "Write a detailed 20 section essay about the history of computing " +
                "with four sentences per section.",
            },
          ],
          options,
        });

        await waitForThreadTurnStarted({
          ctx,
          threadId,
          timeoutMs: 30_000,
          label: "turn/started before stop",
        });

        const completedBeforeStop = turnCompletedCountForThread(
          ctx.events,
          threadId,
        );
        expect(completedBeforeStop).toBe(0);

        await ctx.runtime.stopThread({ threadId });

        const providerThreadId = resolveProviderThreadId({
          events: ctx.events,
          fallbackProviderThreadId: startResult.providerThreadId,
          threadId,
        });
        await ctx.runtime.resumeThread({
          environmentId: "env-1",
          threadId,
          projectId: "test-project",
          providerThreadId,
          providerId,
          options,
        });

        const recoveryStartIndex = ctx.events.length;
        const completedBeforeRecovery = turnCompletedCountForThread(
          ctx.events,
          threadId,
        );
        await ctx.runtime.runTurn({
          threadId,
          clientRequestSequence: 2,
          input: [
            {
              type: "text",
              text: "Reply with a short confirmation that you are ready for the next task.",
            },
          ],
          options,
        });

        await waitForRuntimeCondition({
          ctx,
          threadId,
          predicate: () =>
            turnCompletedCountForThread(ctx.events, threadId) >
              completedBeforeRecovery &&
            getAgentTextAfterIndex(ctx.events, recoveryStartIndex, threadId)
              .length > 0,
          timeoutMs: 60_000,
          label: "recovery turn/completed with output",
        });

        expect(
          turnStartedCountForThread(ctx.events, threadId),
        ).toBeGreaterThanOrEqual(2);
        expect(
          getAgentTextAfterIndex(ctx.events, recoveryStartIndex, threadId)
            .length,
        ).toBeGreaterThan(0);
        const inputAcceptedCount = getInputAcceptedEvents(
          getEventsForThread(ctx.events, threadId),
        ).length;
        expect(inputAcceptedCount).toBe(2);
      } finally {
        await ctx.runtime.shutdown();
        cleanup(ctx);
      }
    }, 90_000);

    // 6. Respects developer instructions
    it("respects developer instructions", async () => {
      const ctx = createTestRuntime(providerId);
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
            "IMPORTANT: End every single response with exactly [TEST_TAG]. Never omit this tag.",
        });

        await ctx.runtime.runTurn({
          threadId,
          input: [{ type: "text", text: "What is 2+2?" }],
          options,
        });

        await waitForThreadTurnCompleted({
          ctx,
          threadId,
          timeoutMs: 30_000,
          label: "turn/completed",
        });

        const text = getAgentText(ctx.events) || getStreamedText(ctx.events);
        expect(text).toContain("[TEST_TAG]");
      } finally {
        await ctx.runtime.shutdown();
        cleanup(ctx);
      }
    });

    // 7. Recovers from a bad request
    it("recovers from a bad request", async () => {
      const ctx = createTestRuntime(providerId);
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
        });

        // Good turn 1
        await ctx.runtime.runTurn({
          threadId,
          input: [{ type: "text", text: "Say hello in one word." }],
          options,
        });

        await waitForThreadTurnCompleted({
          ctx,
          threadId,
          timeoutMs: 30_000,
          label: "first turn/completed",
        });

        // Bad request — nonexistent thread
        const badThreadId = `nonexistent_${Date.now()}`;
        let badRequestFailed = false;
        try {
          await ctx.runtime.runTurn({
            threadId: badThreadId,
            input: [{ type: "text", text: "This should fail." }],
            options,
          });
        } catch {
          badRequestFailed = true;
        }
        expect(badRequestFailed).toBe(true);

        // Good turn 2 — same session should still work
        await ctx.runtime.runTurn({
          threadId,
          input: [{ type: "text", text: "Say goodbye in one word." }],
          options,
        });

        await waitForThreadTurnCompletedCount({
          ctx,
          threadId,
          count: 2,
          timeoutMs: 30_000,
          label: "second turn/completed after recovery",
        });

        expect(turnCompletedCount(ctx.events)).toBeGreaterThanOrEqual(2);
      } finally {
        await ctx.runtime.shutdown();
        cleanup(ctx);
      }
    });

    // 8. Handles dynamic tool calls
    it("handles dynamic tool calls", async () => {
      let toolCalled = false;
      const ctx = createTestRuntime(providerId, {
        onToolCall: async (req) => {
          if (req.tool === "bb_test_ping") {
            toolCalled = true;
            return {
              contentItems: [
                { type: "inputText" as const, text: "PONG_FROM_TOOL" },
              ],
              success: true,
            };
          }
          return {
            contentItems: [
              { type: "inputText" as const, text: "unknown tool" },
            ],
            success: false,
          };
        },
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
          dynamicTools: [
            {
              name: "bb_test_ping",
              description:
                "Returns a test ping response. Always call this tool when asked to use it.",
              inputSchema: {
                type: "object",
                properties: {},
              },
            },
          ],
        });

        await ctx.runtime.runTurn({
          threadId,
          input: [
            {
              type: "text",
              text: "Call the bb_test_ping tool right now and report what it returns.",
            },
          ],
          options,
        });

        await waitForToolCallBeforeTurnCompletion({
          ctx,
          threadId,
          toolName: "bb_test_ping",
          timeoutMs: 30_000,
          label: "tool call",
        });

        expect(toolCalled).toBe(true);
      } finally {
        await ctx.runtime.shutdown();
        cleanup(ctx);
      }
    });
  });
}
