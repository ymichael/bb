import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { nanoid } from "nanoid";
import type {
  PromptHistoryEntry,
  ResolvedThreadExecutionOptions,
  ThreadListEntry,
  ThreadQueuedMessage,
  ThreadWithRuntime,
} from "@bb/domain";
import type {
  CreateQueuedMessageRequest,
  PromptHistoryResponse,
  SendMessageResponse,
  SendQueuedMessageResponse,
  SendQueuedMessageMode,
  ThreadQueuedMessageListResponse,
  ThreadResponse,
  ThreadSearchResponse,
  ThreadTimelineResponse,
  TimelineConversationAttachments,
  TimelineRow,
  UpdateQueuedMessageRequest,
} from "@bb/server-contract";
import type { AppCreateThreadRequest } from "@bb/client-core";
import { OPTIMISTIC_TIMELINE_ROW_ID_PREFIX } from "@bb/client-core";
import { collectPromptAttachments } from "@/lib/prompt-attachments";
import { prependPromptHistoryEntry } from "@/lib/prompt-history";
import {
  applyQueuedMessageReorder,
  collectLeadQueuedMessageGroupIds,
  preserveLeadQueuedMessageGroupAfterReorder,
  type QueuedMessageReorderRequest,
} from "@/lib/queued-message-reorder";
import type { SendThreadMessageMutationRequest } from "../mutations/mutation-request-types";
import {
  insertOptimisticTimelineRow,
  optimisticallyInsertThread,
  removeOptimisticTimelineRow,
  applyToCachedThreadListsAndSidebarNavigation,
  updateCachedThread,
} from "./query-cache";
import {
  applyToCachedThreadLists,
  getCachedThreadLists,
  type ThreadListCacheData,
} from "./thread-list-cache-data";
import {
  projectPromptHistoryQueryKey,
  projectSourceBranchesQueryKeyPrefix,
  threadPromptHistoryQueryKey,
  threadQueryKey,
  threadQueuedMessagesQueryKey,
  threadSearchQueryKeyPrefix,
  threadsQueryKey,
  threadTimelineQueryKeyPrefix,
  threadTimelineTurnSummaryDetailsQueryKeyPrefix,
} from "../queries/query-keys";
import { threadDefaultExecutionOptionsQueryKey } from "../queries/thread-default-execution-options-query";
import {
  invalidateProjectPromptHistoryQueries,
  invalidateThreadAcceptedMessageQueriesWithoutRealtime,
  invalidateThreadQueuedMessageListQuery,
  invalidateThreadQueueQueries,
  markThreadAcceptedMessageQueriesStale,
  invalidateThreadQueuedMessageSendQueries,
  invalidateThreadListMembershipQueries,
  refetchThreadListsAfterComposerThreadCreate,
} from "./mutation-cache-effects";

interface ThreadIdCacheArgs {
  queryClient: QueryClient;
  threadId: string;
}

interface PrefetchThreadQueuedMessagesArgs extends ThreadIdCacheArgs {
  load: (signal: AbortSignal) => Promise<ThreadQueuedMessageListResponse>;
}

type ThreadBannerActivityKind = "goal" | "plan";

interface BeginCreateThreadTransactionArgs {
  queryClient: QueryClient;
}

interface CreateThreadSuccessArgs {
  queryClient: QueryClient;
  request: AppCreateThreadRequest;
  thread: ThreadResponse;
}

interface SendThreadMessageTransactionArgs {
  queryClient: QueryClient;
  request: SendThreadMessageMutationRequest;
}

interface CreateQueuedMessageRequestWithThreadId extends CreateQueuedMessageRequest {
  id: string;
}

interface CreateQueuedMessageTransactionArgs {
  queryClient: QueryClient;
  request: CreateQueuedMessageRequestWithThreadId;
}

interface UpdateQueuedMessageRequestWithThreadId extends UpdateQueuedMessageRequest {
  id: string;
  queuedMessageId: string;
}

interface UpdateQueuedMessageTransactionArgs {
  queryClient: QueryClient;
  request: UpdateQueuedMessageRequestWithThreadId;
}

interface RollbackUpdateQueuedMessageTransactionArgs {
  queryClient: QueryClient;
  request: UpdateQueuedMessageRequestWithThreadId;
  transaction: UpdateQueuedMessageTransaction | undefined;
}

interface RemoveQueuedMessageRequest {
  id: string;
  queuedMessageId: string;
}

interface SendQueuedMessageRequest extends RemoveQueuedMessageRequest {
  mode: SendQueuedMessageMode;
}

interface RemoveQueuedMessageTransactionArgs {
  queryClient: QueryClient;
  request: RemoveQueuedMessageRequest;
}

interface SendQueuedMessageTransactionArgs {
  queryClient: QueryClient;
  request: SendQueuedMessageRequest;
}

interface RollbackSendThreadMessageTransactionArgs {
  queryClient: QueryClient;
  request: SendThreadMessageMutationRequest;
  transaction: SendThreadMessageTransaction | undefined;
}

interface RollbackCreateQueuedMessageTransactionArgs {
  queryClient: QueryClient;
  request: CreateQueuedMessageRequestWithThreadId;
  transaction: CreateQueuedMessageTransaction | undefined;
}

interface RollbackRemoveQueuedMessageTransactionArgs {
  queryClient: QueryClient;
  request: RemoveQueuedMessageRequest;
  transaction: RemoveQueuedMessageTransaction | undefined;
}

interface ApplyQueuedMessageSendResultArgs {
  queryClient: QueryClient;
  request: SendQueuedMessageRequest;
  result: SendQueuedMessageResponse;
  transaction: RemoveQueuedMessageTransaction | undefined;
}

interface ApplySendThreadMessageSuccessArgs {
  queryClient: QueryClient;
  realtimeConnected: boolean;
  request: SendThreadMessageMutationRequest;
  result: SendMessageResponse;
  transaction: SendThreadMessageTransaction | undefined;
}

interface QueuedMessageSuccessArgs {
  queryClient: QueryClient;
  queuedMessage: ThreadQueuedMessage;
  threadId: string;
  transaction: CreateQueuedMessageTransaction | undefined;
}

interface ReorderQueuedMessageRequest extends QueuedMessageReorderRequest {
  id: string;
}

interface SetQueuedMessageGroupBoundaryRequest {
  groupBoundaryQueuedMessageId: string;
  id: string;
}

