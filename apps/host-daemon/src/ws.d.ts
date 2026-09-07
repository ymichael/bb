declare module "ws" {
  import { EventEmitter } from "node:events";
  import type { IncomingMessage } from "node:http";
  import type { Duplex } from "node:stream";

  export type RawData = string | Buffer | ArrayBuffer | Buffer[];

  export interface ClientOptions {
    headers?: Record<string, string>;
  }

  export class WebSocket extends EventEmitter {
    constructor(address: string | URL, options?: ClientOptions);
    constructor(
      address: string | URL,
      protocols?: string | string[],
      options?: ClientOptions,
    );
    static readonly OPEN: number;
    readonly readyState: number;
    readonly protocol: string;
    send(data: string | Buffer | Uint8Array): void;
    close(code?: number, reason?: string): void;
    terminate(): void;
    on(event: "open", listener: () => void): this;
    on(event: "message", listener: (data: RawData) => void): this;
    on(
      event: "message",
      listener: (data: Buffer, isBinary: boolean) => void,
    ): this;
    on(event: "close", listener: () => void): this;
    on(event: "close", listener: (code: number, reason: Buffer) => void): this;
    on(event: "error", listener: (error: Error) => void): this;
    on(
      event: "unexpected-response",
      listener: (request: unknown, response: IncomingMessage) => void,
    ): this;
    removeAllListeners(): this;
  }

  export class WebSocketServer extends EventEmitter {
    clients: Set<WebSocket>;
    constructor(options?: { noServer?: boolean; maxPayload?: number });
    handleUpgrade(
      request: IncomingMessage,
      socket: Duplex,
      head: Buffer,
      callback: (websocket: WebSocket) => void,
    ): void;
    close(callback?: (error?: Error) => void): void;
  }
}
