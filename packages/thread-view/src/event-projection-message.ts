import type {
  BackgroundTaskStatus,
  BackgroundTaskUsage,
  ExtensionKind,
  JsonObject,
  JsonValue,
  OwnershipChangeOperationMetadata,
  PendingInteractionUserAnswer,
  PendingInteractionUserQuestionQuestion,
  ProviderErrorInfo,
  PromptTextMention,
  SystemMessageKind,
  SystemMessageSubject,
  Thread,
  ThreadEventItemPresentation,
  ThreadEventPlanStep,
  ThreadEventScope,
  ThreadEventSearchMode,
  ThreadTurnInitiator,
  WorkflowProgressSnapshot,
} from "@bb/domain";
import type { EventProjection } from "./event-projection.js";

const eventProjectionMessageStatusValues = [
  "streaming",
  "pending",
  "completed",
  "error",
  "interrupted",
] as const;
type EventProjectionMessageStatus =
  (typeof eventProjectionMessageStatusValues)[number];

const eventProjectionApprovalLifecycleStatusValues = [
  "waiting_for_approval",
  "denied",
] as const;
export type EventProjectionApprovalLifecycleStatus =
  (typeof eventProjectionApprovalLifecycleStatusValues)[number];

const eventProjectionPermissionGrantLifecycleValues = [
  "pending",
  "resolving",
  "granted",
  "denied",
  "interrupted",
] as const;
export type EventProjectionPermissionGrantLifecycle =
  (typeof eventProjectionPermissionGrantLifecycleValues)[number];
const eventProjectionUserQuestionLifecycleValues = [
  "pending",
  "resolving",
  "answered",
  "interrupted",
] as const;
export type EventProjectionUserQuestionLifecycle =
  (typeof eventProjectionUserQuestionLifecycleValues)[number];

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

interface EventProjectionPresentedMessage {
  presentation?: ThreadEventItemPresentation;
}

const eventProjectionTurnRequestKindValues = ["message", "steer"] as const;
export type EventProjectionTurnRequestKind =
  (typeof eventProjectionTurnRequestKindValues)[number];

const eventProjectionTurnRequestStatusValues = [
  "pending",
  "accepted",
  "rejected",
] as const;
type EventProjectionTurnRequestStatus =
  (typeof eventProjectionTurnRequestStatusValues)[number];

export interface EventProjectionTurnRequest {
  isGrouped: boolean;
  kind: EventProjectionTurnRequestKind;
  status: EventProjectionTurnRequestStatus;
}

