export type ReasoningLevel = "low" | "medium" | "high" | "xhigh";
export type SandboxMode =
  | "read-only"
  | "workspace-write"
  | "danger-full-access";

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
