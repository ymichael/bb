import type { ThreadEvent } from "@bb/domain";
import { describe, expect, it } from "vitest";
import { createBridgeProtocolAdapter } from "./bridge-protocol-adapter.js";
import type { ProviderExecutionContext } from "./provider-adapter.js";

function makeAdapter(staticProviderOptions?: Record<string, unknown>) {
  return createBridgeProtocolAdapter({
    id: "fake-bridge",
    capabilities: {
      supportsThreadArchive: false,
      supportsThreadRename: false,
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      fork: "checkpoint",
      permissionModes: ["full"],
    },
    process: { command: "node", args: ["fake-bridge.mjs"] },
    ...(staticProviderOptions === undefined ? {} : { staticProviderOptions }),
  });
}

function completeHandshake(
  adapter: ReturnType<typeof makeAdapter>,
  capabilities: Record<string, unknown>,
): void {
  const requests = adapter.buildPostInitializeRequests();
  expect(requests).toHaveLength(1);
  requests[0]?.onResult({
    protocolVersion: 2,
    capabilities: { grammarVersions: [3, 3], ...capabilities },
  });
}

const fullModeOptions: ProviderExecutionContext = {
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
  providerOptions: {},
};

describe("handshake version gate", () => {
  it("rejects a bridge on another protocol version with a legible error", () => {
    const adapter = makeAdapter();
    const requests = adapter.buildPostInitializeRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.required).toBe(true);
    expect(() =>
      requests[0]?.onResult({ protocolVersion: 1, capabilities: {} }),
    ).toThrowError(
      /speaks Provider Bridge Protocol version 1.*requires version 2.*fake-bridge/s,
    );
  });

  it("rejects a malformed initialize result instead of defaulting capabilities", () => {
    const adapter = makeAdapter();
    const requests = adapter.buildPostInitializeRequests();
    expect(requests).toHaveLength(1);
    expect(() => requests[0]?.onResult({ nonsense: true })).toThrowError(
      /malformed result.*fake-bridge/s,
    );
    expect(() => requests[0]?.onResult(null)).toThrowError(/malformed result/);
  });

  it("states the assembler's grammar range and rejects a bridge with no common version", () => {
    const adapter = makeAdapter();
    const requests = adapter.buildPostInitializeRequests();
    expect(requests[0]?.plan).toMatchObject({
      method: "initialize",
      params: { grammarVersions: [3, 3] },
    });
    expect(() =>
      requests[0]?.onResult({
        protocolVersion: 2,
        capabilities: { grammarVersions: [4, 5] },
      }),
    ).toThrowError(
      /grammar versions 4-5.*assembles versions 3-3.*fake-bridge/s,
    );
    expect(() =>
      requests[0]?.onResult({
        protocolVersion: 2,
        capabilities: { grammarVersions: [2, 2] },
      }),
    ).toThrowError(/grammar versions 2-2.*assembles versions 3-3/s);
    expect(() =>
      requests[0]?.onResult({ protocolVersion: 2, capabilities: {} }),
    ).toThrowError(/grammar versions 2-2.*assembles versions 3-3/s);
    expect(() =>
      requests[0]?.onResult({
        protocolVersion: 2,
        capabilities: { grammarVersions: [3, 3] },
      }),
    ).not.toThrow();
    expect(() =>
      requests[0]?.onResult({
        protocolVersion: 2,
        capabilities: { grammarVersions: [2, 4] },
      }),
    ).not.toThrow();
  });
});

