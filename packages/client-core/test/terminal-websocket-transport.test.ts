import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  TerminalServerMessage,
  TerminalSession,
} from "@bb/server-contract";
import {
  TerminalWebSocketTransport,
  type TerminalBrowserSocket,
  type TerminalSocketConnectionState,
} from "../src/terminal/terminal-websocket-transport.js";

class FakeTerminalBrowserSocket implements TerminalBrowserSocket {
  bufferedAmount: number | undefined = 0;
  closeCalls: Array<{ code?: number; reason?: string }> = [];
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  readyState = 0;
  readonly sent: string[] = [];
  throwOnSend = false;

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    if (this.readyState === 3) {
      return;
    }
    this.readyState = 3;
    this.onclose?.({ code: code ?? 1005, reason: reason ?? "" } as CloseEvent);
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  receive(message: TerminalServerMessage): void {
    this.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify(message) }),
    );
  }

  send(data: string): void {
    if (this.throwOnSend) {
      throw new Error("send failed");
    }
    this.sent.push(data);
  }
}

interface TransportHarness {
  messages: TerminalServerMessage[];
  overflow: ReturnType<typeof vi.fn<(maxBytes: number) => void>>;
  sockets: FakeTerminalBrowserSocket[];
  states: TerminalSocketConnectionState[];
  transport: TerminalWebSocketTransport;
  urls: string[];
}

function createHarness(
  overrides: Partial<
    ConstructorParameters<typeof TerminalWebSocketTransport>[0]
  > = {},
): TransportHarness {
  const sockets: FakeTerminalBrowserSocket[] = [];
  const messages: TerminalServerMessage[] = [];
  const states: TerminalSocketConnectionState[] = [];
  const overflow = vi.fn<(maxBytes: number) => void>();
  const urls: string[] = [];
  const transport = new TerminalWebSocketTransport({
    createSocket: (url) => {
      urls.push(url);
      const socket = new FakeTerminalBrowserSocket();
      sockets.push(socket);
      return socket;
    },
    heartbeatIntervalMs: 15_000,
    heartbeatTimeoutMs: 45_000,
    onConnectionState: (state) => states.push(state),
    onInputOverflow: overflow,
    onMessage: (message) => messages.push(message),
    reconnectDelaysMs: [100],
    shouldReconnect: () => true,
    url: "ws://example.test/ws/terminals/term-1",
    ...overrides,
  });
  return { messages, overflow, sockets, states, transport, urls };
}

function terminalSession(): TerminalSession {
  return {
    id: "term_1",
    threadId: "thr_1",
    environmentId: "env_1",
    hostId: "host_1",
    title: "Terminal",
    initialCwd: "/workspace",
    cols: 100,
    rows: 30,
    status: "running",
    exitCode: null,
    closeReason: null,
    createdAt: 1,
    updatedAt: 1,
    lastUserInputAt: null,
  };
}

function inputMessages(socket: FakeTerminalBrowserSocket): string[] {
  return socket.sent
    .map(
      (payload) => JSON.parse(payload) as { dataBase64?: string; type: string },
    )
    .filter((message) => message.type === "input")
    .map((message) => message.dataBase64 ?? "");
}

afterEach(() => {
  vi.useRealTimers();
});

