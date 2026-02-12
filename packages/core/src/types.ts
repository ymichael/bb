import type {
  CodexServerNotificationMethod,
  CodexServerNotificationParamsByMethod,
} from "./generated/codex-app-server/index.js";
import type { PromptInput } from "./api-types.js";

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
  archivedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export type ThreadEventType = CodexServerNotificationMethod;

export interface TurnLifecycleEventData {
  turnId?: string;
  input?: PromptInput[];
}

export type ThreadEventDataByType = CodexServerNotificationParamsByMethod;

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
