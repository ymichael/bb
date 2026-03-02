import type {
  ClientMessage,
  ChangedMessage,
  RealtimeEntity,
  ServerMessage,
} from "@beanbag/agent-core";

export type ChangeCallback = (message: ChangedMessage) => void;
export type WebSocketConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnected";
export type ConnectionStateCallback = (
  state: WebSocketConnectionState,
) => void;

class WebSocketManager {
  private socket: WebSocket | null = null;
  private subscriptions = new Set<string>();
  private callbacks = new Set<ChangeCallback>();
  private connectionCallbacks = new Set<ConnectionStateCallback>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectionState: WebSocketConnectionState = "idle";

  connect(): void {
    if (this.socket) return;
    this.setConnectionState("connecting");

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/ws`;

    try {
      this.socket = new WebSocket(url);
    } catch {
      this.setConnectionState("disconnected");
      this.scheduleReconnect();
      return;
    }

    this.socket.onopen = () => {
      this.setConnectionState("connected");
      // Re-subscribe to all active subscriptions
      for (const key of this.subscriptions) {
        const parsed = parseSubKey(key);
        if (!parsed) continue;
        this.sendMessage({ type: "subscribe", entity: parsed.entity, id: parsed.id });
      }
    };

    this.socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as ServerMessage;
        if (msg.type === "changed") {
          for (const cb of this.callbacks) {
            cb(msg);
          }
        }
      } catch {
        // Ignore malformed messages
      }
    };

    this.socket.onclose = () => {
      this.socket = null;
      this.setConnectionState("disconnected");
      this.scheduleReconnect();
    };

    this.socket.onerror = () => {
      // onclose will fire after this
    };
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      socket.close();
    }
    this.setConnectionState("idle");
  }

  subscribe(entity: RealtimeEntity, id?: string): void {
    const key = subKey(entity, id);
    this.subscriptions.add(key);
    if (this.connectionState === "connected") {
      this.sendMessage({ type: "subscribe", entity, id });
    }
  }

  unsubscribe(entity: RealtimeEntity, id?: string): void {
    const key = subKey(entity, id);
    this.subscriptions.delete(key);
    if (this.connectionState === "connected") {
      this.sendMessage({ type: "unsubscribe", entity, id });
    }
  }

  onChanged(callback: ChangeCallback): () => void {
    this.callbacks.add(callback);
    return () => {
      this.callbacks.delete(callback);
    };
  }

  getConnectionState(): WebSocketConnectionState {
    return this.connectionState;
  }

  onConnectionStateChange(callback: ConnectionStateCallback): () => void {
    this.connectionCallbacks.add(callback);
    callback(this.connectionState);
    return () => {
      this.connectionCallbacks.delete(callback);
    };
  }

  private sendMessage(msg: ClientMessage): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(msg));
    }
  }

  private setConnectionState(nextState: WebSocketConnectionState): void {
    if (this.connectionState === nextState) return;
    this.connectionState = nextState;
    for (const callback of this.connectionCallbacks) {
      callback(nextState);
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 3000);
  }
}

function subKey(entity: RealtimeEntity, id?: string): string {
  return id ? `${entity}:${id}` : entity;
}

function isRealtimeEntity(value: string): value is RealtimeEntity {
  return value === "thread";
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

// Singleton instance
export const wsManager = new WebSocketManager();
