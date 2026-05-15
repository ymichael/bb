import path from "node:path";
import {
  getBuiltInAgentProviderInfo,
  isAgentProviderId,
} from "@bb/agent-providers";
import { getDefaultProjectSource, getProject, getThread } from "@bb/db";
import type {
  DynamicTool,
  InstructionMode,
  PermissionEscalation,
  PermissionMode,
  ProjectExecutionDefaults,
  ResolvedThreadExecutionOptions,
  Thread,
  ThreadExecutionOptions,
  ThreadExecutionSource,
  ThreadTurnInitiator,
  WorkspaceProvisionType,
} from "@bb/domain";
import { renderTemplate } from "@bb/templates";
import { COMMAND_TIMEOUT_MS } from "../../constants.js";
import { ApiError } from "../../errors.js";
import type {
  AppDeps,
  LoggedSandboxWorkSessionDeps,
} from "../../types.js";
import { queueCommandAndWait } from "../hosts/command-wait.js";
import { getLastExecutionOptions } from "./thread-events.js";
import { requireThreadStoragePath } from "./thread-storage.js";
import {
  DEFAULT_REASONING_LEVEL,
  DEFAULT_SERVICE_TIER,
  resolveThreadExecutionPermissionMode,
} from "./thread-default-policy.js";

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
const MANAGER_DISALLOWED_TOOLS = [
  "ExitPlanMode",
  "NotebookEdit",
  "Task",
] as const;

function resolveLocalTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export interface ThreadRuntimeCommandEnvironment {
  hostId: string;
  id: string;
  path: string | null;
  workspaceProvisionType: WorkspaceProvisionType;
}

export interface ResolveExecutionOptionsArgs {
  projectDefaults?: ProjectExecutionDefaults | null;
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

export interface ResolvePermissionEscalationArgs {
  initiator: ThreadTurnInitiator;
  thread: Thread;
}

export interface ResolvedThreadRuntimeCommandConfig {
  dynamicTools: DynamicTool[];
  disallowedTools?: readonly string[];
  instructionMode: InstructionMode;
  instructions: string;
  projectId: string;
  providerId: string;
  /** Only set for manager threads. */
  threadStoragePath?: string;
  workspacePath: string;
  workspaceProvisionType: WorkspaceProvisionType;
}

interface ReadManagerPreferencesArgs {
  hostId: string;
  threadStoragePath: string;
}

function requireWorkspacePath(
  environment: ThreadRuntimeCommandEnvironment,
): string {
  if (!environment.path) {
    throw new ApiError(409, "invalid_request", "Environment is not ready");
  }

  return environment.path;
}

async function readManagerPreferences(
  deps: LoggedSandboxWorkSessionDeps,
  args: ReadManagerPreferencesArgs,
): Promise<string> {
  try {
    const result = await queueCommandAndWait(deps, {
      hostId: args.hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "host.read_file",
        path: path.join(args.threadStoragePath, MANAGER_PREFERENCES_FILE_NAME),
        rootPath: args.threadStoragePath,
      },
    });
    if (result.contentEncoding !== "utf8") {
      throw new ApiError(
        502,
        "invalid_request",
        "Manager preferences must be UTF-8 text",
      );
    }
    return result.content;
  } catch (error) {
    if (error instanceof ApiError && error.body.code === "ENOENT") {
      return NO_MANAGER_PREFERENCES;
    }
    throw error;
  }
}

function validateProviderPermissionMode(
  providerId: string | undefined,
  permissionMode: PermissionMode,
): void {
  if (!providerId || !isAgentProviderId(providerId)) {
    return;
  }

  const provider = getBuiltInAgentProviderInfo(providerId);
  if (provider.capabilities.supportedPermissionModes.includes(permissionMode)) {
    return;
  }

  throw new ApiError(
    400,
    "invalid_request",
    `Provider ${providerId} only supports ${provider.capabilities.supportedPermissionModes.join(", ")} permission mode.`,
  );
}

