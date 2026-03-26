import { fileURLToPath } from "node:url";
import {
  threadEventItemSchema,
  type AvailableModel,
  type ThreadEvent,
  type ToolCallRequest,
} from "@bb/domain";
import { z } from "zod";
import type {
  AdapterCommand,
  JsonRpcMessage,
  ProviderAdapter,
} from "../provider-adapter.js";

export interface CreateFakeAdapterOptions {
  displayName?: string;
  id?: string;
  modelId?: string;
  modelName?: string;
  scriptPath?: string;
}

interface FakeEventMessage {
  method?: string;
  params?: Record<string, unknown>;
}

const toolCallParamsSchema = z.object({
  arguments: z.unknown().optional(),
  callId: z.string().optional(),
  threadId: z.string().optional(),
  tool: z.string().optional(),
  turnId: z.string().optional(),
});
type ToolCallParams = z.infer<typeof toolCallParamsSchema>;

const DEFAULT_ADAPTER_ID = "fake";
const DEFAULT_DISPLAY_NAME = "Fake Provider";
const DEFAULT_MODEL_ID = "fake-model";
const DEFAULT_MODEL_NAME = "Fake Model";

export const fakeProviderScriptPath = fileURLToPath(
  new URL("./fake-provider-script.cjs", import.meta.url),
);

function buildCommand(command: AdapterCommand): JsonRpcMessage | null {
  switch (command.type) {
    case "initialize":
      return { jsonrpc: "2.0", method: "initialize", params: {} };
    case "thread/start":
      return {
        jsonrpc: "2.0",
        method: "thread/start",
        params: {
          dynamicTools: command.dynamicTools,
          input: command.input,
          options: command.options,
          threadId: command.threadId,
        },
      };
    case "thread/resume":
      return {
        jsonrpc: "2.0",
        method: "thread/resume",
        params: {
          dynamicTools: command.dynamicTools,
          options: command.options,
          providerThreadId: command.providerThreadId,
          resumePath: command.resumePath,
          threadId: command.threadId,
        },
      };
    case "turn/start":
      return {
        jsonrpc: "2.0",
        method: "turn/start",
        params: {
          input: command.input,
          options: command.options,
          providerThreadId: command.providerThreadId,
          threadId: command.threadId,
        },
      };
    case "turn/steer":
      return {
        jsonrpc: "2.0",
        method: "turn/steer",
        params: {
          expectedTurnId: command.expectedTurnId,
          input: command.input,
          providerThreadId: command.providerThreadId,
          threadId: command.threadId,
        },
      };
    case "thread/stop":
      return {
        jsonrpc: "2.0",
        method: "thread/stop",
        params: { threadId: command.threadId },
      };
    case "thread/name/set":
      return {
        jsonrpc: "2.0",
        method: "thread/name/set",
        params: {
          providerThreadId: command.providerThreadId,
          threadId: command.threadId,
          title: command.title,
        },
      };
    default: {
      const _exhaustive: never = command;
      void _exhaustive;
      return null;
    }
  }
}

function translateEventMessage(event: FakeEventMessage): ThreadEvent[] {
  if (!event.method || !event.params) {
    return [];
  }

  const threadId =
    typeof event.params.threadId === "string" ? event.params.threadId : "";
  const turnId =
    typeof event.params.turnId === "string" ? event.params.turnId : "";
  const providerThreadId =
    typeof event.params.providerThreadId === "string"
      ? event.params.providerThreadId
      : "";

  switch (event.method) {
    case "thread/identity":
      return [
        {
          type: "thread/identity",
          threadId,
          providerThreadId,
        },
      ];
    case "turn/started":
      return [
        {
          type: "turn/started",
          threadId,
          providerThreadId,
          turnId,
        },
      ];
    case "turn/completed":
      return [
        {
          type: "turn/completed",
          threadId,
          providerThreadId,
          turnId,
          status:
            event.params.status === "failed" ||
            event.params.status === "interrupted"
              ? event.params.status
              : "completed",
        },
      ];
    case "item/completed":
      return [
        {
          type: "item/completed",
          threadId,
          providerThreadId,
          turnId,
          item: threadEventItemSchema.parse(event.params.item),
        },
      ];
    case "thread/name/updated":
      return [
        {
          type: "thread/name/updated",
          threadId,
          providerThreadId,
          threadName:
            typeof event.params.threadName === "string"
              ? event.params.threadName
              : "",
        },
      ];
    default:
      return [];
  }
}

function decodeToolCallRequest(request: JsonRpcMessage): ToolCallRequest | null {
  if (request.method !== "item/tool/call") {
    return null;
  }
  if (!request.params || typeof request.params !== "object") {
    return null;
  }

  const parsedParams = toolCallParamsSchema.safeParse(request.params);
  if (!parsedParams.success) {
    return null;
  }

  const params: ToolCallParams = parsedParams.data;
  return {
    arguments: params.arguments,
    callId: typeof params.callId === "string" ? params.callId : "",
    requestId: request.id ?? 0,
    threadId: typeof params.threadId === "string" ? params.threadId : "",
    tool: typeof params.tool === "string" ? params.tool : "",
    turnId: typeof params.turnId === "string" ? params.turnId : "",
  };
}

function listModels(options: CreateFakeAdapterOptions): Promise<AvailableModel[]> {
  return Promise.resolve([
    {
      defaultReasoningEffort: "medium",
      description: "Fake model for integration and runtime tests",
      displayName: options.modelName ?? DEFAULT_MODEL_NAME,
      id: options.modelId ?? DEFAULT_MODEL_ID,
      isDefault: true,
      model: options.modelId ?? DEFAULT_MODEL_ID,
      supportedReasoningEfforts: [
        {
          description: "Medium",
          reasoningEffort: "medium",
        },
      ],
    },
  ]);
}

export function createFakeAdapter(
  options: CreateFakeAdapterOptions = {},
): ProviderAdapter {
  /*
   * Fake provider input control tokens:
   * - `delay:<ms>` delays turn completion by the requested duration.
   * - `call_tool:<name>` emits a tool call before the turn completes.
   * - remaining text is echoed back as `Response to: ...`.
   */
  return {
    buildCommand,
    capabilities: { supportsRename: true, supportsServiceTier: false },
    decodeToolCallRequest,
    displayName: options.displayName ?? DEFAULT_DISPLAY_NAME,
    id: options.id ?? DEFAULT_ADAPTER_ID,
    async listModels() {
      return listModels(options);
    },
    process: {
      args: [options.scriptPath ?? fakeProviderScriptPath],
      command: "node",
    },
    translateEvent(event) {
      if (!event || typeof event !== "object") {
        return [];
      }
      return translateEventMessage(event as FakeEventMessage);
    },
  };
}
