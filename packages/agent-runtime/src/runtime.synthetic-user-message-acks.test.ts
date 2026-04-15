import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ThreadEvent } from "@bb/domain";
import type { AgentRuntimeCaptureEntry } from "./capture-types.js";
import type { AdapterCommand } from "./provider-adapter.js";
import { createAgentRuntime } from "./runtime.js";
import {
  createFakeAdapter as createSharedFakeAdapter,
  fakeProviderScriptPath,
} from "./test/index.js";
import {
  fullRuntimeOptions,
  wait,
  waitForCondition,
} from "./test/runtime-test-harness.js";

describe("createAgentRuntime synthetic user-message acks", () => {
  let tmpDir: string;
  let scriptPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "bb-runtime-test-"));
    scriptPath = fakeProviderScriptPath;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("turn/start acks", () => {
    it("emits synthetic provider user acks for Claude Code turns", async () => {
      const events: ThreadEvent[] = [];
      const captures: AgentRuntimeCaptureEntry[] = [];
      const runtime = createAgentRuntime({
        workspacePath: tmpDir,
        onCapture: (entry) => captures.push(entry),
        onEvent: (event) => events.push(event),
        onToolCall: async () => ({
          contentItems: [{ type: "inputText", text: "ok" }],
          success: true,
        }),
        adapterFactory: () =>
          createSharedFakeAdapter({
            id: "claude-code",
            scriptPath,
            syntheticUserMessageAcks: true,
          }),
      });

      await runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "claude-code",
        options: fullRuntimeOptions,
      });
      await runtime.runTurn({
        threadId: "t1",
        input: [{ type: "text", text: "hello" }],
        options: fullRuntimeOptions,
      });
      await wait(100);

      const eventTypes = events.map((event) => event.type);
      const turnStartedIndex = eventTypes.indexOf("turn/started");
      const userAckIndex = events.findIndex(
        (event) => event.type === "item/completed" && event.item.type === "userMessage",
      );
      const assistantIndex = events.findIndex(
        (event) => event.type === "item/completed" && event.item.type === "agentMessage",
      );

      expect(turnStartedIndex).toBeGreaterThan(-1);
      expect(userAckIndex).toBeGreaterThan(turnStartedIndex);
      expect(assistantIndex).toBeGreaterThan(userAckIndex);

      const userAck = events[userAckIndex];
      expect(userAck?.type).toBe("item/completed");
      if (userAck?.type !== "item/completed" || userAck.item.type !== "userMessage") {
        throw new Error("Expected synthetic userMessage ack");
      }
      expect(userAck.turnId).toBe("turn-1");
      expect(userAck.item.content).toEqual([{ type: "text", text: "hello" }]);
      expect(
        captures.some(
          (entry) =>
            entry.kind === "translated-thread-event" &&
            entry.rawMethod === "runtime/userMessage/ack",
        ),
      ).toBe(true);

      await runtime.shutdown();
    });

    it("clears pending synthetic user acks when a thread is stopped before turn start", async () => {
      const events: ThreadEvent[] = [];
      const noStartScriptPath = join(tmpDir, "no-start-provider.cjs");
      writeFileSync(
        noStartScriptPath,
        `
const readline = require("node:readline");

let turnCount = 0;

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
    turnCount += 1;
    send({ jsonrpc: "2.0", id: message.id, result: { ok: true } });
    if (turnCount === 1) {
      return;
    }
    send({
      jsonrpc: "2.0",
      method: "turn/started",
      params: {
        threadId: message.params.threadId,
        providerThreadId: "prov-thread-1",
        turnId: "turn-2",
      },
    });
    return;
  }
  if (message.method === "thread/stop") {
    send({ jsonrpc: "2.0", id: message.id, result: { ok: true } });
  }
});
`,
        "utf8",
      );
      const runtime = createAgentRuntime({
        workspacePath: tmpDir,
        onEvent: (event) => events.push(event),
        onToolCall: async () => ({
          contentItems: [{ type: "inputText", text: "ok" }],
          success: true,
        }),
        adapterFactory: () =>
          createSharedFakeAdapter({
            id: "claude-code",
            scriptPath: noStartScriptPath,
            syntheticUserMessageAcks: true,
          }),
      });

      await runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "claude-code",
        options: fullRuntimeOptions,
      });
      await runtime.runTurn({
        threadId: "t1",
        input: [{ type: "text", text: "first turn" }],
        options: fullRuntimeOptions,
      });
      await runtime.stopThread({ threadId: "t1" });
      await runtime.runTurn({
        threadId: "t1",
        input: [{ type: "text", text: "second turn" }],
        options: fullRuntimeOptions,
      });
      await wait(100);

      const userAcks = events.filter(
        (event) => event.type === "item/completed" && event.item.type === "userMessage",
      );
      expect(userAcks).toHaveLength(1);
      const userAck = userAcks[0];
      expect(userAck?.type).toBe("item/completed");
      if (userAck?.type !== "item/completed" || userAck.item.type !== "userMessage") {
        throw new Error("Expected synthetic userMessage ack");
      }
      expect(userAck.item.content).toEqual([{ type: "text", text: "second turn" }]);

      await runtime.shutdown();
    });

    it("preserves synthetic user acks when terminal turn events arrive before turn start", async () => {
      const events: ThreadEvent[] = [];
      const outOfOrderScriptPath = join(tmpDir, "out-of-order-provider.cjs");
      writeFileSync(
        outOfOrderScriptPath,
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
      method: "turn/completed",
      params: {
        threadId: message.params.threadId,
        providerThreadId: "prov-thread-1",
        turnId: "turn-out-of-order",
        status: "completed",
      },
    });
    send({
      jsonrpc: "2.0",
      method: "turn/started",
      params: {
        threadId: message.params.threadId,
        providerThreadId: "prov-thread-1",
        turnId: "turn-out-of-order",
      },
    });
  }
});
`,
        "utf8",
      );
      const runtime = createAgentRuntime({
        workspacePath: tmpDir,
        onEvent: (event) => events.push(event),
        onToolCall: async () => ({
          contentItems: [{ type: "inputText", text: "ok" }],
          success: true,
        }),
        adapterFactory: () =>
          createSharedFakeAdapter({
            id: "claude-code",
            scriptPath: outOfOrderScriptPath,
            syntheticUserMessageAcks: true,
          }),
      });

      await runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "claude-code",
        options: fullRuntimeOptions,
      });
      await runtime.runTurn({
        threadId: "t1",
        input: [{ type: "text", text: "out of order" }],
        options: fullRuntimeOptions,
      });
      await wait(100);

      const userAcks = events.filter(
        (event) => event.type === "item/completed" && event.item.type === "userMessage",
      );
      expect(userAcks).toHaveLength(1);
      const userAck = userAcks[0];
      expect(userAck?.type).toBe("item/completed");
      if (userAck?.type !== "item/completed" || userAck.item.type !== "userMessage") {
        throw new Error("Expected synthetic userMessage ack");
      }
      expect(userAck.turnId).toBe("turn-out-of-order");
      expect(userAck.item.content).toEqual([{ type: "text", text: "out of order" }]);

      await runtime.shutdown();
    });

    it("does not let late duplicate turn starts consume later synthetic user acks", async () => {
      const events: ThreadEvent[] = [];
      const stderrLines: string[] = [];
      const lateDuplicateStartScriptPath = join(
        tmpDir,
        "late-duplicate-start-provider.cjs",
      );
      writeFileSync(
        lateDuplicateStartScriptPath,
        `