describe("handshake gating", () => {
  it("never sends capability-gated methods a bridge did not advertise", () => {
    const adapter = makeAdapter();
    const before = adapter.buildCommandPlan({
      type: "thread/name/set",
      threadId: "thr_1",
      providerThreadId: "p_1",
      title: "New title",
    });
    expect(before).toMatchObject({ kind: "noop" });

    completeHandshake(adapter, { threadRename: true, threadArchive: true });

    expect(
      adapter.buildCommandPlan({
        type: "thread/name/set",
        threadId: "thr_1",
        providerThreadId: "p_1",
        title: "New title",
      }),
    ).toMatchObject({ kind: "request", method: "thread/name/set" });
    expect(
      adapter.buildCommandPlan({
        type: "thread/archive",
        threadId: "thr_1",
        providerThreadId: "p_1",
      }),
    ).toMatchObject({ kind: "request", method: "thread/archive" });
    expect(
      adapter.buildCommandPlan({
        type: "thread/goal/clear",
        threadId: "thr_1",
        providerThreadId: "p_1",
      }),
    ).toMatchObject({ kind: "noop" });
  });

  it("moves approval policy ownership per the handshake", () => {
    const adapter = makeAdapter();
    expect(adapter.approvalEnforcedBy).toBe("runtime");
    completeHandshake(adapter, { approvalEnforcedBy: "provider" });
    expect(adapter.approvalEnforcedBy).toBe("provider");
  });

  it("routes declared sessionless maintenance methods with provider context", () => {
    const adapter = makeAdapter();
    expect(
      adapter.buildCommandPlan({ type: "provider/health", cwd: "/workspace" }),
    ).toEqual({
      kind: "request",
      method: "provider/health",
      params: { providerId: "fake-bridge", cwd: "/workspace" },
    });
    expect(adapter.buildCommandPlan({ type: "provider/usage" })).toEqual({
      kind: "request",
      method: "provider/usage",
      params: { providerId: "fake-bridge" },
    });
    expect(
      adapter.buildCommandPlan({
        type: "provider/installation/status",
        cwd: "/workspace",
        requirement: "thread_rewind",
      }),
    ).toEqual({
      kind: "request",
      method: "provider/installation/status",
      params: {
        providerId: "fake-bridge",
        cwd: "/workspace",
        requirement: "thread_rewind",
      },
    });
    expect(
      adapter.buildCommandPlan({
        type: "provider/installation/run",
        action: "update",
      }),
    ).toEqual({
      kind: "request",
      method: "provider/installation/run",
      params: { providerId: "fake-bridge", action: "update" },
    });
  });
});

describe("fork narrowing", () => {
  const forkCommand = {
    type: "thread/fork",
    threadId: "thr_2",
    cwd: "/w",
    sourceProviderThreadId: "p_1",
    options: fullModeOptions,
    instructionMode: "replace",
  } as const;

  it("refuses a fork the handshake does not support, however the declaration reads", () => {
    const adapter = makeAdapter();
    completeHandshake(adapter, {});
    expect(() => adapter.buildCommandPlan(forkCommand)).toThrow(
      /does not support forking/u,
    );
  });

  it("refuses a checkpoint fork on a tip-only bridge but allows a tip fork", () => {
    const adapter = makeAdapter();
    completeHandshake(adapter, { fork: "tip" });
    expect(() =>
      adapter.buildCommandPlan({
        ...forkCommand,
        sourceProviderCheckpointId: "ckpt_1",
      }),
    ).toThrow(/only fork at the end of a session/u);
    expect(adapter.buildCommandPlan(forkCommand)).toMatchObject({
      kind: "request",
      method: "thread/fork",
    });
  });

  it("allows a checkpoint fork on a checkpoint bridge", () => {
    const adapter = makeAdapter();
    completeHandshake(adapter, { fork: "checkpoint" });
    expect(
      adapter.buildCommandPlan({
        ...forkCommand,
        sourceProviderCheckpointId: "ckpt_1",
      }),
    ).toMatchObject({
      kind: "request",
      method: "thread/fork",
      params: { sourceProviderCheckpointId: "ckpt_1" },
    });
  });
});

describe("thread/stop intent", () => {
  it("derives interrupt for an active turn and release for an idle stop", () => {
    const adapter = makeAdapter();
    expect(
      adapter.buildCommandPlan({
        type: "thread/stop",
        threadId: "thr_1",
        providerThreadId: "p_1",
        activeTurnId: "turn_9",
      }),
    ).toMatchObject({
      params: { intent: "interrupt", activeTurnId: "turn_9" },
    });
    expect(
      adapter.buildCommandPlan({
        type: "thread/stop",
        threadId: "thr_1",
        providerThreadId: "p_1",
        activeTurnId: null,
      }),
    ).toMatchObject({ params: { intent: "release", activeTurnId: null } });
  });
});

