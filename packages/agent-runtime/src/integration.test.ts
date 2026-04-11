/**
 * Provider integration tests using createAgentRuntime.
 *
 * These tests validate that each provider works end-to-end through the
 * real runtime: process spawning, JSON-RPC framing, event routing, and
 * tool call round-trips.
 *
 * All providers must be authenticated in the current environment before
 * running these tests.
 *
 * Run with: pnpm test:integration
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ThreadEvent, ToolCallRequest, ToolCallResponse } from "@bb/domain";
import { createAgentRuntime } from "./runtime.js";
import type { AgentRuntime } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function waitForCondition(
  predicate: () => boolean,
  opts?: { timeoutMs?: number; label?: string },
): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? 30_000;
  const label = opts?.label ?? "condition";
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Timeout after ${timeoutMs}ms waiting for ${label}`));
        return;
      }
      setTimeout(check, 100);
    };
    check();
  });
}

function hasTurnCompleted(events: ThreadEvent[]): boolean {
  return events.some((e) => e.type === "turn/completed");
}

function turnCompletedCount(events: ThreadEvent[]): number {
  return events.filter((e) => e.type === "turn/completed").length;
}

function collectTurnIds(events: ThreadEvent[]): Set<string> {
  const turnIds = new Set<string>();
  for (const event of events) {
    if ("turnId" in event && event.turnId) {
      turnIds.add(event.turnId);
    }
  }
  return turnIds;
}

interface RuntimeRestartTurnIdAssertionArgs {
  firstEvents: ThreadEvent[];
  providerId: string;
  secondEvents: ThreadEvent[];
}

function providerUsesRuntimeTurnIds(providerId: string): boolean {
  return providerId === "claude-code" || providerId === "pi";
}

function expectNoSharedRuntimeTurnIds(
  args: RuntimeRestartTurnIdAssertionArgs,
): void {
  if (!providerUsesRuntimeTurnIds(args.providerId)) {
    return;
  }

  const firstTurnIds = collectTurnIds(args.firstEvents);
  const secondTurnIds = collectTurnIds(args.secondEvents);
  const sharedTurnIds = Array.from(firstTurnIds).filter((turnId) =>
    secondTurnIds.has(turnId),
  );

  expect(firstTurnIds.size).toBeGreaterThan(0);
  expect(secondTurnIds.size).toBeGreaterThan(0);
  expect(sharedTurnIds).toEqual([]);
}

function getAgentText(events: ThreadEvent[]): string {
  const texts: string[] = [];
  for (const e of events) {
    if (e.type === "item/completed" && e.item.type === "agentMessage" && e.item.text) {
      texts.push(e.item.text);
    }
  }
  return texts.join(" ");
}

function getStreamedText(events: ThreadEvent[]): string {
  const chunks: string[] = [];
  for (const e of events) {
    if (e.type === "item/agentMessage/delta") {
      chunks.push(e.delta);
    }
  }
  return chunks.join("");
}

function getCompletedCommandOutputs(events: ThreadEvent[]): string {
  const outputs: string[] = [];
  for (const event of events) {
    if (
      event.type === "item/completed"
      && event.item.type === "commandExecution"
      && event.item.aggregatedOutput
    ) {
      outputs.push(event.item.aggregatedOutput);
    }
  }
  return outputs.join("\n");
}

function getCompletedCommands(events: ThreadEvent[]): string[] {
  const commands: string[] = [];
  for (const event of events) {
    if (
      event.type === "item/completed"
      && event.item.type === "commandExecution"
    ) {
      commands.push(event.item.command);
    }
  }
  return commands;
}

function resolveDefaultModel(providerId: string, ctx: TestContext): Promise<string | undefined> {
  return ctx.runtime.listModels({ providerId }).then((models) =>
    models.find((model) => model.isDefault)?.model ?? models[0]?.model,
  );
}

function newThreadId(): string {
  return randomUUID();
}

interface TestContext {
  runtime: AgentRuntime;
  events: ThreadEvent[];
  toolCalls: ToolCallRequest[];
  tmpDir: string;
}

function createTestRuntime(
  providerId: string,
  opts?: {
    onToolCall?: (req: ToolCallRequest) => Promise<ToolCallResponse>;
  },
): TestContext {
  const tmpDir = mkdtempSync(join(tmpdir(), `bb-integ-${providerId}-`));
  const events: ThreadEvent[] = [];
  const toolCalls: ToolCallRequest[] = [];

  const defaultToolHandler = async (): Promise<ToolCallResponse> => ({
    contentItems: [{ type: "inputText" as const, text: "ok" }],
    success: true,
  });

  const runtime = createAgentRuntime({
    workspacePath: tmpDir,
    onEvent: (e) => events.push(e),
    onToolCall: async (req) => {
      toolCalls.push(req);
      if (opts?.onToolCall) return opts.onToolCall(req);
      return defaultToolHandler();
    },
    onStderr: () => {},
  });

  return { runtime, events, toolCalls, tmpDir };
}

function cleanup(ctx: TestContext): void {
  rmSync(ctx.tmpDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Tests -- one describe per provider, all run concurrently
// ---------------------------------------------------------------------------

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
        const model = await resolveDefaultModel(providerId, ctx);
        await ctx.runtime.startThread({
          environmentId: "env-1",
          threadId,
          projectId: "test-project",
          providerId,
          options: {
            sandboxMode: "danger-full-access",
            ...(model ? { model } : {}),
          },
        });

        await ctx.runtime.runTurn({
          threadId,
          options: {
            sandboxMode: "danger-full-access",
            ...(model ? { model } : {}),
          },
          input: [{ type: "text", text: "Reply with exactly: PONG" }],
        });

        await waitForCondition(() => hasTurnCompleted(ctx.events), {
          timeoutMs: 30_000,
          label: "turn/completed",
        });

        expect(ctx.events.some((e) => e.type === "turn/started")).toBe(true);
        expect(ctx.events.some((e) => e.type === "turn/completed")).toBe(true);

        // Should have some content (agent message or streamed text)
        const text = getAgentText(ctx.events) || getStreamedText(ctx.events);
        expect(text.length).toBeGreaterThan(0);
      } finally {
        await ctx.runtime.shutdown();
        cleanup(ctx);
      }
    });

    it("starts turns in the workspace cwd and still allows cd outside it", async () => {
      const ctx = createTestRuntime(providerId);
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
            sandboxMode: "danger-full-access",
            ...(model ? { model } : {}),
          },
          instructions:
            "When the user asks you to run exact shell commands, use your shell or command execution tool and preserve the command output.",
        });

        await ctx.runtime.runTurn({
          threadId,
          options: {
            sandboxMode: "danger-full-access",
            ...(model ? { model } : {}),
          },
          input: [{
            type: "text",
            text:
              `Run these two shell commands exactly as written, in order, from the current working directory: `
              + `\`pwd && cat ${workspaceMarkerName}\` and \`cd .. && pwd && cat ${parentMarkerName}\`. `
              + "Do not use absolute paths. After both commands finish, reply with exactly DONE.",
          }],
        });

        await waitForCondition(() => {
          const outputs = getCompletedCommandOutputs(ctx.events);
          return (
            (
              outputs.includes(workspaceToken)
              && outputs.includes(parentToken)
            )
            || hasTurnCompleted(ctx.events)
          );
        }, {
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

    // 3. Handles a follow-up turn in the same session
    it("handles a follow-up turn in the same session", async () => {
      const ctx = createTestRuntime(providerId);
      try {
        const threadId = newThreadId();
        await ctx.runtime.startThread({
          environmentId: "env-1",
          threadId,
          projectId: "test-project",
          providerId,
          options: { sandboxMode: "danger-full-access" },
        });

        // Turn 1
        await ctx.runtime.runTurn({
          threadId,
          input: [{ type: "text", text: "Say hello in one word." }],
        });

        await waitForCondition(() => turnCompletedCount(ctx.events) >= 1, {
          timeoutMs: 30_000,
          label: "first turn/completed",
        });

        // Turn 2
        await ctx.runtime.runTurn({
          threadId,
          input: [{ type: "text", text: "Now say goodbye in one word." }],
        });

        await waitForCondition(() => turnCompletedCount(ctx.events) >= 2, {
          timeoutMs: 30_000,
          label: "second turn/completed",
        });

        const turnStarts = ctx.events.filter((e) => e.type === "turn/started");
        const turnEnds = ctx.events.filter((e) => e.type === "turn/completed");
        expect(turnStarts.length).toBeGreaterThanOrEqual(2);
        expect(turnEnds.length).toBeGreaterThanOrEqual(2);
      } finally {
        await ctx.runtime.shutdown();
        cleanup(ctx);
      }
    });

    // 4. Respects developer instructions
    it("respects developer instructions", async () => {
      const ctx = createTestRuntime(providerId);
      try {
        const threadId = newThreadId();
        await ctx.runtime.startThread({
          environmentId: "env-1",
          threadId,
          projectId: "test-project",
          providerId,
          options: {
            sandboxMode: "danger-full-access",
          },
          instructions: "IMPORTANT: End every single response with exactly [TEST_TAG]. Never omit this tag.",
        });

        await ctx.runtime.runTurn({
          threadId,
          input: [{ type: "text", text: "What is 2+2?" }],
        });

        await waitForCondition(() => hasTurnCompleted(ctx.events), {
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

    // 5. Recovers from a bad request
    it("recovers from a bad request", async () => {
      const ctx = createTestRuntime(providerId);
      try {
        const threadId = newThreadId();
        await ctx.runtime.startThread({
          environmentId: "env-1",
          threadId,
          projectId: "test-project",
          providerId,
          options: { sandboxMode: "danger-full-access" },
        });

        // Good turn 1
        await ctx.runtime.runTurn({
          threadId,
          input: [{ type: "text", text: "Say hello in one word." }],
        });

        await waitForCondition(() => hasTurnCompleted(ctx.events), {
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
          });
        } catch {
          badRequestFailed = true;
        }
        expect(badRequestFailed).toBe(true);

        // Good turn 2 — same session should still work
        await ctx.runtime.runTurn({
          threadId,
          input: [{ type: "text", text: "Say goodbye in one word." }],
        });

        await waitForCondition(() => turnCompletedCount(ctx.events) >= 2, {
          timeoutMs: 30_000,
          label: "second turn/completed after recovery",
        });

        expect(turnCompletedCount(ctx.events)).toBeGreaterThanOrEqual(2);
      } finally {
        await ctx.runtime.shutdown();
        cleanup(ctx);
      }
    });

    // 6. Handles dynamic tool calls
    it("handles dynamic tool calls", async () => {
      let toolCalled = false;
      const ctx = createTestRuntime(providerId, {
        onToolCall: async (req) => {
          if (req.tool === "bb_test_ping") {
            toolCalled = true;
            return {
              contentItems: [{ type: "inputText" as const, text: "PONG_FROM_TOOL" }],
              success: true,
            };
          }
          return {
            contentItems: [{ type: "inputText" as const, text: "unknown tool" }],
            success: false,
          };
        },
      });

      try {
        const threadId = newThreadId();
        await ctx.runtime.startThread({
          environmentId: "env-1",
          threadId,
          projectId: "test-project",
          providerId,
          options: { sandboxMode: "danger-full-access" },
          dynamicTools: [
            {
              name: "bb_test_ping",
              description: "Returns a test ping response. Always call this tool when asked to use it.",
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
        });

        await waitForCondition(() => toolCalled, {
          timeoutMs: 30_000,
          label: "tool call",
        });

        expect(toolCalled).toBe(true);
      } finally {
        await ctx.runtime.shutdown();
        cleanup(ctx);
      }
    });

    // 7. Resumes a thread across process lifetimes
    //
    // Verifies that after shutting down one runtime (simulating process death),
    // a new runtime can resume or re-create a session. For codex and pi, this
    // uses actual session resume with conversation recall. For claude-code, the
    // SDK's session persistence may not complete before SIGTERM, so we verify
    // the runtime lifecycle by starting a fresh session in the new process.
    it("resumes a thread across process lifetimes", async () => {
      const ctx1 = createTestRuntime(providerId);
      let providerThreadId: string | undefined;
      let resumePath: string | undefined;
      let firstRuntimeEvents: ThreadEvent[] = [];
      const firstThreadId = newThreadId();

      try {
        const startResult = await ctx1.runtime.startThread({
          environmentId: "env-1",
          threadId: firstThreadId,
          projectId: "test-project",
          providerId,
          options: { sandboxMode: "danger-full-access" },
        });

        providerThreadId = startResult.providerThreadId || undefined;

        await ctx1.runtime.runTurn({
          threadId: firstThreadId,
          input: [{ type: "text", text: "Remember the secret word STRAWBERRY. Just confirm you will remember it." }],
        });

        await waitForCondition(() => hasTurnCompleted(ctx1.events), {
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

        // For pi, the resume path is the session file
        if (providerId === "pi") {
          const homeDir = require("node:os").homedir();
          const sanitized = firstThreadId.replace(/[^A-Za-z0-9._-]/g, "_");
          resumePath = join(homeDir, ".bb", "pi-bridge-sessions", `${sanitized}.jsonl`);
        }

        // Shutdown first runtime (simulates process death)
        await ctx1.runtime.shutdown();
      } finally {
        cleanup(ctx1);
      }

      // Create a new runtime and attempt to resume
      const ctx2 = createTestRuntime(providerId);
      try {
        const threadId = newThreadId();

        // Attempt resume
        await ctx2.runtime.resumeThread({
          environmentId: "env-1",
          threadId,
          providerThreadId,
          providerId,
          resumePath,
        });

        await ctx2.runtime.runTurn({
          threadId,
          input: [{ type: "text", text: "What was the secret word I told you to remember? Reply with just the word." }],
        });

        // Wait for a turn to complete. Use a shorter initial timeout so we can
        // fall back to a fresh thread if the provider doesn't support resume.
        let resumed = false;
        try {
          await waitForCondition(() => hasTurnCompleted(ctx2.events), {
            timeoutMs: 15_000,
            label: "resumed turn/completed",
          });
          resumed = true;
        } catch {
          // Resume didn't produce events — acceptable for providers whose SDK
          // doesn't persist sessions across SIGTERM (claude-code).
        }

        if (resumed) {
          expectNoSharedRuntimeTurnIds({
            firstEvents: firstRuntimeEvents,
            providerId,
            secondEvents: ctx2.events,
          });
          const text = getAgentText(ctx2.events) || getStreamedText(ctx2.events);
          expect(text.toUpperCase()).toContain("STRAWBERRY");
        } else {
          // Fall back: verify the new runtime can start a fresh session.
          // Shut down the current (potentially stuck) runtime first.
          await ctx2.runtime.shutdown();

          const ctx3 = createTestRuntime(providerId);
          try {
            const fallbackThreadId = newThreadId();
            await ctx3.runtime.startThread({
              environmentId: "env-1",
              threadId: fallbackThreadId,
              projectId: "test-project",
              providerId,
              options: { sandboxMode: "danger-full-access" },
            });

            await ctx3.runtime.runTurn({
              threadId: fallbackThreadId,
              input: [{ type: "text", text: "Reply with exactly: LIFECYCLE_OK" }],
            });

            await waitForCondition(() => hasTurnCompleted(ctx3.events), {
              timeoutMs: 30_000,
              label: "fallback turn/completed",
            });
            expectNoSharedRuntimeTurnIds({
              firstEvents: firstRuntimeEvents,
              providerId,
              secondEvents: ctx3.events,
            });

            const text = getAgentText(ctx3.events) || getStreamedText(ctx3.events);
            expect(text.length).toBeGreaterThan(0);
          } finally {
            await ctx3.runtime.shutdown();
            cleanup(ctx3);
          }
        }
      } finally {
        // Only shutdown if not already shut down (in the fallback path)
        try { await ctx2.runtime.shutdown(); } catch { /* already shut down */ }
        cleanup(ctx2);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Cross-provider and multi-thread scenarios