interface ReorderQueuedMessageTransactionArgs {
  queryClient: QueryClient;
  request: ReorderQueuedMessageRequest;
}

interface SetQueuedMessageGroupBoundaryTransactionArgs {
  queryClient: QueryClient;
  request: SetQueuedMessageGroupBoundaryRequest;
}

interface RollbackQueuedMessageTransactionArgs {
  queryClient: QueryClient;
  request: ReorderQueuedMessageRequest;
  transaction: ReorderQueuedMessageTransaction | undefined;
}

interface ApplyQueuedMessagesResultArgs {
  queryClient: QueryClient;
  queuedMessages: ThreadQueuedMessageListResponse;
  request: Pick<ReorderQueuedMessageRequest, "id">;
}

interface StopThreadTransactionArgs extends ThreadIdCacheArgs {
  requestedAt: number;
}

interface RollbackStopThreadTransactionArgs extends ThreadIdCacheArgs {
  transaction: StopThreadTransaction | undefined;
}

interface ThreadListSnapshotEntry {
  data: ThreadListCacheData;
  queryKey: QueryKey;
}

type ThreadListSnapshot = ThreadListSnapshotEntry[];

interface BuildAcceptedPromptHistoryEntryArgs {
  createdAt: number;
  input: PromptHistoryEntry["input"];
}

interface BuildOptimisticUserMessageRowParams {
  createdAt: number;
  input: SendThreadMessageMutationRequest["input"];
  mode: SendThreadMessageMutationRequest["mode"];
  threadId: string;
  threadStatus: ThreadWithRuntime["status"] | null;
}

interface BuildOptimisticQueuedMessageParams {
  createdAt: number;
  queryClient: QueryClient;
  request: CreateQueuedMessageRequestWithThreadId & { sendAt?: number };
}

type OptimisticTurnRequestKind = "message" | "steer";

interface OptimisticTurnRequestKindArgs {
  mode: SendThreadMessageMutationRequest["mode"];
  threadStatus: ThreadWithRuntime["status"] | null;
}

interface SendThreadMessageAcceptedTurnTransaction {
  kind: "accepted-turn";
  optimisticCreatedAt: number;
  optimisticRowId: string;
  optimisticThreadDataUpdateCount: number | null;
  previousThread: ThreadResponse | undefined;
}

interface SendThreadMessageQueuedTransaction {
  kind: "queued-message";
  optimisticCreatedAt: number;
  optimisticQueuedMessageId: string;
  previousThreadStatus: ThreadWithRuntime["status"] | null;
}

export type SendThreadMessageTransaction =
  | SendThreadMessageAcceptedTurnTransaction
  | SendThreadMessageQueuedTransaction;

export interface ReorderQueuedMessageTransaction {
  previousQueuedMessages: ThreadQueuedMessageListResponse | undefined;
}

export interface CreateQueuedMessageTransaction {
  optimisticCreatedAt: number;
  optimisticQueuedMessageId: string;
}

export interface UpdateQueuedMessageTransaction {
  optimisticUpdatedAt: number | null;
  previousQueuedMessage: ThreadQueuedMessage | undefined;
}

export interface RemoveQueuedMessageTransaction {
  optimisticCreatedAt: number | null;
  optimisticQueueDataUpdateCount: number;
  optimisticRowId: string | null;
  optimisticThreadDataUpdateCount: number | null;
  previousQueuedMessages: ThreadQueuedMessageListResponse | undefined;
  previousThread: ThreadResponse | undefined;
}

export interface StopThreadTransaction {
  previousThread: ThreadResponse | undefined;
  previousThreadLists: ThreadListSnapshot;
}

function buildAcceptedPromptHistoryEntry({
  createdAt,
  input,
}: BuildAcceptedPromptHistoryEntryArgs): PromptHistoryEntry {
  return {
    id: `optimistic-prompt-history:${nanoid()}`,
    createdAt,
    input,
  };
}

function buildQueuedPromptHistoryEntry(
  queuedMessage: ThreadQueuedMessage,
): PromptHistoryEntry {
  return {
    id: `queued-message:${queuedMessage.id}`,
    createdAt: queuedMessage.createdAt,
    input: queuedMessage.content,
  };
}

function applyQueuedMessageGroupBoundary({
  groupBoundaryQueuedMessageId,
  queuedMessages,
}: {
  groupBoundaryQueuedMessageId: string;
  queuedMessages: readonly ThreadQueuedMessage[];
}): ThreadQueuedMessage[] {
  const boundaryIndex = queuedMessages.findIndex(
    (queuedMessage) => queuedMessage.id === groupBoundaryQueuedMessageId,
  );
  if (boundaryIndex === -1) return [...queuedMessages];
  return queuedMessages.map((queuedMessage, index) => ({
    ...queuedMessage,
    groupWithNext: index < boundaryIndex,
  }));
}

function queuedMessageSendGroup(
  queuedMessages: readonly ThreadQueuedMessage[] | undefined,
  queuedMessageId: string,
): ThreadQueuedMessage[] {
  if (!queuedMessages) return [];
  const queuedMessageIndex = queuedMessages.findIndex(
    (queuedMessage) => queuedMessage.id === queuedMessageId,
  );
  if (queuedMessageIndex === -1) return [];
  if (queuedMessageIndex !== 0) return [queuedMessages[queuedMessageIndex]!];

  const group: ThreadQueuedMessage[] = [];
  for (const queuedMessage of queuedMessages) {
    group.push(queuedMessage);
    if (!queuedMessage.groupWithNext) break;
  }
  return group;
}

function queuedMessageSendIds(
  queuedMessages: readonly ThreadQueuedMessage[] | undefined,
  queuedMessageId: string,
): Set<string> {
  const group = queuedMessageSendGroup(queuedMessages, queuedMessageId);
  if (group.length === 0) return new Set([queuedMessageId]);
  return new Set(group.map((queuedMessage) => queuedMessage.id));
}

function removeQueuedMessagesAndRepairGroupEdges(
  queuedMessages: ThreadQueuedMessageListResponse | undefined,
  removeIds: ReadonlySet<string>,
): ThreadQueuedMessageListResponse | undefined {
  if (!queuedMessages) return queuedMessages;
  return queuedMessages.flatMap((queuedMessage, index) => {
    if (removeIds.has(queuedMessage.id)) return [];
    const nextQueuedMessage = queuedMessages[index + 1];
    if (
      nextQueuedMessage &&
      removeIds.has(nextQueuedMessage.id) &&
      queuedMessage.groupWithNext
    ) {
      return [{ ...queuedMessage, groupWithNext: false }];
    }
    return [queuedMessage];
  });
}

