import {
  changedMessageLenientSchema,
  pluginSignalLenientSchema,
  pongMessageLenientSchema,
  realtimeSubscriptionTargetKey,
  threadOpenSignalLenientSchema,
  threadPaneActionSignalLenientSchema,
  type ChangedMessage,
  type ClientMessage,
  type PluginSignal,
  type RealtimeSubscriptionTarget,
  type ThreadOpenFile,
  type ThreadOpenSignal,
  type ThreadPaneActionSignal,
} from "@bb/server-contract";
import {
  SOCKET_OPEN,
  defaultRealtimeSocketFactory,
  type RealtimeSocketFactory,
  type RealtimeSocketLike,
} from "./socket";

export type MobileRealtimeConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting";

export interface MobileRealtimeConnectFailedEvent {
  message: string | null;
  authRejected: boolean;
}

const AUTH_REJECTION_PATTERN = /\b40[13]\b|unauthorized|forbidden/iu;

function isAuthRejectionMessage(message: string | null): boolean {
  return message !== null && AUTH_REJECTION_PATTERN.test(message);
}

export type MobileRealtimeConnectedEvent =
  | { reconnected: false }
  | {
      reconnected: true;
      disconnectedAt: number;
    };

export interface MobileRealtime {
  connect(): void;
  disconnect(): void;
  suspend(): void;
  resume(): void;
  probeOrReconnect(): void;
  subscribe(target: RealtimeSubscriptionTarget): void;
  unsubscribe(target: RealtimeSubscriptionTarget): void;
  onChanged(callback: (message: ChangedMessage) => void): () => void;
  onThreadOpen(callback: (signal: ThreadOpenSignal) => void): () => void;
  onThreadPaneAction(
    callback: (signal: ThreadPaneActionSignal) => void,
  ): () => void;
  onPluginSignal(callback: (signal: PluginSignal) => void): () => void;
  onConnected(
    callback: (event: MobileRealtimeConnectedEvent) => void,
  ): () => void;
  onConnectFailed(
    callback: (event: MobileRealtimeConnectFailedEvent) => void,
  ): () => void;
  onConnectionStateChange(callback: () => void): () => void;
  getConnectionState(): MobileRealtimeConnectionState;
  isSuspended(): boolean;
  consumePendingOpenFile(threadId: string): ThreadOpenFile | null;
  dispose(): void;
}

export interface CreateMobileRealtimeOptions {
  url: string;
  socketFactory?: RealtimeSocketFactory;
  headers?: () => Record<string, string>;
  connectionTimeoutMs?: number;
  onInvalidMessage?: (error: unknown) => void;
}

const REALTIME_MIN_RECONNECT_DELAY_MS = 1000;
const REALTIME_MAX_RECONNECT_DELAY_MS = 30_000;
const REALTIME_RECONNECT_GROW_FACTOR = 1.5;
const REALTIME_CONNECTION_TIMEOUT_MS = 10_000;
export const REALTIME_PING_INTERVAL_MS = 25_000;
export const REALTIME_PONG_TIMEOUT_MS = 5_000;

interface ActiveSubscription {
  count: number;
  target: RealtimeSubscriptionTarget;
}

export function reconnectDelayMs(
  attempt: number,
  options: {
    minDelayMs: number;
    maxDelayMs: number;
    growFactor: number;
  },
): number {
  return Math.min(
    options.maxDelayMs,
    Math.round(options.minDelayMs * options.growFactor ** attempt),
  );
}

