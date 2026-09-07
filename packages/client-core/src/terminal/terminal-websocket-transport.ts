import { getTerminalBase64DecodedByteLength } from "@bb/domain";
import {
  terminalServerMessageSchema,
  type TerminalServerMessage,
} from "@bb/server-contract";

const SOCKET_OPEN = 1;
const DEFAULT_INPUT_QUEUE_MAX_BYTES = 1024 * 1024;
const DEFAULT_SOCKET_HIGH_WATER_BYTES = 1024 * 1024;
const DEFAULT_DRAIN_POLL_MS = 10;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 45_000;
const DEFAULT_RECONNECT_DELAYS_MS = [100, 250, 500, 1_000, 2_000] as const;

export type TerminalSocketConnectionState =
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed";

export interface TerminalBrowserSocket {
  bufferedAmount?: number;
  close(code?: number, reason?: string): void;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onopen: ((event: Event) => void) | null;
  readonly readyState: number;
  send(data: string): void;
}

export type CreateTerminalBrowserSocket = (
  url: string,
) => TerminalBrowserSocket;

function socketBufferedAmount(socket: TerminalBrowserSocket): number {
  return socket.bufferedAmount ?? 0;
}

function terminalSocketUrlWithSinceSeq(url: string, sinceSeq: number): string {
  const parsed = new URL(url);
  parsed.searchParams.set("sinceSeq", String(sinceSeq));
  return parsed.toString();
}

interface PendingTerminalInput {
  bytes: number;
  payload: string;
}

export interface TerminalWebSocketTransportOptions {
  createSocket?: CreateTerminalBrowserSocket;
  drainPollMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  inputQueueMaxBytes?: number;
  now?: () => number;
  onConnectionState?: (state: TerminalSocketConnectionState) => void;
  onInputOverflow?: (maxBytes: number) => void;
  onInvalidMessage?: () => void;
  onMessage: (message: TerminalServerMessage) => void;
  onSequenceGap?: (expectedSeq: number, receivedSeq: number) => void;
  reconnectDelaysMs?: readonly number[];
  shouldReconnect: () => boolean;
  socketHighWaterBytes?: number;
  url: string;
}

export class TerminalWebSocketTransport {
  private readonly createSocket: CreateTerminalBrowserSocket;
  private readonly drainPollMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly inputQueueMaxBytes: number;
  private readonly now: () => number;
  private readonly reconnectDelaysMs: readonly number[];
  private readonly socketHighWaterBytes: number;
  private drainTimeout: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private lastPongAt = 0;
  private lastResize: { cols: number; rows: number } | null = null;
  private nextOutputSeq = 0;
  private pendingInputBytes = 0;
  private readonly pendingInputs: PendingTerminalInput[] = [];
  private reconnectAttempt = 0;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private socket: TerminalBrowserSocket | null = null;
  private started = false;
  private suspended = false;
  private terminalEnded = false;

