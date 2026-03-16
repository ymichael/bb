import { assertNever, getStringField, toRecord } from "@bb/core";
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
  "turn.start",
  "turn.steer",
  "thread.rename",
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

function requireParamsField(
  record: Record<string, unknown>,
  commandType: string,
): unknown {
  if (!("params" in record)) {
    throw new Error(
      `Invalid persisted environment-agent command payload for ${commandType}`,
    );
  }
  return record.params;
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
      const command = requireStringField(record, "command", commandType);
      const providerArgs = decodeStringArray(record.args);
      if (!providerArgs) {
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
      return {
        type: commandType,
        command,
        args: providerArgs,
        ...(launchCommand ? { launchCommand } : {}),
        ...(launchArgs ? { launchArgs } : {}),
        ...(env ? { env } : {}),
        ...(files ? { files } : {}),
      };
    }
    case "thread.start":
      return {
        type: commandType,
        threadId: requireStringField(record, "threadId", commandType),
        projectId: requireStringField(record, "projectId", commandType),
        params: requireParamsField(record, commandType),
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
        params: requireParamsField(record, commandType),
        ...(initialize ? { initialize } : {}),
      };
    case "thread.stop":
      return {
        type: commandType,
        threadId: requireStringField(record, "threadId", commandType),
        ...(record.params !== undefined ? { params: record.params } : {}),
        ...(initialize ? { initialize } : {}),
      };
    case "turn.start":
      return {
        type: commandType,
        threadId: requireStringField(record, "threadId", commandType),
        providerThreadId: requireStringField(
          record,
          "providerThreadId",
          commandType,
        ),
        params: requireParamsField(record, commandType),
        ...(initialize ? { initialize } : {}),
      };
    case "turn.steer":
      return {
        type: commandType,
        threadId: requireStringField(record, "threadId", commandType),
        providerThreadId: requireStringField(
          record,
          "providerThreadId",
          commandType,
        ),
        turnId: requireStringField(record, "turnId", commandType),
        params: requireParamsField(record, commandType),
        ...(initialize ? { initialize } : {}),
      };
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
        params: requireParamsField(record, commandType),
        ...(initialize ? { initialize } : {}),
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
