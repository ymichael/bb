import type {
  JsonObject,
  Thread,
  ThreadEventRow,
  ThreadEventScope,
} from "@bb/domain";
import type { EventProjection } from "./event-projection.js";

export const eventProjectionMessageStatusValues = [
  "streaming",
  "pending",
  "completed",
  "error",
  "interrupted",
] as const;
export type EventProjectionMessageStatus =
  (typeof eventProjectionMessageStatusValues)[number];

export const eventProjectionApprovalLifecycleStatusValues = [
  "waiting_for_approval",
  "denied",
] as const;
export type EventProjectionApprovalLifecycleStatus =
  (typeof eventProjectionApprovalLifecycleStatusValues)[number];

export interface EventProjectionMessageBase {
  id: string;
  threadId: string;
  sourceSeqStart: number;
  sourceSeqEnd: number;
  createdAt: number;
  scope: ThreadEventScope;
  startedAt?: number;
  parentToolCallId?: string;
}

export const eventProjectionUserRequestKindValues = [
  "message",
  "steer",
] as const;
export type EventProjectionUserRequestKind =
  (typeof eventProjectionUserRequestKindValues)[number];

export const eventProjectionUserRequestStatusValues = [
  "pending",
  "accepted",
] as const;
export type EventProjectionUserRequestStatus =
  (typeof eventProjectionUserRequestStatusValues)[number];

export interface EventProjectionUserRequest {
  kind: EventProjectionUserRequestKind;
  status: EventProjectionUserRequestStatus;
}

export interface EventProjectionUserMessage extends EventProjectionMessageBase {
  kind: "user";
  request: EventProjectionUserRequest;
  text: string;
  attachments?: {
    webImages: number;
    localImages: number;
    localFiles: number;
    imageUrls?: string[];
    localImagePaths?: string[];
    localFilePaths?: string[];
  };
}

export interface EventProjectionAssistantTextMessage extends EventProjectionMessageBase {
  kind: "assistant-text";
  text: string;
  status: Extract<EventProjectionMessageStatus, "streaming" | "completed">;
  /** True when this message was delivered via the manager's `message_user` tool. */
  isManagerUserMessage?: boolean;
}

export type EventProjectionToolParsedIntent =
  | {
      type: "read";
      cmd: string;
      name: string;
      path: string | null;
    }
  | {
      type: "list_files";
      cmd: string;
      path: string | null;
    }
  | {
      type: "search";
      cmd: string;
      query: string | null;
      path: string | null;
    }
  | {
      type: "unknown";
      cmd: string;
    };

export interface EventProjectionDelegationMetadata {
  subagentType?: string;
  description?: string;
}

export interface EventProjectionToolCallMessage extends EventProjectionMessageBase {
  kind: "tool-call";
  toolName: string;
  toolArgs: JsonObject | null;
  callId: string;
  parsedIntents: EventProjectionToolParsedIntent[];
  output: string;
  durationMs: number | null;
  approvalStatus: EventProjectionApprovalLifecycleStatus | null;
  status: Extract<
    EventProjectionMessageStatus,
    "pending" | "completed" | "error" | "interrupted"
  >;
}

export interface EventProjectionCommandMessage extends EventProjectionMessageBase {
  kind: "command";
  callId: string;
  command: string;
  cwd: string | null;
  parsedIntents: EventProjectionToolParsedIntent[];
  source: string | null;
  output: string;
  exitCode: number | null;
  durationMs: number | null;
  approvalStatus: EventProjectionApprovalLifecycleStatus | null;
  status: Extract<
    EventProjectionMessageStatus,
    "pending" | "completed" | "error" | "interrupted"
  >;
}

export interface EventProjectionWebSearchMessage extends EventProjectionMessageBase {
  kind: "web-search";
  callId: string;
  queries: string[];
  resultText: string | null;
  status: Extract<
    EventProjectionMessageStatus,
    "pending" | "completed" | "interrupted"
  >;
}

export interface EventProjectionWebFetchMessage extends EventProjectionMessageBase {
  kind: "web-fetch";
  callId: string;
  url: string;
  prompt: string | null;
  pattern: string | null;
  resultText: string | null;
  status: Extract<
    EventProjectionMessageStatus,
    "pending" | "completed" | "interrupted"
  >;
}

export interface EventProjectionFileEditChange {
  path: string;
  kind?: string;
  movePath?: string | null;
  diff?: string;
}

