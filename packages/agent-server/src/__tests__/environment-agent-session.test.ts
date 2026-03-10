import {
  ENVIRONMENT_AGENT_PROTOCOL_VERSION,
  type EnvironmentAgentEventEnvelope,
} from "@beanbag/environment-agent";
import { describe, expect, it, vi } from "vitest";
import { AgentServer, AgentServerSessionError } from "../agent-server.js";
import { createCodexProviderAdapter } from "../codex-provider-adapter.js";
import { createEnvironmentAgentSimulator } from "./helpers/environment-agent-simulator.js";

describe("AgentServer environment-agent control plane", () => {
  it("passes resolved provider launch auth through provider ensure", async () => {
    const provider = createCodexProviderAdapter();
    provider.resolveLaunchConfiguration = async () => ({
      env: {
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
    const agentServer = new AgentServer({ provider });
    const simulator = createEnvironmentAgentSimulator();

    await agentServer.startThreadCommand({
      client: simulator.createClient(),
      threadId: "thread-1",
      projectId: "project-1",
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

    expect(simulator.ensureRequests).toContainEqual(
      expect.objectContaining({
        command: "codex",
        args: ["app-server"],
        env: {
          OPENAI_API_KEY: "sk-test-123",
        },
        files: [
          {
            placement: "home",
            path: ".codex/auth.json",
            content: '{"auth_mode":"chatgpt"}',
          },
        ],
      }),
    );
  });

  it("starts threads through stateless environment-agent commands", async () => {
    const agentServer = new AgentServer({
      provider: createCodexProviderAdapter(),
    });
    const simulator = createEnvironmentAgentSimulator();

    const started = await agentServer.startThreadCommand({
      client: simulator.createClient(),
      threadId: "thread-1",
      projectId: "project-1",
      request: {
        projectId: "project-1",
        input: [{ type: "text", text: "hello" }],
      },
      context: {
        projectId: "project-1",
        threadId: "thread-1",
        path: process.env.PATH ?? "",
      },
    });

    expect(started).toEqual({ providerThreadId: "provider-thread-1" });
    expect(simulator.ensureRequests).toContainEqual(
      expect.objectContaining({
        command: "codex",
        args: ["app-server"],
      }),
    );
    expect(simulator.providerRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: "initialize" }),
        expect.objectContaining({ method: "thread/start" }),
      ]),
    );
  });

  it("resumes threads through stateless environment-agent commands", async () => {
    const agentServer = new AgentServer({
      provider: createCodexProviderAdapter(),
    });
    const simulator = createEnvironmentAgentSimulator();

    const resumed = await agentServer.resumeThreadCommand({
      client: simulator.createClient(),
      threadId: "thread-1",
      projectId: "project-1",
      providerThreadId: "provider-thread-1",
      context: {
        projectId: "project-1",
        threadId: "thread-1",
        path: process.env.PATH ?? "",
      },
    });

    expect(resumed).toEqual({ providerThreadId: "provider-thread-1" });
    expect(simulator.providerRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: "initialize" }),
        expect.objectContaining({ method: "thread/resume" }),
      ]),
    );
  });

  it("sends turn commands through stateless environment-agent commands", async () => {
    const agentServer = new AgentServer({
      provider: createCodexProviderAdapter(),
    });
    const simulator = createEnvironmentAgentSimulator();
    simulator.onProviderRequest("turn/steer", () => ({ result: { ok: true } }));

    const sent = await agentServer.sendTurnCommand({
      client: simulator.createClient(),
      threadId: "thread-1",
      providerThreadId: "provider-thread-1",
      activeTurnId: "turn-1",
      input: [{ type: "text", text: "keep going" }],
      mode: "steer",
      context: {
        projectId: "project-1",
        threadId: "thread-1",
        path: process.env.PATH ?? "",
      },
    });

    expect(sent).toEqual({
      mode: "steer",
      providerThreadId: "provider-thread-1",
    });
    expect(simulator.providerRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: "initialize" }),
        expect.objectContaining({ method: "turn/steer" }),
      ]),
    );
  });

  it("renames threads through stateless environment-agent commands", async () => {
    const agentServer = new AgentServer({
      provider: createCodexProviderAdapter(),
    });
    const simulator = createEnvironmentAgentSimulator();
    simulator.onProviderRequest("thread/name/set", () => ({ result: { ok: true } }));

    await expect(
      agentServer.renameThreadCommand({
        client: simulator.createClient(),
        threadId: "thread-1",
        providerThreadId: "provider-thread-1",
        title: "Renamed thread",
        context: {
          projectId: "project-1",
          threadId: "thread-1",
          path: process.env.PATH ?? "",
        },
      }),
    ).resolves.toBeUndefined();

    expect(simulator.providerRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: "initialize" }),
        expect.objectContaining({ method: "thread/name/set" }),
      ]),
    );
  });

  it("maps provider rpc failures through stateless command acks", async () => {
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
      agentServer.startThreadCommand({
        client: simulator.createClient(),
        threadId: "thread-1",
        projectId: "project-1",
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

  it("ingests replayed provider notifications through the normal notification path", async () => {
    const onNotification = vi.fn();
    const agentServer = new AgentServer({
      provider: createCodexProviderAdapter(),
      onNotification,
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
  });

  it("ingests replayed provider stderr through the normal warning path", async () => {
    const logger = {
      warn: vi.fn(),
      error: vi.fn(),
    };
    const agentServer = new AgentServer({
      provider: createCodexProviderAdapter(),
      logger,
    });

    await expect(
      agentServer.ingestReplayedEnvironmentAgentEvents({
        threadId: "thread-1",
        events: [
          {
            protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
            sequence: 6,
            emittedAt: 1_000,
            threadId: "thread-1",
            event: {
              type: "provider.stderr",
              threadId: "thread-1",
              line: "refresh token has already been used",
            },
          },
        ],
      }),
    ).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("provider auth refresh conflict"),
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("ingests replayed provider rpc errors through the normal logger path", async () => {
    const logger = {
      warn: vi.fn(),
      error: vi.fn(),
    };
    const agentServer = new AgentServer({
      provider: createCodexProviderAdapter(),
      logger,
    });

    await expect(
      agentServer.ingestReplayedEnvironmentAgentEvents({
        threadId: "thread-1",
        events: [
          {
            protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
            sequence: 7,
            emittedAt: 1_000,
            threadId: "thread-1",
            event: {
              type: "provider.rpc_error",
              threadId: "thread-1",
              requestId: 999,
              message: "provider exploded",
            },
          },
        ],
      }),
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      "[thread thread-1] Provider RPC error (request 999):",
      "provider exploded",
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("preserves replay window semantics through delivered event envelopes", async () => {
    const collected: EnvironmentAgentEventEnvelope[] = [];
    const agentServer = new AgentServer({
      provider: createCodexProviderAdapter(),
      onNotification: vi.fn(),
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

    const replay = await simulator.createClient().replay({
      protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
      afterSequence: 0,
      limit: 2,
      threadId: "thread-1",
    });
    collected.push(...replay.events);
    await agentServer.ingestReplayedEnvironmentAgentEvents({
      threadId: "thread-1",
      events: replay.events,
    });

    expect(collected).toHaveLength(2);
    expect(replay).toMatchObject({
      fromSequenceExclusive: 0,
      toSequenceInclusive: 2,
      hasMore: true,
    });
  });
});
