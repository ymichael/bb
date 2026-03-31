import {
  getProjectSourceByHost,
  getProject,
} from "@bb/db";
import type {
  DynamicTool,
  ReasoningLevel,
  ResolvedThreadExecutionOptions,
  SandboxMode,
  ServiceTier,
  Thread,
  ThreadExecutionOptions,
  ThreadExecutionSource,
  WorkspaceProvisionType,
} from "@bb/domain";
import { hostDaemonCommandResultSchemaByType } from "@bb/host-daemon-contract";
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
const NO_MANAGER_PREFERENCES = "(file does not exist)";
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
  workspaceProvisionType: WorkspaceProvisionType;
}

export interface ResolveExecutionOptionsArgs {
  requestedExecution: RequestedExecutionOptions;
  threadId: string;
}

export interface RequestedExecutionOptions extends ThreadExecutionOptions {
  source: ThreadExecutionSource;
}

export interface ResolveThreadRuntimeCommandConfigArgs {
  environment: ThreadRuntimeCommandEnvironment;
  thread: Thread;
  /**
   * True during thread creation. Skips the daemon round-trip to read
   * PREFERENCES.md because the manager has no preferences yet at
   * creation time. Preferences are read on subsequent turns.
   */
  isThreadCreation?: boolean;
}

export interface ResolvedThreadRuntimeCommandConfig {
  dynamicTools: DynamicTool[];
  instructions: string;
  projectId: string;
  providerId: string;
  workspacePath: string;
  workspaceProvisionType: WorkspaceProvisionType;
}

function requireWorkspacePath(environment: ThreadRuntimeCommandEnvironment): string {
  if (!environment.path) {
    throw new ApiError(409, "invalid_request", "Environment is not ready");
  }

  return environment.path;
}

async function readManagerPreferences(
  deps: Pick<AppDeps, "db" | "hub">,
  args: {
    environment: ThreadRuntimeCommandEnvironment;
    workspacePath: string;
    workspaceProvisionType: WorkspaceProvisionType;
  },
): Promise<string> {
  try {
    const rawResult = await queueCommandAndWait(deps, {
      hostId: args.environment.hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "workspace.read_file",
        environmentId: args.environment.id,
        workspaceContext: {
          workspacePath: args.workspacePath,
          workspaceProvisionType: args.workspaceProvisionType,
        },
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
  deps: Pick<AppDeps, "db">,
  args: ResolveExecutionOptionsArgs,
): Promise<ResolvedThreadExecutionOptions> {
  const lastExecution = getLastExecutionOptions(deps, args.threadId);
  const model = args.requestedExecution.model ?? lastExecution?.model;
  if (!model) {
    throw new ApiError(
      500,
      "internal_error",
      `Thread ${args.threadId} has no stored execution model`,
    );
  }

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
    source: args.requestedExecution.source,
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

  const source = getProjectSourceByHost(
    deps.db,
    args.thread.projectId,
    args.environment.hostId,
  );
  const projectRootPath = source?.path ?? workspacePath;

  const { workspaceProvisionType } = args.environment;

  if (args.thread.type !== "manager") {
    return {
      dynamicTools: [],
      instructions: STANDARD_AGENT_INSTRUCTIONS,
      projectId: args.thread.projectId,
      providerId: args.thread.providerId,
      workspacePath,
      workspaceProvisionType,
    };
  }

  const managerPreferencesContent = args.isThreadCreation
    ? NO_MANAGER_PREFERENCES
    : await readManagerPreferences(deps, {
        environment: args.environment,
        workspacePath,
        workspaceProvisionType,
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
    projectId: args.thread.projectId,
    providerId: args.thread.providerId,
    workspacePath,
    workspaceProvisionType,
  };
}
