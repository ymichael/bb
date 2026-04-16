import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ThreadEvent } from "@bb/domain";
import { createAgentRuntimeWithAdapters } from "./runtime.js";
import {
  createInteractiveRequestAdapter,
  createInvalidInteractiveRequestAdapter,
  fullRuntimeOptions,
  waitForRuntimeState,
  waitForThreadAgentMessageText,
} from "./test/runtime-test-harness.js";

describe("createAgentRuntime interactive requests", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "bb-runtime-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("routes interactive requests through onInteractiveRequest and sends the encoded response back", async () => {
    const interactiveScriptPath = join(tmpDir, "interactive-provider.cjs");
    writeFileSync(
      interactiveScriptPath,
      `
const readline = require("node:readline");
const threads = new Map();
const pendingInteractive = new Map();
let nextThreadId = 1;
let nextRequestId = 1;

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function completeTurn(providerThreadId, turnId, text) {
  send({
    jsonrpc: "2.0",
    method: "item/completed",
    params: {
      threadId: providerThreadId,
      turnId,
      item: {
        type: "agentMessage",
        id: "msg-" + turnId,
        text,
      },
    },
  });
  send({
    jsonrpc: "2.0",
    method: "turn/completed",
    params: {
      threadId: providerThreadId,
      turnId,
      status: "completed",
      providerThreadId,
    },
  });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);

  if (message.id !== undefined && !message.method) {
    const pending = pendingInteractive.get(message.id);
    if (!pending) {
      return;
    }
    pendingInteractive.delete(message.id);
    const decision =
      message.result && message.result.resolution
        ? message.result.resolution.decision
        : "unknown";
    completeTurn(pending.providerThreadId, pending.turnId, "interactive:" + decision);
    return;
  }

  if (message.method === "initialize" || message.method === "model/list") {
    send({ jsonrpc: "2.0", id: message.id, result: message.method === "model/list" ? [] : {} });
    return;
  }

  if (message.method === "thread/start") {
    const threadId = message.params.threadId;
    const providerThreadId = "prov-" + String(nextThreadId++);
    threads.set(threadId, { providerThreadId, turnCount: 0 });
    send({ jsonrpc: "2.0", id: message.id, result: { providerThreadId } });
    send({ jsonrpc: "2.0", method: "thread/identity", params: { threadId, providerThreadId } });
    return;
  }

  if (message.method === "turn/start") {
    const threadId = message.params.threadId;
    const providerThreadId = message.params.providerThreadId || threadId;
    const thread = threads.get(threadId);
    thread.turnCount += 1;
    const turnId = "turn-" + String(thread.turnCount);
    send({
      jsonrpc: "2.0",
      method: "turn/started",
      params: { threadId: providerThreadId, turnId, providerThreadId },
    });
    send({ jsonrpc: "2.0", id: message.id, result: { ok: true } });
    const requestId = nextRequestId++;
    pendingInteractive.set(requestId, { providerThreadId, turnId });
    send({
      jsonrpc: "2.0",
      id: requestId,
      method: "request_interaction",
      params: {
        threadId: providerThreadId,
        turnId,
        itemId: "item-1",
        kind: "command_approval",
        command: "git push",
        cwd: "/tmp/project",
        reason: "Needs approval",
      },
    });
  }
});
`,
      "utf8",
    );

    const requests: Array<{ threadId: string; providerThreadId: string }> = [];
    const events: ThreadEvent[] = [];
    const runtime = createAgentRuntimeWithAdapters({
      workspacePath: tmpDir,
      onEvent: (event) => events.push(event),
      onToolCall: async () => ({
        contentItems: [{ type: "inputText", text: "ok" }],
        success: true,
      }),
      onInteractiveRequest: async (request) => {
        requests.push({
          threadId: request.threadId,
          providerThreadId: request.providerThreadId,
        });
        return {
          decision: "allow_for_session",
          grantedPermissions: null,
        };
      },
      adapterFactory: () => createInteractiveRequestAdapter(interactiveScriptPath),
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
      input: [{ type: "text", text: "trigger interactive request" }],
      options: fullRuntimeOptions,
    });
    await waitForRuntimeState({
      events,
      label: "interactive request handled",
      predicate: () =>
        requests.length === 1
        && events.some(
          (event) =>
            event.type === "item/completed"
            && event.item.type === "agentMessage"
            && event.item.text === "interactive:allow_for_session",
        ),
      providerId: "fake",
      runtime,
      threadId: "t1",
    });

    expect(requests).toEqual([
      {
        threadId: "t1",
        providerThreadId: "prov-1",
      },
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "agentMessage",
          text: "interactive:allow_for_session",
        }),
      }),
    );
    await runtime.shutdown();
  });

  it("denies interactive requests when permission escalation is deny", async () => {
    const interactiveScriptPath = join(tmpDir, "interactive-deny-provider.cjs");
    writeFileSync(
      interactiveScriptPath,
      `
const readline = require("node:readline");
let nextThreadId = 1;
let nextRequestId = 1;
const threads = new Map();
const pendingInteractive = new Map();

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function completeTurn(providerThreadId, turnId, text) {
  send({
    jsonrpc: "2.0",
    method: "item/completed",
    params: {
      threadId: providerThreadId,
      turnId,
      item: { type: "agentMessage", id: "msg-" + turnId, text },
    },
  });
  send({
    jsonrpc: "2.0",
    method: "turn/completed",
    params: { threadId: providerThreadId, turnId, status: "completed", providerThreadId },
  });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);

  if (message.id !== undefined && !message.method) {
    const pending = pendingInteractive.get(message.id);
    if (!pending) return;
    pendingInteractive.delete(message.id);
    const decision =
      message.result && message.result.resolution
        ? message.result.resolution.decision
        : "unknown";
    completeTurn(pending.providerThreadId, pending.turnId, "interactive:" + decision);
    return;
  }

  if (message.method === "initialize" || message.method === "model/list") {
    send({ jsonrpc: "2.0", id: message.id, result: message.method === "model/list" ? [] : {} });
    return;
  }

  if (message.method === "thread/start") {
    const threadId = message.params.threadId;
    const providerThreadId = "prov-" + String(nextThreadId++);
    threads.set(threadId, { providerThreadId, turnCount: 0 });
    send({ jsonrpc: "2.0", id: message.id, result: { providerThreadId } });
    send({ jsonrpc: "2.0", method: "thread/identity", params: { threadId, providerThreadId } });
    return;
  }

  if (message.method === "thread/resume") {
    send({ jsonrpc: "2.0", id: message.id, result: { providerThreadId: message.params.threadId } });
    return;
  }

  if (message.method === "turn/start") {
    const providerThreadId = message.params.providerThreadId || message.params.threadId;
    const thread = threads.get(message.params.threadId);
    thread.turnCount += 1;
    const turnId = "turn-" + String(thread.turnCount);
    send({
      jsonrpc: "2.0",
      method: "turn/started",
      params: { threadId: providerThreadId, turnId, providerThreadId },
    });
    send({ jsonrpc: "2.0", id: message.id, result: { ok: true } });
    const requestId = nextRequestId++;
    pendingInteractive.set(requestId, { providerThreadId, turnId });
    send({
      jsonrpc: "2.0",
      id: requestId,
      method: "request_interaction",
      params: {
        threadId: providerThreadId,
        turnId,
        itemId: "item-deny",
        kind: "command_approval",
        command: "git push",
        cwd: "/tmp/project",
        reason: "Needs approval",
      },
    });
  }
});
`,
      "utf8",
    );

    const requests: string[] = [];
    const events: ThreadEvent[] = [];
    const runtime = createAgentRuntimeWithAdapters({
      workspacePath: tmpDir,
      onEvent: (event) => events.push(event),
      onToolCall: async () => ({
        contentItems: [{ type: "inputText", text: "ok" }],
        success: true,
      }),
      onInteractiveRequest: async (request) => {
        requests.push(request.providerRequestId);
        return {
          decision: "allow_once",
          grantedPermissions: null,
        };
      },
      adapterFactory: () => createInteractiveRequestAdapter(interactiveScriptPath),
    });

    await runtime.startThread({
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerId: "fake",
      options: {
        ...fullRuntimeOptions,
        permissionMode: "readonly",
        permissionEscalation: "deny",
      },
    });
    await runtime.runTurn({
      threadId: "t1",
      input: [{ type: "text", text: "trigger denied interactive request" }],
      options: {
        ...fullRuntimeOptions,
        permissionMode: "readonly",
        permissionEscalation: "deny",
      },
    });
    await waitForThreadAgentMessageText({
      events,
      providerId: "fake",
      runtime,
      text: "interactive:deny",
      threadId: "t1",
    });

    expect(requests).toEqual([]);
    await runtime.shutdown();
  });

  it("sends JSON-RPC error back when onInteractiveRequest throws", async () => {
    const interactiveScriptPath = join(tmpDir, "interactive-error-provider.cjs");
    writeFileSync(
      interactiveScriptPath,
      `
const readline = require("node:readline");
const threads = new Map();
const pendingInteractive = new Map();
let nextThreadId = 1;
let nextRequestId = 1;

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function completeTurn(providerThreadId, turnId, text) {
  send({
    jsonrpc: "2.0",
    method: "item/completed",
    params: {
      threadId: providerThreadId,
      turnId,
      item: { type: "agentMessage", id: "msg-" + turnId, text },
    },
  });
  send({
    jsonrpc: "2.0",
    method: "turn/completed",
    params: {
      threadId: providerThreadId,
      turnId,
      status: "completed",
      providerThreadId,
    },
  });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);

  if (message.id !== undefined && !message.method) {
    const pending = pendingInteractive.get(message.id);
    if (!pending) {
      return;
    }
    pendingInteractive.delete(message.id);
    completeTurn(
      pending.providerThreadId,
      pending.turnId,
      message.error ? message.error.message : "missing error",
    );
    return;
  }

  if (message.method === "initialize" || message.method === "model/list") {
    send({ jsonrpc: "2.0", id: message.id, result: message.method === "model/list" ? [] : {} });
    return;
  }

  if (message.method === "thread/start") {
    const threadId = message.params.threadId;
    const providerThreadId = "prov-" + String(nextThreadId++);
    threads.set(threadId, { providerThreadId, turnCount: 0 });
    send({ jsonrpc: "2.0", id: message.id, result: { providerThreadId } });
    send({ jsonrpc: "2.0", method: "thread/identity", params: { threadId, providerThreadId } });
    return;
  }

  if (message.method === "turn/start") {
    const threadId = message.params.threadId;
    const providerThreadId = message.params.providerThreadId || threadId;
    const thread = threads.get(threadId);
    thread.turnCount += 1;
    const turnId = "turn-" + String(thread.turnCount);
    send({
      jsonrpc: "2.0",
      method: "turn/started",
      params: { threadId: providerThreadId, turnId, providerThreadId },
    });
    send({ jsonrpc: "2.0", id: message.id, result: { ok: true } });
    const requestId = nextRequestId++;
    pendingInteractive.set(requestId, { providerThreadId, turnId });
    send({
      jsonrpc: "2.0",
      id: requestId,
      method: "request_interaction",
      params: {
        threadId: providerThreadId,
        turnId,
        itemId: "item-error",
        kind: "command_approval",
        command: "git push",
        cwd: "/tmp/project",
        reason: "Needs approval",
      },
    });
  }
});
`,
      "utf8",
    );

    const events: ThreadEvent[] = [];
    const runtime = createAgentRuntimeWithAdapters({
      workspacePath: tmpDir,
      onEvent: (event) => events.push(event),
      onToolCall: async () => ({
        contentItems: [{ type: "inputText", text: "ok" }],
        success: true,
      }),
      onInteractiveRequest: async () => {
        throw new Error("Interaction failed");
      },
      adapterFactory: () => createInteractiveRequestAdapter(interactiveScriptPath),
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
      input: [{ type: "text", text: "trigger interactive request failure" }],
      options: fullRuntimeOptions,
    });
    await waitForThreadAgentMessageText({
      events,
      providerId: "fake",
      runtime,
      text: "Interaction failed",
      threadId: "t1",
    });

    await runtime.shutdown();
  });

  it("responds to unsupported interactive requests with a JSON-RPC error instead of dropping them", async () => {
    const unsupportedScriptPath = join(tmpDir, "unsupported-interactive-provider.cjs");
    writeFileSync(
      unsupportedScriptPath,
      `
const readline = require("node:readline");
const threads = new Map();
const pendingInteractive = new Map();
let nextThreadId = 1;
let nextRequestId = 1;

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function completeTurn(providerThreadId, turnId, text) {
  send({
    jsonrpc: "2.0",
    method: "item/completed",
    params: {
      threadId: providerThreadId,
      turnId,
      item: {
        type: "agentMessage",
        id: "msg-" + turnId,
        text,
      },
    },
  });
  send({
    jsonrpc: "2.0",
    method: "turn/completed",
    params: {
      threadId: providerThreadId,
      turnId,
      status: "completed",
      providerThreadId,
    },
  });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);

  if (message.id !== undefined && !message.method) {
    const pending = pendingInteractive.get(message.id);
    if (!pending) {
      return;
    }
    pendingInteractive.delete(message.id);
    const errorMessage = message.error ? message.error.message : "missing error";
    completeTurn(pending.providerThreadId, pending.turnId, errorMessage);
    return;
  }

  if (message.method === "initialize" || message.method === "model/list") {
    send({ jsonrpc: "2.0", id: message.id, result: message.method === "model/list" ? [] : {} });
    return;
  }

  if (message.method === "thread/start") {
    const threadId = message.params.threadId;
    const providerThreadId = "prov-" + String(nextThreadId++);
    threads.set(threadId, { providerThreadId, turnCount: 0 });
    send({ jsonrpc: "2.0", id: message.id, result: { providerThreadId } });
    send({ jsonrpc: "2.0", method: "thread/identity", params: { threadId, providerThreadId } });
    return;
  }

  if (message.method === "turn/start") {
    const threadId = message.params.threadId;
    const providerThreadId = message.params.providerThreadId || threadId;
    const thread = threads.get(threadId);
    thread.turnCount += 1;
    const turnId = "turn-" + String(thread.turnCount);
    send({
      jsonrpc: "2.0",
      method: "turn/started",
      params: { threadId: providerThreadId, turnId, providerThreadId },
    });
    send({ jsonrpc: "2.0", id: message.id, result: { ok: true } });
    const requestId = nextRequestId++;
    pendingInteractive.set(requestId, { providerThreadId, turnId });
    send({
      jsonrpc: "2.0",
      id: requestId,
      method: "request_unsupported",
      params: {
        threadId: providerThreadId,
        turnId,
        itemId: "item-unsupported",
      },
    });
  }
});
`,
      "utf8",
    );

    const events: ThreadEvent[] = [];
    const runtime = createAgentRuntimeWithAdapters({
      workspacePath: tmpDir,
      onEvent: (event) => events.push(event),
      onToolCall: async () => ({
        contentItems: [{ type: "inputText", text: "ok" }],
        success: true,
      }),
      adapterFactory: () => createInteractiveRequestAdapter(unsupportedScriptPath),
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
      input: [{ type: "text", text: "trigger unsupported interactive request" }],
      options: fullRuntimeOptions,
    });
    await waitForThreadAgentMessageText({
      events,
      providerId: "fake",
      runtime,
      text: 'Unsupported provider request "request_unsupported"',
      threadId: "t1",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "agentMessage",
          text: 'Unsupported provider request "request_unsupported"',
        }),
      }),
    );
    await runtime.shutdown();
  });

  it("responds to invalid interactive request params with a JSON-RPC invalid params error", async () => {
    const invalidScriptPath = join(tmpDir, "invalid-interactive-provider.cjs");
    writeFileSync(
      invalidScriptPath,
      `
const readline = require("node:readline");
let pendingInteractive = null;

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function completeTurn(text) {
  send({
    jsonrpc: "2.0",
    method: "item/completed",
    params: {
      threadId: "prov-t1",
      turnId: "turn-1",
      item: {
        type: "agentMessage",
        id: "msg-turn-1",
        text,
      },
    },
  });
  send({
    jsonrpc: "2.0",
    method: "turn/completed",
    params: {
      threadId: "prov-t1",
      turnId: "turn-1",
      status: "completed",
      providerThreadId: "prov-t1",
    },
  });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);

  if (message.id !== undefined && !message.method) {
    if (!pendingInteractive || pendingInteractive !== message.id) {
      return;
    }
    pendingInteractive = null;
    completeTurn(String(message.error && message.error.code));
    return;
  }

  if (message.method === "initialize" || message.method === "model/list") {
    send({ jsonrpc: "2.0", id: message.id, result: message.method === "model/list" ? [] : {} });
    return;
  }

  if (message.method === "thread/start") {
    send({ jsonrpc: "2.0", id: message.id, result: { providerThreadId: "prov-t1" } });
    send({ jsonrpc: "2.0", method: "thread/identity", params: { threadId: message.params.threadId, providerThreadId: "prov-t1" } });
    return;
  }

  if (message.method === "turn/start") {
    send({ jsonrpc: "2.0", id: message.id, result: { ok: true } });
    send({
      jsonrpc: "2.0",
      method: "turn/started",
      params: { threadId: "prov-t1", turnId: "turn-1", providerThreadId: "prov-t1" },
    });
    pendingInteractive = 101;
    send({
      jsonrpc: "2.0",
      id: pendingInteractive,
      method: "request_interaction",
      params: { broken: true },
    });
  }
});
`,
      "utf8",
    );

    const events: ThreadEvent[] = [];
    const runtime = createAgentRuntimeWithAdapters({
      workspacePath: tmpDir,
      onEvent: (event) => events.push(event),
      onToolCall: async () => ({
        contentItems: [{ type: "inputText", text: "ok" }],
        success: true,
      }),
      adapterFactory: () => createInvalidInteractiveRequestAdapter(invalidScriptPath),
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
      input: [{ type: "text", text: "trigger invalid interactive request" }],
      options: fullRuntimeOptions,
    });
    await waitForThreadAgentMessageText({
      events,
      providerId: "fake",
      runtime,
      text: "-32602",
      threadId: "t1",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "agentMessage",
          text: "-32602",
        }),
      }),
    );
    await runtime.shutdown();
  });

});