function getCachedDefaultExecutionOptions(
  queryClient: QueryClient,
  threadId: string,
): ResolvedThreadExecutionOptions | null | undefined {
  return queryClient.getQueryData<ResolvedThreadExecutionOptions | null>(
    threadDefaultExecutionOptionsQueryKey(threadId),
  );
}

function buildOptimisticQueuedMessage({
  createdAt,
  queryClient,
  request,
}: BuildOptimisticQueuedMessageParams): ThreadQueuedMessage {
  const defaultExecutionOptions = getCachedDefaultExecutionOptions(
    queryClient,
    request.id,
  );
  const scheduledSendAt =
    request.sendAt !== undefined && request.sendAt > createdAt
      ? request.sendAt
      : null;

  return {
    id: `optimistic-queued-${nanoid()}`,
    threadId: request.id,
    content: request.input,
    model: request.model ?? defaultExecutionOptions?.model ?? "pending",
    reasoningLevel:
      request.reasoningLevel ??
      defaultExecutionOptions?.reasoningLevel ??
      "medium",
    permissionMode:
      request.permissionMode ??
      defaultExecutionOptions?.permissionMode ??
      "auto",
    serviceTier:
      request.serviceTier ?? defaultExecutionOptions?.serviceTier ?? "default",
    groupWithNext: false,
    sendAt: scheduledSendAt,
    waitingOn: scheduledSendAt === null ? null : { kind: "time" },
    failureReason: null,
    payload: { kind: "inline" },
    editable: true,
    createdAt,
    updatedAt: createdAt,
  };
}

function insertOptimisticQueuedMessage({
  queryClient,
  request,
}: {
  queryClient: QueryClient;
  request: CreateQueuedMessageRequestWithThreadId & { sendAt?: number };
}): CreateQueuedMessageTransaction {
  const queryKey = threadQueuedMessagesQueryKey(request.id);
  const optimisticCreatedAt = Date.now();
  const optimisticQueuedMessage = buildOptimisticQueuedMessage({
    createdAt: optimisticCreatedAt,
    queryClient,
    request,
  });

  queryClient.setQueryData<ThreadQueuedMessageListResponse>(
    queryKey,
    (currentQueuedMessages) => [
      ...(currentQueuedMessages ?? []),
      optimisticQueuedMessage,
    ],
  );

  return {
    optimisticCreatedAt,
    optimisticQueuedMessageId: optimisticQueuedMessage.id,
  };
}

function restoreQueuedMessageSnapshotIfUnchanged({
  optimisticQueueDataUpdateCount,
  previousQueuedMessages,
  queryClient,
  threadId,
}: {
  optimisticQueueDataUpdateCount: number;
  previousQueuedMessages: ThreadQueuedMessageListResponse | undefined;
  queryClient: QueryClient;
  threadId: string;
}): boolean {
  const queryKey = threadQueuedMessagesQueryKey(threadId);
  if (
    queryClient.getQueryState(queryKey)?.dataUpdateCount !==
    optimisticQueueDataUpdateCount
  ) {
    return false;
  }
  queryClient.setQueryData<ThreadQueuedMessageListResponse>(
    queryKey,
    previousQueuedMessages ?? [],
  );
  return true;
}

function removeOptimisticQueuedMessage(
  queryClient: QueryClient,
  threadId: string,
  optimisticQueuedMessageId: string,
): boolean {
  let removed = false;
  queryClient.setQueryData<ThreadQueuedMessageListResponse>(
    threadQueuedMessagesQueryKey(threadId),
    (currentQueuedMessages) => {
      if (!currentQueuedMessages) return currentQueuedMessages;
      const nextQueuedMessages = currentQueuedMessages.filter(
        (queuedMessage) => queuedMessage.id !== optimisticQueuedMessageId,
      );
      removed = nextQueuedMessages.length !== currentQueuedMessages.length;
      return removed ? nextQueuedMessages : currentQueuedMessages;
    },
  );
  return removed;
}

function reconcileAuthoritativeQueuedMessage({
  insertWhenMissing,
  optimisticQueuedMessageId,
  queryClient,
  queuedMessage,
  threadId,
}: {
  insertWhenMissing: boolean;
  optimisticQueuedMessageId: string | null;
  queryClient: QueryClient;
  queuedMessage: ThreadQueuedMessage;
  threadId: string;
}): void {
  queryClient.setQueryData<ThreadQueuedMessageListResponse>(
    threadQueuedMessagesQueryKey(threadId),
    (currentQueuedMessages) => {
      if (!currentQueuedMessages) {
        return insertWhenMissing ? [queuedMessage] : currentQueuedMessages;
      }
      const authoritativeIndex = currentQueuedMessages.findIndex(
        (currentQueuedMessage) => currentQueuedMessage.id === queuedMessage.id,
      );
      if (authoritativeIndex !== -1) {
        const nextQueuedMessages = [...currentQueuedMessages];
        nextQueuedMessages[authoritativeIndex] = queuedMessage;
        return nextQueuedMessages;
      }
      const optimisticIndex =
        optimisticQueuedMessageId === null
          ? -1
          : currentQueuedMessages.findIndex(
              (currentQueuedMessage) =>
                currentQueuedMessage.id === optimisticQueuedMessageId,
            );
      if (optimisticIndex !== -1) {
        const nextQueuedMessages = [...currentQueuedMessages];
        nextQueuedMessages[optimisticIndex] = queuedMessage;
        return nextQueuedMessages;
      }
      return insertWhenMissing
        ? [...currentQueuedMessages, queuedMessage]
        : currentQueuedMessages;
    },
  );
}

