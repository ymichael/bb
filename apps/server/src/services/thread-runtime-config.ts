import {
  getDefaultProjectSource,
  getProject,
} from "@bb/db";
import type {
  DynamicTool,
  ReasoningLevel,
  SandboxMode,
  ServiceTier,
  Thread,
  ThreadExecutionOptions,
} from "@bb/domain";
import { hostDaemonCommandResultSchemaByType } from "@bb/host-daemon-contract";
import type { HostDaemonExecutionOptions } from "@bb/host-daemon-contract";
import { renderTemplate } from "@bb/templates";
import { COMMAND_TIMEOUT_MS } from "../constants.js";
import { ApiError } from "../errors.js";
import type { AppDeps } from "../types.js";
import { queueCommandAndWait } from "./command-wait.js";
import { getLastExecutionOptions } from "./thread-events.js";

const DEFAULT_SERVICE_TIER: ServiceTier = "flex";
const DEFAULT_REASONING_LEVEL: ReasoningLevel = "medium";
const DEFAULT_SANDBOX_MODE: SandboxMode = "danger-full-access";
const MANAGER_PREFERENCES_FILE_NAME = "PREFERENCES.md";
const NO_MANAGER_PREFERENCES = "No preferences yet.";
const STANDARD_AGENT_INSTRUCTIONS = renderTemplate(
  "standardAgentInstructions",
  {},
);
const MESSAGE_USER_TOOL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    text: {
      type: "string",
      description: "User-visible message text.",
    },
  },
  required: ["text"],
};
const MANAGER_DYNAMIC_TOOLS: DynamicTool[] = [
  {
    name: "message_user",
    description: "Send a user-visible update from the manager thread.",
    inputSchema: MESSAGE_USER_TOOL_SCHEMA,
  },
];

export interface ThreadRuntimeCommandEnvironment {
  hostId: string;
  id: string;
  path: string | null;
}

export interface ResolveExecutionOptionsArgs {
  hostId: string;
  providerId: string;
  requestedExecution: ThreadExecutionOptions;
  threadId: string;
}

export interface ResolveThreadRuntimeCommandConfigArgs {
  environment: ThreadRuntimeCommandEnvironment;
  execution: ThreadExecutionOptions;
  thread: Thread;
}

export interface ResolvedThreadRuntimeCommandConfig {
  dynamicTools: DynamicTool[];
  instructions: string;
  options: HostDaemonExecutionOptions;
  projectId: string;
  providerId: string;
  workspacePath: string;
}

function requireWorkspacePath(environment: ThreadRuntimeCommandEnvironment): string {
  if (!environment.path) {
    throw new ApiError(409, "invalid_request", "Environment is not ready");
  }

  return environment.path;
}

async function resolveDefaultModel(
  deps: Pick<AppDeps, "db" | "hub">,
  args: {
    hostId: string;
    providerId: string;
  },
): Promise<string> {
  const rawResult = await queueCommandAndWait(deps, {
    hostId: args.hostId,
    timeoutMs: COMMAND_TIMEOUT_MS,
    command: {
      type: "provider.list_models",
      providerId: args.providerId,
    },
  });
  const result = hostDaemonCommandResultSchemaByType["provider.list_models"].parse(rawResult);
  const model =
    result.models.find((candidate) => candidate.isDefault)?.model ??
    result.models[0]?.model;
  if (!model) {
    throw new ApiError(
      409,
      "invalid_request",
      `Provider ${args.providerId} has no available models`,
    );
  }
  return model;
}

async function readManagerPreferences(
  deps: Pick<AppDeps, "db" | "hub">,
  args: {
    environment: ThreadRuntimeCommandEnvironment;
    workspacePath: string;
  },
): Promise<string> {
  try {
    const rawResult = await queueCommandAndWait(deps, {
      hostId: args.environment.hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "workspace.read_file",
        environmentId: args.environment.id,
        environmentStatus: "ready",
        workspacePath: args.workspacePath,
        path: MANAGER_PREFERENCES_FILE_NAME,
      },
    });
    const result = hostDaemonCommandResultSchemaByType["workspace.read_file"].parse(rawResult);
    return result.content;
  } catch (error) {
    if (error instanceof ApiError && error.body.code === "ENOENT") {
      return NO_MANAGER_PREFERENCES;
    }
    throw error;
  }
}

export async function resolveExecutionOptions(
  deps: Pick<AppDeps, "db" | "hub">,
  args: ResolveExecutionOptionsArgs,
): Promise<HostDaemonExecutionOptions> {
  const lastExecution = getLastExecutionOptions(deps, args.threadId);
  const model =
    args.requestedExecution.model ??
    lastExecution?.model ??
    await resolveDefaultModel(deps, {
      hostId: args.hostId,
      providerId: args.providerId,
    });

  return {
    model,
    serviceTier:
      args.requestedExecution.serviceTier ??
      lastExecution?.serviceTier ??
      DEFAULT_SERVICE_TIER,
    reasoningLevel:
      args.requestedExecution.reasoningLevel ??
      lastExecution?.reasoningLevel ??
      DEFAULT_REASONING_LEVEL,
    sandboxMode:
      args.requestedExecution.sandboxMode ??
      lastExecution?.sandboxMode ??
      DEFAULT_SANDBOX_MODE,
    ...(args.requestedExecution.source
      ? { source: args.requestedExecution.source }
      : {}),
  };
}

export async function resolveThreadRuntimeCommandConfig(
  deps: Pick<AppDeps, "db" | "hub">,
  args: ResolveThreadRuntimeCommandConfigArgs,
): Promise<ResolvedThreadRuntimeCommandConfig> {
  const workspacePath = requireWorkspacePath(args.environment);
  const project = getProject(deps.db, args.thread.projectId);
  if (!project) {
    throw new ApiError(404, "project_not_found", "Project not found");
  }

  const defaultSource = getDefaultProjectSource(deps.db, args.thread.projectId);
  const projectRootPath = defaultSource?.path ?? workspacePath;
  const options = await resolveExecutionOptions(deps, {
    hostId: args.environment.hostId,
    providerId: args.thread.providerId,
    requestedExecution: args.execution,
    threadId: args.thread.id,
  });

  if (args.thread.type !== "manager") {
    return {
      dynamicTools: [],
      instructions: STANDARD_AGENT_INSTRUCTIONS,
      options,
      projectId: args.thread.projectId,
      providerId: args.thread.providerId,
      workspacePath,
    };
  }

  const managerPreferencesContent = await readManagerPreferences(deps, {
    environment: args.environment,
    workspacePath,
  });

  return {
    dynamicTools: MANAGER_DYNAMIC_TOOLS,
    instructions: renderTemplate("managerAgentInstructions", {
      managerPreferencesContent,
      managerThreadId: args.thread.id,
      managerWorkspacePath: workspacePath,
      projectId: args.thread.projectId,
      projectName: project.name,
      projectRootPath,
    }),
    options,
    projectId: args.thread.projectId,
    providerId: args.thread.providerId,
    workspacePath,
  };
}
