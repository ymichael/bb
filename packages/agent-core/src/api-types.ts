import type {
  PromptInput,
  ReasoningLevel,
  SandboxMode,
} from "./shared-types.js";
import type { ThreadDetailRow } from "./thread-detail-rows.js";
import type { UIMessage } from "./ui-message.js";
import type { ThreadWorkStatus } from "./types.js";
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
  environmentId?: string;
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

export interface UpdateThreadRequest {
  title?: string;
}

export interface ThreadExecutionOptions {
  model?: string;
  reasoningLevel?: ReasoningLevel;
  sandboxMode?: SandboxMode;
  approvalPolicy?: string;
  source?: "client/thread/start" | "client/turn/start";
  seq?: number;
}

export interface ThreadToolGroupMessagesRequest {
  turnId: string;
  sourceSeqStart: number;
  sourceSeqEnd: number;
}

export interface ThreadToolGroupMessagesResponse {
  messages: UIMessage[];
}

export interface ThreadTimelineResponse {
  rows: ThreadDetailRow[];
}

// Project endpoints
export interface CreateProjectRequest {
  name: string;
  rootPath: string;
}

export interface UpdateProjectRequest {
  name?: string;
  rootPath?: string;
  workflowInstructions?: string;
}

export interface CommitThreadRequest {
  message?: string;
  includeUnstaged?: boolean;
  autoArchiveThreadOnCommit?: boolean;
}

export interface CommitThreadResponse {
  ok: true;
  commitCreated: boolean;
  message: string;
  workStatus: ThreadWorkStatus;
  commitSha?: string;
}

export interface SquashMergeThreadRequest {
  commitIfNeeded?: boolean;
  includeUnstaged?: boolean;
  commitMessage?: string;
  squashMessage?: string;
  autoArchiveThreadOnCommit?: boolean;
}

export interface SquashMergeThreadResponse {
  ok: true;
  merged: boolean;
  committed: boolean;
  message: string;
  workStatus: ThreadWorkStatus;
  conflictFiles?: string[];
}

export interface CommitProjectResponse {
  ok: true;
  commitCreated: boolean;
  message: string;
  workStatus: ThreadWorkStatus;
  commitSha?: string;
}

export interface ProjectFileSuggestion {
  path: string;
}

export interface UploadedPromptAttachment {
  type: "localImage" | "localFile";
  path: string;
  name: string;
  mimeType?: string;
  sizeBytes: number;
}

// System
export type OpenPathTarget = "file" | "directory";

export type OpenPathEditor =
  | "system_default"
  | "vscode"
  | "cursor"
  | "zed"
  | "windsurf";

export interface OpenPathRequest {
  path: string;
  target?: OpenPathTarget;
  editor?: OpenPathEditor;
  command?: string;
}

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