function removeCachedQueuedMessage({
  queryClient,
  request,
}: RemoveQueuedMessageTransactionArgs): RemoveQueuedMessageTransaction {
  const queryKey = threadQueuedMessagesQueryKey(request.id);
  const previousQueuedMessages =
    queryClient.getQueryData<ThreadQueuedMessageListResponse>(queryKey);

  queryClient.setQueryData<ThreadQueuedMessageListResponse>(
    queryKey,
    (currentQueuedMessages) =>
      removeQueuedMessagesAndRepairGroupEdges(
        currentQueuedMessages,
        new Set([request.queuedMessageId]),
      ),
  );

  return {
    optimisticCreatedAt: null,
    optimisticQueueDataUpdateCount:
      queryClient.getQueryState(queryKey)?.dataUpdateCount ?? 0,
    optimisticRowId: null,
    optimisticThreadDataUpdateCount: null,
    previousQueuedMessages,
    previousThread: undefined,
  };
}

function prependProjectPromptHistory(
  queryClient: QueryClient,
  projectId: string,
  entry: PromptHistoryEntry,
): void {
  queryClient.setQueryData<PromptHistoryResponse>(
    projectPromptHistoryQueryKey(projectId),
    (currentEntries) => prependPromptHistoryEntry(currentEntries, entry),
  );
}

function prependThreadPromptHistory(
  queryClient: QueryClient,
  threadId: string,
  entry: PromptHistoryEntry,
): void {
  queryClient.setQueryData<PromptHistoryResponse>(
    threadPromptHistoryQueryKey(threadId),
    (currentEntries) => prependPromptHistoryEntry(currentEntries, entry),
  );
}

function hasUnmanagedCheckoutIntent(request: AppCreateThreadRequest): boolean {
  return (
    request.environment.type === "host" &&
    request.environment.workspace.type === "unmanaged" &&
    request.environment.workspace.branch !== undefined
  );
}

function snapshotThreadLists(queryClient: QueryClient): ThreadListSnapshot {
  return getCachedThreadLists(queryClient, { queryKey: threadsQueryKey() });
}

function restoreThreadLists(
  queryClient: QueryClient,
  threadLists: ThreadListSnapshot,
): void {
  for (const { queryKey, data } of threadLists) {
    queryClient.setQueryData(queryKey, data);
  }
}

function optimisticTurnRequestKind({
  mode,
  threadStatus,
}: OptimisticTurnRequestKindArgs): OptimisticTurnRequestKind {
  if (mode === "steer" || mode === "steer-if-active") {
    return "steer";
  }
  if (mode === "auto" && threadStatus === "active") {
    return "steer";
  }
  return "message";
}

function requestWillOptimisticallyQueue(
  request: SendThreadMessageMutationRequest,
  thread: ThreadWithRuntime | undefined,
): boolean {
  return (
    (request.sendAt !== undefined && request.sendAt > Date.now()) ||
    (request.mode === "queue-if-active" && thread?.status === "active")
  );
}

function buildOptimisticUserMessageRow({
  createdAt,
  input,
  mode,
  threadId,
  threadStatus,
}: BuildOptimisticUserMessageRowParams): TimelineRow {
  const id = `${OPTIMISTIC_TIMELINE_ROW_ID_PREFIX}${nanoid()}`;
  const text = input
    .filter(
      (entry): entry is Extract<typeof entry, { type: "text" }> =>
        entry.type === "text" && entry.visibility !== "agent-only",
    )
    .map((entry) => entry.text)
    .join("\n\n");
  const attachments = collectPromptAttachments(input);
  const timelineAttachments: TimelineConversationAttachments | null =
    attachments
      ? {
          webImages: attachments.webImages,
          localImages: attachments.localImages,
          localFiles: attachments.localFiles,
          imageUrls: attachments.imageUrls ?? [],
          localImagePaths: attachments.localImagePaths ?? [],
          localFilePaths: attachments.localFilePaths ?? [],
        }
      : null;
  return {
    id,
    kind: "conversation",
    role: "user",
    threadId,
    turnId: null,
    sourceSeqStart: 0,
    sourceSeqEnd: 0,
    startedAt: createdAt,
    createdAt,
    text,
    mentions: [],
    attachments: timelineAttachments,
    initiator: "user",
    senderThreadId: null,
    systemMessageKind: "unlabeled",
    systemMessageSubject: null,
    turnRequest: {
      isGrouped: false,
      kind: optimisticTurnRequestKind({ mode, threadStatus }),
      status: "pending",
    },
  };
}

function applyOptimisticAcceptedTurnThreadState({
  createdAt,
  queryClient,
  threadId,
}: {
  createdAt: number;
  queryClient: QueryClient;
  threadId: string;
}): void {
  updateCachedThread(queryClient, threadId, (thread) => ({
    ...thread,
    status: "active",
    updatedAt: Math.max(thread.updatedAt, createdAt),
    runtime: {
      ...thread.runtime,
      displayStatus:
        thread.runtime.displayStatus === "host-reconnecting" ||
        thread.runtime.displayStatus === "waiting-for-host"
          ? thread.runtime.displayStatus
          : "active",
    },
  }));
}

function removeOptimisticTimelineRowIfPresent(
  queryClient: QueryClient,
  threadId: string,
  optimisticRowId: string,
): boolean {
  const wasPresent = queryClient
    .getQueriesData<ThreadTimelineResponse>({
      queryKey: threadTimelineQueryKeyPrefix(threadId),
    })
    .some(([, timeline]) =>
      timeline?.rows.some((row) => row.id === optimisticRowId),
    );
  removeOptimisticTimelineRow(queryClient, threadId, optimisticRowId);
  return wasPresent;
}

function restoreOptimisticThreadSnapshotIfUnchanged({
  optimisticThreadDataUpdateCount,
  previousThread,
  queryClient,
  threadId,
}: {
  optimisticThreadDataUpdateCount: number | null;
  previousThread: ThreadResponse | undefined;
  queryClient: QueryClient;
  threadId: string;
}): void {
  if (
    optimisticThreadDataUpdateCount === null ||
    previousThread === undefined ||
    queryClient.getQueryState(threadQueryKey(threadId))?.dataUpdateCount !==
      optimisticThreadDataUpdateCount
  ) {
    return;
  }
  queryClient.setQueryData<ThreadResponse>(
    threadQueryKey(threadId),
    previousThread,
  );
}

function applyOptimisticStopRequest({
  queryClient,
  requestedAt,
  threadId,
}: StopThreadTransactionArgs): void {
  updateCachedThread(queryClient, threadId, (thread) => ({
    ...thread,
    status: "stopping",
    runtime: { ...thread.runtime, displayStatus: "stopping" },
    updatedAt: Math.max(thread.updatedAt, requestedAt),
  }));

  applyToCachedThreadLists(queryClient, {
    queryKey: threadsQueryKey(),
    mapper: (list) =>
      list.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              status: "stopping",
              runtime: { ...thread.runtime, displayStatus: "stopping" },
              updatedAt: Math.max(thread.updatedAt, requestedAt),
            }
          : thread,
      ),
  });
}

