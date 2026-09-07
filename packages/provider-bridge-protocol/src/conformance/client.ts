import type { ThreadEvent } from "@bb/domain";
import { z } from "zod";
import type { BridgeDeltaEventCollector } from "../testing/bridge-delta-assembly.js";
import { THREAD_DELTA_NOTIFICATION_METHOD } from "../thread-delta.js";
import type { BridgeConformanceTransport } from "./types.js";

export interface JsonRpcWireMessage {
  jsonrpc?: unknown;
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown; data?: unknown };
}

export interface AssembledConformanceEvent {
  threadId: string;
  event: ThreadEvent;
  logIndex: number;
}

function isWireMessage(value: unknown): value is JsonRpcWireMessage {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const threadDeltaAddressSchema = z
  .object({ threadId: z.string() })
  .passthrough();

export class ConformanceClient {
  private nextId = 1;
  readonly log: JsonRpcWireMessage[] = [];
  readonly events: AssembledConformanceEvent[] = [];

  constructor(
    private readonly transport: BridgeConformanceTransport,
    private readonly timeoutMs: number,
    private readonly collector: BridgeDeltaEventCollector,
  ) {}

  drainIntoLog(): void {
    for (const raw of this.transport.takeMessages()) {
      if (!isWireMessage(raw)) {
        continue;
      }
      const logIndex = this.log.length;
      this.log.push(raw);
      if (raw.method !== THREAD_DELTA_NOTIFICATION_METHOD) {
        continue;
      }
      const events = this.collector.assembleMessage(raw);
      const address = threadDeltaAddressSchema.parse(raw.params);
      for (const event of events) {
        this.events.push({ threadId: address.threadId, event, logIndex });
      }
    }
  }

  sendRaw(line: string): void {
    this.transport.send(line);
  }

  notify(method: string, params?: unknown): void {
    this.transport.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method,
        ...(params !== undefined ? { params } : {}),
      }),
    );
  }

  request(method: string, params?: unknown): number {
    const id = this.nextId;
    this.nextId += 1;
    this.transport.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        ...(params !== undefined ? { params } : {}),
      }),
    );
    return id;
  }

  async waitFor<T>(resolve: () => T | undefined): Promise<T | null> {
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      this.drainIntoLog();
      const value = resolve();
      if (value !== undefined) {
        return value;
      }
      if (Date.now() > deadline) {
        return null;
      }
      await new Promise((r) => setTimeout(r, 15));
    }
  }

  async waitForResponse(id: number): Promise<JsonRpcWireMessage | null> {
    return this.waitFor(() =>
      this.log.find(
        (message) => message.id === id && message.method === undefined,
      ),
    );
  }

  async settle(quietMs: number): Promise<void> {
    const deadline = Date.now() + quietMs;
    while (Date.now() < deadline) {
      this.drainIntoLog();
      await new Promise((r) => setTimeout(r, 15));
    }
    this.drainIntoLog();
  }

  responsesFor(id: number): JsonRpcWireMessage[] {
    return this.log.filter(
      (message) => message.id === id && message.method === undefined,
    );
  }

  notifications(method?: string): JsonRpcWireMessage[] {
    return this.log.filter(
      (message) =>
        message.id === undefined &&
        typeof message.method === "string" &&
        (method === undefined || message.method === method),
    );
  }
}

let clientRequestCounter = 0;

export function nextConformanceClientRequestId(): string {
  const alphabet = "23456789abcdefghijkmnpqrstuvwxyz";
  clientRequestCounter += 1;
  let remaining = clientRequestCounter;
  let suffix = "";
  while (suffix.length < 10) {
    suffix = alphabet[remaining % alphabet.length] + suffix;
    remaining = Math.floor(remaining / alphabet.length);
  }
  return `creq_${suffix}`;
}
