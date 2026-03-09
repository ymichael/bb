import { describe, expect, it } from "vitest";
import {
  ENVIRONMENT_AGENT_PROTOCOL_VERSION,
  type EnvironmentAgentCommandEnvelope,
  type EnvironmentAgentEventEnvelope,
  type EnvironmentAgentReplayResponse,
} from "./index.js";

describe("environment-agent protocol", () => {
  it("uses a versioned command envelope shape", () => {
    const envelope: EnvironmentAgentCommandEnvelope = {
      meta: {
        protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
        commandId: "cmd-1",
        idempotencyKey: "idem-1",
        sentAt: 123,
        threadId: "thread-1",
      },
      command: {
        type: "thread.start",
        threadId: "thread-1",
        projectId: "proj-1",
      },
    };

    expect(envelope.meta.protocolVersion).toBe(1);
    expect(envelope.command.type).toBe("thread.start");
  });

  it("uses a versioned replay response shape", () => {
    const event: EnvironmentAgentEventEnvelope = {
      protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
      sequence: 8,
      emittedAt: 456,
      threadId: "thread-1",
      event: {
        type: "environment.ready",
        threadId: "thread-1",
      },
    };
    const replay: EnvironmentAgentReplayResponse = {
      protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
      fromSequenceExclusive: 5,
      toSequenceInclusive: 8,
      events: [event],
      hasMore: false,
    };

    expect(replay.events[0]?.sequence).toBe(8);
    expect(replay.protocolVersion).toBe(1);
  });
});
