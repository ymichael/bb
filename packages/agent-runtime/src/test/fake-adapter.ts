import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  threadScope,
  threadEventItemSchema,
  turnScope,
  type AvailableModel,
  type ThreadEvent,
} from "@bb/domain";
import type {
  AdapterCommand,
  DecodedToolCallRequest,
  ProviderAdapter,
  ProviderCommandPlan,
} from "../provider-adapter.js";
import { noPreparedProviderCommandDispatch } from "../provider-adapter.js";
import type {
  ProviderInboundRequest,
  ProviderRuntimeEvent,
} from "../runtime-json-rpc.js";
import { parseAvailableModelList } from "../shared/available-models.js";
import { decodeNormalizedProviderToolCallRequest } from "../shared/provider-tool-call-contract.js";

export interface CreateFakeProviderExecutionContext {
  displayName?: string;
  id?: string;
  scriptPath?: string;
}

interface FakeEventMessage {
  method: string;
  params: Record<string, unknown>;
}

const DEFAULT_ADAPTER_ID = "fake";
const DEFAULT_DISPLAY_NAME = "Fake Provider";

function resolveTsxLoaderSpecifier(): string {
  return import.meta.resolve("tsx");
}

export function buildNodeScriptArgs(scriptPath: string): string[] {
  if (scriptPath.endsWith(".ts")) {
    return [
      "--conditions=source",
      "--import",
      resolveTsxLoaderSpecifier(),
      scriptPath,
    ];
  }

  return [scriptPath];
}

function resolveFakeProviderScriptPath(): string {
  const sourceScriptPath = fileURLToPath(
    new URL("./fake-provider-script.ts", import.meta.url),
  );
  if (existsSync(sourceScriptPath)) {
    return sourceScriptPath;
  }

  throw new Error(
    "Missing fake provider script. Expected packages/agent-runtime/src/test/fake-provider-script.ts.",
  );
}

export const fakeProviderScriptPath = resolveFakeProviderScriptPath();

function buildCommandPlan(command: AdapterCommand): ProviderCommandPlan {
  switch (command.type) {
    case "initialize":
      return { kind: "request", method: "initialize", params: {} };
    case "model/list":
      return { kind: "request", method: "model/list", params: {} };
    case "thread/start":
      return {
        kind: "request",
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
        kind: "request",
        method: "thread/resume",
        params: {
          cwd: command.cwd,
          dynamicTools: command.dynamicTools,
          options: command.options,
          providerThreadId: command.providerThreadId,
          threadId: command.threadId,
        },
      };
    case "turn/start":
      return {
        kind: "request",
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
        kind: "request",
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
        kind: "request",
        method: "thread/stop",
        params: {
          activeTurnId: command.activeTurnId,
          providerThreadId: command.providerThreadId,
          threadId: command.threadId,
        },
      };
    case "thread/name/set":
      return {
        kind: "request",
        method: "thread/name/set",
        params: {
          providerThreadId: command.providerThreadId,
          threadId: command.threadId,
          title: command.title,
        },
      };
    case "thread/archive":
      return {
        kind: "request",
        method: "thread/archive",
        params: {
          providerThreadId: command.providerThreadId,
          threadId: command.threadId,
        },
      };
    case "thread/unarchive":
      return {
        kind: "request",
        method: "thread/unarchive",
        params: {
          providerThreadId: command.providerThreadId,
          threadId: command.threadId,
        },
      };
    default: {
      const _exhaustive: never = command;
      throw new Error(`Unhandled fake adapter command: ${String(_exhaustive)}`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toFakeEventMessage(
  event: ProviderRuntimeEvent,
): FakeEventMessage | null {
  if (typeof event.method !== "string" || !isRecord(event.params)) {
    return null;
  }
  return {
    method: event.method,
    params: event.params,
  };
}

function translateEventMessage(event: ProviderRuntimeEvent): ThreadEvent[] {
  const message = toFakeEventMessage(event);
  if (!message) {
    return [];
  }

  const threadId =
    typeof message.params.threadId === "string" ? message.params.threadId : "";
  const turnId =
    typeof message.params.turnId === "string" ? message.params.turnId : "";
  const providerThreadId =
    typeof message.params.providerThreadId === "string"
      ? message.params.providerThreadId
      : "";

  switch (message.method) {
    case "thread/identity":
      return [
        {
          type: "thread/identity",
          threadId,
          providerThreadId,
          scope: threadScope(),
        },
      ];
    case "turn/started":
      return [
        {
          type: "turn/started",
          threadId,
          providerThreadId,
          scope: turnScope(turnId),
        },
      ];
    case "turn/completed": {
      const status = message.params.status;
      return [
        {
          type: "turn/completed",
          threadId,
          providerThreadId,
          scope: turnScope(turnId),
          status:
            status === "failed" || status === "interrupted"
              ? status
              : "completed",
        },
      ];
    }
    case "item/completed": {
      const item = threadEventItemSchema.parse(message.params.item);
      if (item.type === "userMessage") {
        return [];
      }
      return [
        {
          type: "item/completed",
          threadId,
          providerThreadId,
          scope: turnScope(turnId),
          item,
        },
      ];
    }
    case "thread/name/updated":
      return [
        {
          type: "thread/name/updated",
          threadId,
          providerThreadId,
          scope: threadScope(),
          threadName:
            typeof message.params.threadName === "string"
              ? message.params.threadName
              : "",
        },
      ];
    default:
      return [];
  }
}

function decodeToolCallRequest(
  request: ProviderInboundRequest,
): DecodedToolCallRequest | null {
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
  options: CreateFakeProviderExecutionContext = {},
): ProviderAdapter {
  /*
   * Fake provider input control tokens:
   * - `delay:<ms>` delays turn completion by the requested duration.
   * - `call_tool:<name>` emits a provider-scoped tool call with required
   *   `providerThreadId` and no BB `threadId` hint.
   * - `call_tool_unresolved:<name>` emits the same tool call with a null
   *   `turnId`, matching the canonical bridge wire form for providers that
   *   cannot resolve the BB turn id.
   * - remaining text is echoed back as `Response to: ...`.
   */
  return {
    buildCommandPlan,
    capabilities: {
      supportsArchive: true,
      supportsRename: true,
      supportsServiceTier: false,
      supportedPermissionModes: ["full", "workspace-write", "readonly"],
    },
    decodeToolCallRequest,
    displayName: options.displayName ?? DEFAULT_DISPLAY_NAME,
    id: options.id ?? DEFAULT_ADAPTER_ID,
    parseModelListResult,
    prepareTurnStart: noPreparedProviderCommandDispatch,
    process: {
      args: buildNodeScriptArgs(options.scriptPath ?? fakeProviderScriptPath),
      command: "node",
    },
    translateEvent(event) {
      return translateEventMessage(event);
    },
    translateAcceptedCommand() {
      return [];
    },
  };
}
