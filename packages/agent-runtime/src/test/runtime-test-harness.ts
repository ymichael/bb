import type {
  AdapterCommand,
  DecodedInteractiveRequest,
  DecodedToolCallRequest,
  ProviderAdapter,
} from "../provider-adapter.js";
import { ProviderRequestDecodeError } from "../provider-adapter.js";
import { parseAvailableModelList } from "../shared/available-models.js";
import type { AgentRuntimeExecutionOptions } from "../types.js";
import { createFakeAdapter as createSharedFakeAdapter } from "./index.js";

export const fullRuntimeOptions = {
  permissionMode: "full",
  permissionEscalation: null,
} satisfies AgentRuntimeExecutionOptions;

interface CreateRecordingAdapterArgs {
  recordedCommands: AdapterCommand[];
  scriptPath: string;
}

type RuntimeTestRecord = Record<string, unknown>;

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is RuntimeTestRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function waitForCondition(
  condition: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await wait(10);
  }
  throw new Error("Timed out waiting for condition");
}

export function findLastRecordedCommand(
  commands: AdapterCommand[],
  type: AdapterCommand["type"],
): AdapterCommand | undefined {
  for (let index = commands.length - 1; index >= 0; index -= 1) {
    if (commands[index]?.type === type) {
      return commands[index];
    }
  }
  return undefined;
}

export function createFakeAdapter(scriptPath: string): ProviderAdapter {
  return createSharedFakeAdapter({ scriptPath });
}

export function createRecordingAdapter(
  args: CreateRecordingAdapterArgs,
): ProviderAdapter {
  const adapter = createFakeAdapter(args.scriptPath);
  return {
    ...adapter,
    buildCommand(command) {
      args.recordedCommands.push(command);
      return adapter.buildCommand(command);
    },
  };
}

export function createThreadHintMismatchAdapter(
  scriptPath: string,
): ProviderAdapter {
  const adapter = createFakeAdapter(scriptPath);
  return {
    ...adapter,
    decodeToolCallRequest(request): DecodedToolCallRequest | null {
      const decoded = adapter.decodeToolCallRequest(request);
      if (!decoded) {
        return null;
      }
      return {
        ...decoded,
        threadId: "thr_wrong",
      };
    },
  };
}

export function createInteractiveRequestAdapter(
  scriptPath: string,
): ProviderAdapter {
  const adapter = createFakeAdapter(scriptPath);
  return {
    ...adapter,
    decodeInteractiveRequest(request): DecodedInteractiveRequest | null {
      if (request.method !== "request_interaction") {
        return null;
      }
      if (typeof request.id !== "string" && typeof request.id !== "number") {
        return null;
      }
      if (!isRecord(request.params)) {
        return null;
      }

      const params = request.params;
      if (
        typeof params.threadId !== "string"
        || typeof params.turnId !== "string"
        || typeof params.itemId !== "string"
        || typeof params.kind !== "string"
      ) {
        return null;
      }

      if (params.kind === "command_approval") {
        const command = typeof params.command === "string" ? params.command : "";
        return {
          requestId: request.id,
          method: request.method,
          providerThreadId: params.threadId,
          turnId: params.turnId,
          payload: {
            subject: {
              kind: "command",
              itemId: params.itemId,
              command,
              cwd: typeof params.cwd === "string" ? params.cwd : null,
              actions: [],
              sessionGrant: null,
            },
            reason: typeof params.reason === "string" ? params.reason : null,
            availableDecisions: ["allow_once", "allow_for_session", "deny"],
          },
        };
      }

      if (params.kind === "file_change_approval") {
        return {
          requestId: request.id,
          method: request.method,
          providerThreadId: params.threadId,
          turnId: params.turnId,
          payload: {
            subject: {
              kind: "file_change",
              itemId: params.itemId,
              writeScope: null,
              sessionGrant: null,
            },
            reason: null,
            availableDecisions: ["allow_once", "deny"],
          },
        };
      }

      return null;
    },
    buildInteractiveResponse({ resolution }) {
      return { resolution };
    },
  };
}

export function createInvalidInteractiveRequestAdapter(
  scriptPath: string,
): ProviderAdapter {
  const adapter = createFakeAdapter(scriptPath);
  return {
    ...adapter,
    decodeInteractiveRequest(request): DecodedInteractiveRequest | null {
      if (request.method !== "request_interaction") {
        return null;
      }
      throw new ProviderRequestDecodeError("Invalid interactive request params");
    },
    buildInteractiveResponse({ resolution }) {
      return { resolution };
    },
  };
}

