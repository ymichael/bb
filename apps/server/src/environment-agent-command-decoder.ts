import { assertNever, getStringField, toRecord } from "@bb/core";
import type {
  PromptInput,
  ProviderDynamicTool,
  ProviderExecutionOptions,
  ProviderThreadContext,
  SpawnThreadRequest,
} from "@bb/core";
import type {
  EnvironmentAgentCommand,
  EnvironmentAgentInitializeRequest,
  EnvironmentAgentProviderFile,
} from "@bb/environment-daemon";

const ENVIRONMENT_AGENT_COMMAND_TYPES = [
  "provider.ensure",
  "thread.start",
  "thread.resume",
  "thread.stop",
  "turn.run",
  "thread.rename",
  "provider.list_models",
  "provider.list_catalog",
  "workspace.status",
  "workspace.diff",
] as const satisfies readonly EnvironmentAgentCommand["type"][];

function decodeEnvironmentAgentCommandType(
  value: string,
): EnvironmentAgentCommand["type"] | null {
  return ENVIRONMENT_AGENT_COMMAND_TYPES.find((candidate) => candidate === value) ?? null;
}

function decodeStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const result = value.filter(
    (entry): entry is string => typeof entry === "string",
  );
  return result.length === value.length ? result : null;
}

function decodeStringRecord(value: unknown): Record<string, string> | undefined {
  const record = toRecord(value);
  if (!record) return undefined;

  const entries = Object.entries(record);
  if (entries.some(([, entry]) => typeof entry !== "string")) {
    return undefined;
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function decodeProviderFile(value: unknown): EnvironmentAgentProviderFile | null {
  const record = toRecord(value);
  if (!record) return null;

  const path = getStringField(record, "path");
  const content = getStringField(record, "content");
  const placement = getStringField(record, "placement");
  if (!path || !content || placement !== "home") {
    return null;
  }

  return {
    path,
    content,
    placement,
  };
}

function decodeProviderFiles(value: unknown): EnvironmentAgentProviderFile[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const files = value
    .map((entry) => decodeProviderFile(entry))
    .filter((entry): entry is EnvironmentAgentProviderFile => entry !== null);
  return files.length === value.length ? files : undefined;
}

function decodeInitializeRequest(
  value: unknown,
): EnvironmentAgentInitializeRequest | undefined {
  if (value === undefined) return undefined;

  const record = toRecord(value);
  const method = getStringField(record, "method");
  if (!record || !method || !("params" in record)) {
    return undefined;
  }

  return {
    method,
    params: record.params,
  };
}

function decodeCommandRecord(
  payload: unknown,
  commandType: string,
): Record<string, unknown> {
  const record = toRecord(payload);
  if (!record) {
    throw new Error(
      `Invalid persisted environment-agent command payload for ${commandType}`,
    );
  }
  if ("type" in record && record.type !== commandType) {
    throw new Error(
      `Environment-agent command payload type mismatch for ${commandType}`,
    );
  }
  return record;
}

function requireStringField(
  record: Record<string, unknown>,
  key: string,
  commandType: string,
): string {
  const value = getStringField(record, key);
  if (!value) {
    throw new Error(
      `Invalid persisted environment-agent command payload for ${commandType}`,
    );
  }
  return value;
}

function decodeThreadContext(value: unknown): ProviderThreadContext | undefined {
  return toRecord(value) as unknown as ProviderThreadContext | undefined;
}

function decodeSpawnThreadRequest(value: unknown): SpawnThreadRequest | undefined {
  return toRecord(value) as unknown as SpawnThreadRequest | undefined;
}

function decodeDynamicTools(value: unknown): ProviderDynamicTool[] | undefined {
  return Array.isArray(value) ? value as ProviderDynamicTool[] : undefined;
}

function decodeExecutionOptions(value: unknown): ProviderExecutionOptions | undefined {
  return toRecord(value) as ProviderExecutionOptions | undefined;
}

function decodePromptInputArray(value: unknown): PromptInput[] | undefined {
  return Array.isArray(value) ? value as PromptInput[] : undefined;
}

function decodeProviderId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export function decodePersistedEnvironmentAgentCommand(args: {
  commandType: string;
  payload: unknown;
}): EnvironmentAgentCommand {
  const commandType = decodeEnvironmentAgentCommandType(args.commandType);
  if (!commandType) {
    throw new Error(`Unsupported environment-agent command type ${args.commandType}`);
  }

  const record = decodeCommandRecord(args.payload, commandType);
  const initialize = decodeInitializeRequest(record.initialize);

  switch (commandType) {
    case "provider.ensure": {
      const command = getStringField(record, "command");
      const providerArgs =
        record.args === undefined ? undefined : decodeStringArray(record.args);
      if (record.args !== undefined && !providerArgs) {
        throw new Error(
          `Invalid persisted environment-agent command payload for ${commandType}`,
        );
      }
      const launchArgs =
        record.launchArgs === undefined ? undefined : decodeStringArray(record.launchArgs);
      if (record.launchArgs !== undefined && !launchArgs) {
        throw new Error(
          `Invalid persisted environment-agent command payload for ${commandType}`
        );
      }
      const env = decodeStringRecord(record.env);
      if (record.env !== undefined && !env) {
        throw new Error(
          `Invalid persisted environment-agent command payload for ${commandType}`
        );
      }
      const files = decodeProviderFiles(record.files);
      if (record.files !== undefined && !files) {
        throw new Error(
          `Invalid persisted environment-agent command payload for ${commandType}`
        );
      }
      const launchCommand = getStringField(record, "launchCommand");
      const forThreadId = getStringField(record, "forThreadId");
      if (!command && !decodeProviderId(record.providerId)) {
        throw new Error(
          `Invalid persisted environment-agent command payload for ${commandType}`,
        );
      }
      return {
        type: commandType,
        ...(command ? { command } : {}),
        ...(providerArgs ? { args: providerArgs } : {}),
        ...(launchCommand ? { launchCommand } : {}),
        ...(launchArgs ? { launchArgs } : {}),
        ...(env ? { env } : {}),
        ...(files ? { files } : {}),
        ...(forThreadId ? { forThreadId } : {}),
        ...(decodeProviderId(record.providerId)
          ? { providerId: decodeProviderId(record.providerId)! }
          : {}),
        ...(decodeThreadContext(record.context)
          ? { context: decodeThreadContext(record.context)! }
          : {}),
        ...(toRecord(record.providerLaunch)
          ? {
              providerLaunch: {
                command: requireStringField(
                  toRecord(record.providerLaunch)!,
                  "command",
                  commandType,
                ),
                args: decodeStringArray(toRecord(record.providerLaunch)!.args) ?? [],
              },
            }
          : {}),
      };
    }
    case "thread.start":
      return {
        type: commandType,
        threadId: requireStringField(record, "threadId", commandType),
        projectId: requireStringField(record, "projectId", commandType),
        ...(decodeSpawnThreadRequest(record.request)
          ? { request: decodeSpawnThreadRequest(record.request)! }
          : {}),
        ...(decodeThreadContext(record.context)
          ? { context: decodeThreadContext(record.context)! }
          : {}),
        ...(decodeDynamicTools(record.dynamicTools)
          ? { dynamicTools: decodeDynamicTools(record.dynamicTools)! }
          : {}),
        ...(initialize ? { initialize } : {}),
      };
    case "thread.resume":
      return {
        type: commandType,
        threadId: requireStringField(record, "threadId", commandType),
        projectId: requireStringField(record, "projectId", commandType),
        providerThreadId: requireStringField(
          record,
          "providerThreadId",
          commandType,
        ),
        ...(decodeThreadContext(record.context)
          ? { context: decodeThreadContext(record.context)! }
          : {}),
        ...(decodeExecutionOptions(record.options)
          ? { options: decodeExecutionOptions(record.options)! }
          : {}),
        ...(getStringField(record, "resumePath")
          ? { resumePath: getStringField(record, "resumePath")! }
          : {}),
        ...(initialize ? { initialize } : {}),
      };
    case "thread.stop":
      return {
        type: commandType,
        threadId: requireStringField(record, "threadId", commandType),
        ...(initialize ? { initialize } : {}),
      };
    case "turn.run": {
      const requestedMode = getStringField(record, "requestedMode");
      if (
        requestedMode !== undefined &&
        requestedMode !== "auto" &&
        requestedMode !== "steer" &&
        requestedMode !== "start"
      ) {
        throw new Error(
          `Invalid persisted environment-agent command payload for ${commandType}`,
        );
      }
      const activeTurnId = getStringField(record, "activeTurnId");
      if (!Array.isArray(record.input)) {
        throw new Error(
          `Invalid persisted environment-agent command payload for ${commandType}`,
        );
      }
      return {
        type: commandType,
        threadId: requireStringField(record, "threadId", commandType),
        providerThreadId: requireStringField(
          record,
          "providerThreadId",
          commandType,
        ),
        ...(requestedMode ? { requestedMode } : {}),
        ...(activeTurnId ? { activeTurnId } : {}),
        input: decodePromptInputArray(record.input)!,
        ...(decodeExecutionOptions(record.options)
          ? { options: decodeExecutionOptions(record.options)! }
          : {}),
        ...(initialize ? { initialize } : {}),
      };
    }
    case "thread.rename":
      return {
        type: commandType,
        threadId: requireStringField(record, "threadId", commandType),
        providerThreadId: requireStringField(
          record,
          "providerThreadId",
          commandType,
        ),
        title: requireStringField(record, "title", commandType),
        ...(initialize ? { initialize } : {}),
      };
    case "provider.list_models":
      return {
        type: commandType,
        ...(decodeProviderId(record.providerId)
          ? { providerId: decodeProviderId(record.providerId)! }
          : {}),
      };
    case "provider.list_catalog":
      return {
        type: commandType,
      };
    case "workspace.status":
    case "workspace.diff":
      return {
        type: commandType,
        threadId: requireStringField(record, "threadId", commandType),
      };
    default:
      return assertNever(commandType);
  }
}