  constructor(private readonly options: TerminalWebSocketTransportOptions) {
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url));
    this.drainPollMs = options.drainPollMs ?? DEFAULT_DRAIN_POLL_MS;
    this.heartbeatIntervalMs =
      options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.heartbeatTimeoutMs =
      options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.inputQueueMaxBytes =
      options.inputQueueMaxBytes ?? DEFAULT_INPUT_QUEUE_MAX_BYTES;
    this.now = options.now ?? Date.now;
    this.reconnectDelaysMs =
      options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
    this.socketHighWaterBytes =
      options.socketHighWaterBytes ?? DEFAULT_SOCKET_HIGH_WATER_BYTES;
  }

  start(): void {
    if (this.disposed || this.socket !== null) {
      return;
    }
    this.started = true;
    if (this.suspended) {
      return;
    }
    this.connect("connecting");
  }

  suspend(): void {
    if (this.disposed || this.suspended) {
      return;
    }
    this.suspended = true;
    this.clearReconnectTimeout();
    this.clearDrainTimeout();
    this.stopHeartbeat();
    const socket = this.socket;
    this.socket = null;
    if (socket !== null) {
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      socket.onopen = null;
      socket.close(1000, "suspended");
    }
    this.options.onConnectionState?.("closed");
  }

  resume(): void {
    if (this.disposed || !this.suspended) {
      return;
    }
    this.suspended = false;
    if (!this.started || this.terminalEnded || this.socket !== null) {
      return;
    }
    this.reconnectAttempt = 0;
    this.connect("reconnecting");
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.clearReconnectTimeout();
    this.clearDrainTimeout();
    this.stopHeartbeat();
    const socket = this.socket;
    this.socket = null;
    if (socket !== null) {
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      socket.onopen = null;
      socket.close();
    }
    this.options.onConnectionState?.("closed");
  }

  sendInput(dataBase64: string): boolean {
    const pending = {
      bytes: getTerminalBase64DecodedByteLength(dataBase64),
      payload: JSON.stringify({
        type: "input",
        dataBase64,
      }),
    };
    const socket = this.socket;
    if (
      socket !== null &&
      socket.readyState === SOCKET_OPEN &&
      socketBufferedAmount(socket) <= this.socketHighWaterBytes &&
      this.pendingInputs.length === 0
    ) {
      if (this.trySend(socket, pending.payload)) {
        return true;
      }
    }
    return this.enqueueInput(pending);
  }

  sendResize(cols: number, rows: number): void {
    if (this.lastResize?.cols === cols && this.lastResize.rows === rows) {
      return;
    }
    this.lastResize = { cols, rows };
    const socket = this.socket;
    if (socket === null || socket.readyState !== SOCKET_OPEN) {
      return;
    }
    this.trySend(
      socket,
      JSON.stringify({
        type: "resize",
        cols,
        rows,
      }),
    );
  }

  private connect(state: "connecting" | "reconnecting"): void {
    if (this.disposed || this.suspended || this.terminalEnded) {
      return;
    }
    this.options.onConnectionState?.(state);
    let socket: TerminalBrowserSocket;
    try {
      socket = this.createSocket(
        terminalSocketUrlWithSinceSeq(this.options.url, this.nextOutputSeq),
      );
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => this.handleOpen(socket);
    socket.onmessage = (event) => this.handleMessage(socket, event.data);
    socket.onerror = () => undefined;
    socket.onclose = () => this.handleClose(socket);
  }

  private handleOpen(socket: TerminalBrowserSocket): void {
    if (this.disposed || this.socket !== socket) {
      return;
    }
    this.reconnectAttempt = 0;
    this.lastPongAt = this.now();
    this.options.onConnectionState?.("open");
    this.startHeartbeat(socket);
    if (this.lastResize !== null) {
      this.trySend(
        socket,
        JSON.stringify({ type: "resize", ...this.lastResize }),
      );
    }
    this.flushInputs();
  }

  private handleMessage(socket: TerminalBrowserSocket, raw: unknown): void {
    if (this.disposed || this.socket !== socket || typeof raw !== "string") {
      return;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      this.options.onInvalidMessage?.();
      return;
    }
    const parsed = terminalServerMessageSchema.safeParse(decoded);
    if (!parsed.success) {
      this.options.onInvalidMessage?.();
      return;
    }
    const message = parsed.data;
    if (message.type === "pong") {
      this.lastPongAt = this.now();
    }
    if (
      message.type === "attached" &&
      message.replayStartSeq > this.nextOutputSeq
    ) {
      this.options.onSequenceGap?.(this.nextOutputSeq, message.replayStartSeq);
      this.nextOutputSeq = message.replayStartSeq;
    }
    if (message.type === "output") {
      if (message.chunk.seq < this.nextOutputSeq) {
        return;
      }
      if (message.chunk.seq > this.nextOutputSeq) {
        this.options.onSequenceGap?.(this.nextOutputSeq, message.chunk.seq);
      }
      this.nextOutputSeq = message.chunk.seq + 1;
    }
    if (message.type === "exited") {
      this.terminalEnded = true;
      this.clearReconnectTimeout();
    }
    if (
      message.type === "error" &&
      [
        "terminal_exited",
        "terminal_not_found",
        "terminal_not_running",
      ].includes(message.code)
    ) {
      this.terminalEnded = true;
      this.clearReconnectTimeout();
    }
    this.options.onMessage(message);
  }

  private handleClose(socket: TerminalBrowserSocket): void {
    if (this.socket !== socket) {
      return;
    }
    this.socket = null;
    this.stopHeartbeat();
    this.clearDrainTimeout();
    if (
      this.disposed ||
      this.terminalEnded ||
      !this.options.shouldReconnect()
    ) {
      this.options.onConnectionState?.("closed");
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (
      this.disposed ||
      this.suspended ||
      this.terminalEnded ||
      this.reconnectTimeout !== null ||
      !this.options.shouldReconnect()
    ) {
      return;
    }
    this.options.onConnectionState?.("reconnecting");
    const delayIndex = Math.min(
      this.reconnectAttempt,
      this.reconnectDelaysMs.length - 1,
    );
    const delay = this.reconnectDelaysMs[delayIndex] ?? 0;
    this.reconnectAttempt += 1;
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.connect("reconnecting");
    }, delay);
  }

  private enqueueInput(pending: PendingTerminalInput): boolean {
    if (this.pendingInputBytes + pending.bytes > this.inputQueueMaxBytes) {
      this.options.onInputOverflow?.(this.inputQueueMaxBytes);
      return false;
    }
    this.pendingInputs.push(pending);
    this.pendingInputBytes += pending.bytes;
    this.scheduleDrain();
    return true;
  }

  private flushInputs(): void {
    this.clearDrainTimeout();
    const socket = this.socket;
    if (socket === null || socket.readyState !== SOCKET_OPEN) {
      return;
    }
    while (
      this.pendingInputs.length > 0 &&
      socketBufferedAmount(socket) <= this.socketHighWaterBytes
    ) {
      const pending = this.pendingInputs[0];
      if (!pending || !this.trySend(socket, pending.payload)) {
        break;
      }
      this.pendingInputs.shift();
      this.pendingInputBytes -= pending.bytes;
    }
    if (this.pendingInputs.length > 0) {
      this.scheduleDrain();
    }
  }

  private trySend(socket: TerminalBrowserSocket, payload: string): boolean {
    if (socket.readyState !== SOCKET_OPEN) {
      return false;
    }
    try {
      socket.send(payload);
      return true;
    } catch {
      try {
        socket.close(1011, "send-failed");
      } catch {
        this.handleClose(socket);
      }
      return false;
    }
  }

  private scheduleDrain(): void {
    if (this.drainTimeout !== null || this.socket?.readyState !== SOCKET_OPEN) {
      return;
    }
    this.drainTimeout = setTimeout(() => {
      this.drainTimeout = null;
      this.flushInputs();
    }, this.drainPollMs);
  }

  private clearDrainTimeout(): void {
    if (this.drainTimeout === null) {
      return;
    }
    clearTimeout(this.drainTimeout);
    this.drainTimeout = null;
  }

  private clearReconnectTimeout(): void {
    if (this.reconnectTimeout === null) {
      return;
    }
    clearTimeout(this.reconnectTimeout);
    this.reconnectTimeout = null;
  }

  private startHeartbeat(socket: TerminalBrowserSocket): void {
    this.stopHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      if (this.socket !== socket || socket.readyState !== SOCKET_OPEN) {
        return;
      }
      if (this.now() - this.lastPongAt > this.heartbeatTimeoutMs) {
        socket.close(4000, "heartbeat-timeout");
        return;
      }
      this.trySend(socket, JSON.stringify({ type: "ping" }));
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval === null) {
      return;
    }
    clearInterval(this.heartbeatInterval);
    this.heartbeatInterval = null;
  }
}
