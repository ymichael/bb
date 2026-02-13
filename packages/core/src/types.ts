import type {
  CodexServerNotificationMethod,
  CodexServerNotificationParamsByMethod,
} from "./generated/codex-app-server/index.js";
import type {
  PromptInput,
  ReasoningLevel,
  SandboxMode,
} from "./api-types.js";

// Project
export interface Project {
  id: string;
  name: string;
  rootPath: string;
  createdAt: number;
  updatedAt: number;
}

// Task
export type TaskStatus = "open" | "in_progress" | "blocked" | "closed";

export type TaskCloseReason = "completed" | "failed" | "canceled";

export type TaskDependencyType = "blocks" | "parent-child" | "related";

export interface Task {
  id: string;
  projectId: string;
  title: string;
  description?: string;
  status: TaskStatus;
  closeReason?: TaskCloseReason;
  assignee?: string;
  closedAt?: number;
  resultSummary?: string;
  createdAt: number;
  updatedAt: number;
}

export interface TaskDependency {
  taskId: string;
  dependsOnTaskId: string;
  type: TaskDependencyType;
  createdAt: number;
}

export interface TaskEvent {
  id: string;
  taskId: string;
  seq: number;
  type: string;
  data: Record<string, unknown>;
  createdAt: number;
}

// Thread
export type ThreadStatus =
  | "created"
  | "provisioning"
  | "provisioning_failed"
  | "idle"
  | "active";

export interface Thread {
  id: string;
  projectId: string;
  title?: string;
  status: ThreadStatus;
  archivedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export type AppThreadEventType = "client/thread/start" | "client/turn/start";

export interface ClientExecutionOptionsSnapshot {
  model?: string;
  reasoningLevel?: ReasoningLevel;
  sandboxMode?: SandboxMode;
  approvalPolicy?: string;
}

export interface ClientOutboundStartEventData {
  direction: "outbound";
  source: "spawn" | "tell";
  request: {
    method: "thread/start" | "turn/start";
    params: Record<string, unknown>;
  };
  execution: ClientExecutionOptionsSnapshot;
}

export type ThreadEventType = CodexServerNotificationMethod | AppThreadEventType;

export interface TurnLifecycleEventData {
  turnId?: string;
  input?: PromptInput[];
}

export type ThreadEventDataByType = CodexServerNotificationParamsByMethod & {
  "client/thread/start": ClientOutboundStartEventData;
  "client/turn/start": ClientOutboundStartEventData;
};

export type ThreadEventData = ThreadEventDataByType[ThreadEventType];

export type ThreadEventDataForType<TType extends ThreadEventType> =
  ThreadEventDataByType[TType];

// Event (streaming log from codex)
export interface ThreadEvent<
  TType extends ThreadEventType = ThreadEventType,
> {
  id: string;
  threadId: string;
  seq: number;
  type: TType;
  data: ThreadEventDataForType<TType>;
  createdAt: number;
}

export type ThreadEventOfType<TType extends ThreadEventType> = ThreadEvent<
  TType
>;
