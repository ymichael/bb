import type {
  EnvironmentAgentAckRequest,
  EnvironmentAgentAckResponse,
  EnvironmentAgentClient,
  EnvironmentAgentProviderSpec,
  EnvironmentAgentProviderStatus,
  EnvironmentAgentReplayRequest,
  EnvironmentAgentReplayResponse,
  EnvironmentAgentStatusSnapshot,
  JsonLineTransport,
  JsonLineTransportHandlers,
} from "@beanbag/environment-agent";
import { describe, expect, it, vi } from "vitest";
import { AgentServer } from "../agent-server.js";
import { createCodexProviderAdapter } from "../codex-provider-adapter.js";

const ENVIRONMENT_AGENT_PROTOCOL_VERSION = 1 as const;

class FakeJsonLineTransport implements JsonLineTransport {
  private handlers: JsonLineTransportHandlers | undefined;
  readonly sentLines: string[] = [];

  setHandlers(handlers: JsonLineTransportHandlers): void {
    this.handlers = handlers;
  }

  send(line: string): void {
    this.sentLines.push(line);

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }

    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      (parsed as { jsonrpc?: unknown }).jsonrpc === "2.0"
    ) {
      const message = parsed as { id?: unknown; method?: unknown };
      if (message.method === "thread/start") {
        this.emitLiveEvent({
          protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
          sequence: 1,
          emittedAt: 999,
          threadId: "thread-1",
          event: {
            type: "environment.ready",
            threadId: "thread-1",
          },
        });
      }

      this.handlers?.onLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result:
            message.method === "thread/start"
              ? { threadId: "provider-thread-1" }
              : {},
        }),
      );
    }
  }

  close(reason?: Error): void {
    this.handlers?.onClose?.(reason);
  }

  emitLiveEvent(payload: {
    protocolVersion: number;
    sequence: number;
    emittedAt: number;
    threadId: string;
    event: {
      type: string;
      threadId: string;
      method?: string;
      payload?: unknown;
    };
  }): void {
    this.handlers?.onLine(
      JSON.stringify({
        environmentAgentMessage: true,
        type: "event.emitted",
        payload,
      }),
    );
  }
}

function createFakeEnvironmentAgentClient() {
  const providerTransport = new FakeJsonLineTransport();
  const acknowledgements: number[] = [];

  const client: EnvironmentAgentClient = {
    providerTransport,
    ensureProviderRunning: async (
      _spec: EnvironmentAgentProviderSpec,
    ): Promise<EnvironmentAgentProviderStatus> => ({
      running: true,
      launched: true,
      pid: 12345,
    }),
    retryDaemonDelivery: async (): Promise<EnvironmentAgentStatusSnapshot> => ({
      protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
      threadId: "thread-1",
      latestSequence: 3,
      connectedToDaemon: true,
      pendingEventCount: 2,
      pendingCommandCount: 0,
    }),
    acknowledge: async (
      request: EnvironmentAgentAckRequest,
    ): Promise<EnvironmentAgentAckResponse> => {
      acknowledgements.push(request.sequence);
      return {
        protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
        threadId: request.threadId,
        acknowledgedSequence: request.sequence,
      };
    },
    replay: async (
      request: EnvironmentAgentReplayRequest,
    ): Promise<EnvironmentAgentReplayResponse> => ({
      protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
      fromSequenceExclusive: request.afterSequence,
      toSequenceInclusive: 3,
      hasMore: false,
      events: [
        {
          protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
          sequence: 2,
          emittedAt: 1000,
          threadId: "thread-1",
          event: {
            type: "environment.ready",
            threadId: "thread-1",
          },
        },
      ],
    }),
    status: async (): Promise<EnvironmentAgentStatusSnapshot> => ({
      protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
      threadId: "thread-1",
      latestSequence: 3,
      connectedToDaemon: true,
      pendingEventCount: 2,
      pendingCommandCount: 0,
    }),
    getLatestObservedSequence: () => 1,
    close: vi.fn(),
  };

  return { client, providerTransport, acknowledgements };
}

describe("AgentServer environment-agent control plane", () => {
  it("surfaces environment-agent status, replay, and ack through the session", async () => {
    const agentServer = new AgentServer({
      provider: createCodexProviderAdapter(),
    });
    const { client, acknowledgements } = createFakeEnvironmentAgentClient();

    await agentServer.startSession({
      threadId: "thread-1",
      connectSession: () => ({
        transport: "http",
        client,
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
      events: [
        expect.objectContaining({
          sequence: 2,
        }),
      ],
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

    expect(acknowledgements).toContain(1);
  });

  it("ingests replayed provider notifications through the normal notification path", async () => {
    const onNotification = vi.fn();
    const agentServer = new AgentServer({
      provider: createCodexProviderAdapter(),
      onNotification,
    });
    const { client, acknowledgements } = createFakeEnvironmentAgentClient();

    await agentServer.startSession({
      threadId: "thread-1",
      connectSession: () => ({
        transport: "http",
        client,
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
          emittedAt: 1000,
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
    expect(acknowledgements).toContain(5);
  });
});