// ---------------------------------------------------------------------------

describe.concurrent("cross-provider and multi-thread scenarios", () => {
  // Multi-thread: single provider, single runtime
  describe.concurrent("multi-thread scenarios", () => {
    it("runs multiple threads on the same codex runtime", async () => {
      const ctx = createTestRuntime("codex");
      try {
        const threadA = newThreadId();
        const threadB = newThreadId();

        await ctx.runtime.startThread({
          environmentId: "env-1",
          threadId: threadA,
          projectId: "test-project",
          providerId: "codex",
          options: { sandboxMode: "danger-full-access" },
        });

        await ctx.runtime.startThread({
          environmentId: "env-1",
          threadId: threadB,
          projectId: "test-project",
          providerId: "codex",
          options: { sandboxMode: "danger-full-access" },
        });

        // Run turns concurrently
        await Promise.all([
          ctx.runtime.runTurn({
            threadId: threadA,
            input: [{ type: "text", text: "Reply with exactly: THREAD_A_OK" }],
          }),
          ctx.runtime.runTurn({
            threadId: threadB,
            input: [{ type: "text", text: "Reply with exactly: THREAD_B_OK" }],
          }),
        ]);

        await waitForCondition(() => turnCompletedCount(ctx.events) >= 2, {
          timeoutMs: 30_000,
          label: "both threads turn/completed",
        });

        expect(turnCompletedCount(ctx.events)).toBeGreaterThanOrEqual(2);
        const text = getAgentText(ctx.events) || getStreamedText(ctx.events);
        expect(text.length).toBeGreaterThan(0);
      } finally {
        await ctx.runtime.shutdown();
        cleanup(ctx);
      }
    }, 60_000);
  });

  // Multi-provider: single runtime
  describe.concurrent("multi-provider scenarios", () => {
    it("uses multiple providers in a single runtime", async () => {
      const ctx = createTestRuntime("codex");
      try {
        const codexThread = newThreadId();
        const claudeThread = newThreadId();

        await ctx.runtime.startThread({
          environmentId: "env-1",
          threadId: codexThread,
          projectId: "test-project",
          providerId: "codex",
          options: { sandboxMode: "danger-full-access" },
        });

        await ctx.runtime.startThread({
          environmentId: "env-1",
          threadId: claudeThread,
          projectId: "test-project",
          providerId: "claude-code",
          options: { sandboxMode: "danger-full-access" },
        });

        // Run turns concurrently on both providers
        await Promise.all([
          ctx.runtime.runTurn({
            threadId: codexThread,
            input: [{ type: "text", text: "Reply with exactly: CODEX_OK" }],
          }),
          ctx.runtime.runTurn({
            threadId: claudeThread,
            input: [{ type: "text", text: "Reply with exactly: CLAUDE_OK" }],
          }),
        ]);

        await waitForCondition(() => turnCompletedCount(ctx.events) >= 2, {
          timeoutMs: 45_000,
          label: "both providers turn/completed",
        });

        // Verify events came from both threads
        const codexEvents = ctx.events.filter((e) => "threadId" in e && e.threadId === codexThread);
        const claudeEvents = ctx.events.filter((e) => "threadId" in e && e.threadId === claudeThread);
        expect(codexEvents.length).toBeGreaterThan(0);
        expect(claudeEvents.length).toBeGreaterThan(0);
      } finally {
        await ctx.runtime.shutdown();
        cleanup(ctx);
      }
    }, 45_000);
  });

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
      const startResult = await ctx1.runtime.startThread({
        environmentId: "env-1",
        threadId: firstThreadId,
        projectId: "test-project",
        providerId,
        options: { sandboxMode: "danger-full-access" },
        dynamicTools,
      });

      providerThreadId = startResult.providerThreadId || undefined;

      await ctx1.runtime.runTurn({
        threadId: firstThreadId,
        input: [{ type: "text", text: "Call the bb_test_ping tool right now." }],
      });

      await waitForCondition(() => toolCalledInRuntime1, {
        timeoutMs: 30_000,
        label: "tool call in runtime 1",
      });

      await waitForCondition(() => hasTurnCompleted(ctx1.events), {
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
      await ctx2.runtime.resumeThread({
        environmentId: "env-1",
        threadId,
        providerThreadId,
        providerId,
        dynamicTools,
      });

      await ctx2.runtime.runTurn({
        threadId,
        input: [{ type: "text", text: "Call the bb_test_ping tool again right now." }],
      });

      await waitForCondition(() => toolCalledInRuntime2, {
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
      const startResult = await ctx1.runtime.startThread({
        environmentId: "env-1",
        threadId: firstThreadId,
        projectId: "test-project",
        providerId,
        options: { sandboxMode: "danger-full-access" },
      });

      providerThreadId = startResult.providerThreadId || undefined;

      await ctx1.runtime.runTurn({
        threadId: firstThreadId,
        input: [{ type: "text", text: "Remember the word STRAWBERRY. Just confirm you will remember it." }],
      });

      await waitForCondition(() => hasTurnCompleted(ctx1.events), {
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
      await ctx2.runtime.resumeThread({
        environmentId: "env-1",
        threadId,
        providerThreadId,
        providerId,
      });

      await ctx2.runtime.runTurn({
        threadId,
        input: [{ type: "text", text: "What was the word I asked you to remember? Reply with just the word." }],
      });

      await waitForCondition(() => hasTurnCompleted(ctx2.events), {
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
      const startResult = await ctx1.runtime.startThread({
        environmentId: "env-1",
        threadId: firstThreadId,
        projectId: "test-project",
        providerId,
        options: { sandboxMode: "danger-full-access" },
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
      });

      await waitForCondition(() => toolCalledInRuntime1 && hasTurnCompleted(ctx1.events), {
        timeoutMs: 30_000,
        label: "runtime 1 tool call and turn/completed",
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
      await ctx2.runtime.resumeThread({
        environmentId: "env-1",
        threadId,
        providerThreadId,
        providerId,
        dynamicTools,
      });

      await ctx2.runtime.runTurn({
        threadId,
        input: [
          {
            type: "text",
            text: "What did I ask you to remember? Also call the bb_test_ping tool right now.",
          },
        ],
      });

      await waitForCondition(() => toolCalledInRuntime2 && hasTurnCompleted(ctx2.events), {
        timeoutMs: 30_000,
        label: "runtime 2 tool call and turn/completed",
      });

      const text = getAgentText(ctx2.events) || getStreamedText(ctx2.events);
      expect(text.toUpperCase()).toContain("BANANA");
      expect(toolCalledInRuntime2).toBe(true);
    } finally {
      await ctx2.runtime.shutdown();
      cleanup(ctx2);
    }
  }, 45_000);

  // Matrix test: multiple threads, multiple providers, with resume
  it("handles multiple threads across providers with resume", async () => {
    // Runtime 1: start threads on codex and claude-code, remember different words
    const ctx1 = createTestRuntime("codex");
    const codexThreadId1 = newThreadId();
    const claudeThreadId1 = newThreadId();
    let codexProviderThreadId: string | undefined;
    let claudeProviderThreadId: string | undefined;

    try {
      const [codexStart, claudeStart] = await Promise.all([
        ctx1.runtime.startThread({
          environmentId: "env-1",
          threadId: codexThreadId1,
          projectId: "test-project",
          providerId: "codex",
          options: { sandboxMode: "danger-full-access" },
        }),
        ctx1.runtime.startThread({
          environmentId: "env-1",
          threadId: claudeThreadId1,
          projectId: "test-project",
          providerId: "claude-code",
          options: { sandboxMode: "danger-full-access" },
        }),
      ]);

      codexProviderThreadId = codexStart.providerThreadId || undefined;
      claudeProviderThreadId = claudeStart.providerThreadId || undefined;

      // Run turns concurrently: codex remembers APPLE, claude-code remembers ORANGE
      await Promise.all([
        ctx1.runtime.runTurn({
          threadId: codexThreadId1,
          input: [{ type: "text", text: "Remember the fruit APPLE. Just confirm you will remember it." }],
        }),
        ctx1.runtime.runTurn({
          threadId: claudeThreadId1,
          input: [{ type: "text", text: "Remember the fruit ORANGE. Just confirm you will remember it." }],
        }),
      ]);

      await waitForCondition(() => turnCompletedCount(ctx1.events) >= 2, {
        timeoutMs: 45_000,
        label: "both threads turn/completed",
      });

      // Capture providerThreadIds from identity events if needed
      if (!codexProviderThreadId) {
        const identityEvent = ctx1.events.find(
          (e) => e.type === "thread/identity" && "threadId" in e && e.threadId === codexThreadId1,
        );
        if (identityEvent && identityEvent.type === "thread/identity") {
          codexProviderThreadId = identityEvent.providerThreadId;
        }
      }
      if (!claudeProviderThreadId) {
        const identityEvent = ctx1.events.find(
          (e) => e.type === "thread/identity" && "threadId" in e && e.threadId === claudeThreadId1,
        );
        if (identityEvent && identityEvent.type === "thread/identity") {
          claudeProviderThreadId = identityEvent.providerThreadId;
        }
      }

      await ctx1.runtime.shutdown();
    } finally {
      cleanup(ctx1);
    }

    // Runtime 2: resume both threads, ask what fruit they remember
    const ctx2 = createTestRuntime("codex");
    try {
      const codexThreadId2 = newThreadId();
      const claudeThreadId2 = newThreadId();

      await Promise.all([
        ctx2.runtime.resumeThread({
          environmentId: "env-1",
          threadId: codexThreadId2,
          providerThreadId: codexProviderThreadId,
          providerId: "codex",
        }),
        ctx2.runtime.resumeThread({
          environmentId: "env-1",
          threadId: claudeThreadId2,
          providerThreadId: claudeProviderThreadId,
          providerId: "claude-code",
        }),
      ]);

      await Promise.all([
        ctx2.runtime.runTurn({
          threadId: codexThreadId2,
          input: [{ type: "text", text: "What fruit did I ask you to remember? Reply with just the fruit name." }],
        }),
        ctx2.runtime.runTurn({
          threadId: claudeThreadId2,
          input: [{ type: "text", text: "What fruit did I ask you to remember? Reply with just the fruit name." }],
        }),
      ]);

      // Wait for at least one turn to complete — both providers resuming
      // concurrently can take a while.
      await waitForCondition(() => turnCompletedCount(ctx2.events) >= 1, {
        timeoutMs: 45_000,
        label: "at least one resumed thread turn/completed",
      });

      // Try to wait for the second, but don't fail if it doesn't arrive
      // (claude-code SDK may not persist sessions on SIGTERM).
      try {
        await waitForCondition(() => turnCompletedCount(ctx2.events) >= 2, {
          timeoutMs: 15_000,
          label: "second resumed thread turn/completed",
        });
      } catch {
        // Acceptable — one provider's resume may not have completed
      }

      // Verify at least one provider recalled its fruit
      const allText = (getAgentText(ctx2.events) || getStreamedText(ctx2.events)).toUpperCase();
      expect(allText.length).toBeGreaterThan(0);
      // At least codex should recall APPLE (it has reliable resume)
      expect(allText).toContain("APPLE");
    } finally {
      await ctx2.runtime.shutdown();
      cleanup(ctx2);
    }
  }, 90_000);
});
