import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EnvironmentAgentRuntime } from "./runtime.js";
import { ENVIRONMENT_AGENT_PROTOCOL_VERSION } from "./protocol.js";

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    const fn = cleanup.pop();
    await fn?.();
  }
});

describe("EnvironmentAgentRuntime", () => {
  it("records sequenced events and reports basic status", () => {
    const runtime = new EnvironmentAgentRuntime({ threadId: "thread-1" });

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
    const runtime = new EnvironmentAgentRuntime({ threadId: "thread-1" });

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
    const runtime = new EnvironmentAgentRuntime({ threadId: "thread-1" });
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
    const runtime = new EnvironmentAgentRuntime({ threadId: "thread-1" });

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
    const tempHome = await mkdtemp(join(tmpdir(), "beanbag-env-agent-runtime-"));
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

  it("accepts explicit commands and forwards them to the provider transport", async () => {
    const runtime = new EnvironmentAgentRuntime({
      threadId: "thread-1",
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
        params: { model: "gpt-5" },
        initialize: {
          method: "initialize",
          params: { clientInfo: { name: "beanbag", version: "0.0.1" } },
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

  it("resolves provider server requests through the callback", async () => {
    const requests: Array<{ requestId: string | number; method: string; params?: unknown }> = [];
    const stdout: string[] = [];
    const runtime = new EnvironmentAgentRuntime({
      threadId: "thread-1",
      providerCommand: "node",
      providerArgs: [
        "-e",
        [
          "console.log(JSON.stringify({ id: 61, method: 'item/tool/call', params: { tool: 'echo', arguments: { text: 'hi' } } }));",
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

    await expect.poll(() => requests).toContainEqual({
      requestId: 61,
      method: "item/tool/call",
      params: { tool: "echo", arguments: { text: "hi" } },
    });
    await expect.poll(() =>
      stdout.some((line) => line.includes('"id":61') && line.includes('"result"')),
    ).toBe(true);
  });
});
