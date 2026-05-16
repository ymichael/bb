// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import type { TerminalSession } from "@bb/server-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadTerminalView } from "./ThreadTerminalView";

type TerminalDataHandler = (data: string) => void;

const xtermMocks = vi.hoisted(() => {
  class MockTerminal {
    static instances: MockTerminal[] = [];

    readonly onDataHandlers: TerminalDataHandler[] = [];
    readonly write = vi.fn();
    readonly dispose = vi.fn();
    cols = 80;
    rows = 24;

    constructor() {
      MockTerminal.instances.push(this);
    }

    loadAddon(): void {}

    open(): void {}

    onData(handler: TerminalDataHandler): void {
      this.onDataHandlers.push(handler);
    }

    emitData(data: string): void {
      for (const handler of this.onDataHandlers) {
        handler(data);
      }
    }
  }

  class MockFitAddon {
    readonly fit = vi.fn();
  }

  class MockWebLinksAddon {}

  return {
    MockFitAddon,
    MockTerminal,
    MockWebLinksAddon,
  };
});

vi.mock("@xterm/xterm", () => ({
  Terminal: xtermMocks.MockTerminal,
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: xtermMocks.MockFitAddon,
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: xtermMocks.MockWebLinksAddon,
}));

class FakeResizeObserver {
  disconnect(): void {}

  observe(): void {}
}

class FakeTerminalWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeTerminalWebSocket[] = [];

  readonly sentMessages: string[] = [];
  onclose: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onopen: (() => void) | null = null;
  readyState = 0;

  constructor(readonly url: string) {
    FakeTerminalWebSocket.instances.push(this);
  }

  close(): void {
    this.readyState = FakeTerminalWebSocket.CLOSED;
    this.onclose?.();
  }

  open(): void {
    this.readyState = FakeTerminalWebSocket.OPEN;
    this.onopen?.();
  }

  send(data: string): void {
    this.sentMessages.push(data);
  }

  receive(data: string): void {
    this.onmessage?.(new MessageEvent("message", { data }));
  }
}

const terminalSession: TerminalSession = {
  id: "term_test",
  threadId: "thr_test",
  environmentId: "env_test",
  hostId: "host_test",
  title: "Terminal 1",
  initialCwd: "/tmp/workspace",
  currentCwd: null,
  cols: 80,
  rows: 24,
  status: "running",
  exitCode: null,
  closeReason: null,
  createdAt: 1,
  updatedAt: 1,
};

beforeEach(() => {
  xtermMocks.MockTerminal.instances.length = 0;
  FakeTerminalWebSocket.instances.length = 0;
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: FakeResizeObserver,
  });
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: FakeTerminalWebSocket,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ThreadTerminalView", () => {
  it("sends xterm input to the terminal websocket", async () => {
    render(
      <ThreadTerminalView session={terminalSession} threadId="thr_test" />,
    );

    await waitFor(() => {
      expect(FakeTerminalWebSocket.instances).toHaveLength(1);
      expect(xtermMocks.MockTerminal.instances).toHaveLength(1);
    });

    const socket = FakeTerminalWebSocket.instances[0];
    const terminal = xtermMocks.MockTerminal.instances[0];
    if (!socket || !terminal) {
      throw new Error("Expected terminal websocket and xterm instances");
    }

    expect(socket.url).toBe(
      "ws://localhost:3000/ws/threads/thr_test/terminals/term_test",
    );
    socket.open();
    expect(JSON.parse(socket.sentMessages[0] ?? "")).toEqual({
      type: "resize",
      cols: 80,
      rows: 24,
    });

    terminal.emitData("pwd\n");

    expect(JSON.parse(socket.sentMessages[1] ?? "")).toEqual({
      type: "input",
      dataBase64: "cHdkCg==",
    });
  });

  it("writes websocket output into xterm", async () => {
    render(
      <ThreadTerminalView session={terminalSession} threadId="thr_test" />,
    );

    await waitFor(() => {
      expect(FakeTerminalWebSocket.instances).toHaveLength(1);
      expect(xtermMocks.MockTerminal.instances).toHaveLength(1);
    });

    const socket = FakeTerminalWebSocket.instances[0];
    const terminal = xtermMocks.MockTerminal.instances[0];
    if (!socket || !terminal) {
      throw new Error("Expected terminal websocket and xterm instances");
    }

    socket.receive(
      JSON.stringify({
        type: "output",
        chunk: {
          seq: 0,
          dataBase64: "aGVsbG8K",
        },
      }),
    );

    expect(terminal.write).toHaveBeenCalledWith("hello\n");
  });
});
