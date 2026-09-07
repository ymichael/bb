import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import type { IconName } from "@bb/shared-ui/icon";
import type { PromptMentionLinkResolver } from "@/components/promptbox/editor/prompt-mention-link";
import {
  getFollowUpPromptPlaceholder,
  getCompactFollowUpPromptPlaceholder,
} from "@/components/promptbox/follow-up-placeholder";
import { PERSONAL_PROJECT_ID } from "@bb/domain";
import type {
  EnvironmentStatus,
  PendingInteraction,
  PromptInput,
  ThreadQueuedMessage,
  ThreadPullRequest,
  ThreadTimelineActivePromptMode,
  ThreadTimelineGoal,
  ThreadTimelineModelFallback,
  ThreadTimelinePendingTodos,
  ThreadWithRuntime,
} from "@bb/domain";
import type {
  PullRequestMergeMethod,
  ThreadTimelineResponse,
  TimelineWorkflowWorkRow,
} from "@bb/server-contract";
import type { ChildThreadPendingAttention } from "@/hooks/queries/child-thread-pending-interactions";
import { ThreadPendingInteractionBanner } from "@/components/thread/pending-interactions/ThreadPendingInteractionBanner";
import {
  type PluginComposerHost,
  useComposerHostDraftNotifier,
  usePublishPluginComposerHost,
} from "@/components/plugin/plugin-composer-host";
import {
  ThreadPromptContextBanner,
  type ContextBannerMergeBaseConfig,
  type ThreadPromptContextBannerExpandedSection,
  type ThreadPromptParentThreadSection,
  type ThreadPromptChildThreadsSection,
  type ThreadPromptPullRequestSection,
} from "@/components/promptbox/banner/ThreadPromptContextBanner";
import { ThreadGoalCard } from "@/components/promptbox/banner/ThreadGoalCard";
import { ThreadTodoCard } from "@/components/promptbox/banner/ThreadTodoCard";
import { ThreadPromptModeCard } from "@/components/promptbox/banner/ThreadPromptModeCard";
import { ThreadWorkflowCard } from "@/components/promptbox/banner/ThreadWorkflowCard";
import { ThreadBackgroundCommandsCard } from "@/components/promptbox/banner/ThreadBackgroundCommandsCard";
import { ThreadModelFallbackCard } from "@/components/promptbox/banner/ThreadModelFallbackCard";
import { InlineMessageEditorFrame } from "@/components/promptbox/InlineMessageEditorFrame";
import type {
  WorkspaceChangedFileSelection,
  WorkspaceChangedFilesSection,
} from "@/components/workspace/workspace-change-summary";
import {
  QueuedMessagesList,
  QueuedMessagesPendingCard,
  type QueuedMessageInlineEditor,
} from "@/components/promptbox/banner/QueuedMessagesList";
import { ThreadEnvironmentSummary } from "@/components/promptbox/ThreadEnvironmentSummary";
import type { EnvironmentWorkspaceTypeLabel } from "@/lib/environment-workspace-display";
import type { WorkspaceCheckoutDisplay } from "@/lib/workspace-checkout-display";
import { useComposerTextEffects } from "@/lib/composer-text-effects";
import { useLatestRef } from "@/hooks/useLatestRef";
import { useThreadCreationOptions } from "@/hooks/useThreadCreationOptions";
import { useProjectDisplayName } from "@/hooks/queries/sidebar-navigation-query";
import {
  useActiveComposerDraft,
  useComposerAttachmentUploads,
  useDraftAttachmentUploads,
  useComposerTypeahead,
  useInlineQueuedMessageEditing,
  useQueuedMessageActions,
  type InlineQueuedMessageEditState,
} from "@/components/thread/embedded-chat";
import {
  useCreateThreadQueuedMessage,
  useCancelThreadPlan,
  useClearThreadGoal,
  useStopThread,
} from "@/hooks/mutations/thread-runtime-mutations";
import { useUnarchiveThread } from "@/hooks/mutations/thread-state-mutations";
import {
  getLatestPendingInteraction,
  useThreadQueuedMessages,
  useThreadPromptHistory,
} from "@/hooks/queries/thread-queries";
import { useThreadDefaultExecutionOptions } from "@/hooks/queries/thread-default-execution-options-query";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import { promptHistoryEntriesToDrafts } from "@/lib/prompt-history";
import { usePromptHistoryEnabled } from "@/hooks/usePromptHistoryEnabled";
import { getProjectComposeRoutePath } from "@/lib/route-paths";
import { getThreadDisplayTitle } from "@/lib/thread-title";
import { buildThreadHandoffLocationState } from "@bb/client-core";
import { appToast } from "@/components/ui/app-toast";
import {
  emptyPromptDraftState,
  promptDraftToInput,
  type PromptDraftAttachment,
  type PromptDraftState,
} from "@bb/client-core";
import {
  FollowUpPromptBox,
  type FollowUpComposerProps,
  type FollowUpPromptBoxProps,
  type FollowUpSubmitMode,
} from "@/components/promptbox/FollowUpPromptBox";
import type { SendMessageMutationLike } from "./threadDetailMutationTypes";
import {
  buildAutoFollowUpRequest,
  buildCreateQueuedFollowUpRequest,
  buildFollowUpSubmitMode,
  buildFollowUpShortcutRequest,
  canSubmitFollowUpShortcut,
  resolveDefaultExecutionOptionsState,
  shouldQueueFollowUpMessage,
  type FollowUpExecutionSelection,
} from "@bb/client-core";

const ignorePromptBannerFileClick = () => {};

export interface ThreadDetailSentMessageEdit {
  draft: PromptDraftState;
  hostElement: HTMLDivElement | null;
  isSubmitting: boolean;
  operationId: string;
  onCancel: () => void;
  onSubmit: (target: {
    execution: FollowUpExecutionSelection;
    input: PromptInput[];
  }) => void;
  updateDraft: (
    update: (current: PromptDraftState) => PromptDraftState,
  ) => void;
}

const THREAD_DETAIL_COMPOSER_TEXTAREA_ID = "thread-detail-follow-up-composer";
const EMPTY_QUEUED_MESSAGES: readonly ThreadQueuedMessage[] = [];

interface ThreadDetailPromptAreaProps {
  activeBackgroundAgentCount: number;
  canUseGitUi: boolean;
  contextWindowUsage?: ThreadTimelineResponse["contextWindowUsage"];
  environmentCheckout?: WorkspaceCheckoutDisplay;
  environmentCompactLabel?: string;
  environmentGoneStatus: Extract<
    EnvironmentStatus,
    "destroying" | "destroyed"
  > | null;
  environmentHostId?: string;
  environmentIcon?: IconName;
  environmentLabel?: string;
  environmentTypeLabel?: EnvironmentWorkspaceTypeLabel;
  onCreateNewThreadInWorktree?: () => void;
  onPullRequestDraft?: () => void;
  onPullRequestMerge?: (method: PullRequestMergeMethod) => void;
  onPullRequestReady?: () => void;
  pullRequestMergeMethod: PullRequestMergeMethod;
  isEnvironmentActionPending: boolean;
  pendingInteractions: readonly PendingInteraction[];
  pendingInteractionsInitialLoading: boolean;
  queuedMessageCount: number;
  onChangedFileClick: (selection: WorkspaceChangedFileSelection) => void;
  projectId: string;
  resolveMentionLink: PromptMentionLinkResolver;
  workspaceChangedFilesSection: WorkspaceChangedFilesSection | null;
  workspaceStatusPending: boolean;
  contextBannerMergeBase: ContextBannerMergeBaseConfig | null;
  pendingTodos: ThreadTimelinePendingTodos | null;
  activePromptMode: ThreadTimelineActivePromptMode | null;
  goal: ThreadTimelineGoal | null;
  modelFallback: ThreadTimelineModelFallback | null;
  activeWorkflows: TimelineWorkflowWorkRow[];
  activeBackgroundCommands: TimelineWorkflowWorkRow[];
  parentThreadSection: ThreadPromptParentThreadSection | null;
  childPendingInteractions: readonly ChildThreadPendingAttention[];
  childThreadsSection: ThreadPromptChildThreadsSection | null;
  pullRequest: ThreadPullRequest | null;
  sendMessage: SendMessageMutationLike;
  sentMessageEdit?: ThreadDetailSentMessageEdit;
  steerActiveThreadOnEnter: boolean;
  composerFocusRequestNonce: number;
  thread: ThreadWithRuntime;
}