const readline = require("node:readline");

let turnCount = 0;

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
    turnCount += 1;
    send({ jsonrpc: "2.0", id: message.id, result: { ok: true } });
    if (turnCount === 1) {
      send({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          threadId: message.params.threadId,
          providerThreadId: "prov-thread-1",
          turnId: "turn-1",
          status: "completed",
        },
      });
      setTimeout(() => {
        send({
          jsonrpc: "2.0",
          method: "turn/started",
          params: {
            threadId: message.params.threadId,
            providerThreadId: "prov-thread-1",
            turnId: "turn-1",
          },
        });
      }, 25);
      return;
    }
    setTimeout(() => {
      send({
        jsonrpc: "2.0",
        method: "turn/started",
        params: {
          threadId: message.params.threadId,
          providerThreadId: "prov-thread-1",
          turnId: "turn-2",
        },
      });
    }, 60);
    setTimeout(() => {
      send({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          threadId: message.params.threadId,
          providerThreadId: "prov-thread-1",
          turnId: "turn-2",
          status: "completed",
        },
      });
    }, 80);
  }
});
`,
        "utf8",
      );
      const runtime = createAgentRuntime({
        workspacePath: tmpDir,
        onEvent: (event) => events.push(event),
        onStderr: (line) => stderrLines.push(line),
        onToolCall: async () => ({
          contentItems: [{ type: "inputText", text: "ok" }],
          success: true,
        }),
        adapterFactory: () =>
          createSharedFakeAdapter({
            id: "claude-code",
            scriptPath: lateDuplicateStartScriptPath,
            syntheticUserMessageAcks: true,
          }),
      });

      await runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "claude-code",
        options: fullRuntimeOptions,
      });
      await runtime.runTurn({
        threadId: "t1",
        input: [{ type: "text", text: "first turn" }],
        options: fullRuntimeOptions,
      });
      await runtime.runTurn({
        threadId: "t1",
        input: [{ type: "text", text: "second turn" }],
        options: fullRuntimeOptions,
      });
      await waitForCondition(() =>
        events.filter(
          (event) => event.type === "item/completed" && event.item.type === "userMessage",
        ).length >= 2,
      );

      const userAcks = events.filter(
        (event) => event.type === "item/completed" && event.item.type === "userMessage",
      );
      expect(userAcks).toHaveLength(2);
      const firstAck = userAcks.find((event) =>
        event.type === "item/completed" &&
        event.item.type === "userMessage" &&
        event.item.content.some((content) =>
          content.type === "text" && content.text === "first turn",
        )
      );
      const secondAck = userAcks.find((event) =>
        event.type === "item/completed" &&
        event.item.type === "userMessage" &&
        event.item.content.some((content) =>
          content.type === "text" && content.text === "second turn",
        )
      );
      expect(firstAck?.type).toBe("item/completed");
      expect(secondAck?.type).toBe("item/completed");
      if (
        firstAck?.type !== "item/completed" ||
        firstAck.item.type !== "userMessage" ||
        secondAck?.type !== "item/completed" ||
        secondAck.item.type !== "userMessage"
      ) {
        throw new Error("Expected first and second synthetic userMessage acks");
      }
      expect(firstAck.turnId).toBe("turn-1");
      expect(secondAck.turnId).toBe("turn-2");
      expect(
        stderrLines.some((line) =>
          line.includes("Skipping synthetic user ack for turn/started"),
        ),
      ).toBe(true);

      await runtime.shutdown();
    });

  });

  describe("turn/steer acks", () => {
    it("emits synthetic provider user acks for Pi steer turns", async () => {
      const events: ThreadEvent[] = [];
      const runtime = createAgentRuntime({
        workspacePath: tmpDir,
        onEvent: (event) => events.push(event),
        onToolCall: async () => ({
          contentItems: [{ type: "inputText", text: "ok" }],
          success: true,
        }),
        adapterFactory: () =>
          createSharedFakeAdapter({
            id: "pi",
            scriptPath,
            syntheticUserMessageAcks: true,
          }),
      });

      await runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "pi",
        options: fullRuntimeOptions,
      });
      await runtime.runTurn({
        threadId: "t1",
        input: [{ type: "text", text: "delay:500" }],
        options: fullRuntimeOptions,
      });
      await waitForCondition(() =>
        events.some((event) => event.type === "turn/started" && event.turnId === "turn-1"),
      );
      await runtime.steerTurn({
        threadId: "t1",
        expectedTurnId: "turn-1",
        input: [{ type: "text", text: "steer input" }],
        options: fullRuntimeOptions,
      });
      await wait(100);

      const userAcks = events.filter(
        (event) => event.type === "item/completed" && event.item.type === "userMessage",
      );
      const userAck = userAcks.find(
        (event) =>
          event.type === "item/completed" &&
          event.item.type === "userMessage" &&
          event.item.content.some((content) =>
            content.type === "text" && content.text === "steer input",
          ),
      );
      expect(userAck?.type).toBe("item/completed");
      if (userAck?.type !== "item/completed" || userAck.item.type !== "userMessage") {
        throw new Error("Expected synthetic userMessage ack");
      }
      expect(userAck.turnId).toBe("turn-1");
      expect(userAck.item.content).toEqual([{ type: "text", text: "steer input" }]);

      await runtime.shutdown();
    });

    it("emits a steer ack when turn completion arrives before the steer response", async () => {
      const events: ThreadEvent[] = [];
      const completionBeforeSteerResponseScriptPath = join(
        tmpDir,
        "completion-before-steer-response-provider.cjs",
      );
      writeFileSync(
        completionBeforeSteerResponseScriptPath,
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
      method: "turn/completed",
      params: {
        threadId: message.params.threadId,
        providerThreadId: "prov-thread-1",
        turnId: message.params.expectedTurnId,
        status: "completed",
      },
    });
    setTimeout(() => {
      send({ jsonrpc: "2.0", id: message.id, result: { ok: true } });
    }, 25);
  }
});
`,
        "utf8",
      );
      const runtime = createAgentRuntime({
        workspacePath: tmpDir,
        onEvent: (event) => events.push(event),
        onToolCall: async () => ({
          contentItems: [{ type: "inputText", text: "ok" }],
          success: true,
        }),
        adapterFactory: () =>
          createSharedFakeAdapter({
            id: "pi",
            scriptPath: completionBeforeSteerResponseScriptPath,
            syntheticUserMessageAcks: true,
          }),
      });

      await runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "pi",
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
        input: [{ type: "text", text: "completion race steer" }],
        options: fullRuntimeOptions,
      });

      const raceAck = events.find(
        (event) =>
          event.type === "item/completed" &&
          event.item.type === "userMessage" &&
          event.item.content.some((content) =>
            content.type === "text" && content.text === "completion race steer",
          ),
      );
      expect(raceAck?.type).toBe("item/completed");
      if (raceAck?.type !== "item/completed" || raceAck.item.type !== "userMessage") {
        throw new Error("Expected steer userMessage ack after completion race");
      }
      expect(raceAck.turnId).toBe("turn-1");

      await runtime.shutdown();
    });

    it("treats steers for already-completed turns as stale no-ops", async () => {
      const builtCommands: AdapterCommand[] = [];
      const events: ThreadEvent[] = [];
      const stderrLines: string[] = [];
      const baseAdapter = createSharedFakeAdapter({
        id: "pi",
        scriptPath,
        syntheticUserMessageAcks: true,
      });
      const runtime = createAgentRuntime({
        workspacePath: tmpDir,
        onEvent: (event) => events.push(event),
        onStderr: (line) => stderrLines.push(line),
        onToolCall: async () => ({
          contentItems: [{ type: "inputText", text: "ok" }],
          success: true,
        }),
        adapterFactory: () => ({
          ...baseAdapter,
          buildCommand(command) {
            builtCommands.push(command);
            return baseAdapter.buildCommand(command);
          },
        }),
      });

      await runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "pi",
        options: fullRuntimeOptions,
      });
      await runtime.runTurn({
        threadId: "t1",
        input: [{ type: "text", text: "complete quickly" }],
        options: fullRuntimeOptions,
      });
      await waitForCondition(() =>
        events.some((event) => event.type === "turn/completed" && event.turnId === "turn-1"),
      );

      await runtime.steerTurn({
        threadId: "t1",
        expectedTurnId: "turn-1",
        input: [{ type: "text", text: "late stale steer" }],
        options: fullRuntimeOptions,
      });

      expect(builtCommands.some((command) => command.type === "turn/steer")).toBe(false);
      expect(stderrLines.some((line) => line.includes("Ignoring stale steer"))).toBe(true);
      const staleAcks = events.filter(
        (event) =>
          event.type === "item/completed" &&
          event.item.type === "userMessage" &&
          event.item.content.some((content) =>
            content.type === "text" && content.text === "late stale steer",
          ),
      );
      expect(staleAcks).toHaveLength(0);

      await runtime.shutdown();
    });

    it("emits separate acks for duplicate concurrent steers on the same turn", async () => {
      const events: ThreadEvent[] = [];
      const runtime = createAgentRuntime({
        workspacePath: tmpDir,
        onEvent: (event) => events.push(event),
        onToolCall: async () => ({
          contentItems: [{ type: "inputText", text: "ok" }],
          success: true,
        }),
        adapterFactory: () =>
          createSharedFakeAdapter({
            id: "pi",
            scriptPath,
            syntheticUserMessageAcks: true,
          }),
      });

      await runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "pi",
        options: fullRuntimeOptions,
      });
      await runtime.runTurn({
        threadId: "t1",
        input: [{ type: "text", text: "delay:500" }],
        options: fullRuntimeOptions,
      });
      await waitForCondition(() =>
        events.some((event) => event.type === "turn/started" && event.turnId === "turn-1"),
      );

      await Promise.all([
        runtime.steerTurn({
          threadId: "t1",
          expectedTurnId: "turn-1",
          input: [{ type: "text", text: "duplicate steer" }],
          options: fullRuntimeOptions,
        }),
        runtime.steerTurn({
          threadId: "t1",
          expectedTurnId: "turn-1",
          input: [{ type: "text", text: "duplicate steer" }],
          options: fullRuntimeOptions,
        }),
      ]);

      const duplicateAcks = events.filter(
        (event) =>
          event.type === "item/completed" &&
          event.item.type === "userMessage" &&
          event.item.content.some((content) =>
            content.type === "text" && content.text === "duplicate steer",
          ),
      );
      expect(duplicateAcks).toHaveLength(2);

      await runtime.shutdown();
    });

    it("does not emit synthetic steer acks when the provider rejects the steer", async () => {
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
      const runtime = createAgentRuntime({
        workspacePath: tmpDir,
        onEvent: (event) => events.push(event),
        onToolCall: async () => ({
          contentItems: [{ type: "inputText", text: "ok" }],
          success: true,
        }),
        adapterFactory: () =>
          createSharedFakeAdapter({
            id: "pi",
            scriptPath: rejectingSteerScriptPath,
            syntheticUserMessageAcks: true,
          }),
      });

      await runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "pi",
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

      const rejectedSteerAcks = events.filter(
        (event) =>
          event.type === "item/completed" &&
          event.item.type === "userMessage" &&
          event.item.content.some((content) =>
            content.type === "text" && content.text === "rejected steer",
          ),
      );
      expect(rejectedSteerAcks).toHaveLength(0);

      await runtime.shutdown();
    });

  });
});
