import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PendingInteractionCreate,
  PendingInteractionResolution,
  ThreadEvent,
} from "@bb/domain";
import { promptTextInput } from "./test/prompt-input.js";
import { parseJsonRpcLine } from "@bb/provider-bridge-protocol/bridge-kit";
import type { JsonRpcMessage } from "@bb/provider-bridge-protocol/bridge-kit";
import { createProviderForId } from "./provider-registry.js";
import { handleRuntimeProviderRequest } from "./runtime-provider-requests.js";
import {
  createScriptedEchoLaunch,
  createScriptedEchoRuntime,
  fullRuntimeOptions,
  scriptedEchoProcessEnv,
  waitForThreadAgentMessageText,
  waitForThreadTurnCompleted,
  waitForThreadTurnStarted,
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

function commandApprovalRequest(
  id: number,
  overrides: { turnId?: string | null } = {},
): JsonRpcMessage {
  return {
    jsonrpc: "2.0",
    id,
    method: "interaction/request",
    params: {
      providerThreadId: "prov-1",
      threadId: "t1",
      turnId: overrides.turnId === undefined ? "turn-1" : overrides.turnId,
      payload: {
        kind: "approval",
        subject: {
          kind: "command",
          itemId: "item-1",
          command: "git push",
          cwd: "/tmp/project",
          actions: [],
          sessionGrant: null,
        },
        reason: "Needs approval",
        availableDecisions: ["allow_once", "allow_for_session", "deny"],
      },
    },
  };
}

const deniedEscalationOptions = {
  ...fullRuntimeOptions,
  permissionMode: "auto",
  permissionScope: "workspace",
  approvalReviewer: "automatic",
  permissionEscalation: "deny",
} as const;

async function answerDirectRequest(args: {
  rawRequest: JsonRpcMessage;
  handshake?: Record<string, unknown>;
  getActiveTurnId?: (threadId: string) => string | null;
  getThreadExecutionOptions?: () => typeof deniedEscalationOptions | undefined;
  onInteractiveRequest?:
    | ((
        request: PendingInteractionCreate,
      ) => Promise<PendingInteractionResolution>)
    | undefined;
}): Promise<unknown> {
  const child = spawn(process.execPath, [
    "-e",
    "process.stdin.pipe(process.stdout)",
  ]);
  const adapter = createProviderForId("fake", {
    additionalWorkspaceWriteRoots: [],
    bridgeLaunch: createScriptedEchoLaunch(),
  });
  const [initialize] = adapter.buildPostInitializeRequests();
  initialize?.onResult({
    protocolVersion: 2,
    capabilities: { grammarVersions: [3, 3], ...args.handshake },
  });
  const id = args.rawRequest.id;
  if (typeof id !== "string" && typeof id !== "number") {
    throw new Error("request needs an id");
  }
  try {
    handleRuntimeProviderRequest({
      getActiveTurnId: args.getActiveTurnId ?? (() => "bb-turn-1"),
      getThreadExecutionOptions:
        args.getThreadExecutionOptions ?? (() => undefined),
      onInteractiveRequest: args.onInteractiveRequest,
      onToolCall: async () => ({
        contentItems: [{ type: "inputText", text: "tool result" }],
        success: true,
      }),
      parsedId: id,
      parsedMethod: String(args.rawRequest.method),
      providerProcess: { adapter, child, interactiveRequestScope: "scope-1" },
      rawRequest: args.rawRequest,
      resolveThreadId: () => "t1",
    });
    const parsed = parseJsonRpcLine((await readChildStdoutLine(child)).trim());
    if (parsed.kind !== "response") {
      throw new Error(`Expected JSON-RPC response, got ${parsed.kind}`);
    }
    return parsed.parsed;
  } finally {
    child.kill();
  }
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
    const requests: PendingInteractionCreate[] = [];
    const events: ThreadEvent[] = [];
    const runtime = createScriptedEchoRuntime({
      runtime: {
        workspacePath: tmpDir,
        onEvent: (event) => events.push(event),
        onInteractiveRequest: async (request) => {
          requests.push(request);
          return { decision: "allow_once", grantedPermissions: null };
        },
      },
    });

    const { providerThreadId } = await runtime.startThread({
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerId: "fake",
      options: fullRuntimeOptions,
    });
    await runtime.runTurn({
      clientRequestId: "creq_222222224h",
      threadId: "t1",
      input: [promptTextInput({ text: "approve:command ship it" })],
      options: fullRuntimeOptions,
    });
    const { turnId } = await waitForThreadTurnStarted({
      events,
      providerId: "fake",
      runtime,
      threadId: "t1",
    });
    await waitForThreadAgentMessageText({
      events,
      providerId: "fake",
      runtime,
      text: "Response to: approve:command ship it",
      threadId: "t1",
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      threadId: "t1",
      turnId,
      providerId: "fake",
      providerThreadId,
      payload: {
        kind: "approval",
        subject: { kind: "command", command: "echo hi" },
      },
    });
    await runtime.shutdown();
  });

  it("drops unresolved interactive requests when no active turn is known", async () => {
    const onInteractiveRequest = vi.fn(
      async (): Promise<PendingInteractionResolution> => ({
        decision: "allow_once",
        grantedPermissions: null,
      }),
    );
    const answer = await answerDirectRequest({
      rawRequest: commandApprovalRequest(77, { turnId: null }),
      getActiveTurnId: () => null,
      onInteractiveRequest,
    });
    expect(answer).toMatchObject({
      jsonrpc: "2.0",
      id: 77,
      error: {
        code: -32000,
        message: expect.stringContaining("without a turn id"),
      },
    });
    expect(onInteractiveRequest).not.toHaveBeenCalled();
  });

  it("denies interactive requests when permission escalation is deny", async () => {
    const requests: string[] = [];
    const events: ThreadEvent[] = [];
    const runtime = createScriptedEchoRuntime({
      runtime: {
        workspacePath: tmpDir,
        onEvent: (event) => events.push(event),
        onInteractiveRequest: async (request) => {
          requests.push(request.providerRequestId);
          return { decision: "allow_once", grantedPermissions: null };
        },
      },
    });

    await runtime.startThread({
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerId: "fake",
      options: deniedEscalationOptions,
    });
    await runtime.runTurn({
      clientRequestId: "creq_222222224j",
      threadId: "t1",
      input: [promptTextInput({ text: "approve:command denied" })],
      options: deniedEscalationOptions,
    });
    await waitForThreadAgentMessageText({
      events,
      providerId: "fake",
      runtime,
      text: "Denied",
      threadId: "t1",
    });

    expect(requests).toEqual([]);
    await runtime.shutdown();
  });

  it("does not reclassify provider-filtered approvals against mutable thread settings", async () => {
    const onInteractiveRequest = vi.fn(
      async (): Promise<PendingInteractionResolution> => ({
        decision: "allow_once",
        grantedPermissions: null,
      }),
    );
    const answer = await answerDirectRequest({
      rawRequest: commandApprovalRequest(78),
      handshake: { approvalEnforcedBy: "provider" },
      getThreadExecutionOptions: () => deniedEscalationOptions,
      onInteractiveRequest,
    });
    expect(answer).toMatchObject({
      jsonrpc: "2.0",
      id: 78,
      result: { decision: "allow_once" },
    });
    expect(onInteractiveRequest).toHaveBeenCalledTimes(1);
  });

  it("reaches the user through a provider-enforcing bridge end to end", async () => {
    const requests: PendingInteractionCreate[] = [];
    const events: ThreadEvent[] = [];
    const runtime = createScriptedEchoRuntime({
      runtime: {
        workspacePath: tmpDir,
        env: scriptedEchoProcessEnv({ approvalEnforcedBy: "provider" }),
        onEvent: (event) => events.push(event),
        onInteractiveRequest: async (request) => {
          requests.push(request);
          return { decision: "allow_once", grantedPermissions: null };
        },
      },
    });
    await runtime.startThread({
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerId: "fake",
      options: deniedEscalationOptions,
    });
    await runtime.runTurn({
      clientRequestId: "creq_222222224k",
      threadId: "t1",
      input: [promptTextInput({ text: "approve:command provider-enforced" })],
      options: deniedEscalationOptions,
    });
    await waitForThreadAgentMessageText({
      events,
      providerId: "fake",
      runtime,
      text: "Response to: approve:command provider-enforced",
      threadId: "t1",
    });
    expect(requests).toHaveLength(1);
    await runtime.shutdown();
  });

  it("routes user-question interactive requests through the handler when permission escalation is deny", async () => {
    const requests: PendingInteractionCreate[] = [];
    const events: ThreadEvent[] = [];
    const runtime = createScriptedEchoRuntime({
      runtime: {
        workspacePath: tmpDir,
        onEvent: (event) => events.push(event),
        onInteractiveRequest: async (request) => {
          requests.push(request);
          if (request.payload.kind !== "user_question") {
            throw new Error("expected a user question");
          }
          const question = request.payload.questions[0];
          if (question === undefined) {
            throw new Error("expected one question");
          }
          return {
            kind: "user_answer",
            answers: {
              [question.id]: { selected: ["staging"], freeText: "Go slow." },
            },
          };
        },
      },
    });

    await runtime.startThread({
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerId: "fake",
      options: deniedEscalationOptions,
    });
    await runtime.runTurn({
      clientRequestId: "creq_222222224m",
      threadId: "t1",
      input: [promptTextInput({ text: "ask_user" })],
      options: deniedEscalationOptions,
    });
    await waitForThreadAgentMessageText({
      events,
      providerId: "fake",
      runtime,
      text: "Question answered: staging, Go slow.",
      threadId: "t1",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.payload).toMatchObject({
      kind: "user_question",
      questions: [{ prompt: expect.stringContaining("deployment path") }],
    });
    await runtime.shutdown();
  });

  it("sends a provider error for user-question interactive requests without a handler", async () => {
    const answer = await answerDirectRequest({
      rawRequest: {
        jsonrpc: "2.0",
        id: 79,
        method: "interaction/request",
        params: {
          providerThreadId: "prov-1",
          threadId: "t1",
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
        },
      },
      onInteractiveRequest: undefined,
    });
    expect(answer).toMatchObject({
      jsonrpc: "2.0",
      id: 79,
      error: {
        code: -32000,
        message: expect.stringContaining(
          "No interactive request handler is configured",
        ),
      },
    });
  });

  it("sends JSON-RPC error back when onInteractiveRequest throws", async () => {
    const events: ThreadEvent[] = [];
    const runtime = createScriptedEchoRuntime({
      runtime: {
        workspacePath: tmpDir,
        onEvent: (event) => events.push(event),
        onInteractiveRequest: async () => {
          throw new Error("Interactive handler failed");
        },
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
      clientRequestId: "creq_222222224n",
      threadId: "t1",
      input: [promptTextInput({ text: "approve:command boom" })],
      options: fullRuntimeOptions,
    });
    await waitForThreadTurnCompleted({
      events,
      providerId: "fake",
      runtime,
      threadId: "t1",
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "provider/error",
        threadId: "t1",
        message: expect.stringContaining("Interactive handler failed"),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn/completed",
        threadId: "t1",
        status: "failed",
      }),
    );
    await runtime.shutdown();
  });

  it("forwards a plugin-defined request even under a deny escalation and returns its answer", async () => {
    const onInteractiveRequest = vi.fn(
      async (): Promise<PendingInteractionResolution> => ({
        kind: "request_answer",
        value: { TOKEN: "x" },
      }),
    );
    const answer = await answerDirectRequest({
      rawRequest: {
        jsonrpc: "2.0",
        id: 90,
        method: "interaction/request",
        params: {
          providerThreadId: "prov-1",
          threadId: "t1",
          turnId: "turn-1",
          payload: {
            kind: "secrets/secret-request",
            title: "Add a token",
            data: { fields: ["TOKEN"] },
          },
        },
      },
      handshake: { approvalEnforcedBy: "runtime" },
      getThreadExecutionOptions: () => deniedEscalationOptions,
      onInteractiveRequest,
    });
    expect(onInteractiveRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ kind: "secrets/secret-request" }),
      }),
    );
    expect(answer).toMatchObject({
      jsonrpc: "2.0",
      id: 90,
      result: { kind: "request_answer", value: { TOKEN: "x" } },
    });
  });

  it("refuses a plugin-defined request whose data exceeds 64 KiB at the wire", async () => {
    const onInteractiveRequest = vi.fn(
      async (): Promise<PendingInteractionResolution> => ({
        kind: "request_answer",
        value: null,
      }),
    );
    const answer = await answerDirectRequest({
      rawRequest: {
        jsonrpc: "2.0",
        id: 91,
        method: "interaction/request",
        params: {
          providerThreadId: "prov-1",
          threadId: "t1",
          turnId: "turn-1",
          payload: {
            kind: "secrets/secret-request",
            title: "Add a token",
            data: { blob: "x".repeat(64 * 1024) },
          },
        },
      },
      onInteractiveRequest,
    });
    expect(answer).toMatchObject({
      jsonrpc: "2.0",
      id: 91,
      error: { code: expect.any(Number) },
    });
    expect(onInteractiveRequest).not.toHaveBeenCalled();
  });

  it("responds to unsupported interactive requests with a JSON-RPC error instead of dropping them", async () => {
    const answer = await answerDirectRequest({
      rawRequest: {
        jsonrpc: "2.0",
        id: 80,
        method: "interaction/unsupported",
        params: { providerThreadId: "prov-1", turnId: "turn-1" },
      },
    });
    expect(answer).toMatchObject({
      jsonrpc: "2.0",
      id: 80,
      error: { code: expect.any(Number) },
    });
  });

  it("responds to invalid interactive request params with a JSON-RPC invalid params error", async () => {
    const answer = await answerDirectRequest({
      rawRequest: {
        jsonrpc: "2.0",
        id: 81,
        method: "interaction/request",
        params: {
          providerThreadId: "prov-1",
          turnId: "turn-1",
          payload: { kind: "approval", subject: { kind: "nonsense" } },
        },
      },
    });
    expect(answer).toMatchObject({
      jsonrpc: "2.0",
      id: 81,
      error: { code: expect.any(Number) },
    });
  });
});
