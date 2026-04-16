/** Provider integration tests using createAgentRuntime. */

import { describe, expect, it } from "vitest";
import type { ThreadEvent } from "@bb/domain";
import {
  cleanup,
  createTestRuntime,
  expectNoSharedRuntimeTurnIds,
  getAgentText,
  getStreamedText,
  getThreadText,
  newThreadId,
  resolveRuntimeOptions,
  waitForThreadTurnCompleted,
  waitForToolCallBeforeTurnCompletion,
} from "./test/runtime-integration-harness.js";

const providers = ["codex", "claude-code", "pi"];

for (const providerId of providers) {
  describe.concurrent(`${providerId} provider`, () => {

    // 9. Resumes a thread across process lifetimes.
    it("resumes a thread across process lifetimes", async () => {
      const ctx1 = createTestRuntime(providerId);
      let providerThreadId: string | undefined;
      let firstRuntimeEvents: ThreadEvent[] = [];
      const firstThreadId = newThreadId();
      let ctx1Shutdown = false;

      try {
        const options = await resolveRuntimeOptions({
          ctx: ctx1,
          providerId,
          preset: "full",
        });
        const startResult = await ctx1.runtime.startThread({
          environmentId: "env-1",
          threadId: firstThreadId,
          projectId: "test-project",
          providerId,
          options,
        });

        providerThreadId = startResult.providerThreadId || undefined;

        await ctx1.runtime.runTurn({
          threadId: firstThreadId,
          input: [{ type: "text", text: "Remember the secret word STRAWBERRY. Just confirm you will remember it." }],
          options,
        });

        await waitForThreadTurnCompleted({
          ctx: ctx1,
          threadId: firstThreadId,
          timeoutMs: 30_000,
          label: "first session turn/completed",
        });
        firstRuntimeEvents = [...ctx1.events];

        // Capture providerThreadId from thread/identity event if the response
        // didn't include one (claude-code sends it asynchronously).
        if (!providerThreadId) {
          const identityEvent = ctx1.events.find(
            (e) => e.type === "thread/identity",
          );
          if (identityEvent && identityEvent.type === "thread/identity") {
            providerThreadId = identityEvent.providerThreadId;
          }
        }

        // Shutdown first runtime (simulates process death)
        await ctx1.runtime.shutdown();
        ctx1Shutdown = true;

        // Create a new runtime and attempt to resume in the same workspace.
        const ctx2 = createTestRuntime(providerId, { workspacePath: ctx1.tmpDir });
        const threadId = newThreadId();

        try {
          await ctx2.runtime.resumeThread({
            environmentId: "env-1",
            threadId,
            providerThreadId,
            providerId,
            options,
          });

          await ctx2.runtime.runTurn({
            threadId,
            input: [{ type: "text", text: "What was the secret word I told you to remember? Reply with just the word." }],
            options,
          });

          await waitForThreadTurnCompleted({
            ctx: ctx2,
            threadId,
            timeoutMs: 30_000,
            label: "resumed turn/completed",
          });

          expectNoSharedRuntimeTurnIds({
            firstEvents: firstRuntimeEvents,
            providerId,
            secondEvents: ctx2.events,
          });
          const text = getThreadText(ctx2.events, threadId);
          expect(text.toUpperCase()).toContain("STRAWBERRY");
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
    });
  });
}

describe("codex resume scenarios", () => {

  // Resume with dynamic tools
  it("preserves dynamic tools across resume", async () => {
    const providerId = "codex";
    let toolCalledInRuntime1 = false;
    let toolCalledInRuntime2 = false;

    const dynamicTools = [
      {
        name: "bb_test_ping",
        description: "Returns a test ping response. Always call this tool when asked to use it.",
        inputSchema: {
          type: "object" as const,
          properties: {},
        },
      },
    ];

    // Runtime 1: start thread with dynamic tools, run a turn using the tool
    const ctx1 = createTestRuntime(providerId, {
      onToolCall: async (req) => {
        if (req.tool === "bb_test_ping") {
          toolCalledInRuntime1 = true;
          return {
            contentItems: [{ type: "inputText" as const, text: "PONG_R1" }],
            success: true,
          };
        }
        return { contentItems: [{ type: "inputText" as const, text: "unknown" }], success: false };
      },
    });

    let providerThreadId: string | undefined;
    const firstThreadId = newThreadId();

    try {
      const options = await resolveRuntimeOptions({
        ctx: ctx1,
        providerId,
        preset: "full",
      });
      const startResult = await ctx1.runtime.startThread({
        environmentId: "env-1",
        threadId: firstThreadId,
        projectId: "test-project",
        providerId,
        options,
        dynamicTools,
      });

      providerThreadId = startResult.providerThreadId || undefined;

      await ctx1.runtime.runTurn({
        threadId: firstThreadId,
        input: [{ type: "text", text: "Call the bb_test_ping tool right now." }],
        options,
      });

      await waitForToolCallBeforeTurnCompletion({
        ctx: ctx1,
        threadId: firstThreadId,
        toolName: "bb_test_ping",
        timeoutMs: 30_000,
        label: "tool call in runtime 1",
      });

      await waitForThreadTurnCompleted({
        ctx: ctx1,
        threadId: firstThreadId,
        timeoutMs: 30_000,
        label: "runtime 1 turn/completed",
      });

      if (!providerThreadId) {
        const identityEvent = ctx1.events.find((e) => e.type === "thread/identity");
        if (identityEvent && identityEvent.type === "thread/identity") {
          providerThreadId = identityEvent.providerThreadId;
        }
      }

      await ctx1.runtime.shutdown();
    } finally {
      cleanup(ctx1);
    }

    expect(toolCalledInRuntime1).toBe(true);

    // Runtime 2: resume thread with same dynamic tools, run a turn asking to use the tool again
    const ctx2 = createTestRuntime(providerId, {
      onToolCall: async (req) => {
        if (req.tool === "bb_test_ping") {
          toolCalledInRuntime2 = true;
          return {
            contentItems: [{ type: "inputText" as const, text: "PONG_R2" }],
            success: true,
          };
        }
        return { contentItems: [{ type: "inputText" as const, text: "unknown" }], success: false };
      },
    });

    try {
      const threadId = newThreadId();
      const options = await resolveRuntimeOptions({
        ctx: ctx2,
        providerId,
        preset: "full",
      });
      await ctx2.runtime.resumeThread({
        environmentId: "env-1",
        threadId,
        providerThreadId,
        providerId,
        dynamicTools,
        options,
      });

      await ctx2.runtime.runTurn({
        threadId,
        input: [{ type: "text", text: "Call the bb_test_ping tool again right now." }],
        options,
      });

      await waitForToolCallBeforeTurnCompletion({
        ctx: ctx2,
        threadId,
        toolName: "bb_test_ping",
        timeoutMs: 30_000,
        label: "tool call in runtime 2",
      });

      expect(toolCalledInRuntime2).toBe(true);
    } finally {
      await ctx2.runtime.shutdown();
      cleanup(ctx2);
    }
  }, 45_000);


  // Memory across resumes
  it("recalls information after resume", async () => {
    const providerId = "codex";

    // Runtime 1: start thread, ask to remember a word
    const ctx1 = createTestRuntime(providerId);
    let providerThreadId: string | undefined;
    const firstThreadId = newThreadId();

    try {
      const options = await resolveRuntimeOptions({
        ctx: ctx1,
        providerId,
        preset: "full",
      });
      const startResult = await ctx1.runtime.startThread({
        environmentId: "env-1",
        threadId: firstThreadId,
        projectId: "test-project",
        providerId,
        options,
      });

      providerThreadId = startResult.providerThreadId || undefined;

      await ctx1.runtime.runTurn({
        threadId: firstThreadId,
        input: [{ type: "text", text: "Remember the word STRAWBERRY. Just confirm you will remember it." }],
        options,
      });

      await waitForThreadTurnCompleted({
        ctx: ctx1,
        threadId: firstThreadId,
        timeoutMs: 30_000,
        label: "runtime 1 turn/completed",
      });

      if (!providerThreadId) {
        const identityEvent = ctx1.events.find((e) => e.type === "thread/identity");
        if (identityEvent && identityEvent.type === "thread/identity") {
          providerThreadId = identityEvent.providerThreadId;
        }
      }

      await ctx1.runtime.shutdown();
    } finally {
      cleanup(ctx1);
    }

    // Runtime 2: resume thread, ask what the word was
    const ctx2 = createTestRuntime(providerId);
    try {
      const threadId = newThreadId();
      const options = await resolveRuntimeOptions({
        ctx: ctx2,
        providerId,
        preset: "full",
      });
      await ctx2.runtime.resumeThread({
        environmentId: "env-1",
        threadId,
        providerThreadId,
        providerId,
        options,
      });

      await ctx2.runtime.runTurn({
        threadId,
        input: [{ type: "text", text: "What was the word I asked you to remember? Reply with just the word." }],
        options,
      });

      await waitForThreadTurnCompleted({
        ctx: ctx2,
        threadId,
        timeoutMs: 30_000,
        label: "runtime 2 turn/completed",
      });

      const text = getAgentText(ctx2.events) || getStreamedText(ctx2.events);
      expect(text.toUpperCase()).toContain("STRAWBERRY");
    } finally {
      await ctx2.runtime.shutdown();
      cleanup(ctx2);
    }
  }, 45_000);


  // Memory + dynamic tools across runtime shutdown
  it("preserves memory and dynamic tools across runtime restart", async () => {
    const providerId = "codex";
    let toolCalledInRuntime1 = false;
    let toolCalledInRuntime2 = false;

    const dynamicTools = [
      {
        name: "bb_test_ping",
        description: "Returns a test ping response. Always call this tool when asked to use it.",
        inputSchema: {
          type: "object" as const,
          properties: {},
        },
      },
    ];

    // Runtime 1: start thread, remember word and call tool
    const ctx1 = createTestRuntime(providerId, {
      onToolCall: async (req) => {
        if (req.tool === "bb_test_ping") {
          toolCalledInRuntime1 = true;
          return {
            contentItems: [{ type: "inputText" as const, text: "PONG_R1" }],
            success: true,
          };
        }
        return { contentItems: [{ type: "inputText" as const, text: "unknown" }], success: false };
      },
    });

    let providerThreadId: string | undefined;
    const firstThreadId = newThreadId();

    try {
      const options = await resolveRuntimeOptions({
        ctx: ctx1,
        providerId,
        preset: "full",
      });
      const startResult = await ctx1.runtime.startThread({
        environmentId: "env-1",
        threadId: firstThreadId,
        projectId: "test-project",
        providerId,
        options,
        dynamicTools,
      });

      providerThreadId = startResult.providerThreadId || undefined;

      await ctx1.runtime.runTurn({
        threadId: firstThreadId,
        input: [
          {
            type: "text",
            text: "Remember the word BANANA. Also call the bb_test_ping tool right now.",
          },
        ],
        options,
      });

      await waitForToolCallBeforeTurnCompletion({
        ctx: ctx1,
        threadId: firstThreadId,
        toolName: "bb_test_ping",
        timeoutMs: 30_000,
        label: "runtime 1 tool call",
      });
      await waitForThreadTurnCompleted({
        ctx: ctx1,
        threadId: firstThreadId,
        timeoutMs: 30_000,
        label: "runtime 1 turn/completed",
      });

      if (!providerThreadId) {
        const identityEvent = ctx1.events.find((e) => e.type === "thread/identity");
        if (identityEvent && identityEvent.type === "thread/identity") {
          providerThreadId = identityEvent.providerThreadId;
        }
      }

      await ctx1.runtime.shutdown();
    } finally {
      cleanup(ctx1);
    }

    expect(toolCalledInRuntime1).toBe(true);

    // Runtime 2: resume thread, ask what word was remembered, call tool again
    const ctx2 = createTestRuntime(providerId, {
      onToolCall: async (req) => {
        if (req.tool === "bb_test_ping") {
          toolCalledInRuntime2 = true;
          return {
            contentItems: [{ type: "inputText" as const, text: "PONG_R2" }],
            success: true,
          };
        }
        return { contentItems: [{ type: "inputText" as const, text: "unknown" }], success: false };
      },
    });

    try {
      const threadId = newThreadId();
      const options = await resolveRuntimeOptions({
        ctx: ctx2,
        providerId,
        preset: "full",
      });
      await ctx2.runtime.resumeThread({
        environmentId: "env-1",
        threadId,
        providerThreadId,
        providerId,
        dynamicTools,
        options,
      });

      await ctx2.runtime.runTurn({
        threadId,
        input: [
          {
            type: "text",
            text: "What did I ask you to remember? Also call the bb_test_ping tool right now.",
          },
        ],
        options,
      });

      await waitForToolCallBeforeTurnCompletion({
        ctx: ctx2,
        threadId,
        toolName: "bb_test_ping",
        timeoutMs: 30_000,
        label: "runtime 2 tool call",
      });
      await waitForThreadTurnCompleted({
        ctx: ctx2,
        threadId,
        timeoutMs: 30_000,
        label: "runtime 2 turn/completed",
      });

      const text = getAgentText(ctx2.events) || getStreamedText(ctx2.events);
      expect(text.toUpperCase()).toContain("BANANA");
      expect(toolCalledInRuntime2).toBe(true);
    } finally {
      await ctx2.runtime.shutdown();
      cleanup(ctx2);
    }
  }, 45_000);
});
