import {
  ENVIRONMENT_AGENT_PROTOCOL_VERSION,
  type EnvironmentAgentEventEnvelope,
} from "@beanbag/environment-agent";
import { describe, expect, it, vi } from "vitest";
import { AgentServer, AgentServerSessionError } from "../agent-server.js";
import { createCodexProviderAdapter } from "../codex-provider-adapter.js";
import { createEnvironmentAgentSimulator } from "./helpers/environment-agent-simulator.js";

describe("AgentServer environment-agent control plane", () => {
  it("surfaces environment-agent status, replay, and ack through the session", async () => {
    const agentServer = new AgentServer({
      provider: createCodexProviderAdapter(),
    });
    const simulator = createEnvironmentAgentSimulator();

    simulator.setReplayEvents([
      {
        protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
        sequence: 2,
        emittedAt: 1_000,
        threadId: "thread-1",
        event: {
          type: "environment.ready",
          threadId: "thread-1",
        },
      } satisfies EnvironmentAgentEventEnvelope,
      {
        protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
        sequence: 3,
        emittedAt: 1_001,
        threadId: "thread-1",
        event: {
          type: "provider.event",
          threadId: "thread-1",
          method: "turn/completed",
          payload: { turnId: "turn-1" },
        },
      } satisfies EnvironmentAgentEventEnvelope,
    ]);

    await agentServer.startSession({
      threadId: "thread-1",
      connectSession: () => ({
        transport: "http",
        client: simulator.createClient(),
      }),
      request: {
        projectId: "project-1",
        title: "Test thread",
        input: [{ type: "text", text: "hello" }],
      },
      context: {
        projectId: "project-1",
        threadId: "thread-1",
        path: process.env.PATH ?? "",
      },
    });

    await expect(agentServer.getEnvironmentAgentStatus("thread-1")).resolves.toMatchObject({
      latestSequence: 3,
      pendingEventCount: 2,
    });

    await expect(
      agentServer.replayEnvironmentAgentEvents({
        threadId: "thread-1",
        afterSequence: 1,
      }),
    ).resolves.toMatchObject({
      fromSequenceExclusive: 1,
      toSequenceInclusive: 3,
      events: expect.arrayContaining([
        expect.objectContaining({
          sequence: 2,
        }),
      ]),
    });

    await expect(
      agentServer.acknowledgeEnvironmentAgent({
        threadId: "thread-1",
        sequence: 3,
      }),
    ).resolves.toMatchObject({
      acknowledgedSequence: 3,
      threadId: "thread-1",
    });

    expect(simulator.ackRequests.map((request) => request.sequence)).toContain(1);
  });

  it("ingests replayed provider notifications through the normal notification path", async () => {
    const onNotification = vi.fn();
    const agentServer = new AgentServer({
      provider: createCodexProviderAdapter(),
      onNotification,
    });
    const simulator = createEnvironmentAgentSimulator();

    await agentServer.startSession({
      threadId: "thread-1",
      connectSession: () => ({
        transport: "http",
        client: simulator.createClient(),
      }),
      request: {
        projectId: "project-1",
        title: "Test thread",
        input: [{ type: "text", text: "hello" }],
      },
      context: {
        projectId: "project-1",
        threadId: "thread-1",
        path: process.env.PATH ?? "",
      },
    });

    await agentServer.ingestReplayedEnvironmentAgentEvents({
      threadId: "thread-1",
      events: [
        {
          protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
          sequence: 5,
          emittedAt: 1_000,
          threadId: "thread-1",
          event: {
            type: "provider.event",
            threadId: "thread-1",
            method: "turn/started",
            payload: { turnId: "turn-2" },
          },
        },
      ],
    });

    expect(onNotification).toHaveBeenCalledWith(
      "thread-1",
      expect.objectContaining({
        method: "turn/started",
        normalizedMethod: "turn/started",
      }),
    );
    expect(simulator.ackRequests.map((request) => request.sequence)).toContain(5);
  });

  it("preserves replay window semantics through the session", async () => {
    const agentServer = new AgentServer({
      provider: createCodexProviderAdapter(),
    });
    const simulator = createEnvironmentAgentSimulator();

    simulator.setReplayEvents([
      {
        protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
        sequence: 1,
        emittedAt: 1_000,
        threadId: "thread-1",
        event: {
          type: "environment.ready",
          threadId: "thread-1",
        },
      } satisfies EnvironmentAgentEventEnvelope,
      {
        protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
        sequence: 2,
        emittedAt: 1_001,
        threadId: "thread-1",
        event: {
          type: "provider.event",
          threadId: "thread-1",
          method: "turn/started",
          payload: { turnId: "turn-1" },
        },
      } satisfies EnvironmentAgentEventEnvelope,
      {
        protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
        sequence: 3,
        emittedAt: 1_002,
        threadId: "thread-1",
        event: {
          type: "provider.event",
          threadId: "thread-1",
          method: "turn/completed",
          payload: { turnId: "turn-1" },
        },
      } satisfies EnvironmentAgentEventEnvelope,
    ]);

    await agentServer.startSession({
      threadId: "thread-1",
      connectSession: () => ({
        transport: "http",
        client: simulator.createClient(),
      }),
      request: {
        projectId: "project-1",
        title: "Test thread",
        input: [{ type: "text", text: "hello" }],
      },
      context: {
        projectId: "project-1",
        threadId: "thread-1",
        path: process.env.PATH ?? "",
      },
    });

    await expect(
      agentServer.replayEnvironmentAgentEvents({
        threadId: "thread-1",
        afterSequence: 0,
        limit: 2,
      }),
    ).resolves.toMatchObject({
      fromSequenceExclusive: 0,
      toSequenceInclusive: 2,
      hasMore: true,
      events: [
        expect.objectContaining({ sequence: 1 }),
        expect.objectContaining({ sequence: 2 }),
      ],
    });

    await expect(
      agentServer.replayEnvironmentAgentEvents({
        threadId: "thread-1",
        afterSequence: 2,
        limit: 2,
      }),
    ).resolves.toMatchObject({
      fromSequenceExclusive: 2,
      toSequenceInclusive: 3,
      hasMore: false,
      events: [expect.objectContaining({ sequence: 3 })],
    });
  });

  it("acknowledges live provider notifications at the highest observed sequence", async () => {
    const onNotification = vi.fn();
    const agentServer = new AgentServer({
      provider: createCodexProviderAdapter(),
      onNotification,
    });
    const simulator = createEnvironmentAgentSimulator();

    await agentServer.startSession({
      threadId: "thread-1",
      connectSession: () => ({
        transport: "http",
        client: simulator.createClient(),
      }),
      request: {
        projectId: "project-1",
        title: "Test thread",
        input: [{ type: "text", text: "hello" }],
      },
      context: {
        projectId: "project-1",
        threadId: "thread-1",
        path: process.env.PATH ?? "",
      },
    });

    simulator.emitProviderNotification("turn/started", { turnId: "turn-2" }, { sequence: 2 });
    await vi.waitFor(() => {
      expect(simulator.ackRequests.map((request) => request.sequence)).toContain(2);
    });
    expect(agentServer.getSessionState("thread-1")).toMatchObject({
      activeTurnId: "turn-2",
    });

    simulator.emitProviderNotification("turn/completed", { turnId: "turn-2" }, { sequence: 3 });
    await vi.waitFor(() => {
      expect(simulator.ackRequests.map((request) => request.sequence)).toContain(3);
    });
    expect(onNotification).toHaveBeenCalledWith(
      "thread-1",
      expect.objectContaining({
        method: "turn/completed",
        normalizedMethod: "turn/completed",
      }),
    );
    expect(agentServer.getSessionState("thread-1")).toMatchObject({
      activeTurnId: undefined,
    });
  });

  it("drops the session when the environment-agent transport closes", async () => {
    const onSessionExit = vi.fn();
    const agentServer = new AgentServer({
      provider: createCodexProviderAdapter(),
      onSessionExit,
    });
    const simulator = createEnvironmentAgentSimulator();

    await agentServer.startSession({
      threadId: "thread-1",
      connectSession: () => ({
        transport: "http",
        client: simulator.createClient(),
      }),
      request: {
        projectId: "project-1",
        title: "Test thread",
        input: [{ type: "text", text: "hello" }],
      },
      context: {
        projectId: "project-1",
        threadId: "thread-1",
        path: process.env.PATH ?? "",
      },
    });

    simulator.close(new Error("socket closed"));

    await vi.waitFor(() => {
      expect(agentServer.isSessionActive("thread-1")).toBe(false);
    });
    expect(onSessionExit).toHaveBeenCalledWith("thread-1", {
      code: null,
      signal: null,
    });
    await expect(agentServer.getEnvironmentAgentStatus("thread-1")).rejects.toMatchObject({
      code: "inactive_session",
    } satisfies Partial<AgentServerSessionError>);
  });

  it("maps provider rpc failures through the environment-agent-backed runtime", async () => {
    const agentServer = new AgentServer({
      provider: createCodexProviderAdapter(),
    });
    const simulator = createEnvironmentAgentSimulator();

    simulator.onProviderRequest("thread/start", () => ({
      error: {
        code: -32_000,
        message: "provider exploded",
      },
    }));

    await expect(
      agentServer.startSession({
        threadId: "thread-1",
        connectSession: () => ({
          transport: "http",
          client: simulator.createClient(),
        }),
        request: {
          projectId: "project-1",
          title: "Test thread",
          input: [{ type: "text", text: "hello" }],
        },
        context: {
          projectId: "project-1",
          threadId: "thread-1",
          path: process.env.PATH ?? "",
        },
      }),
    ).rejects.toMatchObject({
      code: "provider_rpc_error",
      name: "AgentServerSessionError",
    } satisfies Partial<AgentServerSessionError>);
  });
});