describe("options mapping", () => {
  it("keeps core fields top-level and merges the plugin-derived bag over the static options", () => {
    const adapter = makeAdapter({ acpLaunchSpec: { command: "echo" } });
    const plan = adapter.buildCommandPlan({
      type: "turn/start",
      threadId: "thr_1",
      providerThreadId: "p_1",
      input: [{ type: "text", text: "hi", mentions: [] }],
      clientRequestId: "creq_abcdefghjk",
      options: {
        ...fullModeOptions,
        model: "gpt-5.6-sol",
        promptMode: "plan",
        providerOptions: { memoryEnabled: false },
      },
    });
    expect(plan).toMatchObject({
      kind: "request",
      params: {
        options: {
          model: "gpt-5.6-sol",
          permissionMode: "full",
          promptMode: "plan",
          providerOptions: {
            acpLaunchSpec: { command: "echo" },
            memoryEnabled: false,
          },
        },
      },
    });
    const options = (plan as { params: { options: Record<string, unknown> } })
      .params.options;
    expect(options).not.toHaveProperty("memoryEnabled");
    expect(options).not.toHaveProperty("skillRoots");
  });
});

describe("skills/configure", () => {
  it("is a noop until the handshake declares skills.configure", () => {
    const adapter = makeAdapter();
    const command = {
      type: "skills/configure" as const,
      skillRoots: [
        { id: "global-skills:abc", path: "/staged/skills", skills: [] },
      ],
    };
    expect(adapter.buildCommandPlan(command)).toMatchObject({ kind: "noop" });
    completeHandshake(adapter, { skills: { configure: true } });
    expect(adapter.buildCommandPlan(command)).toMatchObject({
      kind: "request",
      method: "skills/configure",
    });
  });

  it("forwards the generic skill root unchanged", () => {
    const adapter = makeAdapter();
    completeHandshake(adapter, { skills: { configure: true } });
    const plan = adapter.buildCommandPlan({
      type: "skills/configure",
      skillRoots: [
        {
          id: "global-skills:abc",
          path: "/staged/skills",
          skills: [{ name: "deploy", description: "Ship the app." }],
        },
      ],
    });

    expect(plan).toEqual({
      kind: "request",
      method: "skills/configure",
      params: {
        roots: [
          {
            id: "global-skills:abc",
            path: "/staged/skills",
            skills: [{ name: "deploy", description: "Ship the app." }],
          },
        ],
      },
    });
  });
});