function clearThreadBannerActivity(
  thread: ThreadListEntry,
  threadId: string,
  kind: ThreadBannerActivityKind,
): ThreadListEntry {
  if (thread.id !== threadId) {
    return thread;
  }
  return {
    ...thread,
    activity: {
      ...thread.activity,
      ...(kind === "plan"
        ? { activePlanModeCount: 0 }
        : { activeGoalCount: 0 }),
    },
  };
}

function applyAuthoritativeThreadBannerCancellation({
  kind,
  queryClient,
  threadId,
}: ThreadIdCacheArgs & { kind: ThreadBannerActivityKind }): void {
  for (const [
    queryKey,
    timeline,
  ] of queryClient.getQueriesData<ThreadTimelineResponse>({
    queryKey: threadTimelineQueryKeyPrefix(threadId),
  })) {
    if (!timeline) {
      continue;
    }
    queryClient.setQueryData<ThreadTimelineResponse>(queryKey, {
      ...timeline,
      ...(kind === "plan" ? { activePromptMode: null } : { goal: null }),
    });
  }

  applyToCachedThreadListsAndSidebarNavigation(queryClient, (threads) =>
    threads.map((thread) => clearThreadBannerActivity(thread, threadId, kind)),
  );

  queryClient.setQueriesData<ThreadSearchResponse>(
    { queryKey: threadSearchQueryKeyPrefix() },
    (response) => {
      if (!response) {
        return response;
      }
      const mapGroup = (group: ThreadSearchResponse["active"]) => ({
        ...group,
        results: group.results.map((result) => ({
          ...result,
          thread: clearThreadBannerActivity(result.thread, threadId, kind),
        })),
      });
      return {
        active: mapGroup(response.active),
        archived: mapGroup(response.archived),
      };
    },
  );
}

export function applyThreadPlanCancellationResult(
  args: ThreadIdCacheArgs,
): void {
  applyAuthoritativeThreadBannerCancellation({ ...args, kind: "plan" });
}

export function applyThreadGoalClearResult(args: ThreadIdCacheArgs): void {
  applyAuthoritativeThreadBannerCancellation({ ...args, kind: "goal" });
}

export async function beginCreateThreadTransaction({
  queryClient,
}: BeginCreateThreadTransactionArgs): Promise<void> {
  await queryClient.cancelQueries({ queryKey: threadsQueryKey() });
}

export function prefetchThreadQueuedMessages({
  load,
  queryClient,
  threadId,
}: PrefetchThreadQueuedMessagesArgs): Promise<void> {
  return queryClient.prefetchQuery<ThreadQueuedMessageListResponse>({
    queryKey: threadQueuedMessagesQueryKey(threadId),
    queryFn: ({ signal }) => load(signal),
  });
}

export function applyCreateThreadResult({
  queryClient,
  request,
  thread,
}: CreateThreadSuccessArgs): void {
  queryClient.setQueryData<ThreadResponse>(threadQueryKey(thread.id), thread);
  optimisticallyInsertThread(queryClient, thread);
  prependProjectPromptHistory(
    queryClient,
    request.projectId,
    buildAcceptedPromptHistoryEntry({
      createdAt: thread.createdAt,
      input: request.input,
    }),
  );
  invalidateProjectPromptHistoryQueries({
    queryClient,
    projectId: request.projectId,
  });
  if (hasUnmanagedCheckoutIntent(request)) {
    queryClient.invalidateQueries({
      queryKey: projectSourceBranchesQueryKeyPrefix(request.projectId),
    });
  }
  refetchThreadListsAfterComposerThreadCreate({ queryClient });
}

export async function beginSendThreadMessageTransaction({
  queryClient,
  request,
}: SendThreadMessageTransactionArgs): Promise<SendThreadMessageTransaction> {
  await Promise.all([
    queryClient.cancelQueries({ queryKey: threadQueryKey(request.id) }),
    queryClient.cancelQueries({
      queryKey: threadQueuedMessagesQueryKey(request.id),
    }),
    queryClient.cancelQueries({
      queryKey: threadTimelineQueryKeyPrefix(request.id),
    }),
    queryClient.cancelQueries({
      queryKey: threadTimelineTurnSummaryDetailsQueryKeyPrefix(request.id),
    }),
  ]);

  const previousThread = queryClient.getQueryData<ThreadResponse>(
    threadQueryKey(request.id),
  );
  if (requestWillOptimisticallyQueue(request, previousThread)) {
    const transaction = insertOptimisticQueuedMessage({
      queryClient,
      request,
    });
    return {
      kind: "queued-message",
      previousThreadStatus: previousThread?.status ?? null,
      ...transaction,
    };
  }

  const optimisticCreatedAt = Date.now();

  applyOptimisticAcceptedTurnThreadState({
    createdAt: optimisticCreatedAt,
    queryClient,
    threadId: request.id,
  });

  const optimisticRow = buildOptimisticUserMessageRow({
    createdAt: optimisticCreatedAt,
    input: request.input,
    mode: request.mode,
    threadId: request.id,
    threadStatus: previousThread?.status ?? null,
  });
  insertOptimisticTimelineRow(queryClient, request.id, optimisticRow);

  return {
    kind: "accepted-turn",
    previousThread,
    optimisticCreatedAt,
    optimisticRowId: optimisticRow.id,
    optimisticThreadDataUpdateCount:
      queryClient.getQueryState(threadQueryKey(request.id))?.dataUpdateCount ??
      null,
  };
}

export function rollbackSendThreadMessageTransaction({
  queryClient,
  request,
  transaction,
}: RollbackSendThreadMessageTransactionArgs): void {
  if (transaction?.kind === "queued-message") {
    removeOptimisticQueuedMessage(
      queryClient,
      request.id,
      transaction.optimisticQueuedMessageId,
    );
    return;
  }
  if (transaction?.kind !== "accepted-turn") {
    return;
  }
  removeOptimisticTimelineRow(
    queryClient,
    request.id,
    transaction.optimisticRowId,
  );
  restoreOptimisticThreadSnapshotIfUnchanged({
    optimisticThreadDataUpdateCount:
      transaction.optimisticThreadDataUpdateCount,
    previousThread: transaction.previousThread,
    queryClient,
    threadId: request.id,
  });
}