export function createMobileRealtime(
  options: CreateMobileRealtimeOptions,
): MobileRealtime {
  const socketFactory = options.socketFactory ?? defaultRealtimeSocketFactory;
  const backoff = {
    minDelayMs: REALTIME_MIN_RECONNECT_DELAY_MS,
    maxDelayMs: REALTIME_MAX_RECONNECT_DELAY_MS,
    growFactor: REALTIME_RECONNECT_GROW_FACTOR,
  };
  const connectionTimeoutMs =
    options.connectionTimeoutMs ?? REALTIME_CONNECTION_TIMEOUT_MS;
  const onInvalidMessage =
    options.onInvalidMessage ??
    ((error: unknown) => {
      console.warn("Ignored invalid realtime message", error);
    });

  const subscriptions = new Map<string, ActiveSubscription>();
  const changedCallbacks = new Set<(message: ChangedMessage) => void>();
  const threadOpenCallbacks = new Set<(signal: ThreadOpenSignal) => void>();
  const paneActionCallbacks = new Set<
    (signal: ThreadPaneActionSignal) => void
  >();
  const pluginSignalCallbacks = new Set<(signal: PluginSignal) => void>();
  const connectedCallbacks = new Set<
    (event: MobileRealtimeConnectedEvent) => void
  >();
  const connectFailedCallbacks = new Set<
    (event: MobileRealtimeConnectFailedEvent) => void
  >();
  const connectionStateCallbacks = new Set<() => void>();
  const pendingOpenFileByThreadId = new Map<string, ThreadOpenFile>();

  let socket: RealtimeSocketLike | null = null;
  let socketOpened = false;
  let socketErrorMessage: string | null = null;
  let started = false;
  let suspended = false;
  let disposed = false;
  let hasConnected = false;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let connectionTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let pongTimer: ReturnType<typeof setTimeout> | null = null;
  let lastServerActivityAt = 0;
  let disconnectedAt: number | null = null;
  let connectionState: MobileRealtimeConnectionState = "connecting";

  function setConnectionState(next: MobileRealtimeConnectionState): void {
    if (connectionState === next) return;
    connectionState = next;
    for (const callback of connectionStateCallbacks) callback();
  }

  function clearReconnectTimer(): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function clearConnectionTimer(): void {
    if (connectionTimer !== null) {
      clearTimeout(connectionTimer);
      connectionTimer = null;
    }
  }

  function send(message: ClientMessage): void {
    if (socket && socket.readyState === SOCKET_OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  function clearPongTimer(): void {
    if (pongTimer !== null) {
      clearTimeout(pongTimer);
      pongTimer = null;
    }
  }

  function stopPingLoop(): void {
    if (pingTimer !== null) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    clearPongTimer();
  }

  function sendPing(): void {
    if (!socket || socket.readyState !== SOCKET_OPEN) return;
    if (Date.now() - lastServerActivityAt < REALTIME_PONG_TIMEOUT_MS) return;
    send({ type: "ping" });
    if (pongTimer !== null) return;
    pongTimer = setTimeout(() => {
      pongTimer = null;
      reconnectNow();
    }, REALTIME_PONG_TIMEOUT_MS);
  }

  function startPingLoop(): void {
    if (pingTimer !== null) return;
    if (!socket || socket.readyState !== SOCKET_OPEN) return;
    pingTimer = setInterval(sendPing, REALTIME_PING_INTERVAL_MS);
  }

  function noteServerActivity(): void {
    lastServerActivityAt = Date.now();
    clearPongTimer();
  }

  function markSocketLost(at: number): void {
    stopPingLoop();
    if (hasConnected && disconnectedAt === null) {
      disconnectedAt = at;
    }
    setConnectionState(hasConnected ? "reconnecting" : "connecting");
  }

  function teardownSocket(): void {
    clearConnectionTimer();
    const current = socket;
    socket = null;
    if (!current) return;
    current.onopen = null;
    current.onmessage = null;
    current.onclose = null;
    current.onerror = null;
    try {
      current.close(1000, "client closing");
    } catch {}
  }

  function scheduleReconnect(): void {
    if (disposed || suspended || !started) return;
    clearReconnectTimer();
    const delay = reconnectDelayMs(reconnectAttempt, backoff);
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      openSocket();
    }, delay);
  }

  function emitConnectFailed(message: string | null): void {
    const event: MobileRealtimeConnectFailedEvent = {
      message,
      authRejected: isAuthRejectionMessage(message),
    };
    for (const callback of connectFailedCallbacks) callback(event);
  }

  function handleSocketClosed(closed: RealtimeSocketLike): void {
    if (closed !== socket) return;
    clearConnectionTimer();
    socket = null;
    if (disposed) return;
    if (!socketOpened) {
      const message = socketErrorMessage;
      socketErrorMessage = null;
      markSocketLost(Date.now());
      emitConnectFailed(message);
      scheduleReconnect();
      return;
    }
    if (pongTimer !== null) {
      markSocketLost(lastServerActivityAt);
      openSocket();
      return;
    }
    markSocketLost(Date.now());
    scheduleReconnect();
  }

  function reconnectNow(): void {
    if (disposed || suspended || !started) return;
    const current = socket;
    if (current) {
      const watermark =
        current.readyState === SOCKET_OPEN ? lastServerActivityAt : Date.now();
      teardownSocket();
      markSocketLost(watermark);
    }
    clearReconnectTimer();
    openSocket();
  }

  function probeOrReconnect(): void {
    if (disposed || suspended || !started) return;
    if (!socket) {
      if (reconnectTimer !== null) reconnectNow();
      return;
    }
    if (socket.readyState === SOCKET_OPEN) sendPing();
  }

  function openSocket(): void {
    if (socket || disposed || suspended || !started) return;
    clearReconnectTimer();
    const next = socketFactory(options.url, {
      headers: options.headers?.() ?? {},
    });
    socket = next;
    socketOpened = false;
    socketErrorMessage = null;
    connectionTimer = setTimeout(() => {
      connectionTimer = null;
      if (socket !== next) return;
      teardownSocket();
      setConnectionState(hasConnected ? "reconnecting" : "connecting");
      emitConnectFailed("handshake timeout");
      scheduleReconnect();
    }, connectionTimeoutMs);

    next.onopen = () => {
      if (socket !== next) return;
      socketOpened = true;
      clearConnectionTimer();
      reconnectAttempt = 0;
      const previousDisconnectedAt = disconnectedAt;
      disconnectedAt = null;
      lastServerActivityAt = Date.now();
      const reconnected = hasConnected;
      hasConnected = true;
      setConnectionState("connected");
      startPingLoop();
      for (const subscription of subscriptions.values()) {
        send({ type: "subscribe", target: subscription.target });
      }
      const event: MobileRealtimeConnectedEvent = reconnected
        ? {
            reconnected,
            disconnectedAt: previousDisconnectedAt ?? Date.now(),
          }
        : { reconnected };
      for (const callback of connectedCallbacks) callback(event);
    };
    next.onmessage = (event) => {
      if (socket !== next) return;
      if (typeof event.data !== "string") return;
      noteServerActivity();
      handleIncomingMessage(event.data);
    };
    next.onclose = (event) => {
      if (socket === next && !socketOpened && socketErrorMessage === null) {
        socketErrorMessage = event.reason.length > 0 ? event.reason : null;
      }
      handleSocketClosed(next);
    };
    next.onerror = (event) => {
      if (socket !== next) return;
      if (event.message !== null) socketErrorMessage = event.message;
    };
  }

  function handleIncomingMessage(data: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }

    if (pongMessageLenientSchema.safeParse(parsed).success) return;

    const threadOpen = threadOpenSignalLenientSchema.safeParse(parsed);
    if (threadOpen.success) {
      if (threadOpen.data.file !== null) {
        pendingOpenFileByThreadId.set(
          threadOpen.data.threadId,
          threadOpen.data.file,
        );
      }
      for (const callback of threadOpenCallbacks) callback(threadOpen.data);
      return;
    }

    const paneAction = threadPaneActionSignalLenientSchema.safeParse(parsed);
    if (paneAction.success) {
      for (const callback of paneActionCallbacks) callback(paneAction.data);
      return;
    }

    const pluginSignal = pluginSignalLenientSchema.safeParse(parsed);
    if (pluginSignal.success) {
      for (const callback of pluginSignalCallbacks) callback(pluginSignal.data);
      return;
    }

    const changed = changedMessageLenientSchema.safeParse(parsed);
    if (changed.success) {
      for (const callback of changedCallbacks) callback(changed.data);
      return;
    }
    onInvalidMessage(changed.error);
  }

  function listen<T>(set: Set<T>, callback: T): () => void {
    set.add(callback);
    return () => {
      set.delete(callback);
    };
  }

  return {
    connect() {
      if (disposed) return;
      started = true;
      if (suspended) return;
      openSocket();
    },
    disconnect() {
      started = false;
      clearReconnectTimer();
      stopPingLoop();
      const hadSocket = socket !== null;
      teardownSocket();
      reconnectAttempt = 0;
      if (hadSocket && hasConnected && disconnectedAt === null) {
        disconnectedAt = Date.now();
      }
      setConnectionState("connecting");
    },
    suspend() {
      if (suspended) return;
      suspended = true;
      clearReconnectTimer();
      teardownSocket();
      reconnectAttempt = 0;
      if (started) {
        markSocketLost(Date.now());
      } else {
        stopPingLoop();
      }
    },
    resume() {
      if (!suspended) {
        probeOrReconnect();
        return;
      }
      suspended = false;
      if (!started || disposed) return;
      openSocket();
    },
    probeOrReconnect,
    subscribe(target) {
      const key = realtimeSubscriptionTargetKey(target);
      const existing = subscriptions.get(key);
      if (existing) {
        existing.count += 1;
        return;
      }
      subscriptions.set(key, { count: 1, target });
      send({ type: "subscribe", target });
    },
    unsubscribe(target) {
      const key = realtimeSubscriptionTargetKey(target);
      const existing = subscriptions.get(key);
      if (!existing) return;
      if (existing.count > 1) {
        existing.count -= 1;
        return;
      }
      subscriptions.delete(key);
      send({ type: "unsubscribe", target });
    },
    onChanged: (callback) => listen(changedCallbacks, callback),
    onThreadOpen: (callback) => listen(threadOpenCallbacks, callback),
    onThreadPaneAction: (callback) => listen(paneActionCallbacks, callback),
    onPluginSignal: (callback) => listen(pluginSignalCallbacks, callback),
    onConnected: (callback) => listen(connectedCallbacks, callback),
    onConnectFailed: (callback) => listen(connectFailedCallbacks, callback),
    onConnectionStateChange: (callback) =>
      listen(connectionStateCallbacks, callback),
    getConnectionState: () => connectionState,
    isSuspended: () => suspended,
    consumePendingOpenFile(threadId) {
      const pending = pendingOpenFileByThreadId.get(threadId);
      if (!pending) return null;
      pendingOpenFileByThreadId.delete(threadId);
      return pending;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      started = false;
      clearReconnectTimer();
      stopPingLoop();
      teardownSocket();
      changedCallbacks.clear();
      threadOpenCallbacks.clear();
      paneActionCallbacks.clear();
      pluginSignalCallbacks.clear();
      connectFailedCallbacks.clear();
      connectedCallbacks.clear();
      connectionStateCallbacks.clear();
      subscriptions.clear();
      pendingOpenFileByThreadId.clear();
    },
  };
}
