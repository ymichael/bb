import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderThreadContext, SpawnThreadRequest } from "@bb/core";
import { EnvironmentAgentRuntime } from "./runtime.js";
import { ENVIRONMENT_AGENT_PROTOCOL_VERSION, type EnvironmentAgentProviderSpec } from "./protocol.js";

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    const fn = cleanup.pop();
    await fn?.();
  }
});

function createStartRequest(projectId: string): SpawnThreadRequest {
  return {
    projectId,
    input: [{ type: "text", text: "hello" }],
  };
}

function createThreadContext(
  projectId: string,
  threadId: string,
): ProviderThreadContext {
  return {
    projectId,
    threadId,
    path: `/tmp/${threadId}`,
  };
}

describe("EnvironmentAgentRuntime", () => {
  it("records sequenced events and reports basic status", () => {
    const runtime = new EnvironmentAgentRuntime({ threadId: "thread-1", providerId: "codex" });

    runtime.appendEvent({ type: "environment.ready", threadId: "thread-1" });
    runtime.appendEvent({ type: "workspace.status.changed", threadId: "thread-1" });

    expect(runtime.getStatusSnapshot()).toMatchObject({
      protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
      latestSequence: 2,
      pendingEventCount: 2,
      pendingCommandCount: 0,
      connectedToDaemon: false,
      deliveryState: "stopped",
      retryAttemptCount: 0,
    });
  });

  it("updates daemon delivery status for retry visibility", () => {
    const runtime = new EnvironmentAgentRuntime({ threadId: "thread-1", providerId: "codex" });

    runtime.appendEvent({ type: "environment.ready", threadId: "thread-1" });
    runtime.setDaemonDeliveryState({
      connectedToDaemon: false,
      deliveryState: "retrying",
      retryAttemptCount: 2,
      lastAckedSequence: 1,
      nextRetryAt: 123_456,
      deliveryIssue: "transport_error",
      lastDeliveryError: "daemon unavailable",
    });

    expect(runtime.getStatusSnapshot()).toMatchObject({
      latestSequence: 1,
      lastAckedSequence: 1,
      pendingEventCount: 0,
      connectedToDaemon: false,
      deliveryState: "retrying",
      retryAttemptCount: 2,
      nextRetryAt: 123_456,
      deliveryIssue: "transport_error",
      lastDeliveryError: "daemon unavailable",
    });
  });

  it("publishes appended events to subscribers", () => {
    const runtime = new EnvironmentAgentRuntime({ threadId: "thread-1", providerId: "codex" });
    const events: Array<{ sequence: number; type: string }> = [];
    const unsubscribe = runtime.subscribeToEvents((event) => {
      events.push({ sequence: event.sequence, type: event.event.type });
    });
    cleanup.push(unsubscribe);

    runtime.appendEvent({ type: "environment.ready", threadId: "thread-1" });
    runtime.appendEvent({ type: "workspace.status.changed", threadId: "thread-1" });

    expect(events).toEqual([
      { sequence: 1, type: "environment.ready" },
      { sequence: 2, type: "workspace.status.changed" },
    ]);
  });

  it("tracks quiescence lifecycle state from provider events and command failures", async () => {
    const runtime = new EnvironmentAgentRuntime({
      threadId: "thread-1",
      providerId: "codex",
    });

    expect(runtime.getQuiescenceSnapshot()).toEqual({
      hasObservedWork: false,
      commandExecutionCount: 0,
      pendingProviderRequestCount: 0,
      turnState: "unknown",
    });

    runtime.appendEvent({
      type: "provider.event",
      threadId: "thread-1",
      method: "turn.started",
      payload: {},
    });
    expect(runtime.getQuiescenceSnapshot()).toEqual({
      hasObservedWork: true,
      commandExecutionCount: 0,
      pendingProviderRequestCount: 0,
      turnState: "active",
    });

    runtime.appendEvent({
      type: "provider.event",
      threadId: "thread-1",
      method: "turn.completed",
      payload: {},
    });
    expect(runtime.getQuiescenceSnapshot()).toEqual({
      hasObservedWork: true,
      commandExecutionCount: 0,
      pendingProviderRequestCount: 0,
      turnState: "idle",
    });

    const ack = await runtime.executeCommand({
      meta: {
        protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
        commandId: "cmd-fail-1",
        idempotencyKey: "cmd-fail-1",
        sentAt: 123,
      },
      command: {
        type: "workspace.status",
        threadId: "thread-1",
      },
    });
    expect(ack).toMatchObject({
      commandId: "cmd-fail-1",
      state: "rejected",
      errorCode: "provider_unavailable",
    });
    expect(runtime.getQuiescenceSnapshot()).toEqual({
      hasObservedWork: true,
      commandExecutionCount: 0,
      pendingProviderRequestCount: 0,
      turnState: "idle",
    });
  });

  it("does not require a provider at startup when launched in control-plane mode", () => {
    const runtime = new EnvironmentAgentRuntime({ threadId: "thread-1" });

    expect(runtime.start()).toBeNull();
    expect(runtime.getProviderStatus()).toEqual({
      running: false,
      launched: false,
    });
  });

  it("materializes launch env and auth files before spawning the provider", async () => {
    const tempHome = await mkdtemp(join(tmpdir(), "bb-env-daemon-runtime-"));
    cleanup.push(() => rm(tempHome, { recursive: true, force: true }));

    const runtime = new EnvironmentAgentRuntime({ threadId: "thread-1" });
    const lines: string[] = [];
    const unsubscribe = runtime.subscribeToProviderStdout((line) => {
      lines.push(line);
    });
    cleanup.push(unsubscribe);

    runtime.ensureProviderStatus({
      command: "node",
      args: [
        "-e",
        [
          "const fs = require('node:fs');",
          "const path = require('node:path');",
          "const authPath = path.join(process.env.HOME, '.codex', 'auth.json');",
          "console.log(JSON.stringify({ apiKey: process.env.OPENAI_API_KEY, authFile: fs.readFileSync(authPath, 'utf8') }));",
        ].join(""),
      ],
      env: {
        HOME: tempHome,
        OPENAI_API_KEY: "sk-test-123",
      },
      files: [
        {
          placement: "home",
          path: ".codex/auth.json",
          content: '{"auth_mode":"chatgpt"}',
        },
      ],
    });

    await expect.poll(() => lines.length).toBeGreaterThan(0);
    expect(JSON.parse(lines[0] ?? "{}")).toEqual({
      apiKey: "sk-test-123",
      authFile: '{"auth_mode":"chatgpt"}',
    });
    await expect(readFile(join(tempHome, ".codex", "auth.json"), "utf8")).resolves.toBe(
      '{"auth_mode":"chatgpt"}',
    );
  });

  it("lists provider models through a BB-native env-daemon command", async () => {
    const runtime = new EnvironmentAgentRuntime({
      threadId: "thread-1",
      providerId: "codex",
    });

    const ack = await runtime.executeCommand({
      meta: {
        protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
        commandId: "cmd-models-1",
        idempotencyKey: "cmd-models-1",
        sentAt: 123,
      },
      command: {
        type: "provider.list_models",
        providerId: "codex",
      },
    });

    expect(ack.state).toBe("accepted");
    expect(Array.isArray(ack.result)).toBe(true);
    expect((ack.result as Array<{ model?: string }>).length).toBeGreaterThan(0);
  });

  it("lists provider catalog through a BB-native env-daemon command", async () => {
    const runtime = new EnvironmentAgentRuntime({
      threadId: "thread-1",
      providerId: "codex",
    });

    const ack = await runtime.executeCommand({
      meta: {
        protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
        commandId: "cmd-provider-catalog-1",
        idempotencyKey: "cmd-provider-catalog-1",
        sentAt: 123,
      },
      command: {
        type: "provider.list_catalog",
      },
    });

    expect(ack.state).toBe("accepted");
    expect(Array.isArray(ack.result)).toBe(true);
    expect((ack.result as Array<{ id?: string }>).length).toBeGreaterThan(0);
  });

  it("accepts explicit commands and forwards them to the provider transport", async () => {
    const runtime = new EnvironmentAgentRuntime({
      threadId: "thread-1",
      providerId: "codex",
      providerCommand: "node",
      providerArgs: [
        "-e",
        [
          "process.stdin.setEncoding('utf8');",
          "let buffer='';",
          "process.stdin.on('data',chunk=>{",
          "buffer+=chunk;",
          "const parts=buffer.split(/\\r\\n|\\n|\\r/g);",
          "buffer=parts.pop() ?? '';",
          "for (const line of parts) {",
          "if (!line.trim()) continue;",
          "const msg = JSON.parse(line);",
          "if (msg.method === 'initialize') {",
          "console.log(JSON.stringify({ id: msg.id, result: { capabilities: {} } }));",
          "} else if (msg.method === 'thread/start') {",
          "console.log(JSON.stringify({ id: msg.id, result: { thread: { id: 'provider-thread-1' } } }));",
          "}",
          "}",
          "});",
        ].join(""),
      ],
    });

    const ack = await runtime.executeCommand({
      meta: {
        protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
        commandId: "cmd-1",
        idempotencyKey: "idem-1",
        sentAt: 123,
      },
      command: {
        type: "thread.start",
        threadId: "thread-1",
        projectId: "proj-1",
        request: createStartRequest("proj-1"),
        context: createThreadContext("proj-1", "thread-1"),
        initialize: {
          method: "initialize",
          params: { clientInfo: { name: "bb", version: "0.0.1" } },
        },
      },
    });

    expect(ack).toMatchObject({
      commandId: "cmd-1",
      state: "accepted",
      result: { thread: { id: "provider-thread-1" } },
    });
  });

  it("accepts provider.ensure commands and returns provider status", async () => {
    const runtime = new EnvironmentAgentRuntime({
      threadId: "thread-1",
    });

    const ack = await runtime.executeCommand({
      meta: {
        protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
        commandId: "cmd-provider-1",
        idempotencyKey: "idem-provider-1",
        sentAt: 123,
      },
      command: {
        type: "provider.ensure",
        command: "node",
        args: [
          "-e",
          [
            "process.stdin.resume();",
            "setTimeout(() => process.exit(0), 250);",
          ].join(""),
        ],
      },
    });

    expect(ack).toMatchObject({
      commandId: "cmd-provider-1",
      state: "accepted",
      result: {
        running: true,
        launched: true,
      },
    });
  });

  it("routes provider notifications to the mapped shared thread channel", async () => {
    const runtime = new EnvironmentAgentRuntime({
      threadId: "owner-thread",
      providerId: "codex",
      providerCommand: "node",
      providerArgs: [
        "-e",
        [
          "let threadCounter = 0;",
          "process.stdin.setEncoding('utf8');",
          "let buffer='';",
          "process.stdin.on('data',chunk=>{",
          "buffer+=chunk;",
          "const parts=buffer.split(/\\r\\n|\\n|\\r/g);",
          "buffer=parts.pop() ?? '';",
          "for (const line of parts) {",
          "if (!line.trim()) continue;",
          "const msg = JSON.parse(line);",
          "if (msg.method === 'initialize') {",
          "console.log(JSON.stringify({ id: msg.id, result: { capabilities: {} } }));",
          "} else if (msg.method === 'thread/start') {",
          "threadCounter += 1;",
          "console.log(JSON.stringify({ id: msg.id, result: { threadId: `provider-thread-${threadCounter}` } }));",
          "} else if (msg.method === 'turn/start') {",
          "const threadId = msg.params.threadId;",
          "const turnId = `turn-${threadId}`;",
          "console.log(JSON.stringify({ id: msg.id, result: { threadId, turnId } }));",
          "setTimeout(() => console.log(JSON.stringify({ method: 'turn/started', params: { threadId, turnId } })), 0);",
          "setTimeout(() => console.log(JSON.stringify({ method: 'turn/completed', params: { threadId, turnId } })), 5);",
          "}",
          "}",
          "});",
        ].join(""),
      ],
    });
    const providerEvents: Array<{ threadId: string; method: string }> = [];
    const unsubscribe = runtime.subscribeToEvents((event) => {
      if (event.event.type === "provider.event") {
        providerEvents.push({
          threadId: event.event.threadId,
          method: event.event.method,
        });
      }
    });
    cleanup.push(unsubscribe);

    await runtime.executeCommand({
      meta: {
        protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
        commandId: "cmd-start-1",
        idempotencyKey: "cmd-start-1",
        sentAt: 100,
      },
      command: {
        type: "thread.start",
        threadId: "thread-1",
        projectId: "proj-1",
        request: createStartRequest("proj-1"),
        context: createThreadContext("proj-1", "thread-1"),
        initialize: {
          method: "initialize",
          params: { clientInfo: { name: "bb", version: "0.0.1" } },
        },
      },
    });
    await runtime.executeCommand({
      meta: {
        protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
        commandId: "cmd-start-2",
        idempotencyKey: "cmd-start-2",
        sentAt: 101,
      },
      command: {
        type: "thread.start",
        threadId: "thread-2",
        projectId: "proj-1",
        request: createStartRequest("proj-1"),
        context: createThreadContext("proj-1", "thread-2"),
        initialize: {
          method: "initialize",
          params: { clientInfo: { name: "bb", version: "0.0.1" } },
        },
      },
    });

    await runtime.executeCommand({
      meta: {
        protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
        commandId: "cmd-turn-1",
        idempotencyKey: "cmd-turn-1",
        sentAt: 102,
      },
      command: {
        type: "turn.run",
        threadId: "thread-1",
        providerThreadId: "provider-thread-1",
        input: [],
      },
    });
    await runtime.executeCommand({
      meta: {
        protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
        commandId: "cmd-turn-2",
        idempotencyKey: "cmd-turn-2",
        sentAt: 103,
      },
      command: {
        type: "turn.run",
        threadId: "thread-2",
        providerThreadId: "provider-thread-2",
        input: [],
      },
    });

    await expect.poll(
      () =>
        providerEvents.filter((event) => event.method === "turn/completed"),
      { timeout: 5_000 },
    ).toEqual(
      expect.arrayContaining([
        { threadId: "thread-1", method: "turn/completed" },
        { threadId: "thread-2", method: "turn/completed" },
      ]),
    );
  });

  it("namespaces shared provider-thread mappings by provider during interleaved multi-provider runs", async () => {
    const providerScript = [
      "process.stdin.setEncoding('utf8');",
      "let buffer='';",
      "process.stdin.on('data',chunk=>{",
      "buffer+=chunk;",
      "const parts=buffer.split(/\\r\\n|\\n|\\r/g);",
      "buffer=parts.pop() ?? '';",
      "for (const line of parts) {",
      "if (!line.trim()) continue;",
      "const msg = JSON.parse(line);",
      "if (msg.method === 'initialize') {",
      "console.log(JSON.stringify({ id: msg.id, result: { capabilities: {}, role: process.env.ROLE } }));",
      "} else if (msg.method === 'thread/start') {",
      "console.log(JSON.stringify({ id: msg.id, result: { threadId: 'shared-provider-thread', role: process.env.ROLE } }));",
      "} else if (msg.method === 'turn/start') {",
      "const threadId = msg.params.threadId;",
      "const turnId = `${process.env.ROLE}-turn-${Date.now()}`;",
      "console.log(JSON.stringify({ id: msg.id, result: { threadId, turnId, role: process.env.ROLE } }));",
      "setTimeout(() => console.log(JSON.stringify({ method: 'turn/started', params: { threadId, turnId } })), 0);",
      "setTimeout(() => console.log(JSON.stringify({ method: 'item/completed', params: { threadId, item: { type: 'agentMessage', text: { text: process.env.ROLE } } } })), 1);",
      "setTimeout(() => console.log(JSON.stringify({ method: 'turn/completed', params: { threadId, turnId } })), 2);",
      "}",
      "}",
      "});",
    ].join("");

    const runtime = new EnvironmentAgentRuntime({
      threadId: "owner-thread",
      providerId: "codex",
    });
    cleanup.push(() => runtime.shutdown());

    const providerEvents: Array<{ threadId: string; providerId?: string; method: string }> = [];
    const unsubscribe = runtime.subscribeToEvents((event) => {
      if (event.event.type === "provider.event") {
        providerEvents.push({
          threadId: event.event.threadId,
          providerId: event.event.providerId,
          method: event.event.method,
        });
      }
    });
    cleanup.push(unsubscribe);

    const ensure = async (
      commandId: string,
      threadId: string,
      providerId: "codex" | "claude-code",
      role: string,
    ) => runtime.executeCommand({
      meta: {
        protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
        commandId,
        idempotencyKey: commandId,
        sentAt: Date.now(),
      },
      command: {
        type: "provider.ensure",
        providerId,
        forThreadId: threadId,
        command: "node",
        args: ["-e", providerScript],
        env: { ROLE: role },
      },
    });

    await ensure("ensure-a", "thread-a", "codex", "provider-A");
    await ensure("ensure-b", "thread-b", "claude-code", "provider-B");

    await runtime.executeCommand({
      meta: {
        protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
        commandId: "start-a",
        idempotencyKey: "start-a",
        sentAt: Date.now(),
      },
      command: {
        type: "thread.start",
        threadId: "thread-a",
        projectId: "proj-1",
        request: createStartRequest("proj-1"),
        context: createThreadContext("proj-1", "thread-a"),
        initialize: {
          method: "initialize",
          params: { clientInfo: { name: "bb", version: "0.0.1" } },
        },
      },
    });
    await runtime.executeCommand({
      meta: {
        protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
        commandId: "start-b",
        idempotencyKey: "start-b",
        sentAt: Date.now(),
      },
      command: {
        type: "thread.start",
        threadId: "thread-b",
        projectId: "proj-1",
        request: createStartRequest("proj-1"),
        context: createThreadContext("proj-1", "thread-b"),
        initialize: {
          method: "initialize",
          params: { clientInfo: { name: "bb", version: "0.0.1" } },
        },
      },
    });

    await runtime.executeCommand({
      meta: {
        protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
        commandId: "turn-a",
        idempotencyKey: "turn-a",
        sentAt: Date.now(),
      },
      command: {
        type: "turn.run",
        threadId: "thread-a",
        providerThreadId: "shared-provider-thread",
        input: [{ type: "text", text: "A" }],
      },
    });
    await runtime.executeCommand({
      meta: {
        protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
        commandId: "turn-b",
        idempotencyKey: "turn-b",
        sentAt: Date.now(),
      },
      command: {
        type: "turn.run",
        threadId: "thread-b",
        providerThreadId: "shared-provider-thread",
        input: [{ type: "text", text: "B" }],
      },
    });

    await expect.poll(
      () =>
        providerEvents.filter((event) => event.method === "turn/completed"),
      { timeout: 5_000 },
    ).toEqual(
      expect.arrayContaining([
        {
          threadId: "thread-a",
          providerId: "codex",
          method: "turn/completed",
        },
        {
          threadId: "thread-b",
          providerId: "claude-code",
          method: "turn/completed",
        },
      ]),
    );
  });

  it("captures provider stderr as events", async () => {
    const runtime = new EnvironmentAgentRuntime({
      threadId: "thread-1",
      providerCommand: "node",
      providerArgs: [
        "-e",
        "console.error('refresh token has already been used'); setTimeout(() => process.exit(0), 20);",
      ],
    });
    const events: string[] = [];
    const unsubscribe = runtime.subscribeToEvents((event) => {
      if (event.event.type === "provider.stderr") {
        events.push(event.event.line);
      }
    });
    cleanup.push(unsubscribe);

    runtime.start();

    await expect.poll(() => events).toContain("refresh token has already been used");
  });

  it("captures unmatched provider rpc errors as events", async () => {
    const runtime = new EnvironmentAgentRuntime({
      threadId: "thread-1",
      providerCommand: "node",
      providerArgs: [
        "-e",
        "console.log(JSON.stringify({ id: 999, error: { message: 'provider exploded' } })); setTimeout(() => process.exit(0), 20);",
      ],
    });
    const errors: Array<{ requestId: string | number; message: string }> = [];
    const unsubscribe = runtime.subscribeToEvents((event) => {
      if (event.event.type === "provider.rpc_error") {
        errors.push({ requestId: event.event.requestId, message: event.event.message });
      }
    });
    cleanup.push(unsubscribe);

    runtime.start();

    await expect.poll(() => errors).toContainEqual({
      requestId: 999,
      message: "provider exploded",
    });
  });

  it("routes RPC commands to the correct child when multiple providers are active", async () => {
    // This test catches the bug where ensureProviderForCommand() reads
    // this.providerChild (a shared mutable pointer) instead of routing
    // to the child that was spawned for the command's provider spec.
    //
    // Scenario: spawn child A, spawn child B (clobbers this.providerChild),
    // then send a command that should go to child A — verify it arrives at A.

    // Both children are echo-style JSON-RPC providers that include their
    // ROLE env var in every response so we can tell which child handled it.
    const echoProviderScript = [
      "process.stdin.setEncoding('utf8');",
      "let buffer='';",
      "process.stdin.on('data',chunk=>{",
      "buffer+=chunk;",
      "const parts=buffer.split(/\\r\\n|\\n|\\r/g);",
      "buffer=parts.pop() ?? '';",
      "for (const line of parts) {",
      "if (!line.trim()) continue;",
      "const msg = JSON.parse(line);",
      "if (msg.method === 'initialize') {",
      "console.log(JSON.stringify({ id: msg.id, result: { capabilities: {}, role: process.env.ROLE } }));",
      "} else if (msg.method === 'thread/start') {",
      "console.log(JSON.stringify({ id: msg.id, result: { threadId: `${process.env.ROLE}-thread`, role: process.env.ROLE } }));",
      "} else if (msg.method === 'turn/start') {",
      "console.log(JSON.stringify({ id: msg.id, result: { threadId: msg.params.threadId, role: process.env.ROLE } }));",
      "}",
      "}",
      "});",
    ].join("");

    const runtime = new EnvironmentAgentRuntime({
      threadId: "thread-1",
      providerId: "codex",
    });
    cleanup.push(() => runtime.shutdown());

    const specA: EnvironmentAgentProviderSpec = {
      command: "node",
      args: ["-e", echoProviderScript],
      env: { ROLE: "provider-A" },
    };
    const specB: EnvironmentAgentProviderSpec = {
      command: "node",
      args: ["-e", echoProviderScript],
      env: { ROLE: "provider-B" },
    };

    // 1. Spawn child A via provider.ensure with forThreadId
    runtime.ensureProviderStatus(specA, "thread-a");

    // 2. Send a command through child A to establish it works
    const ackA1 = await runtime.executeCommand({
      meta: {
        protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
        commandId: "cmd-a1",
        idempotencyKey: "cmd-a1",
        sentAt: 100,
      },
      command: {
        type: "thread.start",
        threadId: "thread-a",
        projectId: "proj-1",
        request: createStartRequest("proj-1"),
        context: createThreadContext("proj-1", "thread-a"),
        initialize: {
          method: "initialize",
          params: { clientInfo: { name: "bb", version: "0.0.1" } },
        },
      },
    });
    expect(ackA1.state).toBe("accepted");
    expect((ackA1.result as Record<string, unknown>).role).toBe("provider-A");

    // 3. Spawn child B with forThreadId — this clobbers this.providerChild
    runtime.ensureProviderStatus(specB, "thread-b");

    // 4. Send a command through child B to confirm it uses provider-B
    const ackB = await runtime.executeCommand({
      meta: {
        protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
        commandId: "cmd-b1",
        idempotencyKey: "cmd-b1",
        sentAt: 200,
      },
      command: {
        type: "thread.start",
        threadId: "thread-b",
        projectId: "proj-1",
        request: createStartRequest("proj-1"),
        context: createThreadContext("proj-1", "thread-b"),
        initialize: {
          method: "initialize",
          params: { clientInfo: { name: "bb", version: "0.0.1" } },
        },
      },
    });
    expect(ackB.state).toBe("accepted");
    expect((ackB.result as Record<string, unknown>).role).toBe("provider-B");

    // 5. NOW send a turn/run for thread-a WITHOUT calling
    // ensureProviderRunning(specA) first. The runtime must route this
    // to child A (mapped via forThreadId), not child B (this.providerChild).
    const ackA2 = await runtime.executeCommand({
      meta: {
        protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
        commandId: "cmd-a2",
        idempotencyKey: "cmd-a2",
        sentAt: 300,
      },
      command: {
        type: "turn.run",
        threadId: "thread-a",
        providerThreadId: "thread-a",
        input: [],
      },
    });
    expect(ackA2.state).toBe("accepted");
    // The critical assertion: the command must have been handled by
    // provider-A, not provider-B.
    expect((ackA2.result as Record<string, unknown>).role).toBe("provider-A");
  });

  it("does not re-initialize a provider child that was already initialized by another thread", async () => {
    // When two threads share an environment but use different providers,
    // each child is initialized once. Switching back to an already-initialized
    // child must NOT send initialize again — providers reject double-init
    // with "Already initialized".
    const echoProviderScript = [
      "process.stdin.setEncoding('utf8');",
      "let initialized = false;",
      "let buffer='';",
      "process.stdin.on('data',chunk=>{",
      "buffer+=chunk;",
      "const parts=buffer.split(/\\r\\n|\\n|\\r/g);",
      "buffer=parts.pop() ?? '';",
      "for (const line of parts) {",
      "if (!line.trim()) continue;",
      "const msg = JSON.parse(line);",
      "if (msg.method === 'initialize') {",
      "if (initialized) {",
      "console.log(JSON.stringify({ id: msg.id, error: { code: -32000, message: 'Already initialized' } }));",
      "} else {",
      "initialized = true;",
      "console.log(JSON.stringify({ id: msg.id, result: { capabilities: {} } }));",
      "}",
      "} else if (msg.method === 'thread/start') {",
      "console.log(JSON.stringify({ id: msg.id, result: { threadId: `provider-${process.env.ROLE ?? 'thread'}` } }));",
      "} else if (msg.method === 'turn/start') {",
      "console.log(JSON.stringify({ id: msg.id, result: { threadId: msg.params.threadId } }));",
      "}",
      "}",
      "});",
    ].join("");

    const runtime = new EnvironmentAgentRuntime({ threadId: "thread-1", providerId: "codex" });
    cleanup.push(() => runtime.shutdown());

    const specA: EnvironmentAgentProviderSpec = {
      command: "node",
      args: ["-e", echoProviderScript],
      env: { ROLE: "provider-A" },
    };
    const specB: EnvironmentAgentProviderSpec = {
      command: "node",
      args: ["-e", echoProviderScript],
      env: { ROLE: "provider-B" },
    };

    // Initialize child A via thread.start (which sends initialize first)
    runtime.ensureProviderStatus(specA, "thread-a");
    const ackA1 = await runtime.executeCommand({
      meta: {
        protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
        commandId: "cmd-a1",
        idempotencyKey: "cmd-a1",
        sentAt: 100,
      },
      command: {
        type: "thread.start",
        threadId: "thread-a",
        projectId: "proj-1",
        request: createStartRequest("proj-1"),
        context: createThreadContext("proj-1", "thread-a"),
        initialize: {
          method: "initialize",
          params: { clientInfo: { name: "bb", version: "0.0.1" } },
        },
      },
    });
    expect(ackA1.state).toBe("accepted");

    // Initialize child B
    runtime.ensureProviderStatus(specB, "thread-b");
    const ackB = await runtime.executeCommand({
      meta: {
        protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
        commandId: "cmd-b1",
        idempotencyKey: "cmd-b1",
        sentAt: 200,
      },
      command: {
        type: "thread.start",
        threadId: "thread-b",
        projectId: "proj-1",
        request: createStartRequest("proj-1"),
        context: createThreadContext("proj-1", "thread-b"),
        initialize: {
          method: "initialize",
          params: { clientInfo: { name: "bb", version: "0.0.1" } },
        },
      },
    });
    expect(ackB.state).toBe("accepted");

    // Now send another command for thread-a. Child A is already initialized.
    // Before the fix, providerInitializedPid was overwritten by child B's PID,
    // so the runtime would try to re-initialize child A → "Already initialized" error.
    const ackA2 = await runtime.executeCommand({
      meta: {
        protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
        commandId: "cmd-a2",
        idempotencyKey: "cmd-a2",
        sentAt: 300,
      },
      command: {
        type: "turn.run",
        threadId: "thread-a",
        providerThreadId: "thread-a",
        input: [],
        initialize: {
          method: "initialize",
          params: { clientInfo: { name: "bb", version: "0.0.1" } },
        },
      },
    });
    // Must succeed — child A was already initialized, no re-init should happen.
    expect(ackA2.state).toBe("accepted");
  });

  it("spawns separate children for specs with different env", async () => {
    const runtime = new EnvironmentAgentRuntime({ threadId: "thread-1" });
    const lines: string[] = [];
    const unsubscribe = runtime.subscribeToProviderStdout((line) => {
      lines.push(line);
    });
    cleanup.push(unsubscribe);
    cleanup.push(() => runtime.shutdown());

    // Spawn two provider children with the same command but different env.
    runtime.ensureProviderStatus({
      command: "node",
      args: ["-e", "console.log(JSON.stringify({ marker: process.env.MARKER })); process.stdin.resume();"],
      env: { MARKER: "child-A" },
    });
    runtime.ensureProviderStatus({
      command: "node",
      args: ["-e", "console.log(JSON.stringify({ marker: process.env.MARKER })); process.stdin.resume();"],
      env: { MARKER: "child-B" },
    });

    await expect.poll(() => lines.length).toBeGreaterThanOrEqual(2);

    const markers = lines
      .map((l) => { try { return JSON.parse(l).marker; } catch { return undefined; } })
      .filter(Boolean);
    expect(markers).toContain("child-A");
    expect(markers).toContain("child-B");
  });

  it("routes provider-initiated RPC responses back to the originating child", async () => {
    // Spawn two providers: child A sends a server request (tool call),
    // child B just idles. The RPC response must go to child A, not child B.
    const toolCalls: Array<{ requestId: string | number; method: string; toolCall?: unknown }> = [];
    const stdoutLines: string[] = [];
    const runtime = new EnvironmentAgentRuntime({
      threadId: "thread-1",
      providerId: "codex",
      onProviderRequest: async (request) => {
        toolCalls.push({
          requestId: request.requestId,
          method: request.method,
          toolCall: request.toolCall,
        });
        return {
          contentItems: [{ type: "inputText", text: "ok" }],
          success: true,
        };
      },
    });
    cleanup.push(() => runtime.shutdown());

    // Subscribe to stdout before spawning so we don't miss early output.
    const unsub = runtime.subscribeToProviderStdout((line) => {
      stdoutLines.push(line);
    });
    cleanup.push(unsub);

    // Child A: sends a provider-initiated RPC then echoes any stdin responses.
    runtime.ensureProviderStatus({
      command: "node",
      args: [
        "-e",
        [
          "console.log(JSON.stringify({ id: 42, method: 'item/tool/call', params: { tool: 'test' } }));",
          "process.stdin.setEncoding('utf8');",
          "let buffer='';",
          "process.stdin.on('data',chunk=>{",
          "buffer+=chunk;",
          "const parts=buffer.split(/\\r\\n|\\n|\\r/g);",
          "buffer=parts.pop() ?? '';",
          "for (const line of parts) { if (line.trim()) console.log('ECHO:' + line); }",
          "});",
        ].join(""),
      ],
      env: { ROLE: "requester" },
    });

    // Child B: just idles — but because it is spawned second, it becomes
    // `this.providerChild`. Before the fix, the RPC response would be
    // written to B's stdin instead of A's.
    runtime.ensureProviderStatus({
      command: "node",
      args: [
        "-e",
        [
          "process.stdin.setEncoding('utf8');",
          "process.stdin.on('data',chunk=>{",
          "console.log('WRONG_CHILD:' + chunk.trim());",
          "});",
          "setTimeout(() => {}, 10000);",
        ].join(""),
      ],
      env: { ROLE: "idle" },
    });

    // Wait for the tool call to arrive from child A.
    await expect.poll(() => toolCalls).toContainEqual({
      requestId: 42,
      method: "item/tool/call",
    });

    // The response should be echoed back by child A (not written to child B).
    await expect.poll(() =>
      stdoutLines.some((l) => l.startsWith("ECHO:") && l.includes('"id":42')),
    ).toBe(true);

    // Child B should NOT have received any data.
    expect(stdoutLines.filter((l) => l.startsWith("WRONG_CHILD:"))).toEqual([]);
  });

  it("only rejects requests for the exiting child, not siblings", async () => {
    const runtime = new EnvironmentAgentRuntime({ threadId: "thread-1", providerId: "codex" });
    cleanup.push(() => runtime.shutdown());

    // Child A: responds to initialize immediately, but delays thread/start
    // responses by 500ms so the request is still in-flight when child B exits.
    runtime.ensureProviderStatus({
      command: "node",
      args: [
        "-e",
        [
          "process.stdin.setEncoding('utf8');",
          "let buffer='';",
          "process.stdin.on('data',chunk=>{",
          "buffer+=chunk;",
          "const parts=buffer.split(/\\r\\n|\\n|\\r/g);",
          "buffer=parts.pop() ?? '';",
          "for (const line of parts) {",
          "if (!line.trim()) continue;",
          "const msg = JSON.parse(line);",
          "if (msg.method === 'initialize') {",
          "console.log(JSON.stringify({ id: msg.id, result: { capabilities: {} } }));",
          "} else if (msg.method === 'thread/start') {",
          "setTimeout(() => console.log(JSON.stringify({ id: msg.id, result: { threadId: 'provider-thread-1' } })), 500);",
          "}",
          "}",
          "});",
        ].join(""),
      ],
      env: { ROLE: "long-lived" },
    });

    // Start a command through child A — initialize completes immediately
    // but the thread/start response is delayed 500ms, keeping it in-flight.
    const commandPromise = runtime.executeCommand({
      meta: {
        protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
        commandId: "cmd-a",
        idempotencyKey: "cmd-a",
        sentAt: 100,
      },
      command: {
        type: "thread.start",
        threadId: "thread-1",
        projectId: "proj-1",
        request: createStartRequest("proj-1"),
        context: createThreadContext("proj-1", "thread-1"),
        initialize: {
          method: "initialize",
          params: { clientInfo: { name: "bb", version: "0.0.1" } },
        },
      },
    });

    // Give child A time to receive the command and start the delayed response,
    // then spawn child B which exits immediately.
    await new Promise((r) => setTimeout(r, 50));

    // Child B: exits immediately — its exit handler must NOT reject child A's
    // in-flight request.
    runtime.ensureProviderStatus({
      command: "node",
      args: ["-e", "process.exit(0);"],
      env: { ROLE: "short-lived" },
    });

    // Wait for child B to exit (it'll emit a degraded event).
    await expect.poll(() => {
      const snap = runtime.getQuiescenceSnapshot();
      return snap.hasObservedWork;
    }).toBe(true);

    // Child A's command should still resolve successfully — its in-flight
    // request must not have been rejected by child B's exit.
    const ack = await commandPromise;
    expect(ack.state).toBe("accepted");
    expect(ack.result).toEqual({ threadId: "provider-thread-1" });
  });

  it("derives unique managed HOME dirs for specs differing only in files", async () => {
    const runtime = new EnvironmentAgentRuntime({ threadId: "thread-1" });
    cleanup.push(() => runtime.shutdown());

    const lines: string[] = [];
    const unsubscribe = runtime.subscribeToProviderStdout((line) => {
      lines.push(line);
    });
    cleanup.push(unsubscribe);

    // Two specs identical except for file content. When BB materializes
    // provider files, the runtime should isolate the provider in a managed
    // HOME unless the provider explicitly sets HOME itself.
    runtime.ensureProviderStatus({
      command: "node",
      args: ["-e", "console.log(process.env.HOME); process.stdin.resume();"],
      files: [{ placement: "home", path: ".auth/token.json", content: '{"key":"aaa"}' }],
    });
    runtime.ensureProviderStatus({
      command: "node",
      args: ["-e", "console.log(process.env.HOME); process.stdin.resume();"],
      files: [{ placement: "home", path: ".auth/token.json", content: '{"key":"bbb"}' }],
    });

    await expect.poll(() => lines.length).toBeGreaterThanOrEqual(2);

    const homes = lines.filter((l) => l.includes("provider-home-"));
    expect(homes.length).toBeGreaterThanOrEqual(2);
    // The two HOME paths must be different since file content differs
    expect(homes[0]).not.toBe(homes[1]);
  });

  it("does not leak raw secrets into managed HOME directory names", async () => {
    const runtime = new EnvironmentAgentRuntime({ threadId: "thread-1" });
    cleanup.push(() => runtime.shutdown());

    const secretKey = "sk-super-secret-api-key-12345";

    const lines: string[] = [];
    const unsubscribe = runtime.subscribeToProviderStdout((line) => {
      lines.push(line);
    });
    cleanup.push(unsubscribe);

    runtime.ensureProviderStatus({
      command: "node",
      args: ["-e", "console.log(process.env.HOME); process.stdin.resume();"],
      env: { API_KEY: secretKey },
      files: [{ placement: "home", path: ".config/auth.json", content: `{"apiKey":"${secretKey}"}` }],
    });

    await expect.poll(() => lines.length).toBeGreaterThanOrEqual(1);

    const homePath = lines.find((l) => l.includes("provider-home-"));
    expect(homePath).toBeDefined();
    // The path must NOT contain any part of the secret key
    expect(homePath).not.toContain("secret");
    expect(homePath).not.toContain(secretKey);
    // It should be a hex hash (32 hex chars)
    const match = homePath!.match(/provider-home-([0-9a-f]+)/);
    expect(match).toBeTruthy();
    expect(match![1]).toHaveLength(32);
    expect(match![1]).toMatch(/^[0-9a-f]+$/);
  });

  it("preserves an explicit provider HOME when files are materialized", async () => {
    const runtime = new EnvironmentAgentRuntime({ threadId: "thread-1" });
    cleanup.push(() => runtime.shutdown());

    const lines: string[] = [];
    const unsubscribe = runtime.subscribeToProviderStdout((line) => {
      lines.push(line);
    });
    cleanup.push(unsubscribe);

    runtime.ensureProviderStatus({
      command: "node",
      args: ["-e", "console.log(process.env.HOME); process.stdin.resume();"],
      env: { HOME: "/tmp/bb-explicit-home" },
      files: [{ placement: "home", path: ".config/auth.json", content: '{"token":"abc"}' }],
    });

    await expect.poll(() => lines.length).toBeGreaterThanOrEqual(1);
    expect(lines).toContain("/tmp/bb-explicit-home");
  });

  it("derives CODEX_HOME from the managed provider HOME by default", async () => {
    const runtime = new EnvironmentAgentRuntime({ threadId: "thread-1" });
    cleanup.push(() => runtime.shutdown());

    const lines: string[] = [];
    const unsubscribe = runtime.subscribeToProviderStdout((line) => {
      lines.push(line);
    });
    cleanup.push(unsubscribe);

    runtime.ensureProviderStatus({
      command: "node",
      args: [
        "-e",
        "console.log(JSON.stringify({ HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME })); process.stdin.resume();",
      ],
      files: [{ placement: "home", path: ".config/auth.json", content: '{"token":"abc"}' }],
    });

    await expect.poll(() => lines.length).toBeGreaterThanOrEqual(1);
    const payload = JSON.parse(lines[0] ?? "{}") as { HOME?: string; CODEX_HOME?: string };
    expect(payload.HOME).toContain("provider-home-");
    expect(payload.CODEX_HOME).toBe(`${payload.HOME}/.codex`);
  });

  it("resolves provider server requests through the callback", async () => {
    const requests: Array<{
      requestId: string | number;
      method: string;
      params?: unknown;
      providerId?: string;
      normalizedMethod?: string;
      toolCall?: unknown;
    }> = [];
    const stdout: string[] = [];
    const runtime = new EnvironmentAgentRuntime({
      threadId: "thread-1",
      providerId: "codex",
      providerCommand: "node",
      providerArgs: [
        "-e",
        [
          "console.log(JSON.stringify({ id: 61, method: 'item/tool/call', params: { tool: 'echo', arguments: { text: 'hi' } } }));",
          "console.log(JSON.stringify({ id: 62, method: 'item/tool/call', params: { threadId: 'provider-thread-1', turnId: 'turn-1', callId: 'call-1', tool: 'echo', arguments: { text: 'hi' } } }));",
          "process.stdin.setEncoding('utf8');",
          "let buffer='';",
          "process.stdin.on('data',chunk=>{",
          "buffer+=chunk;",
          "const parts=buffer.split(/\\r\\n|\\n|\\r/g);",
          "buffer=parts.pop() ?? '';",
          "for (const line of parts) { if (line.trim()) console.log(line); }",
          "});",
          "setTimeout(() => process.exit(0), 100);",
        ].join(""),
      ],
      onProviderRequest: async (request) => {
        requests.push(request);
        return {
          success: true,
          contentItems: [{ type: "inputText", text: "ok" }],
        };
      },
    });
    const unsubscribe = runtime.subscribeToProviderStdout((line) => {
      stdout.push(line);
    });
    cleanup.push(unsubscribe);

    runtime.start();

    await expect
      .poll(() =>
        requests.find((request) => {
          return request.requestId === 62;
        }),
      )
      .toEqual({
        requestId: 62,
        method: "item/tool/call",
        params: {
          threadId: "provider-thread-1",
          turnId: "turn-1",
          callId: "call-1",
          tool: "echo",
          arguments: { text: "hi" },
        },
        providerId: "codex",
        normalizedMethod: "item/tool/call",
        toolCall: {
          requestId: 62,
          threadId: "provider-thread-1",
          turnId: "turn-1",
          callId: "call-1",
          tool: "echo",
          arguments: { text: "hi" },
        },
      });
    await expect.poll(() =>
      stdout.some((line) => line.includes('"id":62') && line.includes('"result"')),
    ).toBe(true);
  });

  it("decodes provider server requests using the child provider identity in shared environments", async () => {
    const requests: Array<{
      providerId?: string;
      method: string;
      toolCall?: unknown;
    }> = [];
    const providerScript = [
      "console.log(JSON.stringify({ id: 77, method: 'item/tool/call', params: { threadId: 'provider-thread-shared', turnId: 'turn-1', callId: 'call-1', tool: 'echo', arguments: { text: process.env.ROLE } } }));",
      "process.stdin.setEncoding('utf8');",
      "let buffer='';",
      "process.stdin.on('data',chunk=>{",
      "buffer+=chunk;",
      "const parts=buffer.split(/\\r\\n|\\n|\\r/g);",
      "buffer=parts.pop() ?? '';",
      "for (const line of parts) { if (line.trim()) console.log(line); }",
      "});",
      "setTimeout(() => process.exit(0), 100);",
    ].join("");

    const runtime = new EnvironmentAgentRuntime({
      threadId: "owner-thread",
      providerId: "codex",
      onProviderRequest: async (request) => {
        requests.push(request);
        return {
          success: true,
          contentItems: [{ type: "inputText", text: "ok" }],
        };
      },
    });
    cleanup.push(() => runtime.shutdown());

    await runtime.executeCommand({
      meta: {
        protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
        commandId: "ensure-claude",
        idempotencyKey: "ensure-claude",
        sentAt: Date.now(),
      },
      command: {
        type: "provider.ensure",
        providerId: "claude-code",
        forThreadId: "thread-claude",
        command: "node",
        args: ["-e", providerScript],
        env: { ROLE: "provider-claude" },
      },
    });

    await expect
      .poll(
        () =>
          requests.find((request) => request.providerId === "claude-code"),
        { timeout: 5_000 },
      )
      .toMatchObject({
        providerId: "claude-code",
        method: "item/tool/call",
        toolCall: {
          threadId: "provider-thread-shared",
          turnId: "turn-1",
          callId: "call-1",
          tool: "echo",
        },
      });
  });
});