export function applySendThreadMessageSuccess({
  queryClient,
  realtimeConnected,
  request,
  result,
  transaction,
}: ApplySendThreadMessageSuccessArgs): void {
  const optimisticCreatedAt = transaction?.optimisticCreatedAt ?? Date.now();
  if (result.delivery === "queued") {
    const optimisticTimelineRowRemoved =
      transaction?.kind === "accepted-turn"
        ? removeOptimisticTimelineRowIfPresent(
            queryClient,
            request.id,
            transaction.optimisticRowId,
          )
        : false;
    reconcileAuthoritativeQueuedMessage({
      insertWhenMissing:
        transaction === undefined || optimisticTimelineRowRemoved,
      optimisticQueuedMessageId:
        transaction?.kind === "queued-message"
          ? transaction.optimisticQueuedMessageId
          : null,
      queryClient,
      queuedMessage: result.queuedMessage,
      threadId: request.id,
    });
    if (transaction?.kind === "accepted-turn" && optimisticTimelineRowRemoved) {
      restoreOptimisticThreadSnapshotIfUnchanged({
        optimisticThreadDataUpdateCount:
          transaction.optimisticThreadDataUpdateCount,
        previousThread: transaction.previousThread,
        queryClient,
        threadId: request.id,
      });
    }
    prependThreadPromptHistory(
      queryClient,
      request.id,
      buildAcceptedPromptHistoryEntry({
        createdAt: optimisticCreatedAt,
        input: request.input,
      }),
    );
    invalidateThreadQueueQueries({ queryClient, threadId: request.id });
    return;
  }

  if (transaction?.kind === "queued-message") {
    const optimisticQueuedMessageRemoved = removeOptimisticQueuedMessage(
      queryClient,
      request.id,
      transaction.optimisticQueuedMessageId,
    );
    if (optimisticQueuedMessageRemoved) {
      applyOptimisticAcceptedTurnThreadState({
        createdAt: optimisticCreatedAt,
        queryClient,
        threadId: request.id,
      });
      insertOptimisticTimelineRow(
        queryClient,
        request.id,
        buildOptimisticUserMessageRow({
          createdAt: optimisticCreatedAt,
          input: request.input,
          mode: request.mode,
          threadId: request.id,
          threadStatus: transaction.previousThreadStatus,
        }),
      );
    }
    invalidateThreadQueuedMessageListQuery({
      queryClient,
      threadId: request.id,
    });
  }

  prependThreadPromptHistory(
    queryClient,
    request.id,
    buildAcceptedPromptHistoryEntry({
      createdAt: optimisticCreatedAt,
      input: request.input,
    }),
  );
  const applyAcceptedMessageQueries = realtimeConnected
    ? markThreadAcceptedMessageQueriesStale
    : invalidateThreadAcceptedMessageQueriesWithoutRealtime;

  applyAcceptedMessageQueries({
    queryClient,
    threadId: request.id,
  });
}

export async function beginCreateQueuedMessageTransaction({
  queryClient,
  request,
}: CreateQueuedMessageTransactionArgs): Promise<CreateQueuedMessageTransaction> {
  await queryClient.cancelQueries({
    queryKey: threadQueuedMessagesQueryKey(request.id),
  });
  return insertOptimisticQueuedMessage({ queryClient, request });
}

export function rollbackCreateQueuedMessageTransaction({
  queryClient,
  request,
  transaction,
}: RollbackCreateQueuedMessageTransactionArgs): void {
  if (!transaction) {
    return;
  }
  removeOptimisticQueuedMessage(
    queryClient,
    request.id,
    transaction.optimisticQueuedMessageId,
  );
}

export function applyQueuedMessageCreateResult({
  queryClient,
  queuedMessage,
  threadId,
  transaction,
}: QueuedMessageSuccessArgs): void {
  queryClient.setQueryData<ThreadQueuedMessageListResponse>(
    threadQueuedMessagesQueryKey(threadId),
    (currentQueuedMessages) => {
      if (!currentQueuedMessages) {
        return [queuedMessage];
      }
      if (
        currentQueuedMessages.some(
          (currentQueuedMessage) =>
            currentQueuedMessage.id === queuedMessage.id,
        )
      ) {
        return currentQueuedMessages;
      }

      const optimisticQueuedMessageId =
        transaction?.optimisticQueuedMessageId ?? null;
      if (optimisticQueuedMessageId !== null) {
        const optimisticIndex = currentQueuedMessages.findIndex(
          (currentQueuedMessage) =>
            currentQueuedMessage.id === optimisticQueuedMessageId,
        );
        if (optimisticIndex !== -1) {
          const nextQueuedMessages = [...currentQueuedMessages];
          nextQueuedMessages[optimisticIndex] = queuedMessage;
          return nextQueuedMessages;
        }
      }

      return [...currentQueuedMessages, queuedMessage];
    },
  );
  prependThreadPromptHistory(
    queryClient,
    threadId,
    buildQueuedPromptHistoryEntry(queuedMessage),
  );
  invalidateThreadQueueQueries({ queryClient, threadId });
}

export async function beginUpdateQueuedMessageTransaction({
  queryClient,
  request,
}: UpdateQueuedMessageTransactionArgs): Promise<UpdateQueuedMessageTransaction> {
  const queryKey = threadQueuedMessagesQueryKey(request.id);
  await queryClient.cancelQueries({ queryKey });
  const previousQueuedMessage = queryClient
    .getQueryData<ThreadQueuedMessageListResponse>(queryKey)
    ?.find((queuedMessage) => queuedMessage.id === request.queuedMessageId);
  const optimisticUpdatedAt = previousQueuedMessage
    ? Math.max(Date.now(), previousQueuedMessage.updatedAt + 1)
    : null;
  queryClient.setQueryData<ThreadQueuedMessageListResponse>(
    queryKey,
    (currentQueuedMessages) =>
      currentQueuedMessages?.map((queuedMessage) =>
        queuedMessage.id === request.queuedMessageId
          ? {
              ...queuedMessage,
              content: request.input,
              updatedAt: optimisticUpdatedAt ?? queuedMessage.updatedAt,
            }
          : queuedMessage,
      ),
  );
  return { optimisticUpdatedAt, previousQueuedMessage };
}

