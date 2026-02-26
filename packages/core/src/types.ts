import type {
  CodexServerNotificationMethod,
  CodexServerNotificationParamsByMethod,
} from "./generated/codex-app-server/index.js";
import type {
  PromptInput,
  ReasoningLevel,
  SandboxMode,
} from "./shared-types.js";

// Project
export interface Project {
  id: string;
  name: string;
  rootPath: string;
  createdAt: number;
  updatedAt: number;
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
