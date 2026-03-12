import { describe, expect, it } from "vitest";
import {
  ENVIRONMENT_AGENT_SESSION_PROTOCOL,
  compareEnvironmentAgentSessionCursors,
  isEnvironmentAgentSessionClientMessage,
  isEnvironmentAgentSessionCursor,
  isEnvironmentAgentSessionMessage,
  isEnvironmentAgentSessionServerMessage,
} from "./session-protocol.js";

describe("session-protocol", () => {
  it("compares cursors by generation first, then sequence", () => {
    expect(
      compareEnvironmentAgentSessionCursors(
        { generation: 1, sequence: 10 },
        { generation: 1, sequence: 12 },
      ),
    ).toBeLessThan(0);
    expect(
      compareEnvironmentAgentSessionCursors(
        { generation: 2, sequence: 1 },
        { generation: 1, sequence: 999 },
      ),
    ).toBeGreaterThan(0);
    expect(
      compareEnvironmentAgentSessionCursors(
        { generation: 3, sequence: 7 },
        { generation: 3, sequence: 7 },
      ),
    ).toBe(0);
  });

  it("validates session cursors", () => {
    expect(isEnvironmentAgentSessionCursor({ generation: 0, sequence: 0 })).toBe(
      true,
    );
    expect(isEnvironmentAgentSessionCursor({ generation: -1, sequence: 0 })).toBe(
      false,
    );
    expect(isEnvironmentAgentSessionCursor({ generation: 0, sequence: 1.5 })).toBe(
      false,
    );
  });

  it("recognizes open/resume messages without a session id", () => {
    const message = {
      protocol: ENVIRONMENT_AGENT_SESSION_PROTOCOL,
      messageId: "msg-1",
      sentAt: Date.now(),
      type: "session_open",
      payload: {
        agentId: "agent-1",
        agentInstanceId: "inst-1",
        supportedProtocolVersions: [1],
        channels: [],
      },
    };

    expect(isEnvironmentAgentSessionMessage(message)).toBe(true);
    expect(isEnvironmentAgentSessionClientMessage(message)).toBe(true);
    expect(isEnvironmentAgentSessionServerMessage(message)).toBe(false);
  });

  it("requires session ids for bound messages", () => {
    const message = {
      protocol: ENVIRONMENT_AGENT_SESSION_PROTOCOL,
      messageId: "msg-2",
      sentAt: Date.now(),
      type: "event_batch",
      payload: { batches: [] },
    };

    expect(isEnvironmentAgentSessionMessage(message)).toBe(false);
  });

  it("distinguishes server messages from client messages", () => {
    const serverMessage = {
      protocol: ENVIRONMENT_AGENT_SESSION_PROTOCOL,
      messageId: "msg-3",
      sentAt: Date.now(),
      sessionId: "sess-1",
      type: "command_batch",
      payload: { commands: [] },
    };

    expect(isEnvironmentAgentSessionMessage(serverMessage)).toBe(true);
    expect(isEnvironmentAgentSessionServerMessage(serverMessage)).toBe(true);
    expect(isEnvironmentAgentSessionClientMessage(serverMessage)).toBe(false);
  });
});