describe("translateEvent", () => {
  const validEvent: ThreadEvent = {
    type: "turn/started",
    threadId: "thr_1",
    providerThreadId: "p_1",
    scope: { kind: "turn", turnId: "bturn_1" },
  };

  it("ignores the retired thread/event notification", () => {
    const adapter = makeAdapter();
    expect(
      adapter.translateEvent({
        jsonrpc: "2.0",
        method: "thread/event",
        params: { threadId: "thr_1", event: validEvent },
      }),
    ).toStrictEqual([]);
  });

  it("ignores an unknown bridge notification without emitting a timeline event", () => {
    const adapter = makeAdapter();
    expect(
      adapter.translateEvent({
        jsonrpc: "2.0",
        method: "thread/openWork",
        params: { threadId: "thr_1", open: true },
      }),
    ).toStrictEqual([]);
  });

  it("only surfaces session/replaced when provider context was lost", () => {
    const adapter = makeAdapter();
    expect(
      adapter.translateEvent({
        jsonrpc: "2.0",
        method: "session/replaced",
        params: {
          threadId: "thr_1",
          providerThreadId: "p_2",
          reason: "authentication recovery required a new process",
          contextLost: false,
        },
      }),
    ).toStrictEqual([]);

    expect(
      adapter.translateEvent({
        jsonrpc: "2.0",
        method: "session/replaced",
        params: {
          threadId: "thr_1",
          providerThreadId: "p_2",
          reason:
            "Execution settings changed; the Claude session was rebuilt to apply them.",
          contextLost: false,
          showRuntimeNote: true,
        },
      }),
    ).toMatchObject([
      {
        type: "provider/warning",
        summary:
          "Execution settings changed; the Claude session was rebuilt to apply them.",
      },
    ]);

    const events = adapter.translateEvent({
      jsonrpc: "2.0",
      method: "session/replaced",
      params: {
        threadId: "thr_1",
        providerThreadId: "p_2",
        reason: "model change required a session rebuild",
        contextLost: true,
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "provider/warning",
      threadId: "thr_1",
      providerThreadId: "p_2",
      details: "model change required a session rebuild",
    });
    expect((events[0] as { summary?: string }).summary).toContain(
      "context was lost",
    );
  });
});

describe("provider/recovery", () => {
  it("decodes a typed recovery hint as a runtime signal, never a timeline event", () => {
    const adapter = makeAdapter();
    const event = {
      jsonrpc: "2.0" as const,
      method: "provider/recovery",
      params: {
        threadId: "thr_1",
        kind: "sessionArchived",
        message: "session rollout-1 is archived",
        retryable: true,
      },
    };
    expect(adapter.decodeRecoveryHint(event)).toEqual({
      threadId: "thr_1",
      kind: "sessionArchived",
      message: "session rollout-1 is archived",
      retryable: true,
    });
    expect(adapter.translateEvent(event)).toStrictEqual([]);
    expect(
      adapter.decodeRecoveryHint({
        jsonrpc: "2.0",
        method: "provider/recovery",
        params: { kind: "authRequired", message: "sign in", retryable: false },
      }),
    ).toEqual({ kind: "authRequired", message: "sign in", retryable: false });
  });

  it("drops a malformed or unknown-kind hint and ignores other notifications", () => {
    const adapter = makeAdapter();
    expect(
      adapter.decodeRecoveryHint({
        jsonrpc: "2.0",
        method: "provider/recovery",
        params: { kind: "rebootTheUniverse", message: "x", retryable: true },
      }),
    ).toBeNull();
    expect(
      adapter.decodeRecoveryHint({
        jsonrpc: "2.0",
        method: "thread/openWork",
        params: { threadId: "thr_1", open: true },
      }),
    ).toBeNull();
  });
});

describe("inbound request decoding", () => {
  it("decodes canonical tool calls and rejects other methods", () => {
    const adapter = makeAdapter();
    const decoded = adapter.decodeToolCallRequest({
      id: 7,
      method: "item/tool/call",
      params: {
        providerThreadId: "p_1",
        turnId: null,
        callId: "call_1",
        tool: "ask_user_question",
        arguments: { q: "hi" },
      },
    });
    expect(decoded).toMatchObject({
      requestId: 7,
      providerThreadId: "p_1",
      turnId: null,
      tool: "ask_user_question",
    });
    expect(
      adapter.decodeToolCallRequest({
        id: 8,
        method: "acp/permission/request",
        params: {},
      }),
    ).toBeNull();
  });

  it("decodes canonical interaction requests with the domain payload", () => {
    const adapter = makeAdapter();
    const decoded = adapter.decodeInteractiveRequest?.({
      id: 9,
      method: "interaction/request",
      params: {
        providerThreadId: "p_1",
        turnId: "bturn_1",
        payload: {
          kind: "approval",
          subject: {
            kind: "command",
            itemId: "item_1",
            command: "rm -rf ./scratch",
            cwd: null,
            actions: [],
            sessionGrant: null,
          },
          reason: null,
          availableDecisions: ["allow_once", "deny"],
        },
      },
    });
    expect(decoded).toMatchObject({
      requestId: 9,
      providerThreadId: "p_1",
      turnId: "bturn_1",
      payload: { kind: "approval" },
    });
  });
});

function feedDeltas(
  adapter: ReturnType<typeof makeAdapter>,
  threadId: string,
  deltas: unknown[],
): ThreadEvent[] {
  return adapter.translateEvent({
    jsonrpc: "2.0",
    method: "thread/delta",
    params: { threadId, deltas },
  });
}

describe("provider-native id translation", () => {
  it("reverse-maps steer/interrupt turn ids to provider-native ids", () => {
    const adapter = makeAdapter();
    const [started] = feedDeltas(adapter, "t_1", [
      { kind: "turn.open", providerTurnId: "codex-turn-1" },
    ]);
    const bbTurnId =
      started?.type === "turn/started" && started.scope.kind === "turn"
        ? started.scope.turnId
        : "";
    expect(bbTurnId).not.toBe("");

    const steer = adapter.buildCommandPlan({
      type: "turn/steer",
      threadId: "t_1",
      providerThreadId: "p_1",
      expectedTurnId: bbTurnId,
      input: [],
      clientRequestId: "creq_abcdefghjk",
      options: fullModeOptions,
    });
    expect(steer).toMatchObject({
      params: { expectedTurnId: "codex-turn-1" },
    });

    const stop = adapter.buildCommandPlan({
      type: "thread/stop",
      threadId: "t_1",
      providerThreadId: "p_1",
      activeTurnId: bbTurnId,
    });
    expect(stop).toMatchObject({
      params: { intent: "interrupt", activeTurnId: "codex-turn-1" },
    });

    const passthrough = adapter.buildCommandPlan({
      type: "turn/steer",
      threadId: "t_1",
      providerThreadId: "p_1",
      expectedTurnId: "unmapped-turn",
      input: [],
      clientRequestId: "creq_abcdefghjk",
      options: fullModeOptions,
    });
    expect(passthrough).toMatchObject({
      params: { expectedTurnId: "unmapped-turn" },
    });
  });

  it("maps providerNativeIds interaction requests onto assembler-minted ids", () => {
    const adapter = makeAdapter();
    const events = feedDeltas(adapter, "t_1", [
      { kind: "turn.open", providerTurnId: "codex-turn-1" },
      {
        kind: "item.open",
        key: { providerItemId: "cmd-1" },
        item: { type: "command", command: "git status", cwd: "/repo" },
        providerTurnId: "codex-turn-1",
      },
    ]);
    const bbItemId =
      events[1]?.type === "item/started" ? events[1].item.id : "";
    const bbTurnId =
      events[0]?.type === "turn/started" && events[0].scope.kind === "turn"
        ? events[0].scope.turnId
        : "";

    const params = {
      providerThreadId: "p_1",
      threadId: "t_1",
      turnId: "codex-turn-1",
      providerNativeIds: true,
      payload: {
        kind: "approval",
        subject: {
          kind: "command",
          itemId: "cmd-1",
          command: "git status",
          cwd: null,
          actions: [],
          sessionGrant: null,
        },
        reason: null,
        availableDecisions: ["allow_once", "deny"],
      },
    };
    const decoded = adapter.decodeInteractiveRequest?.({
      id: 11,
      method: "interaction/request",
      params,
    });
    expect(decoded).toMatchObject({
      turnId: bbTurnId,
      payload: { subject: { itemId: bbItemId } },
    });

    const unmarked = adapter.decodeInteractiveRequest?.({
      id: 12,
      method: "interaction/request",
      params: { ...params, providerNativeIds: undefined },
    });
    expect(unmarked).toMatchObject({
      turnId: "codex-turn-1",
      payload: { subject: { itemId: "cmd-1" } },
    });
  });

  it("maps providerNativeIds tool-call requests onto assembler-minted ids", () => {
    const adapter = makeAdapter();
    const events = feedDeltas(adapter, "t_1", [
      { kind: "turn.open", providerTurnId: "codex-turn-1" },
      {
        kind: "item.open",
        key: { providerItemId: "dyn-1" },
        item: { type: "tool", tool: "bb_test_ping" },
        providerTurnId: "codex-turn-1",
      },
    ]);
    const bbItemId =
      events[1]?.type === "item/started" ? events[1].item.id : "";
    const bbTurnId =
      events[0]?.type === "turn/started" && events[0].scope.kind === "turn"
        ? events[0].scope.turnId
        : "";

    const decoded = adapter.decodeToolCallRequest({
      id: 13,
      method: "item/tool/call",
      params: {
        providerThreadId: "p_1",
        threadId: "t_1",
        turnId: "codex-turn-1",
        callId: "dyn-1",
        tool: "bb_test_ping",
        arguments: {},
        providerNativeIds: true,
      },
    });
    expect(decoded).toMatchObject({ turnId: bbTurnId, callId: bbItemId });
  });
});
