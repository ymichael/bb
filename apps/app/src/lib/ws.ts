import ReconnectingWebSocket from "partysocket/ws";
import {
  REALTIME_ENTITIES,
} from "@bb/server-contract";
import type {
  ClientMessage,
  ChangedMessage,
  RealtimeEntity,
} from "@bb/server-contract";

type ChangeCallback = (message: ChangedMessage) => void;
type ConnectedCallback = (event: { reconnected: boolean }) => void;
type ConnectionStateCallback = () => void;
export type WebSocketConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting";

export class WebSocketManager {
  private socket: ReconnectingWebSocket | null = null;
  private subscriptions = new Set<string>();
  private callbacks = new Set<ChangeCallback>();
  private connectedCallbacks = new Set<ConnectedCallback>();
  private connectionStateCallbacks = new Set<ConnectionStateCallback>();
  private hasConnected = false;
  private connectionState: WebSocketConnectionState = "connecting";

  connect(): void {
    if (this.socket) return;

    // In dev mode, connect directly to the server to bypass Vite's WS proxy
    // which does not handle reconnection after backend restarts.
    // In production, use the same origin (server serves the app).
    const url = typeof __BB_DEV_WS_URL__ === "string"
      ? __BB_DEV_WS_URL__
      : `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws`;

    this.socket = new ReconnectingWebSocket(url, undefined, {
      minReconnectionDelay: 1000,
      maxReconnectionDelay: 30000,
      reconnectionDelayGrowFactor: 1.5,
      connectionTimeout: 10000,
      maxRetries: Infinity,
    });

    this.socket.onopen = () => {
      const reconnected = this.hasConnected;
      this.hasConnected = true;
      this.setConnectionState("connected");
      // Re-subscribe to all active subscriptions
      for (const key of this.subscriptions) {
        const parsed = parseSubKey(key);
        if (!parsed) continue;
        this.sendMessage({ type: "subscribe", entity: parsed.entity, id: parsed.id });
      }
      for (const callback of this.connectedCallbacks) {
        callback({ reconnected });
      }
    };

    this.socket.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      try {
        const msg: unknown = JSON.parse(event.data);
        if (isChangedMessage(msg)) {
          for (const cb of this.callbacks) {
            cb(msg);
          }
        }
      } catch {
        // Ignore malformed messages
      }
    };

    this.socket.onclose = () => {
      this.setConnectionState(this.hasConnected ? "reconnecting" : "connecting");
    };
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.setConnectionState("connecting");
  }

  subscribe(entity: RealtimeEntity, id?: string): void {
    const key = subKey(entity, id);
    this.subscriptions.add(key);
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.sendMessage({ type: "subscribe", entity, id });
    }
  }

  unsubscribe(entity: RealtimeEntity, id?: string): void {
    const key = subKey(entity, id);
    this.subscriptions.delete(key);
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.sendMessage({ type: "unsubscribe", entity, id });
    }
  }

  onChanged(callback: ChangeCallback): () => void {
    this.callbacks.add(callback);
    return () => {
      this.callbacks.delete(callback);
    };
  }

  onConnected(callback: ConnectedCallback): () => void {
    this.connectedCallbacks.add(callback);
    return () => {
      this.connectedCallbacks.delete(callback);
    };
  }

  onConnectionStateChange(callback: ConnectionStateCallback): () => void {
    this.connectionStateCallbacks.add(callback);
    return () => {
      this.connectionStateCallbacks.delete(callback);
    };
  }

  getConnectionState(): WebSocketConnectionState {
    return this.connectionState;
  }

  private sendMessage(msg: ClientMessage): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(msg));
    }
  }

  private setConnectionState(nextState: WebSocketConnectionState): void {
    if (this.connectionState === nextState) {
      return;
    }
    this.connectionState = nextState;
    for (const callback of this.connectionStateCallbacks) {
      callback();
    }
  }
}

function isChangedMessage(value: unknown): value is ChangedMessage {
  if (typeof value !== "object" || value === null) return false;
  if (!("type" in value) || !("entity" in value) || !("changes" in value)) return false;
  const record = value as Record<string, unknown>;
  return record.type === "changed";
}

function subKey(entity: RealtimeEntity, id?: string): string {
  return id ? `${entity}:${id}` : entity;
}

const realtimeEntitySet: ReadonlySet<string> = new Set(REALTIME_ENTITIES);

function isRealtimeEntity(value: string): value is RealtimeEntity {
  return realtimeEntitySet.has(value);
}

export function parseSubKey(
  key: string,
): { entity: RealtimeEntity; id?: string } | null {
  const idx = key.indexOf(":");
  const entity = idx === -1 ? key : key.slice(0, idx);
  if (!isRealtimeEntity(entity)) {
    return null;
  }
  const id = idx === -1 ? undefined : key.slice(idx + 1);
  return id ? { entity, id } : { entity };
}

// Singleton instance — preserved across Vite HMR so the WebSocket connection
// and its state survive module re-evaluation during dev rebuilds.
function createOrReuse(): WebSocketManager {
  if (import.meta.hot?.data) {
    const existing = import.meta.hot.data.wsManager as WebSocketManager | undefined;
    if (existing) return existing;
    const instance = new WebSocketManager();
    import.meta.hot.data.wsManager = instance;
    return instance;
  }
  return new WebSocketManager();
}

export const wsManager = createOrReuse();
