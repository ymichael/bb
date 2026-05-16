import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PendingInteractionResolution,
  ThreadEvent,
  ToolCallResponse,
} from "@bb/domain";
import type { AgentRuntimeCaptureEntry } from "./capture-types.js";
import type { DecodedInteractiveRequest } from "./provider-adapter.js";
import { createAgentRuntimeWithAdapters } from "./runtime.js";
import { handleRuntimeProviderRequest } from "./runtime-provider-requests.js";
import {
  parseJsonRpcLine,
  type JsonRpcMessage,
  type ProviderInboundRequest,
} from "./runtime-json-rpc.js";
import {
  createInteractiveRequestAdapter,
  createInvalidInteractiveRequestAdapter,
  fullRuntimeOptions,
  waitForRuntimeState,
  waitForThreadAgentMessageText,
} from "./test/runtime-test-harness.js";

type ChildStdoutChunk = Buffer | string;

function readChildStdoutLine(child: ChildProcess): Promise<string> {
  if (!child.stdout) {
    throw new Error("Expected child stdout to be readable");
  }
  const stdout = child.stdout;
  return new Promise((resolve) => {
    stdout.once("data", (chunk: ChildStdoutChunk) => {
      resolve(String(chunk));
    });
  });
}

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

    const requests: Array<{
      threadId: string;
      providerThreadId: string;
      turnId: string;
    }> = [];
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
          turnId: request.turnId,
        });
        return {
          decision: "allow_for_session",
          grantedPermissions: null,
        };
      },
      adapterFactory: () => {
        const adapter = createInteractiveRequestAdapter(interactiveScriptPath);
        return {
          ...adapter,
          decodeInteractiveRequest(request) {
            const decoded = adapter.decodeInteractiveRequest?.(request);
            return decoded ? { ...decoded, turnId: null } : null;
          },
        };
      },
    });

    await runtime.startThread({
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerId: "fake",
      options: fullRuntimeOptions,
    });
    await runtime.runTurn({
      clientRequestId: "creq_222222224i",
      threadId: "t1",
      input: [{ type: "text", text: "trigger interactive request" }],
      options: fullRuntimeOptions,
    });
    await waitForRuntimeState({
      events,
      label: "interactive request handled",
      predicate: () =>
        requests.length === 1 &&
        events.some(
          (event) =>
            event.type === "item/completed" &&
            event.item.type === "agentMessage" &&
            event.item.text === "interactive:allow_for_session",
        ),
      providerId: "fake",
      runtime,
      threadId: "t1",
    });

    expect(requests).toEqual([
      {
        threadId: "t1",
        providerThreadId: "prov-1",
        turnId: "turn-1",
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

  it("drops unresolved interactive requests when no active turn is known", async () => {
    const child = spawn(process.execPath, [
      "-e",
      "process.stdin.pipe(process.stdout)",
    ]);
    const baseAdapter = createInteractiveRequestAdapter(
      join(tmpDir, "unused-interactive-provider.cjs"),
    );
    const adapter = {
      ...baseAdapter,
      decodeInteractiveRequest(
        request: ProviderInboundRequest,
      ): DecodedInteractiveRequest | null {
        const decoded = baseAdapter.decodeInteractiveRequest?.(request);
        return decoded ? { ...decoded, turnId: null } : null;
      },
    };
    const captures: AgentRuntimeCaptureEntry[] = [];
    const interactionResolution = {
      decision: "deny",
    } satisfies PendingInteractionResolution;
    const toolCallResponse = {
      contentItems: [{ type: "inputText", text: "tool result" }],
      success: true,
    } satisfies ToolCallResponse;
    const onInteractiveRequest = vi.fn(async () => interactionResolution);
    const rawRequest = {
      jsonrpc: "2.0",
      id: 77,
      method: "request_interaction",
      params: {
        threadId: "prov-1",
        turnId: "provider-turn-1",
        itemId: "item-1",
        kind: "command_approval",
        command: "git push",
        cwd: "/tmp/project",
        reason: "Needs approval",
      },
    } satisfies JsonRpcMessage;

    try {
      handleRuntimeProviderRequest({
        createCaptureId: () => "cap-1",
        emitCapture: (entry) => captures.push(entry),
        getActiveTurnId: () => undefined,
        getThreadExecutionOptions: () => undefined,
        line: JSON.stringify(rawRequest),
        onInteractiveRequest,
        onToolCall: async () => toolCallResponse,
        parsedId: rawRequest.id,
        parsedMethod: rawRequest.method,
        providerProcess: {
          adapter,
          child,
          interactiveRequestScope: "scope-1",
        },
        rawRequest,
        resolveThreadId: () => "t1",
      });

      const parsed = parseJsonRpcLine((await readChildStdoutLine(child)).trim());
      if (parsed.kind !== "response") {
        throw new Error(`Expected JSON-RPC response, got ${parsed.kind}`);
      }
      expect(parsed.parsed).toMatchObject({
        jsonrpc: "2.0",
        id: 77,
        error: {
          code: -32000,
          message: expect.stringContaining("without a turn id"),
        },
      });
      expect(onInteractiveRequest).not.toHaveBeenCalled();
      expect(
        captures.filter(
          (entry) =>
            entry.kind === "interactive-request" ||
            entry.kind === "interactive-result",
        ),
      ).toHaveLength(0);
    } finally {
      child.kill();
    }
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
      adapterFactory: () =>
        createInteractiveRequestAdapter(interactiveScriptPath),
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
      clientRequestId: "creq_222222224j",
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

  it("routes user-question interactive requests through the handler when permission escalation is deny", async () => {
    const child = spawn(process.execPath, [
      "-e",
      "process.stdin.pipe(process.stdout)",
    ]);
    const baseAdapter = createInteractiveRequestAdapter(
      join(tmpDir, "unused-user-question-provider.cjs"),
    );
    const adapter = {
      ...baseAdapter,
      decodeInteractiveRequest(
        request: ProviderInboundRequest,
      ): DecodedInteractiveRequest | null {
        if (request.method !== "request_user_question") {
          return null;
        }
        if (typeof request.id !== "string" && typeof request.id !== "number") {
          return null;
        }
        return {
          requestId: request.id,
          method: request.method,
          providerThreadId: "prov-1",
          turnId: "turn-1",
          payload: {
            kind: "user_question",
            questions: [
              {
                id: "q1",
                prompt: "Which deployment target?",
                shortLabel: "Target",
                multiSelect: false,
                options: [{ value: "staging", label: "Staging" }],
                allowFreeText: true,
              },
            ],
          },
        };
      },
    };
    const captures: AgentRuntimeCaptureEntry[] = [];
    const userAnswerResolution: PendingInteractionResolution = {
      kind: "user_answer",
      answers: {
        q1: {
          selected: ["staging"],
        },
      },
    };
    const onInteractiveRequest = vi.fn(async () => userAnswerResolution);
    const rawRequest = {
      jsonrpc: "2.0",
      id: 78,
      method: "request_user_question",
      params: {},
    } satisfies JsonRpcMessage;

    try {
      handleRuntimeProviderRequest({
        createCaptureId: () => "cap-user-question",
        emitCapture: (entry) => captures.push(entry),
        getActiveTurnId: () => undefined,
        getThreadExecutionOptions: () => ({
          ...fullRuntimeOptions,
          permissionMode: "readonly",
          permissionEscalation: "deny",
        }),
        line: JSON.stringify(rawRequest),
        onInteractiveRequest,
        onToolCall: async () => ({
          contentItems: [{ type: "inputText", text: "tool result" }],
          success: true,
        }),
        parsedId: rawRequest.id,
        parsedMethod: rawRequest.method,
        providerProcess: {
          adapter,
          child,
          interactiveRequestScope: "scope-1",
        },
        rawRequest,
        resolveThreadId: () => "t1",
      });

      const parsed = parseJsonRpcLine((await readChildStdoutLine(child)).trim());
      if (parsed.kind !== "response") {
        throw new Error(`Expected JSON-RPC response, got ${parsed.kind}`);
      }
      expect(parsed.parsed).toMatchObject({
        jsonrpc: "2.0",
        id: 78,
        result: {
          resolution: {
            kind: "user_answer",
            answers: {
              q1: {
                selected: ["staging"],
              },
            },
          },
        },
      });
      expect(onInteractiveRequest).toHaveBeenCalledTimes(1);
      expect(captures).toContainEqual(
        expect.objectContaining({
          kind: "interactive-result",
          success: true,
        }),
      );
    } finally {
      child.kill();
    }
  });

  it("sends a provider error for user-question interactive requests without a handler", async () => {
    const child = spawn(process.execPath, [
      "-e",
      "process.stdin.pipe(process.stdout)",
    ]);
    const baseAdapter = createInteractiveRequestAdapter(
      join(tmpDir, "unused-missing-user-question-handler.cjs"),
    );
    const adapter = {
      ...baseAdapter,
      decodeInteractiveRequest(
        request: ProviderInboundRequest,
      ): DecodedInteractiveRequest | null {
        if (request.method !== "request_user_question") {
          return null;
        }
        if (typeof request.id !== "string" && typeof request.id !== "number") {
          return null;
        }
        return {
          requestId: request.id,
          method: request.method,
          providerThreadId: "prov-1",
          turnId: "turn-1",
          payload: {
            kind: "user_question",
            questions: [
              {
                id: "q1",
                prompt: "Which deployment target?",
                shortLabel: "Target",
                multiSelect: false,
                options: [{ value: "staging", label: "Staging" }],
                allowFreeText: true,
              },
            ],
          },
        };
      },
    };
    const captures: AgentRuntimeCaptureEntry[] = [];
    const rawRequest = {
      jsonrpc: "2.0",
      id: 79,
      method: "request_user_question",
      params: {},
    } satisfies JsonRpcMessage;

    try {
      handleRuntimeProviderRequest({
        createCaptureId: () => "cap-missing-user-question-handler",
        emitCapture: (entry) => captures.push(entry),
        getActiveTurnId: () => undefined,
        getThreadExecutionOptions: () => undefined,
        line: JSON.stringify(rawRequest),
        onInteractiveRequest: undefined,
        onToolCall: async () => ({
          contentItems: [{ type: "inputText", text: "tool result" }],
          success: true,
        }),
        parsedId: rawRequest.id,
        parsedMethod: rawRequest.method,
        providerProcess: {
          adapter,
          child,
          interactiveRequestScope: "scope-1",
        },
        rawRequest,
        resolveThreadId: () => "t1",
      });

      const parsed = parseJsonRpcLine((await readChildStdoutLine(child)).trim());
      if (parsed.kind !== "response") {
        throw new Error(`Expected JSON-RPC response, got ${parsed.kind}`);
      }
      expect(parsed.parsed).toMatchObject({
        jsonrpc: "2.0",
        id: 79,
        error: {
          code: -32000,
          message: expect.stringContaining(
            "No interactive request handler is configured",
          ),
        },
      });
      expect(captures).toContainEqual(
        expect.objectContaining({
          kind: "interactive-result",
          success: false,
          errorMessage: expect.stringContaining(
            "No interactive request handler is configured",
          ),
        }),
      );
    } finally {
      child.kill();
    }
  });

  it("sends JSON-RPC error back when onInteractiveRequest throws", async () => {
    const interactiveScriptPath = join(
      tmpDir,
      "interactive-error-provider.cjs",
    );
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
      adapterFactory: () =>
        createInteractiveRequestAdapter(interactiveScriptPath),
    });

    await runtime.startThread({
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerId: "fake",
      options: fullRuntimeOptions,
    });
    await runtime.runTurn({
      clientRequestId: "creq_222222224k",
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
    const unsupportedScriptPath = join(
      tmpDir,
      "unsupported-interactive-provider.cjs",
    );
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
      adapterFactory: () =>
        createInteractiveRequestAdapter(unsupportedScriptPath),
    });

    await runtime.startThread({
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerId: "fake",
      options: fullRuntimeOptions,
    });
    await runtime.runTurn({
      clientRequestId: "creq_222222224m",
      threadId: "t1",
      input: [
        { type: "text", text: "trigger unsupported interactive request" },
      ],
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
      adapterFactory: () =>
        createInvalidInteractiveRequestAdapter(invalidScriptPath),
    });

    await runtime.startThread({
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerId: "fake",
      options: fullRuntimeOptions,
    });
    await runtime.runTurn({
      clientRequestId: "creq_222222224n",
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
