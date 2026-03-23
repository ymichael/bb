import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import {
  buildPiAvailableModels,
  createPiProviderAdapter,
} from "./adapter.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, "../__fixtures__/pi");

function loadFixture(name: string): AgentSessionEvent {
  return JSON.parse(readFileSync(resolve(FIXTURES, name), "utf8")) as AgentSessionEvent;
}

describe("pi provider adapter", () => {

  // -- Identity & capabilities ---------------------------------------------

  it("has correct identity", () => {
    const adapter = createPiProviderAdapter();
    expect(adapter.id).toBe("pi");
    expect(adapter.displayName).toBe("Pi");
  });

  it("has correct process config", () => {
    const adapter = createPiProviderAdapter();
    expect(adapter.process.command).toBe("node");
    expect(adapter.process.args).toHaveLength(1);
    expect(adapter.process.args[0]).toMatch(/bridge\.js$/);
  });

  it("advertises trimmed capabilities", () => {
    const adapter = createPiProviderAdapter();
    expect(adapter.capabilities).toEqual({
      supportsRename: false,
      supportsServiceTier: false,
    });
  });

  // -- buildCommand --------------------------------------------------------

  it("buildCommand thread/start includes threadId and baseInstructions", () => {
    const adapter = createPiProviderAdapter();
    const cmd = adapter.buildCommand({
      type: "thread/start",
      threadId: "t1",
      input: [{ type: "text", text: "hello" }],
    });
    expect(cmd).toMatchObject({
      method: "thread/start",
      params: { threadId: "t1" },
    });
    expect((cmd as { params: { baseInstructions?: string } }).params.baseInstructions).toBeTruthy();
  });

  it("buildCommand thread/resume routes to provider thread id", () => {
    const adapter = createPiProviderAdapter();
    const cmd = adapter.buildCommand({
      type: "thread/resume",
      threadId: "bb-t1",
      providerThreadId: "pi-session-1",
    });
    expect(cmd).toMatchObject({
      method: "thread/resume",
      params: { threadId: "pi-session-1" },
    });
  });

  it("buildCommand turn/start includes input", () => {
    const adapter = createPiProviderAdapter();
    const cmd = adapter.buildCommand({
      type: "turn/start",
      threadId: "t1",
      providerThreadId: "pi-1",
      input: [{ type: "text", text: "do it" }],
    });
    expect(cmd).toMatchObject({
      method: "turn/start",
      params: { threadId: "pi-1" },
    });
  });

  it("buildCommand thread/name/set returns null (unsupported)", () => {
    const adapter = createPiProviderAdapter();
    expect(
      adapter.buildCommand({
        type: "thread/name/set",
        threadId: "t1",
        providerThreadId: "p1",
        title: "hi",
      }),
    ).toBeNull();
  });

  // -- translateEvent: turn lifecycle --------------------------------------

  it("translateEvent agent_start emits turn/started", () => {
    const adapter = createPiProviderAdapter();
    const events = adapter.translateEvent(loadFixture("agent-start.json"));

    expect(events).toContainEqual(
      expect.objectContaining({ type: "turn/started", turnId: "turn-1" }),
    );
  });

  it("translateEvent agent_end emits agentMessage + turn/completed", () => {
    const adapter = createPiProviderAdapter();
    // Start a turn first
    adapter.translateEvent(loadFixture("agent-start.json"));

    const events = adapter.translateEvent(loadFixture("agent-end-with-message.json"));

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({ type: "agentMessage" }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn/completed",
        turnId: "turn-1",
        status: "completed",
      }),
    );
  });

  // -- translateEvent: streaming -------------------------------------------

  it("translateEvent message_update emits agentMessage delta", () => {
    const adapter = createPiProviderAdapter();
    // Start a turn first
    adapter.translateEvent(loadFixture("agent-start.json"));

    const events = adapter.translateEvent(loadFixture("message-update-delta.json"));

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/agentMessage/delta",
        delta: expect.any(String),
      }),
    );
  });

  // -- translateEvent: tool calls ------------------------------------------

  it("translateEvent tool_execution_start emits item/started", () => {
    const adapter = createPiProviderAdapter();
    // Start a turn first
    adapter.translateEvent(loadFixture("agent-start.json"));

    const events = adapter.translateEvent(loadFixture("tool-execution-start-bash.json"));

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        item: expect.objectContaining({
          type: "commandExecution",
          id: "tc_01a2b3c4d5e6f7g8h9i0j1k2",
          status: "pending",
        }),
      }),
    );
  });

  it("translateEvent tool_execution_end emits item/completed", () => {
    const adapter = createPiProviderAdapter();
    // Start a turn first
    adapter.translateEvent(loadFixture("agent-start.json"));

    const events = adapter.translateEvent(loadFixture("tool-execution-end-bash.json"));

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "commandExecution",
          id: "tc_01a2b3c4d5e6f7g8h9i0j1k2",
          status: "completed",
        }),
      }),
    );
  });

  // -- translateEvent: multiple turns --------------------------------------

  it("translateEvent increments turn IDs across turns", () => {
    const adapter = createPiProviderAdapter();

    // Turn 1
    adapter.translateEvent(loadFixture("agent-start.json"));
    adapter.translateEvent(loadFixture("agent-end-with-message.json"));

    // Turn 2
    const events = adapter.translateEvent(loadFixture("agent-start.json"));

    expect(events).toContainEqual(
      expect.objectContaining({ type: "turn/started", turnId: "turn-2" }),
    );
  });

  // -- Model catalog -------------------------------------------------------

  it("builds a dynamic model list from the Pi catalog", () => {
    const models = buildPiAvailableModels({
      providers: ["anthropic", "openai", "google"],
      getModels: (provider) => {
        switch (provider) {
          case "anthropic":
            return [
              {
                id: "claude-sonnet-4-20250514",
                name: "Claude Sonnet 4",
                provider: "anthropic",
                reasoning: true,
                input: ["text", "image"],
              },
            ];
          case "openai":
            return [
              {
                id: "codex-mini",
                name: "Codex Mini",
                provider: "openai",
                reasoning: true,
                input: ["text"],
              },
            ];
          default:
            return [
              {
                id: "gemini-2.5-pro",
                name: "Gemini 2.5 Pro",
                provider: "google",
                reasoning: true,
                input: ["text"],
              },
            ];
        }
      },
      hasAuth: (provider) => provider !== "google",
    });

    const ids = models.map((model) => model.id);
    expect(ids).toContain("anthropic/claude-sonnet-4-20250514");
    expect(ids).toContain("openai/codex-mini");
    expect(ids).not.toContain("google/gemini-2.5-pro");
    expect(models.find((model) => model.isDefault)?.id).toBe(
      "anthropic/claude-sonnet-4-20250514",
    );
  });

});
