import { describe, expect, it } from "vitest";
import {
  ENVIRONMENT_DAEMON_PROTOCOL_VERSION,
  decodePersistedEnvironmentDaemonCommand,
  type EnvironmentDaemonCommandEnvelope,
  type EnvironmentDaemonEventEnvelope,
} from "./index.js";

describe("environment-daemon protocol", () => {
  it("uses a versioned command envelope shape", () => {
    const envelope: EnvironmentDaemonCommandEnvelope = {
      meta: {
        protocolVersion: ENVIRONMENT_DAEMON_PROTOCOL_VERSION,
        commandId: "cmd-1",
        idempotencyKey: "idem-1",
        sentAt: 123,
        threadId: "thread-1",
      },
      command: {
        type: "thread.start",
        threadId: "thread-1",
        projectId: "proj-1",
        request: {
          projectId: "proj-1",
          input: [{ type: "text", text: "hello" }],
        },
        context: {
          projectId: "proj-1",
          threadId: "thread-1",
          path: "/tmp/test",
        },
      },
    };

    expect(envelope.meta.protocolVersion).toBe(1);
    expect(envelope.command.type).toBe("thread.start");
  });

  it("uses a versioned event envelope shape", () => {
    const event: EnvironmentDaemonEventEnvelope = {
      protocolVersion: ENVIRONMENT_DAEMON_PROTOCOL_VERSION,
      sequence: 8,
      emittedAt: 456,
      threadId: "thread-1",
      event: {
        type: "environment.ready",
        threadId: "thread-1",
      },
    };

    expect(event.sequence).toBe(8);
    expect(event.protocolVersion).toBe(1);
  });

  it("decodes persisted thread.resume commands with dynamic tools", () => {
    const command = decodePersistedEnvironmentDaemonCommand({
      commandType: "thread.resume",
      payload: {
        type: "thread.resume",
        threadId: "thread-1",
        projectId: "project-1",
        providerThreadId: "provider-thread-1",
        context: {
          projectId: "project-1",
          threadId: "thread-1",
          serverUrl: "http://127.0.0.1:4311",
        },
        dynamicTools: [
          {
            name: "message_user",
            description: "Send a user-visible message.",
            inputSchema: {
              type: "object",
              properties: {
                message: { type: "string" },
              },
              required: ["message"],
            },
          },
        ],
      },
    });

    expect(command).toMatchObject({
      type: "thread.resume",
      threadId: "thread-1",
      providerThreadId: "provider-thread-1",
      dynamicTools: [
        {
          name: "message_user",
          description: "Send a user-visible message.",
        },
      ],
    });
  });

  it("rejects persisted commands with invalid input payloads", () => {
    expect(() =>
      decodePersistedEnvironmentDaemonCommand({
        commandType: "turn.run",
        payload: {
          type: "turn.run",
          threadId: "thread-1",
          input: [{ type: "text" }],
        },
      }),
    ).toThrow(/Invalid persisted environment-daemon command payload for turn.run/);
  });
});
