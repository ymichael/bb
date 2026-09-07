import type { JsonValue } from "@bb/domain";
import { z } from "zod";

export type BridgeJsonRpcId = string | number;
export type BridgeJsonRpcLineHandler = (line: string) => void;

export interface BridgeJsonRpcObject {
  [key: string]: JsonValue;
}

export interface BridgeJsonRpcOutputMessage {
  jsonrpc: "2.0";
  id?: BridgeJsonRpcId;
  method?: string;
  params?: JsonValue;
  result?: JsonValue;
  error?: {
    code: number;
    message: string;
    data?: JsonValue;
  };
}

export interface CapturedBridgeJsonRpcOutput {
  messages: BridgeJsonRpcOutputMessage[];
  takeMessages(): BridgeJsonRpcOutputMessage[];
  restore(): void;
}

export interface BridgeJsonRpcTestHarness {
  messages: BridgeJsonRpcOutputMessage[];
  takeMessages(): BridgeJsonRpcOutputMessage[];
  flushWork(): Promise<void>;
  hasResponse(id: BridgeJsonRpcId): boolean;
  restore(): void;
  sendRequest(
    id: BridgeJsonRpcId,
    method: string,
    params: BridgeJsonRpcObject,
  ): void;
  waitForResponse(id: BridgeJsonRpcId): Promise<BridgeJsonRpcOutputMessage>;
}

export interface SendBridgeJsonRpcRequestArgs {
  handleLine: BridgeJsonRpcLineHandler;
  id: BridgeJsonRpcId;
  method: string;
  params: BridgeJsonRpcObject;
}

export interface WaitForBridgeJsonRpcResponseArgs {
  id: BridgeJsonRpcId;
  output: CapturedBridgeJsonRpcOutput;
}

export interface BridgeJsonRpcResponseExistsArgs {
  id: BridgeJsonRpcId;
  output: CapturedBridgeJsonRpcOutput;
}

const bridgeJsonRpcValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(bridgeJsonRpcValueSchema),
    z.record(z.string(), bridgeJsonRpcValueSchema),
  ]),
);

const bridgeJsonRpcOutputSchema: z.ZodType<BridgeJsonRpcOutputMessage> =
  z.object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.string(), z.number()]).optional(),
    method: z.string().optional(),
    params: bridgeJsonRpcValueSchema.optional(),
    result: bridgeJsonRpcValueSchema.optional(),
    error: z
      .object({
        code: z.number(),
        message: z.string(),
        data: bridgeJsonRpcValueSchema.optional(),
      })
      .optional(),
  });

function waitForNextBridgeTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function captureBridgeJsonRpcOutput(): CapturedBridgeJsonRpcOutput {
  const messages: BridgeJsonRpcOutputMessage[] = [];
  const originalWrite = process.stdout.write;
  const capturingWrite: typeof process.stdout.write = (
    buffer: string | Uint8Array,
  ) => {
    const text =
      typeof buffer === "string"
        ? buffer
        : Buffer.from(buffer).toString("utf8");
    for (const line of text.split("\n")) {
      if (line.trim().length > 0) {
        messages.push(bridgeJsonRpcOutputSchema.parse(JSON.parse(line)));
      }
    }
    return true;
  };
  process.stdout.write = capturingWrite;
  let drained = 0;
  return {
    messages,
    takeMessages() {
      const fresh = messages.slice(drained);
      drained = messages.length;
      return fresh;
    },
    restore() {
      if (process.stdout.write === capturingWrite) {
        process.stdout.write = originalWrite;
      }
    },
  };
}

function sendBridgeJsonRpcRequest(args: SendBridgeJsonRpcRequestArgs): void {
  args.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: args.id,
      method: args.method,
      params: args.params,
    }),
  );
}

async function waitForBridgeJsonRpcResponse(
  args: WaitForBridgeJsonRpcResponseArgs,
): Promise<BridgeJsonRpcOutputMessage> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const response = args.output.messages.find(
      (message) => message.id === args.id,
    );
    if (response) {
      return response;
    }
    await waitForNextBridgeTick();
  }
  throw new Error(`Timed out waiting for JSON-RPC response ${String(args.id)}`);
}

function bridgeJsonRpcResponseExists(
  args: BridgeJsonRpcResponseExistsArgs,
): boolean {
  return args.output.messages.some((message) => message.id === args.id);
}

export function createBridgeJsonRpcTestHarness(
  handleLine: BridgeJsonRpcLineHandler,
): BridgeJsonRpcTestHarness {
  const output = captureBridgeJsonRpcOutput();
  return {
    messages: output.messages,
    takeMessages: output.takeMessages,
    flushWork: waitForNextBridgeTick,
    hasResponse(id: BridgeJsonRpcId): boolean {
      return bridgeJsonRpcResponseExists({ id, output });
    },
    restore() {
      output.restore();
    },
    sendRequest(
      id: BridgeJsonRpcId,
      method: string,
      params: BridgeJsonRpcObject,
    ): void {
      sendBridgeJsonRpcRequest({ handleLine, id, method, params });
    },
    waitForResponse(id: BridgeJsonRpcId): Promise<BridgeJsonRpcOutputMessage> {
      return waitForBridgeJsonRpcResponse({ id, output });
    },
  };
}
