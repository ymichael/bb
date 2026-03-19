import { describe, expect, it } from "vitest";
import {
  createEnvironmentDaemonSessionCapabilities,
  ENVIRONMENT_DAEMON_SESSION_PROTOCOL,
  inferEnvironmentDaemonSessionCapabilities,
  negotiateEnvironmentDaemonSessionCapabilities,
  normalizeEnvironmentDaemonSessionCapabilities,
  compareEnvironmentDaemonSessionCursors,
  isEnvironmentDaemonSessionClientMessage,
  isEnvironmentDaemonSessionCursor,
  isEnvironmentDaemonSessionMessage,
  isEnvironmentDaemonSessionServerMessage,
  selectEnvironmentDaemonSessionProtocolVersion,
} from "./session-protocol.js";

describe("session-protocol", () => {
  it("compares cursors by generation first, then sequence", () => {
    expect(
      compareEnvironmentDaemonSessionCursors(
        { generation: 1, sequence: 10 },
        { generation: 1, sequence: 12 },
      ),
    ).toBeLessThan(0);
    expect(
      compareEnvironmentDaemonSessionCursors(
        { generation: 2, sequence: 1 },
        { generation: 1, sequence: 999 },
      ),
    ).toBeGreaterThan(0);
    expect(
      compareEnvironmentDaemonSessionCursors(
        { generation: 3, sequence: 7 },
        { generation: 3, sequence: 7 },
      ),
    ).toBe(0);
  });

  it("validates session cursors", () => {
    expect(isEnvironmentDaemonSessionCursor({ generation: 0, sequence: 0 })).toBe(
      true,
    );
    expect(isEnvironmentDaemonSessionCursor({ generation: -1, sequence: 0 })).toBe(
      false,
    );
    expect(isEnvironmentDaemonSessionCursor({ generation: 0, sequence: 1.5 })).toBe(
      false,
    );
  });

  it("recognizes open/resume messages without a session id", () => {
    const message = {
      protocol: ENVIRONMENT_DAEMON_SESSION_PROTOCOL,
      messageId: "msg-1",
      sentAt: Date.now(),
      type: "session_open",
      payload: {
        agentId: "agent-1",
        agentInstanceId: "inst-1",
        supportedProtocolVersions: [1],
        worker: {
          name: "environment-daemon",
          version: "0.0.1",
        },
        channels: [],
      },
    };

    expect(isEnvironmentDaemonSessionMessage(message)).toBe(true);
    expect(isEnvironmentDaemonSessionClientMessage(message)).toBe(true);
    expect(isEnvironmentDaemonSessionServerMessage(message)).toBe(false);
  });

  it("requires session ids for bound messages", () => {
    const message = {
      protocol: ENVIRONMENT_DAEMON_SESSION_PROTOCOL,
      messageId: "msg-2",
      sentAt: Date.now(),
      type: "event_batch",
      payload: { batches: [] },
    };

    expect(isEnvironmentDaemonSessionMessage(message)).toBe(false);
  });

  it("distinguishes server messages from client messages", () => {
    const serverMessage = {
      protocol: ENVIRONMENT_DAEMON_SESSION_PROTOCOL,
      messageId: "msg-3",
      sentAt: Date.now(),
      sessionId: "sess-1",
      type: "command_batch",
      payload: { commands: [] },
    };

    expect(isEnvironmentDaemonSessionMessage(serverMessage)).toBe(true);
    expect(isEnvironmentDaemonSessionServerMessage(serverMessage)).toBe(true);
    expect(isEnvironmentDaemonSessionClientMessage(serverMessage)).toBe(false);
  });

  it("selects the highest mutually supported session protocol version", () => {
    expect(
      selectEnvironmentDaemonSessionProtocolVersion({
        supportedByServer: [1],
        supportedByAgent: [3, 2, 1],
      }),
    ).toBe(1);
  });

  it("returns undefined when no mutually supported session protocol version exists", () => {
    expect(
      selectEnvironmentDaemonSessionProtocolVersion({
        supportedByServer: [1],
        supportedByAgent: [3, 2],
      }),
    ).toBeUndefined();
  });

  it("infers capabilities for older agents that only send metadata", () => {
    expect(
      inferEnvironmentDaemonSessionCapabilities({
        worker: { name: "environment-daemon", version: "0.0.1" },
        providers: [{ providerId: "codex", adapterVersion: "0.0.1" }],
      }),
    ).toEqual({
      commands: [
        "provider.ensure",
        "thread.start",
        "thread.resume",
        "thread.stop",
        "turn.run",
        "thread.rename",
        "provider.list_models",
        "provider.list_catalog",
        "workspace.status",
        "workspace.diff",
      ],
      features: ["worker_metadata", "provider_metadata"],
    });
  });

  it("creates explicit capabilities for current env-daemon sessions", () => {
    expect(
      createEnvironmentDaemonSessionCapabilities({
        worker: { name: "environment-daemon", version: "0.0.1" },
        providers: [{ providerId: "codex", adapterVersion: "0.0.1" }],
      }),
    ).toEqual({
      commands: [
        "provider.ensure",
        "thread.start",
        "thread.resume",
        "thread.stop",
        "turn.run",
        "thread.rename",
        "provider.list_models",
        "provider.list_catalog",
        "workspace.status",
        "workspace.diff",
      ],
      features: ["worker_metadata", "provider_metadata"],
    });
  });

  it("normalizes and negotiates advertised capabilities", () => {
    expect(
      negotiateEnvironmentDaemonSessionCapabilities({
        requested: {
          commands: ["turn.run", "turn.run", "workspace.diff", "unknown"] as never,
          features: ["provider_metadata", "provider_metadata", "bogus"] as never,
        },
        fallback: {},
      }),
    ).toEqual({
      commands: ["turn.run", "workspace.diff"],
      features: ["provider_metadata"],
    });

    expect(
      normalizeEnvironmentDaemonSessionCapabilities({
        commands: ["thread.start", "unsupported"] as never,
        features: ["worker_metadata", "nope"] as never,
      }),
    ).toEqual({
      commands: ["thread.start"],
      features: ["worker_metadata"],
    });
  });
});
