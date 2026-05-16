// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import type { TerminalSession } from "@bb/server-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadTerminalView } from "./ThreadTerminalView";

type TerminalDataHandler = (data: string) => void;
type TerminalTitleHandler = (title: string) => void;
type TerminalWriteCallback = () => void;

const xtermMocks = vi.hoisted(() => {
  class MockTerminal {
    static instances: MockTerminal[] = [];

    readonly onDataHandlers: TerminalDataHandler[] = [];
    readonly onTitleChangeHandlers: TerminalTitleHandler[] = [];
    readonly write = vi.fn((_: string, callback?: TerminalWriteCallback) => {
      const data = this.dataDuringNextWrite;
      const title = this.titleDuringNextWrite;
      this.dataDuringNextWrite = null;
      this.titleDuringNextWrite = null;
      if (data !== null) {
        this.emitData(data);
      }
      if (title !== null) {
        this.emitTitle(title);
      }
      callback?.();
    });
    readonly dispose = vi.fn();
    dataDuringNextWrite: string | null = null;
    titleDuringNextWrite: string | null = null;
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

    onTitleChange(handler: TerminalTitleHandler): void {
      this.onTitleChangeHandlers.push(handler);
    }

    emitData(data: string): void {
      for (const handler of this.onDataHandlers) {
        handler(data);
      }
    }

    emitTitle(title: string): void {
      for (const handler of this.onTitleChangeHandlers) {
        handler(title);
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
  lastUserInputAt: null,
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
    const onUserInput = vi.fn();
    render(
      <ThreadTerminalView
        onUserInput={onUserInput}
        session={terminalSession}
        threadId="thr_test"
      />,
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

    expect(onUserInput).toHaveBeenCalledTimes(1);
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

  it("reports xterm title changes", async () => {
    const onTitleChange = vi.fn();
    render(
      <ThreadTerminalView
        onTitleChange={onTitleChange}
        session={terminalSession}
        threadId="thr_test"
      />,
    );

    await waitFor(() => {
      expect(xtermMocks.MockTerminal.instances).toHaveLength(1);
    });

    const terminal = xtermMocks.MockTerminal.instances[0];
    if (!terminal) {
      throw new Error("Expected terminal instance");
    }

    terminal.emitTitle("X");

    expect(onTitleChange).toHaveBeenCalledWith("X");
  });

  it("ignores title changes emitted while replaying scrollback", async () => {
    const onTitleChange = vi.fn();
    render(
      <ThreadTerminalView
        onTitleChange={onTitleChange}
        session={terminalSession}
        threadId="thr_test"
      />,
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
        type: "attached",
        session: terminalSession,
        nextSeq: 1,
      }),
    );
    terminal.titleDuringNextWrite = "~/Projects/bb";
    socket.receive(
      JSON.stringify({
        type: "output",
        chunk: {
          seq: 0,
          dataBase64: "Zm9vCg==",
        },
      }),
    );
    terminal.emitTitle("foo");

    expect(onTitleChange).toHaveBeenCalledTimes(1);
    expect(onTitleChange).toHaveBeenCalledWith("foo");
  });

  it("does not send xterm-generated data while replaying scrollback", async () => {
    const onUserInput = vi.fn();
    render(
      <ThreadTerminalView
        onUserInput={onUserInput}
        session={terminalSession}
        threadId="thr_test"
      />,
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

    socket.open();
    socket.receive(
      JSON.stringify({
        type: "attached",
        session: terminalSession,
        nextSeq: 1,
      }),
    );
    terminal.dataDuringNextWrite = "\x1b[?1;2c";
    socket.receive(
      JSON.stringify({
        type: "output",
        chunk: {
          seq: 0,
          dataBase64: "Zm9vCg==",
        },
      }),
    );
    terminal.emitData("pwd\n");

    expect(onUserInput).toHaveBeenCalledTimes(1);
    expect(socket.sentMessages.map((message) => JSON.parse(message))).toEqual([
      {
        type: "resize",
        cols: 80,
        rows: 24,
      },
      {
        type: "input",
        dataBase64: "cHdkCg==",
      },
    ]);
  });

  it("keeps the terminal mounted when callback props change", async () => {
    const firstTitleChange = vi.fn();
    const secondTitleChange = vi.fn();
    const firstUserInput = vi.fn();
    const secondUserInput = vi.fn();
    const { rerender } = render(
      <ThreadTerminalView
        onTitleChange={firstTitleChange}
        onUserInput={firstUserInput}
        session={terminalSession}
        threadId="thr_test"
      />,
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

    socket.open();
    rerender(
      <ThreadTerminalView
        onTitleChange={secondTitleChange}
        onUserInput={secondUserInput}
        session={{
          ...terminalSession,
          title: "Renamed terminal",
          updatedAt: terminalSession.updatedAt + 1,
        }}
        threadId="thr_test"
      />,
    );

    terminal.emitTitle("Renamed terminal");
    terminal.emitData("pwd\n");

    expect(FakeTerminalWebSocket.instances).toHaveLength(1);
    expect(xtermMocks.MockTerminal.instances).toHaveLength(1);
    expect(terminal.dispose).not.toHaveBeenCalled();
    expect(firstTitleChange).not.toHaveBeenCalled();
    expect(firstUserInput).not.toHaveBeenCalled();
    expect(secondTitleChange).toHaveBeenCalledWith("Renamed terminal");
    expect(secondUserInput).toHaveBeenCalledTimes(1);
  });
});
