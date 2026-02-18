import type {
  CodexServerNotificationMethod,
  CodexServerNotificationParamsByMethod,
} from "./generated/codex-app-server/index.js";
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
  TaskStatus,
  TaskCloseReason,
  TaskDependencyType,
} from "./shared-types.js";

// Project
export interface Project {
  id: string;
  name: string;
  rootPath: string;
  createdAt: number;
  updatedAt: number;
}

// Task
export interface Task {
  id: string;
  projectId: string;
  title: string;
  description?: string;
  status: TaskStatus;
  closeReason?: TaskCloseReason;
  assignee?: string;
  archivedAt?: number;
  closedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface TaskDependency {
  taskId: string;
  dependsOnTaskId: string;
  type: TaskDependencyType;
  createdAt: number;
}

export type TaskEventDataByType = {
  "task.created": {
    projectId: string;
    title: string;
    description?: string;
    assignee?: string;
  };
  "task.updated.title": {
    title: string;
  };
  "task.updated.description": {
    description: string;
  };
  "task.updated.status": {
    status: TaskStatus;
    closeReason?: TaskCloseReason;
  };
  "task.assigned": {
    assignee: string;
  };
  "task.archived": {
    archivedAt: number;
  };
  "task.dependency_added": {
    dependsOnTaskId: string;
    type: TaskDependencyType;
  };
  "task.dependency_removed": {
    dependsOnTaskId: string;
    type: TaskDependencyType;
  };
  "task.chat.message": {
    message: string;
    fromThreadId: string | null;
  };
  "task.chat.thread_created": {
    threadId: string;
    taskRole?: TaskThreadRole;
  };
};

export type TaskEventType = keyof TaskEventDataByType;

export type TaskEventData = TaskEventDataByType[TaskEventType];

export type TaskEventDataForType<TType extends TaskEventType> =
  TaskEventDataByType[TType];

export type TaskEvent<TType extends TaskEventType = TaskEventType> = {
  [K in TType]: {
    id: string;
    taskId: string;
    seq: number;
    type: K;
    data: TaskEventDataForType<K>;
    createdAt: number;
  };
}[TType];

export type TaskEventOfType<TType extends TaskEventType> = TaskEvent<TType>;

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
  taskId?: string;
  taskRole?: TaskThreadRole;
  agentRoleId?: string;
  parentThreadId?: string;
  archivedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export type AppThreadEventType = "client/thread/start" | "client/turn/start";

export type ThreadTurnInitiator = "user" | "agent" | "system";

export interface ClientExecutionOptionsSnapshot {
  model?: string;
  reasoningLevel?: ReasoningLevel;
  sandboxMode?: SandboxMode;
  approvalPolicy?: string;
}

export interface ClientOutboundStartEventData {
  direction: "outbound";
  source: "spawn" | "tell";
  initiator?: ThreadTurnInitiator;
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
