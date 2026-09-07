import type {
  PermissionMode,
  PromptInput,
  ReasoningLevel,
  ServiceTier,
  ThreadRuntimeDisplayStatus,
} from "@bb/domain";
import type {
  CreateQueuedMessageRequest,
  ExistingThreadExecutionInputSources,
  SendMessageRequest,
} from "@bb/server-contract";
import type { FollowUpSubmitMode } from "./follow-up-submit-mode.js";

export interface SendMessageMutationRequest extends SendMessageRequest {
  id: string;
}

export interface CreateQueuedFollowUpRequest extends CreateQueuedMessageRequest {
  id: string;
}

export interface SendQueuedMessageByIdRequest {
  id: string;
  mode: "steer";
  queuedMessageId: string;
}

interface ThreadExecutionSelection {
  model: string;
  permissionMode: PermissionMode;
  reasoningLevel: ReasoningLevel;
  serviceTier: ServiceTier | undefined;
  supportsServiceTier: boolean;
  executionInputSources: ExistingThreadExecutionInputSources;
}

export type FollowUpExecutionSelection = ThreadExecutionSelection | null;

interface SharedThreadExecutionRequestFields {
  model?: string;
  permissionMode?: PermissionMode;
  reasoningLevel?: ReasoningLevel;
  serviceTier?: ServiceTier;
  executionInputSources?: ExistingThreadExecutionInputSources;
}

interface BaseFollowUpRequestArgs {
  input: PromptInput[];
  threadId: string;
}

interface BuildAutoFollowUpRequestArgs extends BaseFollowUpRequestArgs {
  execution: FollowUpExecutionSelection;
}

interface BuildCreateQueuedFollowUpRequestArgs extends BaseFollowUpRequestArgs {
  execution: FollowUpExecutionSelection;
}

interface BuildSendQueuedMessageByIdRequestArgs {
  queuedMessageId: string;
  threadId: string;
}

interface BuildSteerFollowUpRequestArgs extends BaseFollowUpRequestArgs {
  execution: FollowUpExecutionSelection;
}

interface BuildFollowUpShortcutRequestArgs extends BaseFollowUpRequestArgs {
  execution: FollowUpExecutionSelection;
  queuedMessages: readonly QueuedMessageForSend[];
}

interface CanSubmitFollowUpShortcutArgs {
  hasPromptDraftInput: boolean;
  isFollowUpSubmitting: boolean;
  isQueueMutationPending: boolean;
  queuedMessageCount: number;
  runtimeDisplayStatus: ThreadRuntimeDisplayStatus;
  submitModeKind: FollowUpSubmitMode["kind"];
}

interface BuildFollowUpSubmitModeArgs {
  hasPendingInteraction: boolean;
  isDefaultExecutionOptionsLoading: boolean;
  isPendingInteractionsInitialLoading: boolean;
  isStopRequested: boolean;
  onStop: () => void;
  runtimeDisplayStatus: ThreadRuntimeDisplayStatus;
}

interface BuildSideChatSubmitModeArgs {
  childThreadId: string | null;
  hasPendingInteraction: boolean;
  isDefaultExecutionOptionsLoading: boolean;
  isPendingInteractionsInitialLoading: boolean;
  isStopRequested: boolean;
  onStop: () => void;
  runtimeDisplayStatus: ThreadRuntimeDisplayStatus;
}

interface ResolveDefaultExecutionOptionsStateArgs {
  hasConcreteDefaultExecutionOptions: boolean;
  hasResolvedDefaultExecutionOptions: boolean;
  isError: boolean;
}

export interface QueuedMessageForSend {
  id: string;
}

type FollowUpShortcutRequest =
  | { kind: "draft"; request: SendMessageMutationRequest }
  | { kind: "queued"; request: SendQueuedMessageByIdRequest };

export type DefaultExecutionOptionsState =
  | "available"
  | "loading"
  | "unavailable";

export function shouldQueueFollowUpMessage(
  displayStatus: ThreadRuntimeDisplayStatus,
): boolean {
  return (
    displayStatus === "active" ||
    displayStatus === "host-reconnecting" ||
    displayStatus === "provisioning" ||
    displayStatus === "starting" ||
    displayStatus === "waiting-for-host"
  );
}

export function buildFollowUpSubmitMode({
  hasPendingInteraction,
  isDefaultExecutionOptionsLoading,
  isPendingInteractionsInitialLoading,
  isStopRequested,
  onStop,
  runtimeDisplayStatus,
}: BuildFollowUpSubmitModeArgs): FollowUpSubmitMode {
  if (isStopRequested) {
    return { kind: "blocked", reason: "stopping" };
  }
  if (isPendingInteractionsInitialLoading) {
    return { kind: "blocked", reason: "loading-pending-interactions" };
  }
  if (hasPendingInteraction) {
    return { kind: "blocked", reason: "pending-interaction" };
  }
  if (shouldQueueFollowUpMessage(runtimeDisplayStatus)) {
    return { kind: "queue", onStop };
  }
  if (isDefaultExecutionOptionsLoading) {
    return { kind: "blocked", reason: "loading-execution-options" };
  }
  return { kind: "ready" };
}

