import { describe, expect, it, vi } from "vitest";
import {
  EnvironmentAgentSessionHttpClient,
  EnvironmentAgentSessionHttpClientError,
  isEnvironmentAgentSessionInactiveError,
  createEnvironmentAgentSessionHttpClientFromConnection,
} from "./session-http-client.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("EnvironmentAgentSessionHttpClient", () => {
  it("calls the daemon session endpoints with the expected payloads", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(201, {
          protocol: "beanbag.env-agent.v1",
          type: "session_welcome",
          messageId: "msg-1",
          sessionId: "sess-1",
          sentAt: 1_000,
          payload: {
            leaseTtlMs: 30_000,
            heartbeatIntervalMs: 10_000,
            protocolVersion: 1,
            channels: [],
          },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          protocol: "beanbag.env-agent.v1",
          type: "event_ack",
          messageId: "msg-2",
          sessionId: "sess-1",
          sentAt: 2_000,
          payload: {
            channels: [
              {
                channelId: "thread-1",
                ackedThrough: { generation: 1, sequence: 2 },
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          protocol: "beanbag.env-agent.v1",
          type: "command_batch",
          messageId: "msg-3",
          sessionId: "sess-1",
          sentAt: 3_000,
          payload: { commands: [] },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const client = new EnvironmentAgentSessionHttpClient({
      daemonUrl: "http://127.0.0.1:3333/api/v1",
      threadId: "thread-1",
      authToken: "token-1",
      fetchImpl,
    });

    await expect(client.openSession({
      agentId: "agent-1",
      agentInstanceId: "instance-1",
      supportedProtocolVersions: [1],
      channels: [{ channelId: "thread-1", generation: 1 }],
    })).resolves.toMatchObject({ type: "session_welcome", sessionId: "sess-1" });

    await expect(client.heartbeat("sess-1", {
      agentObservedAt: 2_000,
      outboxDepth: 0,
      channels: [],
    })).resolves.toBeUndefined();

    await expect(client.pushEvents({
      sessionId: "sess-1",
      payload: {
        batches: [
          {
            channelId: "thread-1",
            generation: 1,
            events: [
              {
                sequence: 2,
                eventId: "evt-2",
                emittedAt: 2_500,
                event: {
                  type: "provider.stderr",
                  threadId: "thread-1",
                  line: "stderr 2",
                },
              },
            ],
          },
        ],
      },
    })).resolves.toMatchObject({ type: "event_ack" });

    await expect(client.pullCommands({
      sessionId: "sess-1",
      afterCursor: 3,
      limit: 5,
      waitMs: 5_000,
    })).resolves.toMatchObject({ type: "command_batch" });

    await expect(client.acknowledgeCommands("sess-1", {
      commands: [
        {
          commandId: "cmd-1",
          channelId: "thread-1",
          state: "received",
        },
      ],
    })).resolves.toBeUndefined();

    await expect(client.sendCommandResult("sess-1", {
      commandId: "cmd-1",
      channelId: "thread-1",
      state: "completed",
      result: { ok: true },
    })).resolves.toBeUndefined();

    await expect(client.closeSession("sess-1", "agent_shutdown")).resolves.toBeUndefined();

    const requests = fetchImpl.mock.calls.map(([url, init]) => ({
      url: String(url),
      method: init?.method ?? "GET",
    }));

    expect(requests).toEqual(
      expect.arrayContaining([
        {
          url: "http://127.0.0.1:3333/api/v1/threads/thread-1/env-daemon/session/open",
          method: "POST",
        },
        {
          url: "http://127.0.0.1:3333/api/v1/threads/thread-1/env-daemon/session/commands?sessionId=sess-1&afterCursor=3&limit=5&waitMs=5000",
          method: "GET",
        },
        {
          url: "http://127.0.0.1:3333/api/v1/threads/thread-1/env-daemon/session/messages",
          method: "POST",
        },
      ]),
    );
  });

  it("constructs from daemon connection config and raises useful HTTP errors", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () =>
      jsonResponse(409, {
        code: "inactive_session",
        message: "Environment-agent session sess-1 is not active",
      }),
    );
    const client = createEnvironmentAgentSessionHttpClientFromConnection(
      {
        daemonUrl: "http://127.0.0.1:3333/api/v1",
        threadId: "thread-1",
        authToken: "token-1",
      },
      { fetchImpl },
    );

    await expect(client.pullCommands({ sessionId: "sess-1" })).rejects.toMatchObject({
      message:
        "Unexpected daemon response 409 (expected 200): Environment-agent session sess-1 is not active",
      status: 409,
      code: "inactive_session",
    } satisfies Partial<EnvironmentAgentSessionHttpClientError>);

    await client.pullCommands({ sessionId: "sess-1" }).catch((error: unknown) => {
      expect(isEnvironmentAgentSessionInactiveError(error)).toBe(true);
    });
  });
});
