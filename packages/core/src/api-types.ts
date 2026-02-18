import type {
  PromptInput,
  ReasoningLevel,
  SandboxMode,
  TaskCloseReason,
  TaskDependencyType,
  TaskStatus,
  TaskThreadRole,
} from "./shared-types.js";
export type {
  PromptInput,
  ReasoningLevel,
  SandboxMode,
  TaskCloseReason,
  TaskDependencyType,
  TaskStatus,
  TaskThreadRole,
} from "./shared-types.js";

export interface ModelReasoningEffort {
  reasoningEffort: ReasoningLevel;
  description: string;
}

export interface AvailableModel {
  id: string;
  model: string;
  displayName: string;
  description: string;
  supportedReasoningEfforts: ModelReasoningEffort[];
  defaultReasoningEffort: ReasoningLevel;
  isDefault: boolean;
}

// Thread endpoints
export interface SpawnThreadRequest {
  projectId: string;
  title?: string;
  input?: PromptInput[];
  model?: string;
  reasoningLevel?: ReasoningLevel;
  sandboxMode?: SandboxMode;
  roleId?: string;
  agentRoleId?: string;
  developerInstructions?: string;
  taskId?: string;
  parentThreadId?: string;
  taskRole?: TaskThreadRole;
}

export type TellThreadMode = "auto" | "start" | "steer";

export interface TellThreadRequest {
  input: PromptInput[];
  model?: string;
  reasoningLevel?: ReasoningLevel;
  sandboxMode?: SandboxMode;
  mode?: TellThreadMode;
}

export interface ThreadExecutionOptions {
  model?: string;
  reasoningLevel?: ReasoningLevel;
  sandboxMode?: SandboxMode;
  approvalPolicy?: string;
  source?: "client/thread/start" | "client/turn/start";
  seq?: number;
}

// Task endpoints
export interface CreateTaskRequest {
  projectId: string;
  title: string;
  description?: string;
  parentId?: string;
  assignee?: string;
}

export interface UpdateTaskRequest {
  title?: string;
  description?: string;
  status?: TaskStatus;
  closeReason?: TaskCloseReason;
  assignee?: string;
}

export interface AssignTaskRequest {
  assignee: string;
}

export interface TaskChatRequest {
  input: PromptInput[];
}

export interface TaskChatResponse {
  ok: boolean;
  threadId: string;
  createdThread: boolean;
}

export interface CreateTaskDependencyRequest {
  dependsOnTaskId: string;
  type: TaskDependencyType;
}

export interface AgentRole {
  id: string;
  name: string;
  description: string;
  instructions: string;
}

// Project endpoints
export interface CreateProjectRequest {
  name: string;
  rootPath: string;
}

export interface ProjectFileSuggestion {
  path: string;
}

// System
export interface SystemStatus {
  runningThreads: number;
  totalThreads: number;
  uptime: number;
}

export interface ProviderCapabilities {
  supportsSteer: boolean;
  supportsRename: boolean;
  supportsModelList: boolean;
  supportsReasoningLevels: boolean;
  supportsMultimodalInput: boolean;
}

export interface SystemProviderInfo {
  id: string;
  displayName: string;
  capabilities: ProviderCapabilities;
}