export function createWarningEventAdapter(scriptPath: string): ProviderAdapter {
  return {
    id: "warning-fake",
    displayName: "Warning Fake",
    capabilities: {
      supportsRename: false,
      supportsServiceTier: false,
      supportedPermissionModes: ["full", "workspace-write", "readonly"],
    },
    threadStopBehavior: "keep-provider",
    process: {
      command: "node",
      args: [scriptPath],
    },
    buildCommand(command) {
      switch (command.type) {
        case "initialize":
          return {
            jsonrpc: "2.0",
            method: "initialize",
          };
        case "model/list":
          return {
            jsonrpc: "2.0",
            method: "model/list",
            params: {},
          };
        case "thread/start":
          return {
            jsonrpc: "2.0",
            method: "thread/start",
            params: {
              threadId: command.threadId,
            },
          };
        case "turn/start":
          return {
            jsonrpc: "2.0",
            method: "turn/start",
            params: {
              threadId: command.providerThreadId ?? command.threadId,
            },
          };
        case "thread/resume":
        case "turn/steer":
        case "thread/stop":
        case "thread/name/set":
          return null;
      }
    },
    translateEvent(event) {
      if (!isRuntimeTestEvent(event)) {
        return [];
      }

      switch (event.method) {
        case "warning":
          return [
            {
              type: "warning",
              threadId: "",
              providerThreadId: "",
              category: "config",
              summary: "provider warning",
            },
          ];
        case "turn/started":
          return [
            {
              type: "turn/started",
              threadId: stringParam(event, "threadId"),
              providerThreadId: stringParam(event, "providerThreadId"),
              turnId: stringParam(event, "turnId"),
            },
          ];
        case "turn/completed":
          return [
            {
              type: "turn/completed",
              threadId: stringParam(event, "threadId"),
              providerThreadId: stringParam(event, "providerThreadId"),
              turnId: stringParam(event, "turnId"),
              status: "completed",
            },
          ];
        default:
          return [];
      }
    },
    decodeToolCallRequest() {
      return null;
    },
    parseModelListResult(result) {
      return parseAvailableModelList(result);
    },
  };
}

export function createStartedEventAdapter(scriptPath: string): ProviderAdapter {
  return {
    id: "started-fake",
    displayName: "Started Fake",
    capabilities: {
      supportsRename: false,
      supportsServiceTier: false,
      supportedPermissionModes: ["full", "workspace-write", "readonly"],
    },
    threadStopBehavior: "keep-provider",
    process: {
      command: "node",
      args: [scriptPath],
    },
    buildCommand(command) {
      switch (command.type) {
        case "initialize":
          return {
            jsonrpc: "2.0",
            method: "initialize",
          };
        case "model/list":
          return {
            jsonrpc: "2.0",
            method: "model/list",
            params: {},
          };
        case "thread/start":
          return {
            jsonrpc: "2.0",
            method: "thread/start",
            params: {
              threadId: command.threadId,
            },
          };
        case "thread/resume":
        case "turn/start":
        case "turn/steer":
        case "thread/stop":
        case "thread/name/set":
          return null;
      }
    },
    translateEvent(event) {
      if (!isStartedThreadEvent(event)) {
        return [];
      }

      return [
        {
          type: "thread/started",
          threadId: event.params.thread.id,
        },
        {
          type: "thread/identity",
          threadId: event.params.thread.id,
          providerThreadId: event.params.thread.id,
        },
      ];
    },
    decodeToolCallRequest() {
      return null;
    },
    parseModelListResult(result) {
      return parseAvailableModelList(result);
    },
  };
}

interface RuntimeTestEvent {
  method: string;
  params?: RuntimeTestRecord;
}

interface StartedThreadEvent {
  method: "thread/started";
  params: {
    thread: {
      id: string;
      preview?: string;
    };
  };
}

function isRuntimeTestEvent(event: unknown): event is RuntimeTestEvent {
  return isRecord(event) && typeof event.method === "string";
}

function stringParam(event: RuntimeTestEvent, key: string): string {
  if (!isRecord(event.params)) {
    return "";
  }
  const value = event.params[key];
  return typeof value === "string" ? value : "";
}

function isStartedThreadEvent(event: unknown): event is StartedThreadEvent {
  if (!isRecord(event) || event.method !== "thread/started") {
    return false;
  }
  if (!isRecord(event.params) || !isRecord(event.params.thread)) {
    return false;
  }
  return typeof event.params.thread.id === "string";
}