export function rollbackUpdateQueuedMessageTransaction({
  queryClient,
  request,
  transaction,
}: RollbackUpdateQueuedMessageTransactionArgs): void {
  const previousQueuedMessage = transaction?.previousQueuedMessage;
  const optimisticUpdatedAt = transaction?.optimisticUpdatedAt;
  if (
    previousQueuedMessage !== undefined &&
    optimisticUpdatedAt !== null &&
    optimisticUpdatedAt !== undefined
  ) {
    queryClient.setQueryData<ThreadQueuedMessageListResponse>(
      threadQueuedMessagesQueryKey(request.id),
      (currentQueuedMessages) =>
        currentQueuedMessages?.map((queuedMessage) =>
          queuedMessage.id === request.queuedMessageId &&
          queuedMessage.updatedAt === optimisticUpdatedAt
            ? {
                ...queuedMessage,
                content: previousQueuedMessage.content,
                updatedAt: previousQueuedMessage.updatedAt,
              }
            : queuedMessage,
        ),
    );
  }
  invalidateThreadQueueQueries({ queryClient, threadId: request.id });
}

export function applyQueuedMessageUpdateResult({
  queryClient,
  queuedMessage,
  threadId,
}: Omit<QueuedMessageSuccessArgs, "transaction">): void {
  queryClient.setQueryData<ThreadQueuedMessageListResponse>(
    threadQueuedMessagesQueryKey(threadId),
    (currentQueuedMessages) =>
      currentQueuedMessages?.map((currentQueuedMessage) =>
        currentQueuedMessage.id === queuedMessage.id
          ? queuedMessage
          : currentQueuedMessage,
      ) ?? [queuedMessage],
  );
  invalidateThreadQueueQueries({ queryClient, threadId });
}

export async function beginRemoveQueuedMessageTransaction({
  queryClient,
  request,
}: RemoveQueuedMessageTransactionArgs): Promise<RemoveQueuedMessageTransaction> {
  await queryClient.cancelQueries({
    queryKey: threadQueuedMessagesQueryKey(request.id),
  });
  return removeCachedQueuedMessage({ queryClient, request });
}

export async function beginSendQueuedMessageTransaction({
  queryClient,
  request,
}: SendQueuedMessageTransactionArgs): Promise<RemoveQueuedMessageTransaction> {
  await Promise.all([
    queryClient.cancelQueries({
      queryKey: threadQueuedMessagesQueryKey(request.id),
    }),
    queryClient.cancelQueries({ queryKey: threadQueryKey(request.id) }),
    queryClient.cancelQueries({
      queryKey: threadTimelineQueryKeyPrefix(request.id),
    }),
    queryClient.cancelQueries({
      queryKey: threadTimelineTurnSummaryDetailsQueryKeyPrefix(request.id),
    }),
  ]);

  const previousQueuedMessages =
    queryClient.getQueryData<ThreadQueuedMessageListResponse>(
      threadQueuedMessagesQueryKey(request.id),
    );
  const queuedMessageGroup = queuedMessageSendGroup(
    previousQueuedMessages,
    request.queuedMessageId,
  );
  const queuedMessage = queuedMessageGroup[0] ?? null;
  const sendIds = queuedMessageSendIds(
    previousQueuedMessages,
    request.queuedMessageId,
  );
  const previousThread = queryClient.getQueryData<ThreadResponse>(
    threadQueryKey(request.id),
  );

  queryClient.setQueryData<ThreadQueuedMessageListResponse>(
    threadQueuedMessagesQueryKey(request.id),
    (currentQueuedMessages) =>
      removeQueuedMessagesAndRepairGroupEdges(currentQueuedMessages, sendIds),
  );
  const optimisticQueueDataUpdateCount =
    queryClient.getQueryState(threadQueuedMessagesQueryKey(request.id))
      ?.dataUpdateCount ?? 0;

  if (!queuedMessage) {
    return {
      optimisticCreatedAt: null,
      optimisticQueueDataUpdateCount,
      optimisticRowId: null,
      optimisticThreadDataUpdateCount: null,
      previousQueuedMessages,
      previousThread,
    };
  }

  const optimisticCreatedAt = Date.now();
  applyOptimisticAcceptedTurnThreadState({
    createdAt: optimisticCreatedAt,
    queryClient,
    threadId: request.id,
  });
  const optimisticThreadDataUpdateCount =
    queryClient.getQueryState(threadQueryKey(request.id))?.dataUpdateCount ??
    null;
  if (queuedMessageGroup.length > 1) {
    return {
      optimisticCreatedAt,
      optimisticQueueDataUpdateCount,
      optimisticRowId: null,
      optimisticThreadDataUpdateCount,
      previousQueuedMessages,
      previousThread,
    };
  }
  const optimisticRow = buildOptimisticUserMessageRow({
    createdAt: optimisticCreatedAt,
    input: queuedMessage.content,
    mode: request.mode,
    threadId: request.id,
    threadStatus: previousThread?.status ?? null,
  });
  insertOptimisticTimelineRow(queryClient, request.id, optimisticRow);

  return {
    optimisticCreatedAt,
    optimisticQueueDataUpdateCount,
    optimisticRowId: optimisticRow.id,
    optimisticThreadDataUpdateCount,
    previousQueuedMessages,
    previousThread,
  };
}

export function rollbackRemoveQueuedMessageTransaction({
  queryClient,
  request,
  transaction,
}: RollbackRemoveQueuedMessageTransactionArgs): void {
  if (!transaction) {
    return;
  }
  if (transaction.optimisticRowId !== null) {
    removeOptimisticTimelineRow(
      queryClient,
      request.id,
      transaction.optimisticRowId,
    );
  }
  restoreOptimisticThreadSnapshotIfUnchanged({
    optimisticThreadDataUpdateCount:
      transaction.optimisticThreadDataUpdateCount,
    previousThread: transaction.previousThread,
    queryClient,
    threadId: request.id,
  });
  const queueRestored = restoreQueuedMessageSnapshotIfUnchanged({
    optimisticQueueDataUpdateCount: transaction.optimisticQueueDataUpdateCount,
    previousQueuedMessages: transaction.previousQueuedMessages,
    queryClient,
    threadId: request.id,
  });
  if (!queueRestored) {
    invalidateThreadQueueQueries({ queryClient, threadId: request.id });
  }
}

