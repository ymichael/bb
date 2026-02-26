import type {
  PromptInput,
  ReasoningLevel,
  SandboxMode,
} from "./shared-types.js";
export type {
  PromptInput,
  ReasoningLevel,
  SandboxMode,
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
  developerInstructions?: string;
  parentThreadId?: string;
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

// Project endpoints
export interface CreateProjectRequest {
  name: string;
  rootPath: string;
}

export interface UpdateProjectRequest {
  name?: string;
  rootPath?: string;
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

export interface EnvironmentCapabilities {
  isolatedFilesystem: boolean;
  ephemeralWorkspace: boolean;
  supportsCleanup: boolean;
}

export interface SystemEnvironmentInfo {
  id: string;
  displayName: string;
  description?: string;
  capabilities: EnvironmentCapabilities;
}
