import { z } from "zod";

const providerToolCallResponseSchema = z.object({
  success: z.boolean(),
  contentItems: z.array(
    z.discriminatedUnion("type", [
      z.object({
        type: z.literal("inputText"),
        text: z.string(),
      }),
      z.object({
        type: z.literal("inputImage"),
        imageUrl: z.string().min(1),
      }),
    ]),
  ),
});

export interface BridgeToolCallRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: "item/tool/call";
  params: {
    providerThreadId: string;
    threadId?: string;
    turnId: string | null;
    callId: string;
    tool: string;
    arguments: Record<string, unknown>;
  };
}

export const bridgeRequestEnvelopeSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});

const jsonRpcErrorSchema = z.object({
  code: z.number(),
  message: z.string().optional(),
  data: z.unknown().optional(),
});

const jsonRpcSuccessResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  result: z.unknown(),
});

const jsonRpcErrorResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  error: jsonRpcErrorSchema,
});

export type BridgeJsonRpcResponse =
  | z.infer<typeof jsonRpcSuccessResponseSchema>
  | z.infer<typeof jsonRpcErrorResponseSchema>;

function isJsonRpcRequest(input: unknown): boolean {
  return (
    typeof input === "object" &&
    input !== null &&
    "method" in input &&
    input.method !== undefined
  );
}

export function decodeBridgeJsonRpcResponse(
  input: unknown,
): BridgeJsonRpcResponse | null {
  if (isJsonRpcRequest(input)) return null;

  const error = jsonRpcErrorResponseSchema.safeParse(input);
  if (error.success) return error.data;

  const success = jsonRpcSuccessResponseSchema.safeParse(input);
  return success.success ? success.data : null;
}

export interface BridgeToolCallImage {
  data: string;
  mimeType: string;
}

export type BridgeToolCallContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

const IMAGE_DATA_URL = /^data:(.+);base64,(.+)$/s;

function decodeImageDataUrl(imageUrl: string): BridgeToolCallImage | null {
  const match = IMAGE_DATA_URL.exec(imageUrl);
  if (match === null) {
    return null;
  }
  const [, mimeType, data] = match;
  if (data.length === 0) {
    return null;
  }
  return { data, mimeType };
}

export function decodeToolCallResponsePayload(result: unknown): {
  content: string;
  contentBlocks: BridgeToolCallContent[];
  images: BridgeToolCallImage[];
  isError: boolean;
} {
  const parsed = providerToolCallResponseSchema.safeParse(result);
  if (!parsed.success) {
    return {
      content: "Invalid tool call response",
      contentBlocks: [{ type: "text", text: "Invalid tool call response" }],
      images: [],
      isError: true,
    };
  }

  const texts: string[] = [];
  const contentBlocks: BridgeToolCallContent[] = [];
  const images: BridgeToolCallImage[] = [];
  for (const item of parsed.data.contentItems) {
    if (item.type === "inputText") {
      texts.push(item.text);
      if (item.text !== "") {
        contentBlocks.push({ type: "text", text: item.text });
      }
      continue;
    }
    const image = decodeImageDataUrl(item.imageUrl);
    if (image === null) {
      texts.push(item.imageUrl);
      contentBlocks.push({ type: "text", text: item.imageUrl });
      continue;
    }
    images.push(image);
    contentBlocks.push({ type: "image", ...image });
  }

  const text = texts.join("\n");
  const isError = !parsed.data.success;
  if (contentBlocks.length === 0) {
    const fallback = isError ? "Tool call failed" : "OK";
    return {
      content: fallback,
      contentBlocks: [{ type: "text", text: fallback }],
      images,
      isError,
    };
  }
  return {
    content: text,
    contentBlocks,
    images,
    isError,
  };
}

export function buildBridgeToolCallContent(result: {
  content: string;
  contentBlocks?: BridgeToolCallContent[];
  images?: BridgeToolCallImage[];
}): BridgeToolCallContent[] {
  if (result.contentBlocks !== undefined) {
    return result.contentBlocks;
  }
  const blocks: BridgeToolCallContent[] = [];
  if (result.content !== "") {
    blocks.push({ type: "text", text: result.content });
  }
  for (const image of result.images ?? []) {
    blocks.push({ type: "image", data: image.data, mimeType: image.mimeType });
  }
  return blocks;
}