export function buildSideChatSubmitMode({
  childThreadId,
  hasPendingInteraction,
  isDefaultExecutionOptionsLoading,
  isPendingInteractionsInitialLoading,
  isStopRequested,
  onStop,
  runtimeDisplayStatus,
}: BuildSideChatSubmitModeArgs): FollowUpSubmitMode {
  if (childThreadId === null) {
    return isDefaultExecutionOptionsLoading
      ? { kind: "blocked", reason: "loading-execution-options" }
      : { kind: "ready" };
  }
  return buildFollowUpSubmitMode({
    hasPendingInteraction,
    isDefaultExecutionOptionsLoading,
    isPendingInteractionsInitialLoading,
    isStopRequested,
    onStop,
    runtimeDisplayStatus,
  });
}

export function canSubmitFollowUpShortcut({
  hasPromptDraftInput,
  isFollowUpSubmitting,
  isQueueMutationPending,
  queuedMessageCount,
  runtimeDisplayStatus,
  submitModeKind,
}: CanSubmitFollowUpShortcutArgs): boolean {
  return (
    (runtimeDisplayStatus === "active" ||
      runtimeDisplayStatus === "provisioning" ||
      runtimeDisplayStatus === "starting") &&
    submitModeKind === "queue" &&
    !isFollowUpSubmitting &&
    !isQueueMutationPending &&
    (queuedMessageCount > 0 || hasPromptDraftInput)
  );
}

export function resolveDefaultExecutionOptionsState({
  hasConcreteDefaultExecutionOptions,
  hasResolvedDefaultExecutionOptions,
  isError,
}: ResolveDefaultExecutionOptionsStateArgs): DefaultExecutionOptionsState {
  if (hasConcreteDefaultExecutionOptions) {
    return "available";
  }
  if (hasResolvedDefaultExecutionOptions || isError) {
    return "unavailable";
  }
  return "loading";
}

export function buildAutoFollowUpRequest({
  execution,
  input,
  threadId,
}: BuildAutoFollowUpRequestArgs): SendMessageMutationRequest | null {
  if (input.length === 0) {
    return null;
  }

  return {
    id: threadId,
    input,
    mode: "queue-if-active",
    ...buildSharedThreadExecutionRequestFields(execution),
  };
}

function buildSteerFollowUpRequest({
  execution,
  input,
  threadId,
}: BuildSteerFollowUpRequestArgs): SendMessageMutationRequest | null {
  if (input.length === 0) {
    return null;
  }

  return {
    id: threadId,
    input,
    mode: "steer-if-active",
    ...buildSharedThreadExecutionRequestFields(execution),
  };
}

export function buildCreateQueuedFollowUpRequest({
  execution,
  input,
  threadId,
}: BuildCreateQueuedFollowUpRequestArgs): CreateQueuedFollowUpRequest | null {
  if (input.length === 0) {
    return null;
  }

  return {
    id: threadId,
    input,
    ...buildSharedThreadExecutionRequestFields(execution),
  };
}

function buildSendQueuedMessageByIdRequest({
  queuedMessageId,
  threadId,
}: BuildSendQueuedMessageByIdRequestArgs): SendQueuedMessageByIdRequest {
  return {
    id: threadId,
    mode: "steer",
    queuedMessageId,
  };
}

export function buildFollowUpShortcutRequest({
  execution,
  input,
  queuedMessages,
  threadId,
}: BuildFollowUpShortcutRequestArgs): FollowUpShortcutRequest | null {
  const draftRequest = buildSteerFollowUpRequest({
    execution,
    input,
    threadId,
  });
  if (draftRequest) {
    return { kind: "draft", request: draftRequest };
  }

  const nextQueuedMessage = queuedMessages[0];
  if (!nextQueuedMessage) {
    return null;
  }

  return {
    kind: "queued",
    request: buildSendQueuedMessageByIdRequest({
      queuedMessageId: nextQueuedMessage.id,
      threadId,
    }),
  };
}

function buildSharedThreadExecutionRequestFields(
  execution: FollowUpExecutionSelection,
): SharedThreadExecutionRequestFields {
  if (execution === null) {
    return {};
  }

  return {
    model: execution.model,
    ...(execution.supportsServiceTier && execution.serviceTier
      ? { serviceTier: execution.serviceTier }
      : {}),
    reasoningLevel: execution.reasoningLevel,
    permissionMode: execution.permissionMode,
    executionInputSources: execution.executionInputSources,
  };
}