export function resolvePermissionEscalation(
  args: ResolvePermissionEscalationArgs,
): PermissionEscalation {
  if (
    args.initiator === "system" ||
    args.thread.parentThreadId !== null ||
    args.thread.type === "manager"
  ) {
    return "deny";
  }

  return "ask";
}

export async function resolveExecutionOptions(
  deps: Pick<AppDeps, "db">,
  args: ResolveExecutionOptionsArgs,
): Promise<ResolvedThreadExecutionOptions> {
  const lastExecution = getLastExecutionOptions(deps, args.threadId);
  const projectExecution = args.projectDefaults ?? null;
  const thread = getThread(deps.db, args.threadId);
  if (!thread) {
    throw new ApiError(404, "thread_not_found", "Thread not found");
  }
  const model =
    args.requestedExecution.model ??
    lastExecution?.model ??
    projectExecution?.model;
  if (!model) {
    throw new ApiError(
      500,
      "internal_error",
      `Thread ${args.threadId} has no stored execution model`,
    );
  }
  const parentThread =
    thread.parentThreadId !== null
      ? getThread(deps.db, thread.parentThreadId)
      : null;

  const permissionMode = resolveThreadExecutionPermissionMode({
    requestedPermissionMode: args.requestedExecution.permissionMode,
    lastExecutionPermissionMode: lastExecution?.permissionMode,
    parentThread,
    projectExecutionPermissionMode: projectExecution?.permissionMode,
    thread,
  });
  validateProviderPermissionMode(thread.providerId, permissionMode);

  return {
    model,
    serviceTier:
      args.requestedExecution.serviceTier ??
      lastExecution?.serviceTier ??
      projectExecution?.serviceTier ??
      DEFAULT_SERVICE_TIER,
    reasoningLevel:
      args.requestedExecution.reasoningLevel ??
      lastExecution?.reasoningLevel ??
      projectExecution?.reasoningLevel ??
      DEFAULT_REASONING_LEVEL,
    permissionMode,
    source: args.requestedExecution.source,
  };
}

export async function resolveThreadRuntimeCommandConfig(
  deps: LoggedSandboxWorkSessionDeps,
  args: ResolveThreadRuntimeCommandConfigArgs,
): Promise<ResolvedThreadRuntimeCommandConfig> {
  const workspacePath = requireWorkspacePath(args.environment);
  const project = getProject(deps.db, args.thread.projectId);
  if (!project) {
    throw new ApiError(404, "project_not_found", "Project not found");
  }

  const defaultSource = getDefaultProjectSource(deps.db, args.thread.projectId);
  const projectRootPath =
    defaultSource?.type === "local_path" ? defaultSource.path : workspacePath;
  const { workspaceProvisionType } = args.environment;

  if (args.thread.type !== "manager") {
    return {
      dynamicTools: [],
      instructionMode: "append",
      instructions: STANDARD_AGENT_INSTRUCTIONS,
      projectId: args.thread.projectId,
      providerId: args.thread.providerId,
      workspacePath,
      workspaceProvisionType,
    };
  }
  const threadStoragePath = await requireThreadStoragePath(deps, {
    hostId: args.environment.hostId,
    threadId: args.thread.id,
  });

  const managerPreferencesContent = args.isThreadCreation
    ? NO_MANAGER_PREFERENCES
    : await readManagerPreferences(deps, {
        hostId: args.environment.hostId,
        threadStoragePath,
      });

  return {
    dynamicTools: MANAGER_DYNAMIC_TOOLS,
    disallowedTools: MANAGER_DISALLOWED_TOOLS,
    instructionMode: "replace",
    instructions: renderTemplate("managerAgentInstructions", {
      hostId: args.environment.hostId,
      localTimezone: resolveLocalTimezone(),
      managerPreferencesContent,
      managerThreadId: args.thread.id,
      threadStoragePath,
      projectId: args.thread.projectId,
      projectName: project.name,
      projectRootPath,
    }),
    projectId: args.thread.projectId,
    providerId: args.thread.providerId,
    threadStoragePath,
    workspacePath,
    workspaceProvisionType,
  };
}