interface InlineDraftComposerOptions {
  attachments: FollowUpPromptBoxProps["attachments"];
  canModifierSubmit: boolean;
  compactPromptPlaceholder: string;
  composerId: string;
  draft: PromptDraftState;
  editFocusNonce: number;
  execution: FollowUpPromptBoxProps["execution"];
  focusSessionKey: string | number;
  historyResetKey: string;
  isSubmitting: boolean;
  onChangeMessage: FollowUpComposerProps["onChangeMessage"];
  onEscape?: FollowUpComposerProps["onEscape"];
  onSelectHistoryEntry: (draft: PromptDraftState) => void;
  permission: FollowUpPromptBoxProps["permission"];
  pluginComposerHost: PluginComposerHost;
  promptActions: FollowUpPromptBoxProps["promptActions"];
  promptPlaceholder: string;
  submit: () => void;
  submitMode: FollowUpSubmitMode;
  submitTitle?: string;
  suppressPluginComposerCustomizations?: boolean;
  textEffects: FollowUpPromptBoxProps["textEffects"];
  threadRuntimeDisplayStatus: FollowUpComposerProps["threadRuntimeDisplayStatus"];
  typeahead: FollowUpPromptBoxProps["typeahead"];
  collapseResetKey: string;
}

function buildInlineDraftComposer(options: InlineDraftComposerOptions) {
  return (
    <FollowUpPromptBox
      id={options.composerId}
      attachments={options.attachments}
      stack={null}
      composer={{
        history: {
          currentDraft: options.draft,
          entries: [],
          onSelectEntry: options.onSelectHistoryEntry,
          resetKey: options.historyResetKey,
        },
        isFollowUpSubmitting: options.isSubmitting,
        message: options.draft.text,
        mentionRanges: options.draft.mentions,
        onChangeMessage: options.onChangeMessage,
        onModifierSubmit: options.submit,
        onSubmit: options.submit,
        onEscape: options.onEscape,
        submitTitle: options.submitTitle,
        compactPromptPlaceholder: options.compactPromptPlaceholder,
        promptPlaceholder: options.promptPlaceholder,
        canModifierSubmit: options.canModifierSubmit,
        steerActiveThreadOnEnter: false,
        submitMode: options.submitMode,
        threadRuntimeDisplayStatus: options.threadRuntimeDisplayStatus,
      }}
      pluginComposerHost={options.pluginComposerHost}
      pluginComposerScope={options.pluginComposerHost.scope}
      suppressPluginComposerCustomizations={
        options.suppressPluginComposerCustomizations
      }
      textEffects={options.textEffects}
      environmentSummary={null}
      contextWindowUsage={null}
      execution={options.execution}
      executionReadOnly
      permission={options.permission}
      permissionReadOnly
      typeahead={options.typeahead}
      promptActions={options.promptActions}
      collapseResetKey={options.collapseResetKey}
      focusEndKey={`${options.focusSessionKey}:${options.editFocusNonce}`}
      isPrimaryComposer={false}
      showScrollToBottomButton={false}
    />
  );
}

type InlineQueuedMessageEditSession = Pick<
  InlineQueuedMessageEditState,
  "editSessionId" | "queuedMessageId"
>;

function isInlineQueuedMessageEditSession(
  current: InlineQueuedMessageEditState | null,
  session: InlineQueuedMessageEditSession,
): current is InlineQueuedMessageEditState {
  return (
    current?.editSessionId === session.editSessionId &&
    current.queuedMessageId === session.queuedMessageId
  );
}

const ENDED_EDIT_SESSION_DRAFT = emptyPromptDraftState();

function readInlineQueuedMessageDraft(
  editStateRef: RefObject<InlineQueuedMessageEditState | null>,
  session: InlineQueuedMessageEditSession,
  fallback: PromptDraftState,
): PromptDraftState {
  const current = editStateRef.current;
  return isInlineQueuedMessageEditSession(current, session)
    ? current.draft
    : fallback;
}

function writeInlineQueuedMessageDraft(
  editStateRef: RefObject<InlineQueuedMessageEditState | null>,
  session: InlineQueuedMessageEditSession,
  draft: PromptDraftState,
  commit: (next: InlineQueuedMessageEditState) => void,
): void {
  const current = editStateRef.current;
  if (isInlineQueuedMessageEditSession(current, session)) {
    commit({ ...current, draft });
  }
}

function readSentMessageEditDraft(
  sentMessageEditRef: RefObject<ThreadDetailSentMessageEdit | undefined>,
  operationId: string,
  fallback: PromptDraftState,
): PromptDraftState {
  const current = sentMessageEditRef.current;
  return current?.operationId === operationId ? current.draft : fallback;
}

function writeSentMessageEditDraft(
  sentMessageEditRef: RefObject<ThreadDetailSentMessageEdit | undefined>,
  operationId: string,
  nextDraft: PromptDraftState,
): void {
  const current = sentMessageEditRef.current;
  if (current?.operationId === operationId) {
    current.updateDraft(() => nextDraft);
  }
}

async function runWhileFollowUpShortcutSending(
  setSending: (sending: boolean) => void,
  task: () => Promise<void>,
): Promise<void> {
  setSending(true);
  try {
    await task();
  } finally {
    setSending(false);
  }
}

