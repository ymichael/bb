import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockCreateAgentSession,
  mockInMemory,
  mockOpen,
  mockSettingsInMemory,
} = vi.hoisted(() => ({
  mockCreateAgentSession: vi.fn(),
  mockInMemory: vi.fn((cwd?: string) => ({ kind: "in-memory", cwd })),
  mockOpen: vi.fn((path: string) => ({ kind: "open", path })),
  mockSettingsInMemory: vi.fn(() => ({ kind: "settings" })),
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({
  createAgentSession: mockCreateAgentSession,
  SessionManager: {
    open: mockOpen,
    inMemory: mockInMemory,
  },
  SettingsManager: {
    inMemory: mockSettingsInMemory,
  },
}));

vi.mock("@mariozechner/pi-ai", () => ({
  getModel: vi.fn(),
}));

import { handleLine } from "../bridge.js";
import { createBridgeJsonRpcTestHarness } from "../../../test/bridge-json-rpc-test-helpers.js";

interface ControlledPiAgentSession {
  abort: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  finishAbort(): void;
  getActiveToolNames: ReturnType<typeof vi.fn>;
  getContextUsage: ReturnType<typeof vi.fn>;
  prompt: ReturnType<typeof vi.fn>;
  setActiveToolsByName: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
}

function createControlledPiAgentSession(): ControlledPiAgentSession {
  let finishAbort: (() => void) | undefined;
  const abort = vi.fn(() =>
    new Promise<void>((resolve) => {
      finishAbort = resolve;
    })
  );
  return {
    abort,
    dispose: vi.fn(),
    finishAbort() {
      if (!finishAbort) {
        throw new Error("Expected Pi abort to be waiting");
      }
      finishAbort();
      finishAbort = undefined;
    },
    getActiveToolNames: vi.fn(() => []),
    getContextUsage: vi.fn(() => undefined),
    prompt: vi.fn(async () => {}),
    setActiveToolsByName: vi.fn(),
    subscribe: vi.fn(() => () => {}),
  };
}

describe("pi bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("holds thread stop open until the Pi SDK session closes", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const sessions: ControlledPiAgentSession[] = [];
    mockCreateAgentSession.mockImplementation(async () => {
      const session = createControlledPiAgentSession();
      sessions.push(session);
      return { session };
    });

    try {
      bridge.sendRequest(1, "thread/start", {
        cwd: "/tmp/worktree",
        threadId: "thread-stop-waits",
      });
      await bridge.waitForResponse(1);

      bridge.sendRequest(2, "thread/stop", { threadId: "thread-stop-waits" });
      await bridge.flushWork();

      expect(bridge.hasResponse(2)).toBe(false);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.abort).toHaveBeenCalledTimes(1);
      expect(sessions[0]?.dispose).not.toHaveBeenCalled();

      sessions[0]?.finishAbort();
      await expect(bridge.waitForResponse(2)).resolves.toMatchObject({
        id: 2,
        result: { ok: true },
      });
      expect(sessions[0]?.dispose).toHaveBeenCalledTimes(1);
    } finally {
      bridge.restore();
    }
  });

  it("waits for an in-flight close before replacing the same thread", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const sessions: ControlledPiAgentSession[] = [];
    mockCreateAgentSession.mockImplementation(async () => {
      const session = createControlledPiAgentSession();
      sessions.push(session);
      return { session };
    });

    try {
      bridge.sendRequest(11, "thread/start", {
        cwd: "/tmp/worktree",
        threadId: "thread-overlap",
      });
      await bridge.waitForResponse(11);

      bridge.sendRequest(12, "thread/stop", { threadId: "thread-overlap" });
      await bridge.flushWork();
      bridge.sendRequest(13, "thread/start", {
        cwd: "/tmp/worktree",
        threadId: "thread-overlap",
      });
      await bridge.flushWork();

      expect(bridge.hasResponse(12)).toBe(false);
      expect(bridge.hasResponse(13)).toBe(false);
      expect(sessions).toHaveLength(1);

      sessions[0]?.finishAbort();
      await expect(bridge.waitForResponse(12)).resolves.toMatchObject({
        id: 12,
        result: { ok: true },
      });
      await expect(bridge.waitForResponse(13)).resolves.toMatchObject({
        id: 13,
      });
      expect(sessions).toHaveLength(2);

      bridge.sendRequest(14, "thread/stop", { threadId: "thread-overlap" });
      await bridge.flushWork();
      sessions[1]?.finishAbort();
      await bridge.waitForResponse(14);
    } finally {
      bridge.restore();
    }
  });
});
