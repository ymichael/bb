import path from "node:path";
import {
  getDefaultProjectSource,
  getEnvironment,
  getHost,
  getProject,
  getThread,
} from "@bb/db";
import type {
  ApprovalPolicy,
  DynamicTool,
  InstructionMode,
  ProjectExecutionDefaults,
  QuestionPolicy,
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
import { COMMAND_TIMEOUT_MS } from "../../constants.js";
import { ApiError } from "../../errors.js";
import type { AppDeps, SandboxWorkSessionDeps } from "../../types.js";
import { queueCommandAndWait } from "../hosts/command-wait.js";
import { getLastExecutionOptions } from "./thread-events.js";
import { requireThreadStoragePath } from "./thread-storage.js";

const DEFAULT_SERVICE_TIER: ServiceTier = "default";
const DEFAULT_REASONING_LEVEL: ReasoningLevel = "medium";
const DEFAULT_SANDBOX_MODE: SandboxMode = "danger-full-access";
const MANAGER_PREFERENCES_FILE_NAME = "PREFERENCES.md";
const NO_MANAGER_PREFERENCES = "(file does not exist)";
const STANDARD_AGENT_INSTRUCTIONS = renderTemplate(
  "standardAgentInstructions",
  {},
);
const QUESTION_POLICY_INSTRUCTIONS: Record<
  Exclude<QuestionPolicy, "allow">,
  string
> = {
  avoid:
    "Avoid asking the user follow-up questions unless the task truly cannot proceed without clarification. Prefer making reasonable assumptions and continue.",
  deny:
    "Do not ask the user follow-up questions or request additional user input. Make reasonable assumptions and proceed without asking.",
};
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
  questionPolicy: QuestionPolicy;
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
  instructionMode: InstructionMode;
  instructions: string;
  projectId: string;
  providerId: string;
  /** Only set for manager threads. */
  threadStoragePath?: string;
  workspacePath: string;
  workspaceProvisionType: WorkspaceProvisionType;
}

function resolveDefaultApprovalPolicy(
  thread: Thread | null,
): ApprovalPolicy {
  if (thread && thread.parentThreadId !== null) {
    return "never";
  }

  const providerId = thread?.providerId;
  switch (providerId) {
    case "codex":
    case "claude-code":
      return "on-request";
    default:
      return "never";
  }
}

function requireWorkspacePath(environment: ThreadRuntimeCommandEnvironment): string {
  if (!environment.path) {
    throw new ApiError(409, "invalid_request", "Environment is not ready");
  }

  return environment.path;
}

function appendQuestionPolicyInstructions(
  instructions: string,
  questionPolicy: QuestionPolicy,
): string {
  if (questionPolicy === "allow") {
    return instructions;
  }

  return `${instructions}\n\n${QUESTION_POLICY_INSTRUCTIONS[questionPolicy]}`;
}

function resolveDefaultQuestionPolicy(
  deps: Pick<AppDeps, "db">,
  thread: Thread | null,
): QuestionPolicy {
  if (!thread) {
    return "allow";
  }
  if (thread.parentThreadId !== null) {
    return "avoid";
  }
  if (thread.automationId !== null) {
    return "avoid";
  }
  if (thread.environmentId === null) {
    return "allow";
  }

  const environment = getEnvironment(deps.db, thread.environmentId);
  if (!environment) {
    return "allow";
  }

  const host = getHost(deps.db, environment.hostId);
  if (host?.type === "ephemeral") {
    return "avoid";
  }

  return "allow";
}

async function readManagerPreferences(
  deps: SandboxWorkSessionDeps,
  args: {
    hostId: string;
    threadStoragePath: string;
  },
): Promise<string> {
  try {
    const rawResult = await queueCommandAndWait(deps, {
      hostId: args.hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "host.read_file",
        path: path.join(args.threadStoragePath, MANAGER_PREFERENCES_FILE_NAME),
        rootPath: args.threadStoragePath,
      },
    });
    const result = hostDaemonCommandResultSchemaByType["host.read_file"].parse(rawResult);
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

export async function resolveExecutionOptions(
  deps: Pick<AppDeps, "db">,
  args: ResolveExecutionOptionsArgs,
): Promise<ResolvedThreadExecutionOptions> {
  const lastExecution = getLastExecutionOptions(deps, args.threadId);
  const projectExecution = args.projectDefaults ?? null;
  const thread = getThread(deps.db, args.threadId);
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

  const approvalPolicy =
    args.requestedExecution.approvalPolicy ??
    lastExecution?.approvalPolicy ??
    resolveDefaultApprovalPolicy(thread);
  const questionPolicy =
    args.requestedExecution.questionPolicy ??
    lastExecution?.questionPolicy ??
    resolveDefaultQuestionPolicy(deps, thread);

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
    sandboxMode:
      args.requestedExecution.sandboxMode ??
      lastExecution?.sandboxMode ??
      projectExecution?.sandboxMode ??
      DEFAULT_SANDBOX_MODE,
    approvalPolicy,
    questionPolicy,
    source: args.requestedExecution.source,
  };
}

export async function resolveThreadRuntimeCommandConfig(
  deps: SandboxWorkSessionDeps,
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
      instructions: appendQuestionPolicyInstructions(
        STANDARD_AGENT_INSTRUCTIONS,
        args.questionPolicy,
      ),
      projectId: args.thread.projectId,
      providerId: args.thread.providerId,
      workspacePath,
      workspaceProvisionType,
    };
  }
  const threadStoragePath = await requireThreadStoragePath(
    deps,
    { hostId: args.environment.hostId, threadId: args.thread.id },
  );

  const managerPreferencesContent = args.isThreadCreation
    ? NO_MANAGER_PREFERENCES
    : await readManagerPreferences(deps, {
        hostId: args.environment.hostId,
        threadStoragePath,
      });

  return {
    dynamicTools: MANAGER_DYNAMIC_TOOLS,
    instructionMode: "replace",
    instructions: appendQuestionPolicyInstructions(
      renderTemplate("managerAgentInstructions", {
        hostId: args.environment.hostId,
        localTimezone: resolveLocalTimezone(),
        managerPreferencesContent,
        managerThreadId: args.thread.id,
        threadStoragePath,
        projectId: args.thread.projectId,
        projectName: project.name,
        projectRootPath,
      }),
      args.questionPolicy,
    ),
    projectId: args.thread.projectId,
    providerId: args.thread.providerId,
    threadStoragePath,
    workspacePath,
    workspaceProvisionType,
  };
}
