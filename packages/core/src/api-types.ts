export type ReasoningLevel = "low" | "medium" | "high" | "xhigh";
export type SandboxMode =
  | "read-only"
  | "workspace-write"
  | "danger-full-access";
export type TaskStatus = "open" | "in_progress" | "blocked" | "closed";
export type TaskCloseReason = "completed" | "failed" | "canceled";
export type TaskDependencyType = "blocks" | "parent-child" | "related";

export type PromptInput =
  | { type: "text"; text: string }
  | { type: "image"; url: string }
  | { type: "localImage"; path: string };

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
}

export interface UpdateTaskRequest {
  title?: string;
  description?: string;
  status?: TaskStatus;
  closeReason?: TaskCloseReason;
  resultSummary?: string;
  assignee?: string;
}

export interface AssignTaskRequest {
  assignee: string;
}

export interface CreateTaskDependencyRequest {
  dependsOnTaskId: string;
  type: TaskDependencyType;
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