export interface EventProjectionUserMessage extends EventProjectionMessageBase {
  kind: "user";
  initiator: ThreadTurnInitiator;
  senderThreadId: string | null;
  systemMessageKind: SystemMessageKind;
  systemMessageSubject: SystemMessageSubject | null;
  turnRequest: EventProjectionTurnRequest;
  text: string;
  mentions: PromptTextMention[];
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
  isLegacyUserMessage?: boolean;
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

interface EventProjectionDelegationMetadata {
  subagentType?: string;
  description?: string;
  model?: string;
}

export interface EventProjectionToolCallMessage
  extends EventProjectionMessageBase, EventProjectionPresentedMessage {
  kind: "tool-call";
  toolName: string;
  toolArgs: JsonObject | null;
  callId: string;
  output: string;
  completedAt: number | null;
  approvalStatus: EventProjectionApprovalLifecycleStatus | null;
  status: Extract<
    EventProjectionMessageStatus,
    "pending" | "completed" | "error" | "interrupted"
  >;
}

export interface EventProjectionCommandMessage
  extends EventProjectionMessageBase, EventProjectionPresentedMessage {
  kind: "command";
  callId: string;
  command: string;
  cwd: string | null;
  parsedIntents: EventProjectionToolParsedIntent[];
  source: string | null;
  output: string;
  exitCode: number | null;
  completedAt: number | null;
  approvalStatus: EventProjectionApprovalLifecycleStatus | null;
  status: Extract<
    EventProjectionMessageStatus,
    "pending" | "completed" | "error" | "interrupted"
  >;
}

export interface EventProjectionWebSearchMessage
  extends EventProjectionMessageBase, EventProjectionPresentedMessage {
  kind: "web-search";
  callId: string;
  queries: string[];
  completedAt: number | null;
  status: Extract<
    EventProjectionMessageStatus,
    "pending" | "completed" | "interrupted"
  >;
}

export interface EventProjectionWebFetchMessage
  extends EventProjectionMessageBase, EventProjectionPresentedMessage {
  kind: "web-fetch";
  callId: string;
  url: string;
  prompt: string | null;
  pattern: string | null;
  completedAt: number | null;
  status: Extract<
    EventProjectionMessageStatus,
    "pending" | "completed" | "interrupted"
  >;
}

export interface EventProjectionImageViewMessage
  extends EventProjectionMessageBase, EventProjectionPresentedMessage {
  kind: "image-view";
  callId: string;
  path: string;
  completedAt: number | null;
  status: Extract<
    EventProjectionMessageStatus,
    "pending" | "completed" | "interrupted"
  >;
}

type EventProjectionItemActivityStatus = Extract<
  EventProjectionMessageStatus,
  "pending" | "completed" | "error" | "interrupted"
>;

export interface EventProjectionFileReadMessage
  extends EventProjectionMessageBase, EventProjectionPresentedMessage {
  kind: "file-read";
  callId: string;
  path: string;
  cmd: string | null;
  completedAt: number | null;
  status: EventProjectionItemActivityStatus;
}

export interface EventProjectionSearchMessage
  extends EventProjectionMessageBase, EventProjectionPresentedMessage {
  kind: "search";
  callId: string;
  mode: ThreadEventSearchMode;
  query: string;
  path: string | null;
  cmd: string | null;
  completedAt: number | null;
  status: EventProjectionItemActivityStatus;
}

export interface EventProjectionPlanStepsMessage
  extends EventProjectionMessageBase, EventProjectionPresentedMessage {
  kind: "plan-steps";
  callId: string;
  steps: ThreadEventPlanStep[];
  explanation: string | null;
  completedAt: number | null;
  status: EventProjectionItemActivityStatus;
}

export interface EventProjectionExtensionMessage extends EventProjectionMessageBase {
  kind: "extension";
  callId: string;
  extensionKind: ExtensionKind;
  payload: JsonValue;
  presentation: ThreadEventItemPresentation;
  completedAt: number | null;
  status: EventProjectionItemActivityStatus;
}

export interface EventProjectionFileEditChange {
  path: string;
  kind?: string;
  movePath?: string | null;
  diff?: string;
}

export interface EventProjectionFileEditMessage
  extends EventProjectionMessageBase, EventProjectionPresentedMessage {
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

const eventProjectionOperationTypeValues = [
  "provider-unhandled",
  "provider-environment",
  "warning",
  "deprecation",
  "thread-interrupted",
  "thread-provisioning",
  "operation",
  "compaction",
  "context-clear",
] as const;
type EventProjectionOperationType =
  (typeof eventProjectionOperationTypeValues)[number];

const eventProjectionThreadOperationKindValues = [
  "ownership_change",
  "other",
] as const;
export type EventProjectionThreadOperationKind =
  (typeof eventProjectionThreadOperationKindValues)[number];

const eventProjectionThreadOperationStatusValues = [
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

export interface EventProjectionOwnershipChangeThreadOperationMetadata {
  operation: "ownership_change";
  rawOperation: string;
  status: EventProjectionThreadOperationStatus;
  rawStatus: string;
  operationId: string;
  metadata: OwnershipChangeOperationMetadata | null;
}

interface EventProjectionOtherThreadOperationMetadata {
  operation: "other";
  rawOperation: string;
  status: EventProjectionThreadOperationStatus;
  rawStatus: string;
  operationId: string;
  metadata?: JsonObject;
}

export type EventProjectionThreadOperationMetadata =
  | EventProjectionOwnershipChangeThreadOperationMetadata
  | EventProjectionOtherThreadOperationMetadata;

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

interface EventProjectionApprovalTarget {
  itemId: string;
  toolName: string | null;
}

export type EventProjectionPermissionGrantGrantScope = "turn" | "session";

export interface EventProjectionOperationMessage extends EventProjectionMessageBase {
  kind: "operation";
  opType: EventProjectionOperationType;
  title: string;
  detail?: string;
  status?: Extract<
    EventProjectionMessageStatus,
    "pending" | "completed" | "error" | "interrupted"
  >;
  completedAt: number | null;
  provisioning?: EventProjectionProvisioningMetadata;
  threadOperation?: EventProjectionThreadOperationMetadata;
}

export interface EventProjectionPermissionGrantLifecycleMessage extends EventProjectionMessageBase {
  kind: "permission-grant-lifecycle";
  interactionId: string;
  lifecycle: EventProjectionPermissionGrantLifecycle;
  status: Extract<
    EventProjectionMessageStatus,
    "pending" | "completed" | "error" | "interrupted"
  >;
  approvalTarget: EventProjectionApprovalTarget;
  grantScope: EventProjectionPermissionGrantGrantScope | null;
  statusReason: string | null;
}

export interface EventProjectionUserQuestionLifecycleMessage extends EventProjectionMessageBase {
  kind: "user-question-lifecycle";
  interactionId: string;
  lifecycle: EventProjectionUserQuestionLifecycle;
  status: Extract<
    EventProjectionMessageStatus,
    "pending" | "completed" | "error" | "interrupted"
  >;
  questions: PendingInteractionUserQuestionQuestion[];
  answers: Record<string, PendingInteractionUserAnswer> | null;
  statusReason: string | null;
}

export interface EventProjectionDelegationMessage
  extends
    EventProjectionMessageBase,
    EventProjectionDelegationMetadata,
    EventProjectionPresentedMessage {
  kind: "delegation";
  toolName: string;
  callId: string;
  childRef: string | null;
  background: boolean;
  output: string;
  completedAt: number | null;
  status: Extract<
    EventProjectionMessageStatus,
    "pending" | "completed" | "error" | "interrupted"
  >;
  childProjection: EventProjection;
}

export interface EventProjectionWorkflowMessage
  extends EventProjectionMessageBase, EventProjectionPresentedMessage {
  kind: "workflow";
  itemId: string;
  familyId: string | null;
  taskType: string;
  workflowName: string | null;
  description: string;
  model: string | null;
  status: Extract<
    EventProjectionMessageStatus,
    "pending" | "completed" | "error" | "interrupted"
  >;
  taskStatus: BackgroundTaskStatus;
  skipTranscript: boolean;
  workflow: WorkflowProgressSnapshot | null;
  usage: BackgroundTaskUsage | null;
  summary: string | null;
  error: string | null;
  completedAt: number | null;
}

export interface EventProjectionErrorMessage extends EventProjectionMessageBase {
  kind: "error";
  message: string;
  detail: string | null;
  rawType: string;
  providerErrorInfo?: ProviderErrorInfo;
  reconnectAttempt?: number;
  reconnectTotal?: number;
  willRetry?: boolean;
}

export type EventProjectionMessage =
  | EventProjectionUserMessage
  | EventProjectionAssistantTextMessage
  | EventProjectionCommandMessage
  | EventProjectionToolCallMessage
  | EventProjectionWebSearchMessage
  | EventProjectionWebFetchMessage
  | EventProjectionImageViewMessage
  | EventProjectionFileReadMessage
  | EventProjectionSearchMessage
  | EventProjectionPlanStepsMessage
  | EventProjectionExtensionMessage
  | EventProjectionFileEditMessage
  | EventProjectionOperationMessage
  | EventProjectionPermissionGrantLifecycleMessage
  | EventProjectionUserQuestionLifecycleMessage
  | EventProjectionDelegationMessage
  | EventProjectionWorkflowMessage
  | EventProjectionErrorMessage;

export interface BuildEventProjectionMessagesOptions {
  includeProviderUnhandledOperations?: boolean;
  threadStatus?: Thread["status"];
  threadName: string;
  providerDisplayName?: string;
}
