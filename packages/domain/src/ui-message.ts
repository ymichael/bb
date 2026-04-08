import { z } from "zod";
import type { Thread } from "./thread.js";
import type { ThreadEventRow } from "./stored-thread-event.js";

export const viewMessageStatusValues = [
  "streaming",
  "pending",
  "completed",
  "error",
  "interrupted",
] as const;
export const viewMessageStatusSchema = z.enum(viewMessageStatusValues);
export type ViewMessageStatus = z.infer<typeof viewMessageStatusSchema>;

export interface ViewMessageBase {
  id: string;
  threadId: string;
  sourceSeqStart: number;
  sourceSeqEnd: number;
  createdAt: number;
  startedAt?: number;
  turnId?: string;
  parentToolCallId?: string;
}

export interface ViewUserMessage extends ViewMessageBase {
  kind: "user";
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

export interface ViewAssistantReasoningMessage extends ViewMessageBase {
  kind: "assistant-reasoning";
  text: string;
  status: Extract<ViewMessageStatus, "streaming" | "completed">;
}

export interface ViewAssistantTextMessage extends ViewMessageBase {
  kind: "assistant-text";
  text: string;
  status: Extract<ViewMessageStatus, "streaming" | "completed">;
  /** True when this message was delivered via the manager's `message_user` tool. */
  isManagerUserMessage?: boolean;
}

export type ViewToolParsedIntent =
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

export interface ViewDelegationMetadata {
  subagentType?: string;
  description?: string;
}

export interface ViewToolCallSummary extends ViewDelegationMetadata {
  callId: string;
  command?: string;
  cwd?: string;
  parsedCmd: ViewToolParsedIntent[];
  source?: string;
  output?: string;
  exitCode?: number;
  duration?: string;
  durationMs?: number;
  status: Extract<
    ViewMessageStatus,
    "pending" | "completed" | "error" | "interrupted"
  >;
}

export interface ViewToolExploringMessage extends ViewMessageBase {
  kind: "tool-exploring";
  status: Extract<ViewMessageStatus, "pending" | "completed">;
  calls: ViewToolCallSummary[];
}

export interface ViewToolCallMessage
  extends ViewMessageBase, ViewDelegationMetadata {
  kind: "tool-call";
  toolName: string;
  callId: string;
  command?: string;
  cwd?: string;
  parsedCmd?: ViewToolParsedIntent[];
  source?: string;
  output?: string;
  exitCode?: number;
  duration?: string;
  durationMs?: number;
  status: Extract<
    ViewMessageStatus,
    "pending" | "completed" | "error" | "interrupted"
  >;
}

export interface ViewWebSearchMessage extends ViewMessageBase {
  kind: "web-search";
  callId: string;
  query?: string;
  action?: string;
  output?: string;
  status: Extract<ViewMessageStatus, "pending" | "completed">;
}

export interface ViewFileEditChange {
  path: string;
  kind?: string;
  movePath?: string | null;
  diff?: string;
}

export interface ViewFileEditMessage extends ViewMessageBase {
  kind: "file-edit";
  callId: string;
  changes: ViewFileEditChange[];
  stdout?: string;
  stderr?: string;
  status: Extract<
    ViewMessageStatus,
    "pending" | "completed" | "error" | "interrupted"
  >;
}

export const viewOperationTypeValues = [
  "plan-updated",
  "provider-unhandled",
  "warning",
  "deprecation",
  "thread-interrupted",
  "provisioning",
  "operation",
  "compaction",
  "turn-diff",
] as const;
export const viewOperationTypeSchema = z.enum(viewOperationTypeValues);
export type ViewOperationType = z.infer<typeof viewOperationTypeSchema>;

export const viewThreadOperationKindValues = [
  "commit",
  "squash_merge",
  "primary_checkout",
  "ownership_change",
  "other",
] as const;
export const viewThreadOperationKindSchema = z.enum(
  viewThreadOperationKindValues,
);
export type ViewThreadOperationKind = z.infer<
  typeof viewThreadOperationKindSchema
>;

export const viewThreadOperationStatusValues = [
  "requested",
  "queued",
  "running",
  "started",
  "completed",
  "failed",
  "noop",
  "other",
] as const;
export const viewThreadOperationStatusSchema = z.enum(
  viewThreadOperationStatusValues,
);
export type ViewThreadOperationStatus = z.infer<
  typeof viewThreadOperationStatusSchema
>;

export interface ViewThreadOperationMetadata {
  operation: ViewThreadOperationKind;
  rawOperation: string;
  status: ViewThreadOperationStatus;
  rawStatus: string;
  operationId?: string;
  metadata?: Record<string, unknown>;
}

export interface ViewProvisioningTranscriptEntry {
  type: "step" | "output";
  key: string;
  text: string;
  startedAt?: number;
  status?: "started" | "completed" | "failed";
  metadata?: Record<string, unknown>;
}

export interface ViewProvisioningMetadata {
  environmentId?: string;
  transcript?: ViewProvisioningTranscriptEntry[];
}

export interface ViewOperationMessage extends ViewMessageBase {
  kind: "operation";
  opType: ViewOperationType;
  title: string;
  detail?: string;
  status?: Extract<
    ViewMessageStatus,
    "pending" | "completed" | "error" | "interrupted"
  >;
  provisioning?: ViewProvisioningMetadata;
  threadOperation?: ViewThreadOperationMetadata;
}

export const viewTaskStatusValues = [
  "pending",
  "active",
  "completed",
  "failed",
] as const;
export const viewTaskStatusSchema = z.enum(viewTaskStatusValues);
export type ViewTaskStatus = z.infer<typeof viewTaskStatusSchema>;

export interface ViewTaskEntry {
  text: string;
  status: ViewTaskStatus;
}

export interface ViewTasksMessage extends ViewMessageBase {
  kind: "tasks";
  source: "plan" | "todo";
  callId?: string;
  status: Extract<
    ViewMessageStatus,
    "pending" | "completed" | "error" | "interrupted"
  >;
  title: string;
  tasks: ViewTaskEntry[];
}

export interface ViewDelegationMessage
  extends ViewMessageBase, ViewDelegationMetadata {
  kind: "delegation";
  toolName: string;
  callId: string;
  command?: string;
  output?: string;
  duration?: string;
  durationMs?: number;
  status: Extract<
    ViewMessageStatus,
    "pending" | "completed" | "error" | "interrupted"
  >;
  children: ViewMessage[];
}

export interface ViewErrorMessage extends ViewMessageBase {
  kind: "error";
  message: string;
  rawType: string;
}

export interface ViewDebugRawEventMessage extends ViewMessageBase {
  kind: "debug/raw-event";
  rawType: string;
  rawEvent: ThreadEventRow;
  reason: "ignored-noise" | "duplicate-event" | "unhandled";
}

export type ViewMessage =
  | ViewUserMessage
  | ViewAssistantReasoningMessage
  | ViewAssistantTextMessage
  | ViewToolExploringMessage
  | ViewToolCallMessage
  | ViewWebSearchMessage
  | ViewFileEditMessage
  | ViewOperationMessage
  | ViewTasksMessage
  | ViewDelegationMessage
  | ViewErrorMessage
  | ViewDebugRawEventMessage;

export interface ToViewMessagesOptions {
  includeDebugRawEvents?: boolean;
  includeOptionalOperations?: boolean;
  includeInternalSystemMessages?: boolean;
  threadStatus?: Thread["status"];
  threadType?: Thread["type"];
}

export const viewMessageSchema = z.custom<ViewMessage>();