export interface EventProjectionFileEditMessage extends EventProjectionMessageBase {
  kind: "file-edit";
  callId: string;
  changes: EventProjectionFileEditChange[];
  stdout?: string;
  stderr?: string;
  approvalStatus: EventProjectionApprovalLifecycleStatus | null;
  status: Extract<
    EventProjectionMessageStatus,
    "pending" | "completed" | "error" | "interrupted"
  >;
}

export const eventProjectionOperationTypeValues = [
  "plan-updated",
  "provider-unhandled",
  "warning",
  "deprecation",
  "thread-interrupted",
  "thread-provisioning",
  "operation",
  "compaction",
  "turn-diff",
] as const;
export type EventProjectionOperationType =
  (typeof eventProjectionOperationTypeValues)[number];

export const eventProjectionThreadOperationKindValues = [
  "ownership_change",
  "other",
] as const;
export type EventProjectionThreadOperationKind =
  (typeof eventProjectionThreadOperationKindValues)[number];

export const eventProjectionThreadOperationStatusValues = [
  "requested",
  "queued",
  "running",
  "started",
  "completed",
  "failed",
  "noop",
  "other",
] as const;
export type EventProjectionThreadOperationStatus =
  (typeof eventProjectionThreadOperationStatusValues)[number];

export interface EventProjectionThreadOperationMetadata {
  operation: EventProjectionThreadOperationKind;
  rawOperation: string;
  status: EventProjectionThreadOperationStatus;
  rawStatus: string;
  operationId: string;
  metadata?: Record<string, unknown>;
}

export interface EventProjectionProvisioningTranscriptEntry {
  type: "step" | "output";
  key: string;
  text: string;
  startedAt?: number;
  status?: "started" | "completed" | "failed";
  metadata?: Record<string, unknown>;
}

export interface EventProjectionProvisioningMetadata {
  environmentId?: string;
  provisioningId: string;
  transcript?: EventProjectionProvisioningTranscriptEntry[];
}

export interface EventProjectionApprovalTarget {
  itemId: string;
  toolName: string | null;
}

export interface EventProjectionOperationMessage extends EventProjectionMessageBase {
  kind: "operation";
  opType: EventProjectionOperationType;
  title: string;
  detail?: string;
  status?: Extract<
    EventProjectionMessageStatus,
    "pending" | "completed" | "error" | "interrupted"
  >;
  provisioning?: EventProjectionProvisioningMetadata;
  threadOperation?: EventProjectionThreadOperationMetadata;
}

export interface EventProjectionPermissionGrantLifecycleMessage extends EventProjectionMessageBase {
  kind: "permission-grant-lifecycle";
  interactionId: string;
  title: string;
  status: Extract<
    EventProjectionMessageStatus,
    "pending" | "completed" | "error" | "interrupted"
  >;
  approvalTarget: EventProjectionApprovalTarget;
}

export interface EventProjectionDelegationMessage
  extends EventProjectionMessageBase, EventProjectionDelegationMetadata {
  kind: "delegation";
  toolName: string;
  callId: string;
  output: string;
  durationMs: number | null;
  status: Extract<
    EventProjectionMessageStatus,
    "pending" | "completed" | "error" | "interrupted"
  >;
  childProjection: EventProjection;
}

export interface EventProjectionErrorMessage extends EventProjectionMessageBase {
  kind: "error";
  message: string;
  rawType: string;
  reconnectAttempt?: number;
  reconnectTotal?: number;
}

export interface EventProjectionDebugRawEventMessage extends EventProjectionMessageBase {
  kind: "debug/raw-event";
  rawType: string;
  rawEvent: ThreadEventRow;
  reason: "ignored-noise" | "duplicate-event" | "unhandled";
}

export type EventProjectionMessage =
  | EventProjectionUserMessage
  | EventProjectionAssistantTextMessage
  | EventProjectionCommandMessage
  | EventProjectionToolCallMessage
  | EventProjectionWebSearchMessage
  | EventProjectionWebFetchMessage
  | EventProjectionFileEditMessage
  | EventProjectionOperationMessage
  | EventProjectionPermissionGrantLifecycleMessage
  | EventProjectionDelegationMessage
  | EventProjectionErrorMessage
  | EventProjectionDebugRawEventMessage;

export interface BuildEventProjectionMessagesOptions {
  includeDebugRawEvents?: boolean;
  includeProviderUnhandledOperations?: boolean;
  includeOptionalOperations?: boolean;
  threadStatus?: Thread["status"];
  threadType?: Thread["type"];
}
