import type { JsonValue } from "@bb/domain";
import { vi } from "vitest";
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
  restore(): void;
}

export interface BridgeJsonRpcTestHarness {
  messages: BridgeJsonRpcOutputMessage[];
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
  ])
);

const bridgeJsonRpcOutputSchema: z.ZodType<BridgeJsonRpcOutputMessage> =
  z.object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.string(), z.number()]).optional(),
    method: z.string().optional(),
    params: bridgeJsonRpcValueSchema.optional(),
    result: bridgeJsonRpcValueSchema.optional(),
    error: z.object({
      code: z.number(),
      message: z.string(),
      data: bridgeJsonRpcValueSchema.optional(),
    }).optional(),
  });

function waitForNextBridgeTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function captureBridgeJsonRpcOutput(): CapturedBridgeJsonRpcOutput {
  const messages: BridgeJsonRpcOutputMessage[] = [];
  const writeSpy = vi.spyOn(process.stdout, "write");
  writeSpy.mockImplementation((buffer: string | Uint8Array) => {
    const text = typeof buffer === "string"
      ? buffer
      : Buffer.from(buffer).toString("utf8");
    for (const line of text.split("\n")) {
      if (line.trim().length > 0) {
        messages.push(bridgeJsonRpcOutputSchema.parse(JSON.parse(line)));
      }
    }
    return true;
  });
  return {
    messages,
    restore() {
      writeSpy.mockRestore();
    },
  };
}

export function sendBridgeJsonRpcRequest(
  args: SendBridgeJsonRpcRequestArgs,
): void {
  args.handleLine(JSON.stringify({
    jsonrpc: "2.0",
    id: args.id,
    method: args.method,
    params: args.params,
  }));
}

export async function waitForBridgeJsonRpcResponse(
  args: WaitForBridgeJsonRpcResponseArgs,
): Promise<BridgeJsonRpcOutputMessage> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = args.output.messages.find(
      (message) => message.id === args.id,
    );
    if (response) {
      return response;
    }
    await waitForNextBridgeTick();
  }
  throw new Error(
    `Timed out waiting for JSON-RPC response ${String(args.id)}`,
  );
}

export async function flushBridgeJsonRpcWork(): Promise<void> {
  await waitForNextBridgeTick();
}

export function bridgeJsonRpcResponseExists(
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
    flushWork: flushBridgeJsonRpcWork,
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