describe("TerminalWebSocketTransport", () => {
  it("queues input before open and preserves it across reconnect", () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const firstInput = Buffer.from("before open").toString("base64");
    const secondInput = Buffer.from("while reconnecting").toString("base64");

    harness.transport.start();
    expect(harness.transport.sendInput(firstInput)).toBe(true);
    harness.sockets[0]?.open();
    expect(inputMessages(harness.sockets[0]!)).toEqual([firstInput]);

    harness.sockets[0]?.close();
    expect(harness.transport.sendInput(secondInput)).toBe(true);
    vi.advanceTimersByTime(100);
    harness.sockets[1]?.open();

    expect(inputMessages(harness.sockets[1]!)).toEqual([secondInput]);
    expect(harness.states).toContain("reconnecting");
    harness.transport.dispose();
  });

  it("filters replay duplicates after reconnect and reports sequence gaps", () => {
    vi.useFakeTimers();
    const gaps = vi.fn<(expectedSeq: number, receivedSeq: number) => void>();
    const harness = createHarness({ onSequenceGap: gaps });
    const output = (seq: number): TerminalServerMessage => ({
      type: "output",
      chunk: {
        seq,
        dataBase64: Buffer.from(String(seq)).toString("base64"),
      },
    });

    harness.transport.start();
    harness.sockets[0]?.open();
    harness.sockets[0]?.receive(output(0));
    harness.sockets[0]?.close();
    vi.advanceTimersByTime(100);
    harness.sockets[1]?.open();
    harness.sockets[1]?.receive(output(0));
    harness.sockets[1]?.receive(output(2));

    expect(
      harness.messages
        .filter((message) => message.type === "output")
        .map((message) => message.chunk.seq),
    ).toEqual([0, 2]);
    expect(gaps).toHaveBeenCalledWith(1, 2);
    expect(harness.urls).toEqual([
      "ws://example.test/ws/terminals/term-1?sinceSeq=0",
      "ws://example.test/ws/terminals/term-1?sinceSeq=1",
    ]);
    harness.transport.dispose();
  });

  it("reports an explicit replay truncation before accepting available output", () => {
    const gaps = vi.fn<(expectedSeq: number, receivedSeq: number) => void>();
    const harness = createHarness({ onSequenceGap: gaps });

    harness.transport.start();
    const socket = harness.sockets[0]!;
    socket.open();
    socket.receive({
      type: "attached",
      session: terminalSession(),
      replayStartSeq: 5,
      nextSeq: 8,
    });
    socket.receive({
      type: "output",
      chunk: {
        seq: 5,
        dataBase64: Buffer.from("available").toString("base64"),
      },
    });

    expect(gaps).toHaveBeenCalledOnce();
    expect(gaps).toHaveBeenCalledWith(0, 5);
    expect(
      harness.messages
        .filter((message) => message.type === "output")
        .map((message) => message.chunk.seq),
    ).toEqual([5]);
    harness.transport.dispose();
  });

  it("holds input above the socket high-water mark and flushes after drain", () => {
    vi.useFakeTimers();
    const harness = createHarness({
      drainPollMs: 10,
      socketHighWaterBytes: 8,
    });
    const input = Buffer.from("queued").toString("base64");

    harness.transport.start();
    const socket = harness.sockets[0]!;
    socket.open();
    socket.bufferedAmount = 9;
    expect(harness.transport.sendInput(input)).toBe(true);
    expect(inputMessages(socket)).toEqual([]);

    socket.bufferedAmount = 0;
    vi.advanceTimersByTime(10);
    expect(inputMessages(socket)).toEqual([input]);
    harness.transport.dispose();
  });

  it("flushes input when the socket never reports bufferedAmount (React Native)", () => {
    vi.useFakeTimers();
    const harness = createHarness({
      drainPollMs: 10,
      socketHighWaterBytes: 8,
    });
    const queuedInput = Buffer.from("queued").toString("base64");
    const liveInput = Buffer.from("live").toString("base64");

    harness.transport.start();
    const socket = harness.sockets[0]!;
    socket.bufferedAmount = undefined;
    expect(harness.transport.sendInput(queuedInput)).toBe(true);
    socket.open();
    expect(inputMessages(socket)).toEqual([queuedInput]);

    expect(harness.transport.sendInput(liveInput)).toBe(true);
    expect(inputMessages(socket)).toEqual([queuedInput, liveInput]);
    vi.advanceTimersByTime(50);
    expect(inputMessages(socket)).toEqual([queuedInput, liveInput]);
    harness.transport.dispose();
  });

  it("reports bounded input queue overflow instead of silently dropping", () => {
    const harness = createHarness({ inputQueueMaxBytes: 3 });
    harness.transport.start();

    expect(
      harness.transport.sendInput(Buffer.from("four").toString("base64")),
    ).toBe(false);
    expect(harness.overflow).toHaveBeenCalledWith(3);
    harness.transport.dispose();
  });

  it("reconnects after a send exception without throwing to xterm", () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.transport.start();
    const firstSocket = harness.sockets[0]!;
    firstSocket.open();
    firstSocket.throwOnSend = true;
    const input = Buffer.from("retry me").toString("base64");

    expect(() => harness.transport.sendInput(input)).not.toThrow();
    vi.advanceTimersByTime(100);
    harness.sockets[1]?.open();

    expect(inputMessages(harness.sockets[1]!)).toEqual([input]);
    harness.transport.dispose();
  });

  it("closes an unresponsive socket after the heartbeat deadline", () => {
    vi.useFakeTimers();
    let now = 0;
    const harness = createHarness({ now: () => now });
    harness.transport.start();
    const socket = harness.sockets[0]!;
    socket.open();

    now = 60_000;
    vi.advanceTimersByTime(60_000);

    expect(socket.closeCalls).toContainEqual({
      code: 4000,
      reason: "heartbeat-timeout",
    });
    harness.transport.dispose();
  });
  it("suspends without reconnecting and resumes from the last seen chunk", () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const output = (seq: number): TerminalServerMessage => ({
      type: "output",
      chunk: {
        seq,
        dataBase64: Buffer.from(String(seq)).toString("base64"),
      },
    });

    harness.transport.start();
    const first = harness.sockets[0]!;
    first.open();
    first.receive(output(0));
    first.receive(output(1));

    harness.transport.suspend();
    expect(first.closeCalls).toEqual([{ code: 1000, reason: "suspended" }]);
    expect(harness.states.at(-1)).toBe("closed");
    vi.advanceTimersByTime(10_000);
    expect(harness.sockets).toHaveLength(1);
    const queued = Buffer.from("ls\n").toString("base64");
    expect(harness.transport.sendInput(queued)).toBe(true);

    harness.transport.resume();
    expect(harness.sockets).toHaveLength(2);
    expect(harness.urls[1]).toBe(
      "ws://example.test/ws/terminals/term-1?sinceSeq=2",
    );
    harness.sockets[1]!.open();
    expect(inputMessages(harness.sockets[1]!)).toEqual([queued]);
    expect(harness.states.at(-1)).toBe("open");

    harness.transport.resume();
    expect(harness.sockets).toHaveLength(2);
    harness.transport.dispose();
  });

  it("does not open a socket on resume when the transport was never started", () => {
    const harness = createHarness();
    harness.transport.suspend();
    harness.transport.resume();
    expect(harness.sockets).toHaveLength(0);
    harness.transport.start();
    expect(harness.sockets).toHaveLength(1);
    harness.transport.dispose();
  });

  it("defers a start while suspended until resume", () => {
    const harness = createHarness();
    harness.transport.suspend();
    harness.transport.start();
    expect(harness.sockets).toHaveLength(0);
    expect(harness.states).not.toContain("connecting");

    harness.transport.resume();
    expect(harness.sockets).toHaveLength(1);
    expect(harness.urls[0]).toBe(
      "ws://example.test/ws/terminals/term-1?sinceSeq=0",
    );
    expect(harness.states.at(-1)).toBe("reconnecting");
    harness.sockets[0]!.open();
    expect(harness.states.at(-1)).toBe("open");
    harness.transport.dispose();
  });
});
