import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  threadEventItemSchema,
  type AvailableModel,
  type ThreadEvent,
} from "@bb/domain";
import type {
  AdapterCommand,
  DecodedToolCallRequest,
  JsonRpcMessage,
  ProviderAdapter,
} from "../provider-adapter.js";
import { parseAvailableModelList } from "../shared/available-models.js";
import { decodeNormalizedProviderToolCallRequest } from "../shared/provider-tool-call-contract.js";

export interface CreateFakeAdapterOptions {
  displayName?: string;
  id?: string;
  scriptPath?: string;
}

interface FakeEventMessage {
  method?: string;
  params?: Record<string, unknown>;
}

const DEFAULT_ADAPTER_ID = "fake";
const DEFAULT_DISPLAY_NAME = "Fake Provider";

function resolveFakeProviderScriptPath(): string {
  const siblingCompiledPath = fileURLToPath(
    new URL("./fake-provider-script.cjs", import.meta.url),
  );
  if (existsSync(siblingCompiledPath)) {
    return siblingCompiledPath;
  }

  const builtPath = fileURLToPath(
    new URL("../../dist/test/fake-provider-script.cjs", import.meta.url),
  );
  if (existsSync(builtPath)) {
    return builtPath;
  }

  throw new Error(
    "Missing fake provider script. Build @bb/agent-runtime before using createFakeAdapter().",
  );
}

export const fakeProviderScriptPath = resolveFakeProviderScriptPath();

function buildCommand(command: AdapterCommand): JsonRpcMessage | null {
  switch (command.type) {
    case "initialize":
      return { jsonrpc: "2.0", method: "initialize", params: {} };
    case "model/list":
      return { jsonrpc: "2.0", method: "model/list", params: {} };
    case "thread/start":
      return {
        jsonrpc: "2.0",
        method: "thread/start",
        params: {
          cwd: command.cwd,
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
          cwd: command.cwd,
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

function decodeToolCallRequest(request: JsonRpcMessage): DecodedToolCallRequest | null {
  if (typeof request.id !== "string" && typeof request.id !== "number") {
    return null;
  }
  return decodeNormalizedProviderToolCallRequest(
    request.id,
    request.method,
    request.params,
  );
}

function parseModelListResult(result: unknown): AvailableModel[] {
  return parseAvailableModelList(result);
}

export function createFakeAdapter(
  options: CreateFakeAdapterOptions = {},
): ProviderAdapter {
  /*
   * Fake provider input control tokens:
   * - `delay:<ms>` delays turn completion by the requested duration.
   * - `call_tool:<name>` emits a provider-scoped tool call with required
   *   `providerThreadId` and no BB `threadId` hint.
   * - remaining text is echoed back as `Response to: ...`.
   */
  return {
    buildCommand,
    capabilities: { supportsRename: true, supportsServiceTier: false },
    decodeToolCallRequest,
    displayName: options.displayName ?? DEFAULT_DISPLAY_NAME,
    id: options.id ?? DEFAULT_ADAPTER_ID,
    parseModelListResult,
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
