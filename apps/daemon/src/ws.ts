import type { WebSocket } from "ws";
import {
  SYSTEM_CHANGE_KINDS,
  THREAD_CHANGE_KINDS,
  type ClientMessage,
  type RealtimeEntity,
  type ServerMessage,
  type SystemChangeKind,
  type ThreadChangeKind,
} from "@beanbag/agent-core";

function subscriptionKey(entity: RealtimeEntity, id?: string): string {
  return id ? `${entity}:${id}` : entity;
}

export class WSManager {
  /** Map from WebSocket to its subscriptions */
  private connections = new Map<WebSocket, Set<string>>();
  /** Map from subscription key to subscribed sockets */
  private subscriptions = new Map<string, Set<WebSocket>>();

  handleConnection(socket: WebSocket): void {
    this.connections.set(socket, new Set());

    socket.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
      try {
        const msg = JSON.parse(raw.toString()) as ClientMessage;
        if (msg.type === "subscribe") {
          this.subscribe(socket, msg.entity, msg.id);
        } else if (msg.type === "unsubscribe") {
          this.unsubscribe(socket, msg.entity, msg.id);
        }
      } catch {
        // Ignore malformed messages
      }
    });

    socket.on("close", () => {
      this.removeConnection(socket);
    });

    socket.on("error", () => {
      this.removeConnection(socket);
    });
  }

  private subscribe(socket: WebSocket, entity: RealtimeEntity, id?: string): void {
    const key = subscriptionKey(entity, id);

    // Track on the connection side
    const connSubs = this.connections.get(socket);
    if (connSubs) {
      connSubs.add(key);
    }

    // Track on the subscription side
    let sockets = this.subscriptions.get(key);
    if (!sockets) {
      sockets = new Set();
      this.subscriptions.set(key, sockets);
    }
    sockets.add(socket);
  }

  private unsubscribe(socket: WebSocket, entity: RealtimeEntity, id?: string): void {
    const key = subscriptionKey(entity, id);

    // Remove from connection tracking
    const connSubs = this.connections.get(socket);
    if (connSubs) {
      connSubs.delete(key);
    }

    // Remove from subscription tracking
    const sockets = this.subscriptions.get(key);
    if (sockets) {
      sockets.delete(socket);
      if (sockets.size === 0) {
        this.subscriptions.delete(key);
      }
    }
  }

  private removeConnection(socket: WebSocket): void {
    const connSubs = this.connections.get(socket);
    if (connSubs) {
      for (const key of connSubs) {
        const sockets = this.subscriptions.get(key);
        if (sockets) {
          sockets.delete(socket);
          if (sockets.size === 0) {
            this.subscriptions.delete(key);
          }
        }
      }
    }
    this.connections.delete(socket);
  }

  /**
   * Broadcast a "changed" message to all subscribers of the given entity.
   * Subscribers who subscribed to the entity without an id get all changes.
   * Subscribers who subscribed with a specific id only get changes for that id.
   */
  broadcast(entity: "thread", id?: string, changes?: ThreadChangeKind[]): void;
  broadcast(entity: "system", id?: undefined, changes?: SystemChangeKind[]): void;
  broadcast(
    entity: RealtimeEntity,
    id?: string,
    changes?: ThreadChangeKind[] | SystemChangeKind[],
  ): void {
    let msg: ServerMessage;
    switch (entity) {
      case "thread":
        msg = {
          type: "changed",
          entity,
          ...(id ? { id } : {}),
          changes: [...((changes as ThreadChangeKind[] | undefined) ?? THREAD_CHANGE_KINDS)],
        };
        break;
      case "system":
        msg = {
          type: "changed",
          entity,
          changes: [...((changes as SystemChangeKind[] | undefined) ?? SYSTEM_CHANGE_KINDS)],
        };
        break;
    }
    const raw = JSON.stringify(msg);

    const recipients = new Set<WebSocket>();

    // Subscribers to the entity (no id filter) get all changes
    const entitySubs = this.subscriptions.get(subscriptionKey(entity));
    if (entitySubs) {
      for (const socket of entitySubs) {
        recipients.add(socket);
      }
    }

    // Subscribers to the specific entity+id
    if (id) {
      const specificSubs = this.subscriptions.get(subscriptionKey(entity, id));
      if (specificSubs) {
        for (const socket of specificSubs) {
          recipients.add(socket);
        }
      }
    }

    for (const socket of recipients) {
      if (socket.readyState === 1 /* OPEN */) {
        socket.send(raw);
      }
    }
  }

  close(): void {
    for (const socket of this.connections.keys()) {
      try {
        socket.close();
      } catch {
        // Ignore close errors
      }
    }
    this.connections.clear();
    this.subscriptions.clear();
  }
}
