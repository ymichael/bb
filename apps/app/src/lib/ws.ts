import type {
  ClientMessage,
  ChangedMessage,
  RealtimeEntity,
  ServerMessage,
} from "@beanbag/agent-core";

export type ChangeCallback = (message: ChangedMessage) => void;

class WebSocketManager {
  private socket: WebSocket | null = null;
  private subscriptions = new Set<string>();
  private callbacks = new Set<ChangeCallback>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connected = false;

  connect(): void {
    if (this.socket) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/ws`;

    try {
      this.socket = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.socket.onopen = () => {
      this.connected = true;
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
      this.connected = false;
      this.socket = null;
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
      this.socket.close();
      this.socket = null;
    }
    this.connected = false;
  }

  subscribe(entity: RealtimeEntity, id?: string): void {
    const key = subKey(entity, id);
    this.subscriptions.add(key);
    if (this.connected) {
      this.sendMessage({ type: "subscribe", entity, id });
    }
  }

  unsubscribe(entity: RealtimeEntity, id?: string): void {
    const key = subKey(entity, id);
    this.subscriptions.delete(key);
    if (this.connected) {
      this.sendMessage({ type: "unsubscribe", entity, id });
    }
  }

  onChanged(callback: ChangeCallback): () => void {
    this.callbacks.add(callback);
    return () => {
      this.callbacks.delete(callback);
    };
  }

  private sendMessage(msg: ClientMessage): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(msg));
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