export function ThreadDetailPromptArea({
  activeBackgroundAgentCount,
  canUseGitUi,
  contextWindowUsage,
  environmentCheckout,
  environmentCompactLabel,
  environmentGoneStatus,
  environmentHostId,
  environmentIcon,
  environmentLabel,
  environmentTypeLabel,
  onCreateNewThreadInWorktree,
  onPullRequestDraft,
  onPullRequestMerge,
  onPullRequestReady,
  pullRequestMergeMethod,
  isEnvironmentActionPending,
  pendingInteractions,
  pendingInteractionsInitialLoading,
  queuedMessageCount,
  onChangedFileClick,
  projectId,
  resolveMentionLink,
  workspaceChangedFilesSection,
  workspaceStatusPending,
  contextBannerMergeBase,
  pendingTodos,
  activePromptMode,
  goal,
  modelFallback,
  activeWorkflows,
  activeBackgroundCommands,
  parentThreadSection,
  childPendingInteractions,
  childThreadsSection,
  pullRequest,
  sendMessage,
  sentMessageEdit,
  steerActiveThreadOnEnter,
  composerFocusRequestNonce,
  thread,
}: ThreadDetailPromptAreaProps) {
  const navigate = useNavigate();
  const defaultExecutionOptionsQuery = useThreadDefaultExecutionOptions(
    thread.id,
    {
      enabled: true,
    },
  );
  const defaultExecutionOptions = defaultExecutionOptionsQuery.data;
  const verifiedDefaultExecutionOptions =
    defaultExecutionOptionsQuery.isPlaceholderData
      ? undefined
      : defaultExecutionOptions;
  const hasResolvedDefaultExecutionOptions =
    verifiedDefaultExecutionOptions !== undefined;
  const hasConcreteDefaultExecutionOptions =
    verifiedDefaultExecutionOptions !== undefined &&
    verifiedDefaultExecutionOptions !== null;
  const defaultExecutionOptionsState = resolveDefaultExecutionOptionsState({
    hasConcreteDefaultExecutionOptions,
    hasResolvedDefaultExecutionOptions,
    isError: defaultExecutionOptionsQuery.isError,
  });
  const isDefaultExecutionOptionsLoading =
    defaultExecutionOptionsState === "loading";
  const queuedMessagesQuery = useThreadQueuedMessages(thread.id, {
    enabled: true,
  });
  const queuedMessages = queuedMessagesQuery.data ?? EMPTY_QUEUED_MESSAGES;
  const queuedMessagesPending =
    queuedMessagesQuery.data === undefined && queuedMessageCount > 0;
  const queuedMessagesRef =
    useLatestRef<readonly ThreadQueuedMessage[]>(queuedMessages);
  const [bottomPluginFocusNonce, setBottomPluginFocusNonce] = useState(0);
  const [editFocusNonce, setEditFocusNonce] = useState(0);
  const focusBottomPluginComposer = useCallback(() => {
    setBottomPluginFocusNonce((nonce) => nonce + 1);
  }, []);
  const focusInlinePluginComposer = useCallback(() => {
    setEditFocusNonce((nonce) => nonce + 1);
  }, []);
  const sentMessageEditRef = useLatestRef(sentMessageEdit);
  const clearInlineAttachmentErrorRef = useRef<() => void>(() => {});
  const {
    inlineEditingQueuedMessage,
    inlineEditingQueuedMessageRef,
    commitInlineQueuedMessage,
    dismissInlineQueuedMessageEditor,
    beginEditQueuedMessage,
    queuedMessageDraftSession,
  } = useInlineQueuedMessageEditing({
    ownerThreadId: thread.id,
    queuedMessages,
    onBeginEdit: () => {
      clearInlineAttachmentErrorRef.current();
      setEditFocusNonce((nonce) => nonce + 1);
    },
  });
  const inlineDraftSession = queuedMessageDraftSession;
  const inlineDraftSessionRef = useLatestRef(inlineDraftSession);
  const promptHistoryEnabled = usePromptHistoryEnabled();
  const { data: promptHistoryEntries = [] } = useThreadPromptHistory(
    thread.id,
    {
      enabled: promptHistoryEnabled,
    },
  );
  const createQueuedMessage = useCreateThreadQueuedMessage();
  const stopThread = useStopThread();
  const cancelThreadPlan = useCancelThreadPlan();
  const clearThreadGoal = useClearThreadGoal();
  const unarchiveThread = useUnarchiveThread();
  const projectName = useProjectDisplayName(
    thread.projectId === PERSONAL_PROJECT_ID ? undefined : thread.projectId,
  );
  const {
    promptDraft,
    currentPromptDraft,
    currentPromptDraftInput,
    activeComposerDraft,
    activeComposerDraftInput,
    setActiveComposerDraft,
    handleChangeMessage: handleComposerMessageChange,
    removeActiveComposerAttachment,
  } = useActiveComposerDraft({
    draftScope: {
      kind: "thread",
      projectId,
      threadId: thread.id,
    },
    inlineDraft: inlineEditingQueuedMessage?.draft ?? null,
    inlineSessionRef: inlineDraftSessionRef,
  });
  const subscribeInlineQueuedDraft = useComposerHostDraftNotifier(
    inlineEditingQueuedMessage?.draft ?? null,
  );
  const subscribeSentMessageEditDraft = useComposerHostDraftNotifier(
    sentMessageEdit?.draft ?? null,
  );
  const updateSentMessageEditDraft = sentMessageEdit?.updateDraft;
  const addSentMessageEditAttachment = useCallback(
    (attachment: PromptDraftAttachment) => {
      updateSentMessageEditDraft?.((current) =>
        current.attachments.some(
          (existing) => existing.path === attachment.path,
        )
          ? current
          : {
              ...current,
              attachments: [...current.attachments, attachment],
            },
      );
    },
    [updateSentMessageEditDraft],
  );
  const {
    bottomAttachmentError,
    setBottomAttachmentError,
    handleAttachBottomFiles,
    isAttachingBottomFiles,
    inlineAttachmentError,
    setInlineAttachmentError,
    handleAttachInlineFiles,
    isAttachingInlineFiles,
  } = useComposerAttachmentUploads({
    projectId,
    addDraftAttachment: promptDraft.addAttachment,
    inlineEditSessionId: inlineDraftSession?.editSessionId ?? null,
    inlineSessionRef: inlineDraftSessionRef,
  });
  const {
    attachmentError: sentMessageAttachmentError,
    handleAttachFiles: handleAttachSentMessageFiles,
    isAttachingFiles: isAttachingSentMessageFiles,
  } = useDraftAttachmentUploads({
    projectId,
    target: sentMessageEdit
      ? {
          key: sentMessageEdit.operationId,
          addAttachment: addSentMessageEditAttachment,
        }
      : null,
  });
  useLayoutEffect(() => {
    clearInlineAttachmentErrorRef.current = () =>
      setInlineAttachmentError(null);
  }, [setInlineAttachmentError]);
  const promptTextEffects = useComposerTextEffects(promptDraft.storageKey);
  const queuedComposerTextEffects = useComposerTextEffects(
    inlineEditingQueuedMessage
      ? `queued-message:${thread.id}:${inlineEditingQueuedMessage.queuedMessageId}:${inlineEditingQueuedMessage.editSessionId}`
      : null,
  );
  const sentMessageComposerTextEffects = useComposerTextEffects(
    sentMessageEdit
      ? `sent-message:${thread.id}:${sentMessageEdit.operationId}`
      : null,
  );
  const [expandedBannerSection, setExpandedBannerSection] =
    useState<ThreadPromptContextBannerExpandedSection | null>(null);
  const pullRequestSection =
    useMemo<ThreadPromptPullRequestSection | null>(() => {
      if (!pullRequest) {
        return null;
      }
      const actions =
        onPullRequestReady ||
        onPullRequestMerge ||
        onPullRequestDraft ||
        isEnvironmentActionPending
          ? {
              isPending: isEnvironmentActionPending,
              ...(onPullRequestReady
                ? { onMarkReady: onPullRequestReady }
                : {}),
              ...(onPullRequestMerge ? { onMerge: onPullRequestMerge } : {}),
              ...(onPullRequestDraft
                ? { onConvertToDraft: onPullRequestDraft }
                : {}),
              ...(onPullRequestMerge
                ? { selectedMergeMethod: pullRequestMergeMethod }
                : {}),
            }
          : undefined;
      return actions ? { pullRequest, actions } : { pullRequest };
    }, [
      isEnvironmentActionPending,
      onPullRequestDraft,
      onPullRequestMerge,
      onPullRequestReady,
      pullRequest,
      pullRequestMergeMethod,
    ]);
  const [isGoalExpanded, setIsGoalExpanded] = useState(false);
  const [isTodoExpanded, setIsTodoExpanded] = useState(false);
  const [isPromptModeExpanded, setIsPromptModeExpanded] = useState(false);
  const [expandedWorkflowIds, setExpandedWorkflowIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const toggleWorkflowExpanded = useCallback((workflowId: string) => {
    setExpandedWorkflowIds((current) => {
      const next = new Set(current);
      if (!next.delete(workflowId)) {
        next.add(workflowId);
      }
      return next;
    });
  }, []);
  const [isBackgroundCommandsExpanded, setIsBackgroundCommandsExpanded] =
    useState(false);
  const [isFollowUpShortcutSending, setIsFollowUpShortcutSending] =
    useState(false);
  const promptHistoryDrafts = useMemo(
    () => promptHistoryEntriesToDrafts(promptHistoryEntries),
    [promptHistoryEntries],
  );
  const {
    executionOptionsRouting,
    selectedProviderId,
    providerOptions,
    hasMultipleProviders,
    selectedProviderComposerActions,
    selectedModel,
    setSelectedModel,
    serviceTier,
    setServiceTier,
    reasoningLevel,
    setReasoningLevel,
    permissionMode,
    setPermissionMode,
    activeModel,
    modelOptions,
    moreModelOptions,
    isLoadingModels,
    modelLoadFailed,
    modelLoadError,
    reasoningOptions,
    permissionModeOptions,
    supportsPermissionModeSelection,
    supportsServiceTier,
    serviceTierSupportByProvider,
    serviceTierFastLabel,
    executionInputSources,
  } = useThreadCreationOptions({
    enabled: thread.archivedAt === null,
    environmentId: thread.environmentId ?? undefined,
    environmentHostId,
    scope: "component-local",
    resetKey: thread.id,
    initialProviderId: thread.providerId,
    initialModel:
      modelFallback?.fallbackModel ?? defaultExecutionOptions?.model,
    initialServiceTier: defaultExecutionOptions?.serviceTier,
    initialReasoningLevel: defaultExecutionOptions?.reasoningLevel,
    initialPermissionMode: defaultExecutionOptions?.permissionMode,
    initialEnvironmentSelectionValue: thread.environmentId ?? undefined,
  });
  const fallbackIdentity = modelFallback
    ? `${thread.id}:${modelFallback.sourceSeq}`
    : null;
  const [overriddenFallbackIdentity, setOverriddenFallbackIdentity] = useState<
    string | null
  >(null);
  const isFallbackModelActive =
    modelFallback !== null && overriddenFallbackIdentity !== fallbackIdentity;
  const effectiveSelectedModel = isFallbackModelActive
    ? modelFallback.fallbackModel
    : (activeModel?.model ?? selectedModel);
  const handleModelChange = useCallback(
    (model: string) => {
      if (fallbackIdentity !== null) {
        setOverriddenFallbackIdentity(fallbackIdentity);
      }
      setSelectedModel(model);
    },
    [fallbackIdentity, setSelectedModel],
  );
  const { typeaheadConfig, promptActions } = useComposerTypeahead({
    projectId: thread.projectId,
    mentionsProjectId: projectId,
    providerId: thread.providerId,
    environmentId: thread.environmentId,
    currentThreadId: thread.id,
    selectedProviderComposerActions,
    resolveMentionLink,
  });
  const runtimeDisplayStatus = thread.runtime.displayStatus;
  const shouldSteerWhenReady =
    runtimeDisplayStatus === "provisioning" ||
    runtimeDisplayStatus === "starting";
  const isStopRequested =
    thread.status === "stopping" ||
    (stopThread.isPending && stopThread.variables === thread.id);
  const activePendingInteraction =
    getLatestPendingInteraction(pendingInteractions);
  const hasPendingInteraction = activePendingInteraction !== null;
  const shouldHideComposer =
    environmentGoneStatus !== null || thread.archivedAt !== null;
  const {
    processingQueuedMessage: displayedProcessingQueuedMessage,
    queuedMessageActionPending,
    isUpdateQueuedMessagePending,
    sendQueuedMessageById,
    handleSaveInlineQueuedMessage,
    handleDeleteQueuedMessage,
    handleReorderQueuedMessage,
    handleSetQueuedMessageGroupBoundary,
  } = useQueuedMessageActions({
    threadId: thread.id,
    queuedMessages,
    sendProcessingPersistence: "until-left-queue",
    onSendSuccess: () => setInlineAttachmentError(null),
    onSaveSuccess: () => setInlineAttachmentError(null),
    inlineEditingQueuedMessage,
    dismissInlineQueuedMessageEditor,
    activeComposerDraftInput,
  });
  const isQueueMutationPending =
    createQueuedMessage.isPending ||
    queuedMessageActionPending ||
    isFollowUpShortcutSending;
  const isFollowUpSubmitting =
    sendMessage.isPending ||
    createQueuedMessage.isPending ||
    isFollowUpShortcutSending;
  const handleStopThread = useCallback(() => {
    stopThread.mutate(thread.id);
  }, [stopThread, thread.id]);
  const handleCancelPlan = useCallback(() => {
    cancelThreadPlan.mutate(thread.id);
  }, [cancelThreadPlan, thread.id]);
  const handleClearGoal = useCallback(() => {
    clearThreadGoal.mutate(thread.id);
  }, [clearThreadGoal, thread.id]);
  const submitMode: FollowUpSubmitMode = useMemo(() => {
    return buildFollowUpSubmitMode({
      hasPendingInteraction,
      isDefaultExecutionOptionsLoading,
      isPendingInteractionsInitialLoading: pendingInteractionsInitialLoading,
      isStopRequested,
      onStop: handleStopThread,
      runtimeDisplayStatus,
    });
  }, [
    handleStopThread,
    hasPendingInteraction,
    isDefaultExecutionOptionsLoading,
    pendingInteractionsInitialLoading,
    isStopRequested,
    runtimeDisplayStatus,
  ]);
  const promptPlaceholder = isStopRequested
    ? "Stopping thread..."
    : getFollowUpPromptPlaceholder(runtimeDisplayStatus);
  const compactPromptPlaceholder = isStopRequested
    ? "Stopping thread..."
    : getCompactFollowUpPromptPlaceholder(runtimeDisplayStatus);
  const submitScheduledRef = useRef<
    (options: { sendAt: number }) => Promise<void>
  >(async () => {});
  const submitScheduledThroughRef = useCallback(
    (options: { sendAt: number }) => submitScheduledRef.current(options),
    [],
  );
  const normalPluginComposerHost = useMemo<PluginComposerHost>(
    () => ({
      scope: { kind: "thread", threadId: thread.id },
      textEffectKey: promptDraft.storageKey,
      getCurrent: promptDraft.getCurrent,
      subscribeDraft: promptDraft.subscribe,
      setDraft: promptDraft.setDraft,
      focus: focusBottomPluginComposer,
      submit: submitScheduledThroughRef,
    }),
    [
      focusBottomPluginComposer,
      promptDraft.getCurrent,
      promptDraft.setDraft,
      promptDraft.storageKey,
      promptDraft.subscribe,
      submitScheduledThroughRef,
      thread.id,
    ],
  );
  const hasPromptDraftInput = currentPromptDraftInput.length > 0;
  const canSubmitModifierShortcut = canSubmitFollowUpShortcut({
    hasPromptDraftInput,
    isFollowUpSubmitting,
    isQueueMutationPending,
    queuedMessageCount: queuedMessages.length,
    runtimeDisplayStatus,
    submitModeKind: submitMode.kind,
  });
  const followUpExecutionSelection = useMemo<FollowUpExecutionSelection>(() => {
    if (!hasConcreteDefaultExecutionOptions) {
      return null;
    }
    return {
      model: effectiveSelectedModel,
      supportsServiceTier,
      serviceTier,
      reasoningLevel,
      permissionMode,
      executionInputSources,
    };
  }, [
    effectiveSelectedModel,
    executionInputSources,
    hasConcreteDefaultExecutionOptions,
    permissionMode,
    reasoningLevel,
    serviceTier,
    supportsServiceTier,
  ]);

  const handleSend = useCallback(async () => {
    const submittedDraft = currentPromptDraft;
    const submittedInput = currentPromptDraftInput;
    const isQueuingMessage = shouldQueueFollowUpMessage(runtimeDisplayStatus);
    if (
      submittedInput.length === 0 ||
      (!isQueuingMessage && isDefaultExecutionOptionsLoading)
    ) {
      return;
    }

    promptDraft.clearIfCurrentMatches(submittedDraft);
    setBottomAttachmentError(null);

    try {
      if (isQueuingMessage) {
        const request = buildCreateQueuedFollowUpRequest({
          threadId: thread.id,
          input: submittedInput,
          execution: followUpExecutionSelection,
        });
        if (request) {
          await createQueuedMessage.mutateAsync(request);
        }
      } else {
        const request = buildAutoFollowUpRequest({
          threadId: thread.id,
          input: submittedInput,
          execution: followUpExecutionSelection,
        });
        if (request) {
          await sendMessage.mutateAsync(request);
        }
      }
    } catch (nextError) {
      promptDraft.restoreIfEmpty(submittedDraft);
      appToast.error(
        getMutationErrorMessage({
          error: nextError,
          fallbackMessage: isQueuingMessage
            ? "Failed to queue message"
            : "Failed to send message",
          lifecycleOperation: isQueuingMessage
            ? "queue_message"
            : "send_message",
        }),
      );
    }
  }, [
    createQueuedMessage,
    currentPromptDraft,
    currentPromptDraftInput,
    followUpExecutionSelection,
    isDefaultExecutionOptionsLoading,
    promptDraft,
    sendMessage,
    setBottomAttachmentError,
    thread.id,
    runtimeDisplayStatus,
  ]);
  const submitScheduled = useCallback(
    async ({ sendAt }: { sendAt: number }) => {
      if (isDefaultExecutionOptionsLoading) {
        throw new Error("This thread's model options are still loading.");
      }
      const submittedDraft = promptDraft.getCurrent();
      const request = buildAutoFollowUpRequest({
        threadId: thread.id,
        input: promptDraftToInput(submittedDraft),
        execution: followUpExecutionSelection,
      });
      if (request === null) {
        throw new Error("Type a message before scheduling it.");
      }
      const clearedSubmittedDraft =
        promptDraft.clearIfCurrentMatches(submittedDraft);
      setBottomAttachmentError(null);
      try {
        await sendMessage.mutateAsync({ ...request, sendAt });
      } catch (scheduleError) {
        if (clearedSubmittedDraft) {
          promptDraft.restoreIfEmpty(submittedDraft);
        }
        throw new Error(
          getMutationErrorMessage({
            error: scheduleError,
            fallbackMessage: "Failed to schedule message",
            lifecycleOperation: "send_message",
          }),
        );
      }
    },
    [
      followUpExecutionSelection,
      isDefaultExecutionOptionsLoading,
      promptDraft,
      sendMessage,
      setBottomAttachmentError,
      thread.id,
    ],
  );
  useEffect(() => {
    submitScheduledRef.current = submitScheduled;
  }, [submitScheduled]);

  const handleModifierSubmit = useCallback(async () => {
    if (!canSubmitModifierShortcut) {
      return;
    }

    const submittedDraft = currentPromptDraft;
    const submittedInput = currentPromptDraftInput;
    const shortcutRequest = buildFollowUpShortcutRequest({
      execution: followUpExecutionSelection,
      input: submittedInput,
      queuedMessages: queuedMessagesRef.current,
      threadId: thread.id,
    });
    if (!shortcutRequest) {
      return;
    }

    if (shortcutRequest.kind === "draft") {
      promptDraft.clearIfCurrentMatches(submittedDraft);
      setBottomAttachmentError(null);
      await runWhileFollowUpShortcutSending(
        setIsFollowUpShortcutSending,
        async () => {
          try {
            await sendMessage.mutateAsync(shortcutRequest.request);
          } catch (nextError) {
            promptDraft.restoreIfEmpty(submittedDraft);
            appToast.error(
              getMutationErrorMessage({
                error: nextError,
                fallbackMessage: "Failed to send message",
                lifecycleOperation: "send_message",
              }),
            );
          }
        },
      );
      return;
    }

    const queuedMessageId = shortcutRequest.request.queuedMessageId;
    if (queuedMessagesRef.current[0]?.id !== queuedMessageId) {
      return;
    }

    await runWhileFollowUpShortcutSending(
      setIsFollowUpShortcutSending,
      async () => {
        await sendQueuedMessageById({
          guard: "current-head",
          messageId: queuedMessageId,
          mode: shortcutRequest.request.mode,
        });
      },
    );
  }, [
    canSubmitModifierShortcut,
    currentPromptDraft,
    currentPromptDraftInput,
    followUpExecutionSelection,
    promptDraft,
    queuedMessagesRef,
    sendMessage,
    sendQueuedMessageById,
    setBottomAttachmentError,
    thread.id,
  ]);

  const handleSendQueuedMessage = useCallback(
    (messageId: string) => {
      void sendQueuedMessageById({
        guard: "exists",
        messageId,
        mode: shouldSteerWhenReady ? "steer" : "auto",
      });
    },
    [sendQueuedMessageById, shouldSteerWhenReady],
  );

  const bottomFocusEndKey = `${composerFocusRequestNonce}:${bottomPluginFocusNonce}`;

  const handleToggleBannerSection = useCallback(
    (section: ThreadPromptContextBannerExpandedSection | null) => {
      setExpandedBannerSection((previous) =>
        previous === section ? null : section,
      );
    },
    [],
  );
  const isUnarchiveCurrentThreadPending =
    unarchiveThread.isPending && unarchiveThread.variables?.id === thread.id;
  const handleUnarchiveCurrentThread = useCallback(() => {
    unarchiveThread.mutate({ id: thread.id });
  }, [thread.id, unarchiveThread]);
  const sourceThreadDisplayTitle = getThreadDisplayTitle({
    id: thread.id,
    title: thread.title,
    titleFallback: thread.titleFallback,
  });
  const handleHandoffToNewThread = useCallback(() => {
    navigate(getProjectComposeRoutePath(thread.projectId), {
      state: buildThreadHandoffLocationState({
        environmentId: thread.environmentId,
        projectId: thread.projectId,
        sourceThreadId: thread.id,
        sourceThreadTitle: sourceThreadDisplayTitle,
      }),
    });
  }, [
    navigate,
    sourceThreadDisplayTitle,
    thread.environmentId,
    thread.id,
    thread.projectId,
  ]);

  const bottomAttachmentsConfig = useMemo(
    () => ({
      items: currentPromptDraft.attachments,
      projectId,
      isAttaching: isAttachingBottomFiles,
      error: bottomAttachmentError,
      onAttachFiles: handleAttachBottomFiles,
      onRemove: promptDraft.removeAttachment,
    }),
    [
      bottomAttachmentError,
      currentPromptDraft.attachments,
      handleAttachBottomFiles,
      isAttachingBottomFiles,
      projectId,
      promptDraft.removeAttachment,
    ],
  );
  const handleBottomComposerSubmit = useCallback(() => {
    void handleSend();
  }, [handleSend]);
  const handleBottomComposerModifierSubmit = useCallback(() => {
    void handleModifierSubmit();
  }, [handleModifierSubmit]);
  const handleInlineComposerSubmit = useCallback(() => {
    void handleSaveInlineQueuedMessage();
  }, [handleSaveInlineQueuedMessage]);

  const bottomComposerConfig = useMemo<FollowUpComposerProps>(
    () => ({
      history: {
        currentDraft: currentPromptDraft,
        entries: promptHistoryDrafts,
        onSelectEntry: promptDraft.setDraft,
        resetKey: thread.id,
      },
      isFollowUpSubmitting,
      message: currentPromptDraft.text,
      mentionRanges: currentPromptDraft.mentions,
      onChangeMessage: promptDraft.setTextAndMentions,
      onModifierSubmit: handleBottomComposerModifierSubmit,
      onSubmit: handleBottomComposerSubmit,
      compactPromptPlaceholder,
      promptPlaceholder,
      canModifierSubmit: canSubmitModifierShortcut,
      steerActiveThreadOnEnter,
      submitMode,
      threadRuntimeDisplayStatus: runtimeDisplayStatus,
    }),
    [
      canSubmitModifierShortcut,
      compactPromptPlaceholder,
      currentPromptDraft,
      handleBottomComposerModifierSubmit,
      handleBottomComposerSubmit,
      isFollowUpSubmitting,
      promptHistoryDrafts,
      promptPlaceholder,
      promptDraft.setDraft,
      promptDraft.setTextAndMentions,
      runtimeDisplayStatus,
      steerActiveThreadOnEnter,
      submitMode,
      thread.id,
    ],
  );
  const sentMessageEditInput = useMemo(
    () => (sentMessageEdit ? promptDraftToInput(sentMessageEdit.draft) : []),
    [sentMessageEdit],
  );
  const canSubmitSentMessageEdit =
    sentMessageEdit !== undefined &&
    sentMessageEditInput.length > 0 &&
    submitMode.kind === "ready" &&
    !shouldHideComposer &&
    !isDefaultExecutionOptionsLoading &&
    !isAttachingSentMessageFiles &&
    !isFollowUpSubmitting &&
    !isQueueMutationPending &&
    !sentMessageEdit.isSubmitting &&
    queuedMessages.length === 0 &&
    activeBackgroundAgentCount === 0 &&
    activeWorkflows.length === 0 &&
    activeBackgroundCommands.length === 0;
  const sentMessageEditSubmitMode = useMemo<FollowUpSubmitMode>(
    () =>
      canSubmitSentMessageEdit || sentMessageEditInput.length === 0
        ? { kind: "ready" }
        : submitMode.kind === "blocked"
          ? submitMode
          : { kind: "blocked", reason: "unavailable" },
    [canSubmitSentMessageEdit, sentMessageEditInput.length, submitMode],
  );
  const handleSentMessageEditSubmit = useCallback(() => {
    if (!sentMessageEdit || !canSubmitSentMessageEdit) {
      return;
    }
    sentMessageEdit.onSubmit({
      execution: followUpExecutionSelection,
      input: sentMessageEditInput,
    });
  }, [
    canSubmitSentMessageEdit,
    followUpExecutionSelection,
    sentMessageEdit,
    sentMessageEditInput,
  ]);
  const bottomExecutionConfig = useMemo(
    () => ({
      providerRouting: executionOptionsRouting,
      provider: {
        options: providerOptions,
        selectedId: selectedProviderId,
        hasMultiple: hasMultipleProviders,
      },
      model: {
        active: effectiveSelectedModel
          ? { model: effectiveSelectedModel }
          : null,
        selected: selectedModel,
        options: modelOptions,
        moreOptions: moreModelOptions,
        isLoading: isLoadingModels,
        loadFailed: modelLoadFailed,
        loadError: modelLoadError,
        onChange: handleModelChange,
      },
      serviceTier: {
        value: serviceTier,
        onChange: setServiceTier,
        supported: supportsServiceTier,
        supportByProvider: serviceTierSupportByProvider,
        fastLabel: serviceTierFastLabel,
      },
      reasoning: {
        value: reasoningLevel,
        options: reasoningOptions,
        onChange: setReasoningLevel,
      },
      footerAction: {
        label: "Handoff to new thread",
        onClick: handleHandoffToNewThread,
      },
    }),
    [
      effectiveSelectedModel,
      executionOptionsRouting,
      hasMultipleProviders,
      handleHandoffToNewThread,
      handleModelChange,
      isLoadingModels,
      modelLoadFailed,
      modelLoadError,
      modelOptions,
      moreModelOptions,
      providerOptions,
      reasoningLevel,
      reasoningOptions,
      selectedModel,
      selectedProviderId,
      serviceTier,
      serviceTierSupportByProvider,
      setReasoningLevel,
      setServiceTier,
      supportsServiceTier,
      serviceTierFastLabel,
    ],
  );
  const compactExecutionConfig = useMemo(() => {
    const { footerAction: _footerAction, ...executionWithoutFooterAction } =
      bottomExecutionConfig;
    return executionWithoutFooterAction;
  }, [bottomExecutionConfig]);
  const inlineExecutionConfig = useMemo(() => {
    if (!inlineEditingQueuedMessage) return null;
    return {
      ...compactExecutionConfig,
      model: {
        ...compactExecutionConfig.model,
        active: { model: inlineEditingQueuedMessage.model },
        selected: inlineEditingQueuedMessage.model,
      },
      serviceTier: {
        ...compactExecutionConfig.serviceTier,
        value: inlineEditingQueuedMessage.serviceTier,
      },
      reasoning: {
        ...compactExecutionConfig.reasoning,
        value: inlineEditingQueuedMessage.reasoningLevel,
      },
    };
  }, [compactExecutionConfig, inlineEditingQueuedMessage]);

  const bottomPermissionConfig = useMemo(
    () => ({
      value: hasConcreteDefaultExecutionOptions ? permissionMode : undefined,
      options: hasConcreteDefaultExecutionOptions ? permissionModeOptions : [],
      onChange: setPermissionMode,
      supported:
        hasConcreteDefaultExecutionOptions && supportsPermissionModeSelection,
    }),
    [
      hasConcreteDefaultExecutionOptions,
      permissionMode,
      permissionModeOptions,
      setPermissionMode,
      supportsPermissionModeSelection,
    ],
  );
  const inlinePermissionConfig = useMemo(
    () =>
      inlineEditingQueuedMessage
        ? {
            ...bottomPermissionConfig,
            value: inlineEditingQueuedMessage.permissionMode,
          }
        : null,
    [bottomPermissionConfig, inlineEditingQueuedMessage],
  );

  const environmentSummary = useMemo(
    () =>
      environmentLabel ? (
        <ThreadEnvironmentSummary
          projectName={projectName}
          environmentLabel={environmentLabel}
          environmentCompactLabel={environmentCompactLabel}
          environmentIcon={environmentIcon}
          environmentTypeLabel={environmentTypeLabel}
          environmentCheckout={environmentCheckout}
          onCreateNewThreadInWorktree={onCreateNewThreadInWorktree}
        />
      ) : null,
    [
      environmentCheckout,
      environmentCompactLabel,
      environmentIcon,
      environmentLabel,
      environmentTypeLabel,
      onCreateNewThreadInWorktree,
      projectName,
    ],
  );
  const activePromptModeCard = useMemo(
    () => (
      <ThreadPromptModeCard
        activePromptMode={activePromptMode}
        isExitPending={cancelThreadPlan.isPending}
        isExpanded={isPromptModeExpanded}
        onExitPlanMode={handleCancelPlan}
        onToggle={() => setIsPromptModeExpanded((value) => !value)}
      />
    ),
    [
      activePromptMode,
      cancelThreadPlan.isPending,
      handleCancelPlan,
      isPromptModeExpanded,
    ],
  );
  const activeGoalCard = useMemo(
    () => (
      <ThreadGoalCard
        goal={goal}
        isClearPending={clearThreadGoal.isPending}
        isExpanded={isGoalExpanded}
        onClearGoal={handleClearGoal}
        onToggle={() => setIsGoalExpanded((value) => !value)}
      />
    ),
    [clearThreadGoal.isPending, goal, handleClearGoal, isGoalExpanded],
  );
  const inlineEditSessionId = inlineEditingQueuedMessage?.editSessionId ?? null;
  const inlineEditQueuedMessageId =
    inlineEditingQueuedMessage?.queuedMessageId ?? null;
  const queuedMessagePluginComposerHost =
    useMemo<PluginComposerHost | null>(() => {
      if (inlineEditSessionId === null || inlineEditQueuedMessageId === null) {
        return null;
      }
      const session = {
        editSessionId: inlineEditSessionId,
        queuedMessageId: inlineEditQueuedMessageId,
      };
      return {
        scope: {
          kind: "queued-message",
          threadId: thread.id,
          queuedMessageId: inlineEditQueuedMessageId,
        },
        textEffectKey: `queued-message:${thread.id}:${inlineEditQueuedMessageId}:${inlineEditSessionId}`,
        getCurrent: () =>
          readInlineQueuedMessageDraft(
            inlineEditingQueuedMessageRef,
            session,
            ENDED_EDIT_SESSION_DRAFT,
          ),
        subscribeDraft: subscribeInlineQueuedDraft,
        setDraft: (draft) =>
          writeInlineQueuedMessageDraft(
            inlineEditingQueuedMessageRef,
            session,
            draft,
            commitInlineQueuedMessage,
          ),
        focus: focusInlinePluginComposer,
      };
    }, [
      commitInlineQueuedMessage,
      focusInlinePluginComposer,
      inlineEditQueuedMessageId,
      inlineEditSessionId,
      inlineEditingQueuedMessageRef,
      subscribeInlineQueuedDraft,
      thread.id,
    ]);
  const queuedMessageEditor = useMemo(() => {
    if (
      !inlineEditingQueuedMessage ||
      !inlineExecutionConfig ||
      !inlinePermissionConfig ||
      !queuedMessagePluginComposerHost
    ) {
      return null;
    }
    const { editSessionId, queuedMessageId } = inlineEditingQueuedMessage;
    const inlineEditor: QueuedMessageInlineEditor = {
      queuedMessageId,
      queuedMessageIndex: inlineEditingQueuedMessage.queuedMessageIndex,
      onDismiss: dismissInlineQueuedMessageEditor,
      content: buildInlineDraftComposer({
        attachments: {
          items: activeComposerDraft.attachments,
          projectId,
          isAttaching: isAttachingInlineFiles,
          error: inlineAttachmentError,
          onAttachFiles: handleAttachInlineFiles,
          onRemove: removeActiveComposerAttachment,
        },
        canModifierSubmit:
          activeComposerDraftInput.length > 0 && !isUpdateQueuedMessagePending,
        compactPromptPlaceholder,
        composerId: `${THREAD_DETAIL_COMPOSER_TEXTAREA_ID}-queued-${queuedMessageId}`,
        draft: activeComposerDraft,
        editFocusNonce,
        execution: inlineExecutionConfig,
        focusSessionKey: editSessionId,
        historyResetKey: `${thread.id}:${editSessionId}`,
        isSubmitting: isUpdateQueuedMessagePending,
        onChangeMessage: handleComposerMessageChange,
        onSelectHistoryEntry: setActiveComposerDraft,
        permission: inlinePermissionConfig,
        pluginComposerHost: queuedMessagePluginComposerHost,
        promptActions,
        promptPlaceholder,
        submit: handleInlineComposerSubmit,
        submitMode: { kind: "ready" },
        textEffects: queuedComposerTextEffects,
        threadRuntimeDisplayStatus: runtimeDisplayStatus,
        typeahead: typeaheadConfig,
        collapseResetKey: `queued-message:${queuedMessageId}`,
      }),
    };
    return inlineEditor;
  }, [
    activeComposerDraft,
    activeComposerDraftInput.length,
    compactPromptPlaceholder,
    dismissInlineQueuedMessageEditor,
    editFocusNonce,
    handleAttachInlineFiles,
    handleComposerMessageChange,
    handleInlineComposerSubmit,
    inlineAttachmentError,
    inlineEditingQueuedMessage,
    inlineExecutionConfig,
    inlinePermissionConfig,
    isAttachingInlineFiles,
    isUpdateQueuedMessagePending,
    projectId,
    promptActions,
    promptPlaceholder,
    queuedComposerTextEffects,
    queuedMessagePluginComposerHost,
    removeActiveComposerAttachment,
    runtimeDisplayStatus,
    setActiveComposerDraft,
    thread.id,
    typeaheadConfig,
  ]);
  usePublishPluginComposerHost(
    queuedMessageEditor
      ? queuedMessagePluginComposerHost
      : normalPluginComposerHost,
  );
  const sentMessageEditOperationId = sentMessageEdit?.operationId ?? null;
  const sentMessagePluginComposerHost =
    useMemo<PluginComposerHost | null>(() => {
      if (sentMessageEditOperationId === null) {
        return null;
      }
      const operationId = sentMessageEditOperationId;
      return {
        scope: { kind: "thread", threadId: thread.id },
        textEffectKey: `sent-message:${thread.id}:${operationId}`,
        getCurrent: () =>
          readSentMessageEditDraft(
            sentMessageEditRef,
            operationId,
            ENDED_EDIT_SESSION_DRAFT,
          ),
        subscribeDraft: subscribeSentMessageEditDraft,
        setDraft: (nextDraft) =>
          writeSentMessageEditDraft(sentMessageEditRef, operationId, nextDraft),
        focus: focusInlinePluginComposer,
      };
    }, [
      focusInlinePluginComposer,
      sentMessageEditOperationId,
      sentMessageEditRef,
      subscribeSentMessageEditDraft,
      thread.id,
    ]);
  const sentMessageEditorPortal = useMemo(() => {
    if (!sentMessageEdit?.hostElement || !sentMessagePluginComposerHost) {
      return null;
    }
    const { draft, hostElement, operationId } = sentMessageEdit;
    return createPortal(
      <InlineMessageEditorFrame
        cancelLabel="Stop editing sent message"
        label="Editing message"
        onCancel={sentMessageEdit.onCancel}
        variant="cap"
      >
        {buildInlineDraftComposer({
          attachments: {
            items: draft.attachments,
            projectId,
            isAttaching: isAttachingSentMessageFiles,
            error: sentMessageAttachmentError,
            onAttachFiles: handleAttachSentMessageFiles,
            onRemove: (path) => {
              sentMessageEdit.updateDraft((current) => ({
                ...current,
                attachments: current.attachments.filter(
                  (attachment) => attachment.path !== path,
                ),
              }));
            },
          },
          canModifierSubmit: canSubmitSentMessageEdit,
          compactPromptPlaceholder: "Edit message",
          composerId: `${THREAD_DETAIL_COMPOSER_TEXTAREA_ID}-sent-${operationId}`,
          draft,
          editFocusNonce,
          execution: compactExecutionConfig,
          focusSessionKey: operationId,
          historyResetKey: `${thread.id}:${operationId}`,
          isSubmitting: sentMessageEdit.isSubmitting,
          onChangeMessage: (text, mentions) =>
            sentMessageEdit.updateDraft((current) => ({
              ...current,
              text,
              mentions,
            })),
          onEscape: sentMessageEdit.onCancel,
          onSelectHistoryEntry: (nextDraft) =>
            sentMessageEdit.updateDraft(() => nextDraft),
          permission: bottomPermissionConfig,
          pluginComposerHost: sentMessagePluginComposerHost,
          promptActions,
          promptPlaceholder: "Edit message",
          submit: handleSentMessageEditSubmit,
          submitMode: sentMessageEditSubmitMode,
          submitTitle: "Submit edit (Enter)",
          suppressPluginComposerCustomizations: true,
          textEffects: sentMessageComposerTextEffects,
          threadRuntimeDisplayStatus: runtimeDisplayStatus,
          typeahead: typeaheadConfig,
          collapseResetKey: `sent-message:${operationId}`,
        })}
      </InlineMessageEditorFrame>,
      hostElement,
    );
  }, [
    bottomPermissionConfig,
    canSubmitSentMessageEdit,
    compactExecutionConfig,
    editFocusNonce,
    handleAttachSentMessageFiles,
    handleSentMessageEditSubmit,
    isAttachingSentMessageFiles,
    projectId,
    promptActions,
    runtimeDisplayStatus,
    sentMessageAttachmentError,
    sentMessageComposerTextEffects,
    sentMessageEdit,
    sentMessageEditSubmitMode,
    sentMessagePluginComposerHost,
    thread.id,
    typeaheadConfig,
  ]);
  const childPendingInteractionBanners = useMemo(
    () =>
      childPendingInteractions.map((item) => (
        <ThreadPendingInteractionBanner
          key={item.interaction.id}
          interaction={item.interaction}
          sourceThread={{ href: item.href, title: item.childTitle }}
          threadId={item.childThreadId}
        />
      )),
    [childPendingInteractions],
  );
  const promptStack = useMemo(
    () => (
      <>
        {childPendingInteractionBanners}
        {activeWorkflows.map((workflow) => (
          <ThreadWorkflowCard
            key={workflow.id}
            workflow={workflow}
            isExpanded={expandedWorkflowIds.has(workflow.id)}
            onToggle={() => toggleWorkflowExpanded(workflow.id)}
          />
        ))}
        <ThreadBackgroundCommandsCard
          commands={activeBackgroundCommands}
          isExpanded={isBackgroundCommandsExpanded}
          onToggle={() => setIsBackgroundCommandsExpanded((value) => !value)}
        />
        {activePromptModeCard}
        {activeGoalCard}
        <ThreadTodoCard
          pendingTodos={
            thread.archivedAt === null && environmentGoneStatus === null
              ? pendingTodos
              : null
          }
          isExpanded={isTodoExpanded}
          onToggle={() => setIsTodoExpanded((value) => !value)}
        />
        <ThreadPromptContextBanner
          archivedSection={
            thread.archivedAt !== null
              ? {
                  archivedAt: thread.archivedAt,
                  onUnarchive: handleUnarchiveCurrentThread,
                  unarchivePending: isUnarchiveCurrentThreadPending,
                }
              : null
          }
          environmentGoneSection={
            environmentGoneStatus === null
              ? null
              : { status: environmentGoneStatus }
          }
          parentThreadSection={parentThreadSection}
          childThreadsSection={childThreadsSection}
          pullRequestSection={pullRequestSection}
          gitSection={
            workspaceChangedFilesSection
              ? {
                  changedFiles: workspaceChangedFilesSection,
                  mergeBase: contextBannerMergeBase,
                  onPromptBannerFileClick: canUseGitUi
                    ? onChangedFileClick
                    : ignorePromptBannerFileClick,
                }
              : null
          }
          gitSectionPending={workspaceStatusPending}
          expandedSection={expandedBannerSection}
          onToggleSection={handleToggleBannerSection}
        />
        {modelFallback ? (
          <ThreadModelFallbackCard
            key={`${thread.id}:${modelFallback.sourceSeq}`}
            fallback={modelFallback}
            threadId={thread.id}
          />
        ) : null}
        {shouldHideComposer ? null : queuedMessagesPending ? (
          <QueuedMessagesPendingCard queuedMessageCount={queuedMessageCount} />
        ) : (
          <QueuedMessagesList
            attachedToComposer={true}
            queuedMessages={queuedMessages}
            resolveMentionLink={resolveMentionLink}
            inlineEditor={queuedMessageEditor ?? undefined}
            sendAction={shouldSteerWhenReady ? "steer-when-ready" : "send-now"}
            sendDisabled={
              !(submitMode.kind === "ready" || submitMode.kind === "queue") ||
              runtimeDisplayStatus === "waiting-for-host" ||
              isFollowUpSubmitting ||
              isQueueMutationPending
            }
            actionDisabled={isQueueMutationPending}
            processingMessageId={displayedProcessingQueuedMessage?.id ?? null}
            processingAction={displayedProcessingQueuedMessage?.action ?? null}
            onSend={handleSendQueuedMessage}
            onReorder={handleReorderQueuedMessage}
            onSetGroupBoundary={handleSetQueuedMessageGroupBoundary}
            onEdit={beginEditQueuedMessage}
            onDelete={handleDeleteQueuedMessage}
          />
        )}
      </>
    ),
    [
      canUseGitUi,
      childPendingInteractionBanners,
      contextBannerMergeBase,
      expandedBannerSection,
      handleDeleteQueuedMessage,
      beginEditQueuedMessage,
      onChangedFileClick,
      handleReorderQueuedMessage,
      handleSendQueuedMessage,
      handleSetQueuedMessageGroupBoundary,
      handleToggleBannerSection,
      handleUnarchiveCurrentThread,
      environmentGoneStatus,
      isFollowUpSubmitting,
      isUnarchiveCurrentThreadPending,
      isQueueMutationPending,
      queuedMessageEditor,
      activeGoalCard,
      activePromptModeCard,
      isTodoExpanded,
      activeWorkflows,
      expandedWorkflowIds,
      toggleWorkflowExpanded,
      activeBackgroundCommands,
      isBackgroundCommandsExpanded,
      modelFallback,
      parentThreadSection,
      childThreadsSection,
      pullRequestSection,
      pendingTodos,
      displayedProcessingQueuedMessage,
      queuedMessageCount,
      queuedMessages,
      queuedMessagesPending,
      resolveMentionLink,
      runtimeDisplayStatus,
      shouldSteerWhenReady,
      shouldHideComposer,
      submitMode.kind,
      thread.archivedAt,
      thread.id,
      workspaceChangedFilesSection,
      workspaceStatusPending,
    ],
  );

  const pendingInteractionNode = useMemo(() => {
    if (!activePendingInteraction || shouldHideComposer) {
      return null;
    }
    return (
      <ThreadPendingInteractionBanner
        interaction={activePendingInteraction}
        threadId={thread.id}
      />
    );
  }, [activePendingInteraction, shouldHideComposer, thread.id]);
  const pendingInteractionStack = useMemo(
    () => (
      <>
        {childPendingInteractionBanners}
        {activePromptMode ? activePromptModeCard : null}
        {goal ? activeGoalCard : null}
      </>
    ),
    [
      activeGoalCard,
      activePromptMode,
      activePromptModeCard,
      childPendingInteractionBanners,
      goal,
    ],
  );

  const bottomContent = (
    <FollowUpPromptBox
      id={THREAD_DETAIL_COMPOSER_TEXTAREA_ID}
      attachments={bottomAttachmentsConfig}
      stack={pendingInteractionNode ? pendingInteractionStack : promptStack}
      pendingInteraction={pendingInteractionNode}
      activePromptMode={activePromptMode}
      composer={shouldHideComposer ? null : bottomComposerConfig}
      pluginComposerHost={normalPluginComposerHost}
      pluginComposerScope={normalPluginComposerHost.scope}
      textEffects={promptTextEffects}
      collapseResetKey={thread.id}
      focusEndKey={bottomFocusEndKey}
      environmentSummary={environmentSummary}
      contextWindowUsage={contextWindowUsage ?? null}
      execution={bottomExecutionConfig}
      permission={bottomPermissionConfig}
      typeahead={typeaheadConfig}
      promptActions={promptActions}
    />
  );

  return (
    <>
      {sentMessageEditorPortal}
      {bottomContent}
    </>
  );
}
