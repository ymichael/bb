declare module "ws" {
  import { EventEmitter } from "node:events";
  import type { IncomingMessage } from "node:http";
  import type { Duplex } from "node:stream";

  export type RawData = string | Buffer | ArrayBuffer | Buffer[];

  export interface ClientOptions {
    headers?: Record<string, string>;
  }

  export class WebSocket extends EventEmitter {
    constructor(
      address: string | URL,
      protocols?: string | string[],
      options?: ClientOptions,
    );
    static readonly OPEN: number;
    readonly readyState: number;
    send(data: string | Buffer): void;
    close(code?: number, reason?: string): void;
    terminate(): void;
    on(event: "open", listener: () => void): this;
    on(event: "message", listener: (data: RawData) => void): this;
    on(event: "close", listener: () => void): this;
    on(event: "error", listener: (error: Error) => void): this;
    removeAllListeners(): this;
  }

  export class WebSocketServer extends EventEmitter {
    clients: Set<WebSocket>;
    constructor(options?: { noServer?: boolean });
    handleUpgrade(
      request: IncomingMessage,
      socket: Duplex,
      head: Buffer,
      callback: (websocket: WebSocket) => void,
    ): void;
    close(callback?: (error?: Error) => void): void;
  }
}