export function applyQueuedMessageSendResult({
  queryClient,
  request,
  result,
  transaction,
}: ApplyQueuedMessageSendResultArgs): void {
  if (result.delivery === "queued") {
    const optimisticQueueUnchanged =
      transaction !== undefined &&
      queryClient.getQueryState(threadQueuedMessagesQueryKey(request.id))
        ?.dataUpdateCount === transaction.optimisticQueueDataUpdateCount;
    if (optimisticQueueUnchanged && transaction !== undefined) {
      restoreQueuedMessageSnapshotIfUnchanged({
        optimisticQueueDataUpdateCount:
          transaction.optimisticQueueDataUpdateCount,
        previousQueuedMessages: transaction.previousQueuedMessages,
        queryClient,
        threadId: request.id,
      });
    }
    reconcileAuthoritativeQueuedMessage({
      insertWhenMissing: transaction === undefined || optimisticQueueUnchanged,
      optimisticQueuedMessageId: null,
      queryClient,
      queuedMessage: result.queuedMessage,
      threadId: request.id,
    });
    if (transaction !== undefined && transaction.optimisticRowId !== null) {
      removeOptimisticTimelineRow(
        queryClient,
        request.id,
        transaction.optimisticRowId,
      );
    }
    if (transaction !== undefined) {
      restoreOptimisticThreadSnapshotIfUnchanged({
        optimisticThreadDataUpdateCount:
          transaction.optimisticThreadDataUpdateCount,
        previousThread: transaction.previousThread,
        queryClient,
        threadId: request.id,
      });
    }
  }
  invalidateThreadQueuedMessageSendQueries({
    queryClient,
    threadId: request.id,
  });
}

export async function beginReorderQueuedMessageTransaction({
  queryClient,
  request,
}: ReorderQueuedMessageTransactionArgs): Promise<ReorderQueuedMessageTransaction> {
  const queryKey = threadQueuedMessagesQueryKey(request.id);
  const previousQueuedMessages =
    queryClient.getQueryData<ThreadQueuedMessageListResponse>(queryKey);

  queryClient.setQueryData<ThreadQueuedMessageListResponse>(
    queryKey,
    (currentQueuedMessages) => {
      if (!currentQueuedMessages) return currentQueuedMessages;
      const originalLeadGroupIds = collectLeadQueuedMessageGroupIds(
        currentQueuedMessages,
      );
      const reordered = applyQueuedMessageReorder({
        queuedMessages: currentQueuedMessages,
        request,
      });
      return request.groupBoundaryQueuedMessageId !== undefined
        ? applyQueuedMessageGroupBoundary({
            queuedMessages: reordered,
            groupBoundaryQueuedMessageId: request.groupBoundaryQueuedMessageId,
          })
        : preserveLeadQueuedMessageGroupAfterReorder({
            queuedMessages: reordered,
            originalLeadGroupIds,
          });
    },
  );

  await queryClient.cancelQueries({ queryKey });

  return { previousQueuedMessages };
}

export function rollbackReorderQueuedMessageTransaction({
  queryClient,
  request,
  transaction,
}: RollbackQueuedMessageTransactionArgs): void {
  if (transaction?.previousQueuedMessages !== undefined) {
    queryClient.setQueryData<ThreadQueuedMessageListResponse>(
      threadQueuedMessagesQueryKey(request.id),
      transaction.previousQueuedMessages,
    );
  }
  invalidateThreadQueueQueries({
    queryClient,
    threadId: request.id,
  });
}

export function applyQueuedMessagesResult({
  queryClient,
  queuedMessages,
  request,
}: ApplyQueuedMessagesResultArgs): void {
  queryClient.setQueryData<ThreadQueuedMessageListResponse>(
    threadQueuedMessagesQueryKey(request.id),
    queuedMessages,
  );
  invalidateThreadQueueQueries({
    queryClient,
    threadId: request.id,
  });
}

export async function beginSetQueuedMessageGroupBoundaryTransaction({
  queryClient,
  request,
}: SetQueuedMessageGroupBoundaryTransactionArgs): Promise<ReorderQueuedMessageTransaction> {
  const queryKey = threadQueuedMessagesQueryKey(request.id);
  const previousQueuedMessages =
    queryClient.getQueryData<ThreadQueuedMessageListResponse>(queryKey);

  queryClient.setQueryData<ThreadQueuedMessageListResponse>(
    queryKey,
    (currentQueuedMessages) =>
      currentQueuedMessages
        ? applyQueuedMessageGroupBoundary({
            queuedMessages: currentQueuedMessages,
            groupBoundaryQueuedMessageId: request.groupBoundaryQueuedMessageId,
          })
        : currentQueuedMessages,
  );

  await queryClient.cancelQueries({ queryKey });

  return { previousQueuedMessages };
}

export function applyQueuedMessageDeleteResult({
  queryClient,
  threadId,
}: ThreadIdCacheArgs): void {
  invalidateThreadQueueQueries({ queryClient, threadId });
}

export async function beginStopThreadTransaction({
  queryClient,
  requestedAt,
  threadId,
}: StopThreadTransactionArgs): Promise<StopThreadTransaction> {
  await Promise.all([
    queryClient.cancelQueries({ queryKey: threadQueryKey(threadId) }),
    queryClient.cancelQueries({ queryKey: threadsQueryKey() }),
  ]);

  const previousThread = queryClient.getQueryData<ThreadResponse>(
    threadQueryKey(threadId),
  );
  const previousThreadLists = snapshotThreadLists(queryClient);

  applyOptimisticStopRequest({
    queryClient,
    requestedAt,
    threadId,
  });

  return {
    previousThread,
    previousThreadLists,
  };
}

export function rollbackStopThreadTransaction({
  queryClient,
  threadId,
  transaction,
}: RollbackStopThreadTransactionArgs): void {
  if (!transaction) {
    return;
  }

  queryClient.setQueryData(
    threadQueryKey(threadId),
    transaction.previousThread,
  );
  restoreThreadLists(queryClient, transaction.previousThreadLists);
}

export function settleStopThreadTransaction({
  queryClient,
  threadId,
}: ThreadIdCacheArgs): void {
  invalidateThreadListMembershipQueries({ queryClient, threadId });
}
