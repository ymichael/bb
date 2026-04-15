import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ThreadEvent } from "@bb/domain";
import { createAgentRuntime } from "./runtime.js";
import {
  createFakeAdapter,
  fakeProviderScriptPath,
} from "./test/index.js";
import {
  fullRuntimeOptions,
  waitForCondition,
} from "./test/runtime-test-harness.js";

describe("createAgentRuntime provider user-message acks", () => {
  let tmpDir: string;
  let scriptPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "bb-runtime-test-"));
    scriptPath = fakeProviderScriptPath;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("forwards provider-emitted user acks for turns and steers", async () => {
    const events: ThreadEvent[] = [];
    const runtime = createAgentRuntime({
      workspacePath: tmpDir,
      onEvent: (event) => events.push(event),
      onToolCall: async () => ({
        contentItems: [{ type: "inputText", text: "ok" }],
        success: true,
      }),
      adapterFactory: () => createFakeAdapter({ scriptPath }),
    });

    await runtime.startThread({
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerId: "fake",
      options: fullRuntimeOptions,
    });
    await runtime.runTurn({
      threadId: "t1",
      input: [{ type: "text", text: "delay:500 first input" }],
      options: fullRuntimeOptions,
    });
    await waitForCondition(() =>
      events.some(
        (event) =>
          event.type === "item/completed" &&
          event.item.type === "userMessage" &&
          event.item.content.some((content) =>
            content.type === "text" && content.text === "delay:500 first input",
          ),
      ),
    );

    const activeTurn = events.find(
      (event) => event.type === "turn/started" && event.turnId === "turn-1",
    );
    expect(activeTurn?.type).toBe("turn/started");
    await runtime.steerTurn({
      threadId: "t1",
      expectedTurnId: "turn-1",
      input: [{ type: "text", text: "steer input" }],
      options: fullRuntimeOptions,
    });

    await waitForCondition(() =>
      events.some(
        (event) =>
          event.type === "item/completed" &&
          event.item.type === "userMessage" &&
          event.turnId === "turn-1" &&
          event.item.content.some((content) =>
            content.type === "text" && content.text === "steer input",
          ),
      ),
    );

    await runtime.shutdown();
  });

  it("emits provider accepted-command events only after accepted commands", async () => {
    const events: ThreadEvent[] = [];
    const acceptedCommandScriptPath = join(tmpDir, "accepted-command-provider.cjs");
    writeFileSync(
      acceptedCommandScriptPath,
      `
const readline = require("node:readline");

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { ok: true } });
    return;
  }
  if (message.method === "thread/start") {
    send({ jsonrpc: "2.0", id: message.id, result: { providerThreadId: "prov-thread-1" } });
    send({
      jsonrpc: "2.0",
      method: "thread/identity",
      params: { threadId: message.params.threadId, providerThreadId: "prov-thread-1" },
    });
    return;
  }
  if (message.method === "turn/start") {
    send({ jsonrpc: "2.0", id: message.id, result: { ok: true } });
    send({
      jsonrpc: "2.0",
      method: "turn/started",
      params: {
        threadId: message.params.threadId,
        providerThreadId: "prov-thread-1",
        turnId: "turn-1",
      },
    });
    return;
  }
  if (message.method === "turn/steer") {
    send({ jsonrpc: "2.0", id: message.id, result: { ok: true } });
  }
});
`,
      "utf8",
    );
    const baseAdapter = createFakeAdapter({ scriptPath: acceptedCommandScriptPath });
    const runtime = createAgentRuntime({
      workspacePath: tmpDir,
      onEvent: (event) => events.push(event),
      onToolCall: async () => ({
        contentItems: [{ type: "inputText", text: "ok" }],
        success: true,
      }),
      adapterFactory: () => ({
        ...baseAdapter,
        translateAcceptedCommand({ command }) {
          if (command.type !== "turn/steer") {
            return [];
          }
          return [{
            type: "item/completed",
            threadId: command.threadId,
            providerThreadId: command.providerThreadId ?? "",
            turnId: command.expectedTurnId,
            item: {
              type: "userMessage",
              id: "provider-user-1",
              ...(command.clientRequestSequence !== undefined
                ? { clientRequestSequence: command.clientRequestSequence }
                : {}),
              content: [{ type: "text", text: "accepted steer" }],
            },
          }];
        },
      }),
    });

    await runtime.startThread({
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerId: "fake",
      options: fullRuntimeOptions,
    });
    await runtime.runTurn({
      threadId: "t1",
      input: [{ type: "text", text: "active turn" }],
      options: fullRuntimeOptions,
    });
    await waitForCondition(() =>
      events.some((event) => event.type === "turn/started" && event.turnId === "turn-1"),
    );
    await runtime.steerTurn({
      threadId: "t1",
      expectedTurnId: "turn-1",
      clientRequestSequence: 12,
      input: [{ type: "text", text: "accepted steer" }],
      options: fullRuntimeOptions,
    });

    expect(
      events.some(
        (event) =>
          event.type === "item/completed" &&
          event.item.type === "userMessage" &&
          event.item.id === "provider-user-1" &&
          event.item.clientRequestSequence === 12,
      ),
    ).toBe(true);

    await runtime.shutdown();
  });

  it("does not emit provider accepted-command events when a command is rejected", async () => {
    const events: ThreadEvent[] = [];
    const rejectingSteerScriptPath = join(tmpDir, "rejecting-steer-provider.cjs");
    writeFileSync(
      rejectingSteerScriptPath,
      `
const readline = require("node:readline");

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { ok: true } });
    return;
  }
  if (message.method === "thread/start") {
    send({ jsonrpc: "2.0", id: message.id, result: { providerThreadId: "prov-thread-1" } });
    send({
      jsonrpc: "2.0",
      method: "thread/identity",
      params: { threadId: message.params.threadId, providerThreadId: "prov-thread-1" },
    });
    return;
  }
  if (message.method === "turn/start") {
    send({ jsonrpc: "2.0", id: message.id, result: { ok: true } });
    send({
      jsonrpc: "2.0",
      method: "turn/started",
      params: {
        threadId: message.params.threadId,
        providerThreadId: "prov-thread-1",
        turnId: "turn-1",
      },
    });
    return;
  }
  if (message.method === "turn/steer") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32000, message: "No active session" },
    });
  }
});
`,
      "utf8",
    );
    const baseAdapter = createFakeAdapter({ scriptPath: rejectingSteerScriptPath });
    const runtime = createAgentRuntime({
      workspacePath: tmpDir,
      onEvent: (event) => events.push(event),
      onToolCall: async () => ({
        contentItems: [{ type: "inputText", text: "ok" }],
        success: true,
      }),
      adapterFactory: () => ({
        ...baseAdapter,
        translateAcceptedCommand({ command }) {
          if (command.type === "turn/steer") {
            throw new Error("Rejected steer should not be translated");
          }
          return [];
        },
      }),
    });

    await runtime.startThread({
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerId: "fake",
      options: fullRuntimeOptions,
    });
    await runtime.runTurn({
      threadId: "t1",
      input: [{ type: "text", text: "active turn" }],
      options: fullRuntimeOptions,
    });
    await waitForCondition(() =>
      events.some((event) => event.type === "turn/started" && event.turnId === "turn-1"),
    );

    await expect(
      runtime.steerTurn({
        threadId: "t1",
        expectedTurnId: "turn-1",
        input: [{ type: "text", text: "rejected steer" }],
        options: fullRuntimeOptions,
      }),
    ).rejects.toThrow(/No active session/);

    expect(
      events.some(
        (event) =>
          event.type === "item/completed" &&
          event.item.type === "userMessage" &&
          event.item.content.some((content) =>
            content.type === "text" && content.text === "rejected steer",
          ),
      ),
    ).toBe(false);

    await runtime.shutdown();
  });
});
