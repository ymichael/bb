import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ChevronDown, CornerDownRight, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import {
  useThread,
  useThreadWorkStatus,
  useThreadTimeline,
  useThreadEvents,
  useThreadToolGroupMessages,
  useTellThread,
  useEnqueueThreadMessage,
  useSendQueuedThreadMessage,
  useDeleteQueuedThreadMessage,
  useCommitThread,
  usePromoteThread,
  useDemotePrimaryCheckout,
  useSquashMergeThread,
  useStopThread,
  useMarkThreadRead,
  useUnarchiveThread,
  useThreadDefaultExecutionOptions,
  useUploadPromptAttachment,
} from "../hooks/useApi";
import {
  ConversationEntry,
} from "@/components/messages/ConversationEntry";
import {
  CollapsibleHeader,
  getCollapsibleHeaderToneClass,
} from "@/components/messages/CollapsibleHeader";
import { ConversationWorkingIndicator } from "@/components/messages/ConversationWorkingIndicator";
import { PromptBox } from "@/components/promptbox/PromptBox";
import { PromptOptionPicker } from "@/components/promptbox/PromptOptionPicker";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAutoScroll } from "@/hooks/useAutoScroll";
import { useScrollToBottomIndicator } from "@/hooks/useScrollToBottomIndicator";
import { usePromptModelReasoning } from "@/hooks/usePromptModelReasoning";
import { usePromptDraftStorage } from "@/hooks/usePromptDraftStorage";
import { usePromptFileMentions } from "@/hooks/usePromptFileMentions";
import { PageShell } from "@/components/layout/PageShell";
import { DetailCard, DetailRow } from "@/components/shared/DetailCard";
import { ScrollToBottomButton } from "@/components/shared/ScrollToBottomButton";
import {
  ConversationEmptyState,
  ConversationTimeline,
  PromptComposerShell,
} from "@beanbag/ui-core";
import {
  toRecord,
  type PromptInput,
  type ThreadQueuedMessage,
  type UIMessage,
} from "@beanbag/agent-core";
import { type ThreadDetailToolGroupRow } from "./threadDetailRows";
import {
  findLatestActivityMessageId,
  findLatestActivityRowId,
  shouldHighlightLatestActivity,
} from "./threadDetailActivity";
import {
  createLatestInitialExpandedState,
  reduceLatestInitialExpandedState,
} from "@/lib/latestInitialExpanded";
import {
  promptDraftToInput,
  type PromptDraftState,
} from "@/lib/prompt-draft";
import { openPathInEditor } from "@/lib/api";
import { getPathCommandForTarget } from "@/lib/open-path-preferences";
import { StatusPillCommitPopover } from "@/components/shared/StatusPillCommitPopover";
import { WorkspaceChangesList } from "@/components/shared/WorkspaceChangesList";
import { ArchiveTimestampAction } from "@/components/shared/ArchiveTimestampAction";
import { ThreadContextWindowIndicator } from "@/components/thread/ThreadContextWindowIndicator";
import { extractThreadContextWindowUsage } from "@/lib/thread-context-window-usage";
import {
  threadWorkStatusLabel,
  threadWorkStatusVariant,
} from "@/lib/thread-work-status";
import { formatWorkspaceChangeSummary } from "@/lib/workspace-change-summary";

const SCROLL_THRESHOLD = 40;
const QUEUED_FOLLOW_UP_PREVIEW_MAX_CHARS = 220;

function getFileNameFromPath(path: string): string {
  const trimmedPath = path.trim();
  if (trimmedPath.length === 0) return "Attachment";
  const segments = trimmedPath.split("/");
  const lastSegment = segments[segments.length - 1];
  return lastSegment && lastSegment.length > 0 ? lastSegment : trimmedPath;
}

function countQueuedMessageAttachments(input: PromptInput[]): number {
  let count = 0;
  for (const chunk of input) {
    if (chunk.type === "localImage" || chunk.type === "localFile") {
      count += 1;
    }
  }
  return count;
}

function formatQueuedFollowUpPreview(input: PromptInput[]): string {
  const text = input
    .filter((chunk): chunk is Extract<PromptInput, { type: "text" }> => chunk.type === "text")
    .map((chunk) => chunk.text.trim())
    .filter((chunk) => chunk.length > 0)
    .join("\n\n");
  const trimmedText = text.trim();
  if (trimmedText.length > 0) {
    if (trimmedText.length <= QUEUED_FOLLOW_UP_PREVIEW_MAX_CHARS) {
      return trimmedText;
    }
    return `${trimmedText.slice(0, QUEUED_FOLLOW_UP_PREVIEW_MAX_CHARS - 1)}…`;
  }

  const attachmentCount = countQueuedMessageAttachments(input);
  if (attachmentCount === 1) {
    const firstAttachment = input.find(
      (chunk) => chunk.type === "localImage" || chunk.type === "localFile",
    );
    if (firstAttachment) {
      if (firstAttachment.type === "localFile" && firstAttachment.name) {
        return `Attachment only (${firstAttachment.name})`;
      }
      return `Attachment only (${getFileNameFromPath(firstAttachment.path)})`;
    }
    return "Attachment only (1 file)";
  }
  if (attachmentCount > 1) {
    return `Attachment only (${attachmentCount} files)`;
  }

  return "(empty message)";
}

function queuedInputToDraft(input: PromptInput[]): PromptDraftState {
  const textSegments: string[] = [];
  const attachments: PromptDraftState["attachments"] = [];

  for (const chunk of input) {
    if (chunk.type === "text") {
      if (chunk.text.trim().length > 0) {
        textSegments.push(chunk.text);
      }
      continue;
    }

    if (chunk.type === "localImage") {
      attachments.push({
        type: "localImage",
        path: chunk.path,
        name: getFileNameFromPath(chunk.path),
        sizeBytes: 0,
      });
      continue;
    }

    if (chunk.type === "localFile") {
      attachments.push({
        type: "localFile",
        path: chunk.path,
        name: chunk.name ?? getFileNameFromPath(chunk.path),
        sizeBytes: chunk.sizeBytes ?? 0,
        ...(chunk.mimeType ? { mimeType: chunk.mimeType } : {}),
      });
      continue;
    }

    // Open provider/runtime input variant: URL images are intentionally ignored
    // by the prompt draft editor because we cannot map them to local attachments.
  }

  return {
    text: textSegments.join("\n\n"),
    attachments,
  };
}

function isPromptInputChunk(value: unknown): value is PromptInput {
  const record = toRecord(value);
  if (!record) return false;

  const type = record.type;
  if (typeof type !== "string") return false;
  if (type === "text") {
    return typeof record.text === "string";
  }
  if (type === "image") {
    return typeof record.url === "string";
  }
  if (type === "localImage" || type === "localFile") {
    return typeof record.path === "string";
  }
  return false;
}

function isThreadQueuedMessage(value: unknown): value is ThreadQueuedMessage {
  const record = toRecord(value);
  if (!record || typeof record.id !== "string") return false;
  if (!Array.isArray(record.input)) return false;
  return record.input.every(isPromptInputChunk);
}

function extractThreadQueuedMessages(thread: unknown): ThreadQueuedMessage[] {
  const record = toRecord(thread);
  const queuedMessages = record?.queuedMessages;
  if (!Array.isArray(queuedMessages)) return [];
  return queuedMessages.filter(isThreadQueuedMessage);
}

function QueuedFollowUpList({
  queuedMessages,
  sendDisabled,
  actionDisabled,
  processingMessageId,
  onSendImmediately,
  onEdit,
  onDelete,
}: {
  queuedMessages: readonly ThreadQueuedMessage[];
  sendDisabled: boolean;
  actionDisabled: boolean;
  processingMessageId: string | null;
  onSendImmediately: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  if (queuedMessages.length === 0) return null;

  return (
    <section
      aria-label="Queued follow-up messages"
      className="mb-2 overflow-hidden rounded-md border border-border/60 bg-muted/25"
    >
      <div className="flex items-center justify-between px-2.5 pb-1 pt-2.5">
        <p className="text-xs text-muted-foreground">Queued ({queuedMessages.length})</p>
      </div>
      <ul>
        {queuedMessages.map((queuedMessage, index) => {
          const preview = formatQueuedFollowUpPreview(queuedMessage.input);
          const attachmentCount = countQueuedMessageAttachments(queuedMessage.input);
          const isProcessing = processingMessageId === queuedMessage.id;
          return (
            <li
              key={queuedMessage.id}
              className="px-2.5 py-0.5"
            >
              <div className="flex items-center gap-1.5">
                <div className="p-0.5 text-muted-foreground">
                  <CornerDownRight className="size-3.5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-1 text-xs leading-4">
                    <p className="min-w-0 truncate text-foreground" title={preview}>
                      {preview}
                    </p>
                    {attachmentCount > 0 ? (
                      <>
                        <span className="shrink-0 text-muted-foreground">·</span>
                        <span className="shrink-0 text-muted-foreground">
                          {attachmentCount === 1 ? "1 attachment" : `${attachmentCount} attachments`}
                        </span>
                      </>
                    ) : null}
                    {isProcessing ? (
                      <>
                        <span className="shrink-0 text-muted-foreground">·</span>
                        <span className="shrink-0 text-muted-foreground">Sending...</span>
                      </>
                    ) : null}
                  </div>
                </div>
                <div className="ml-1 flex shrink-0 items-center gap-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="link"
                    className="h-auto px-0 text-xs text-muted-foreground"
                    disabled={sendDisabled || isProcessing}
                    onClick={() => onSendImmediately(queuedMessage.id)}
                  >
                    {isProcessing ? "Sending..." : "Steer"}
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="size-7 text-muted-foreground hover:text-destructive"
                    disabled={actionDisabled || isProcessing}
                    onClick={() => onDelete(queuedMessage.id)}
                    aria-label={`Delete queued message ${index + 1}`}
                    title="Delete queued message"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="size-7 text-muted-foreground data-[state=open]:bg-accent"
                        disabled={actionDisabled || isProcessing}
                        aria-label={`More queued message actions for message ${index + 1}`}
                        title="More actions"
                      >
                        <MoreHorizontal className="size-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-40">
                      <DropdownMenuItem
                        disabled={actionDisabled || isProcessing}
                        onSelect={(event) => {
                          event.preventDefault();
                          onEdit(queuedMessage.id);
                        }}
                      >
                        <Pencil className="size-4" />
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={actionDisabled || isProcessing}
                        className="text-destructive focus:text-destructive"
                        onSelect={(event) => {
                          event.preventDefault();
                          onDelete(queuedMessage.id);
                        }}
                      >
                        <Trash2 className="size-4" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function useLatestInitialExpanded(initialExpanded: boolean): {
  isExpanded: boolean;
  onToggle: () => void;
} {
  const [state, dispatch] = useReducer(
    reduceLatestInitialExpandedState,
    initialExpanded,
    createLatestInitialExpandedState,
  );

  useEffect(() => {
    dispatch({ type: "sync", initialExpanded });
  }, [initialExpanded]);

  const onToggle = () => {
    dispatch({ type: "toggle" });
  };

  return { isExpanded: state.isExpanded, onToggle };
}

function ToolGroupEntry({
  projectId,
  entry,
  messages,
  isLoadingMessages,
  onLoadMessages,
  isLatestActivity,
}: {
  projectId?: string;
  entry: ThreadDetailToolGroupRow;
  messages: ThreadDetailToolGroupRow["messages"];
  isLoadingMessages: boolean;
  onLoadMessages: () => void;
  isLatestActivity: boolean;
}) {
  const { isExpanded, onToggle } = useLatestInitialExpanded(isLatestActivity);
  const latestActivityMessageId = useMemo(
    () => findLatestActivityMessageId(messages),
    [messages],
  );
  const count = entry.summaryCount;
  const summaryContent = `${count} tools and changes`;
  const headerToneClass = getCollapsibleHeaderToneClass(isExpanded);
  const handleToggle = () => {
    if (!isExpanded) {
      onLoadMessages();
    }
    onToggle();
  };

  return (
    <div className="group w-full" style={{ overflowAnchor: "none" }}>
      <div className="mr-auto w-full">
        <div className="rounded-md text-muted-foreground">
          <div className="px-2 py-1">
            <CollapsibleHeader
              isExpanded={isExpanded}
              onToggle={handleToggle}
              toneClassName={headerToneClass}
              summaryContent={summaryContent}
            />
          </div>
          {isExpanded ? (
            <div className="px-2 pb-1">
              <div className="overflow-hidden rounded-md border border-border/60 bg-background/40">
                {isLoadingMessages ? (
                  <div className="px-3 py-2 text-xs text-muted-foreground">
                    Loading details...
                  </div>
                ) : null}
                {messages.map((message) => {
                  const isLatestMessage =
                    isLatestActivity &&
                    message.id === latestActivityMessageId;
                  return (
                    <ConversationEntry
                      key={message.id}
                      message={message}
                      projectId={projectId}
                      initialExpanded={isLatestMessage}
                      preferOngoingLabels={isLatestMessage}
                    />
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function ThreadDetailView() {
  const { projectId, threadId } = useParams<{
    projectId: string;
    threadId: string;
  }>();
  const [selectedMergeBaseBranch, setSelectedMergeBaseBranch] = useState<string | undefined>(
    undefined,
  );
  const { data: thread, isLoading, error } = useThread(threadId ?? "");
  const { data: threadWorkStatus } = useThreadWorkStatus(
    threadId ?? "",
    selectedMergeBaseBranch,
  );
  const { data: parentThread } = useThread(thread?.parentThreadId ?? "");
  const { data: timeline, isLoading: timelineLoading } = useThreadTimeline(
    threadId ?? "",
  );
  const { data: threadEvents } = useThreadEvents(threadId ?? "", {
    enabled: Boolean(threadId),
  });
  const threadToolGroupMessages = useThreadToolGroupMessages();
  const { data: defaultExecutionOptions } = useThreadDefaultExecutionOptions(
    threadId ?? "",
  );
  const tellThread = useTellThread();
  const enqueueThreadMessage = useEnqueueThreadMessage();
  const sendQueuedThreadMessage = useSendQueuedThreadMessage();
  const deleteQueuedThreadMessage = useDeleteQueuedThreadMessage();
  const commitThread = useCommitThread();
  const promoteThread = usePromoteThread();
  const demotePrimaryCheckout = useDemotePrimaryCheckout();
  const squashMergeThread = useSquashMergeThread();
  const stopThread = useStopThread();
  const unarchiveThread = useUnarchiveThread();
  const markThreadRead = useMarkThreadRead();
  const uploadPromptAttachment = useUploadPromptAttachment();
  const promptDraft = usePromptDraftStorage({ projectId, threadId });
  const fileMentions = usePromptFileMentions(projectId);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [loadingToolGroupIds, setLoadingToolGroupIds] = useState<Set<string>>(new Set());
  const [toolGroupMessagesById, setToolGroupMessagesById] = useState<
    Record<string, UIMessage[]>
  >({});
  const [isChangeListExpanded, setIsChangeListExpanded] = useState(false);
  const [processingQueuedMessageId, setProcessingQueuedMessageId] = useState<string | null>(
    null,
  );
  const markedReadKeysRef = useRef<Set<string>>(new Set());
  const message = promptDraft.text;
  const promptInput = useMemo(
    () =>
      promptDraftToInput({
        text: promptDraft.text,
        attachments: promptDraft.attachments,
      }),
    [promptDraft.attachments, promptDraft.text],
  );
  const {
    selectedModel,
    setSelectedModel,
    reasoningLevel,
    setReasoningLevel,
    sandboxMode,
    setSandboxMode,
    activeModel,
    modelOptions,
    reasoningOptions,
    sandboxOptions,
    supportsModelList,
    supportsReasoningLevels,
  } = usePromptModelReasoning({
    scope: "thread",
    initialModel: defaultExecutionOptions?.model,
    initialReasoningLevel: defaultExecutionOptions?.reasoningLevel,
    initialSandboxMode: defaultExecutionOptions?.sandboxMode,
    initialEnvironmentId: thread?.environmentId,
  });

  const threadDetailRows = useMemo(() => timeline?.rows ?? [], [timeline?.rows]);
  const contextWindowUsage = useMemo(
    () => extractThreadContextWindowUsage(threadEvents ?? []),
    [threadEvents],
  );
  const latestActivityRowId = useMemo(
    () => findLatestActivityRowId(threadDetailRows),
    [threadDetailRows],
  );
  const shouldHighlightLatest = useMemo(
    () => shouldHighlightLatestActivity(threadDetailRows, latestActivityRowId),
    [latestActivityRowId, threadDetailRows],
  );

  const isReasoningBlockActive = false;
  const isTimelineLoading = timelineLoading;
  const isThreadPrimaryCheckoutActive = thread?.primaryCheckout?.isActive === true;

  useEffect(() => {
    setLoadingToolGroupIds(new Set());
    setToolGroupMessagesById({});
    setProcessingQueuedMessageId(null);
  }, [threadId]);

  useEffect(() => {
    setSelectedMergeBaseBranch(undefined);
  }, [threadId]);

  useEffect(() => {
    if (!threadWorkStatus) return;
    const mergeBaseBranches = threadWorkStatus.mergeBaseBranches ?? [];
    const fallbackBranch = threadWorkStatus.mergeBaseBranch ?? mergeBaseBranches[0];
    if (!fallbackBranch) return;
    if (
      selectedMergeBaseBranch &&
      (
        selectedMergeBaseBranch === threadWorkStatus.mergeBaseBranch ||
        mergeBaseBranches.includes(selectedMergeBaseBranch)
      )
    ) {
      return;
    }
    setSelectedMergeBaseBranch(fallbackBranch);
  }, [selectedMergeBaseBranch, threadWorkStatus]);

  useEffect(() => {
    if (!thread) return;
    if ((thread.lastReadAt ?? 0) >= thread.updatedAt) return;

    const marker = `${thread.id}:${thread.updatedAt}`;
    if (markedReadKeysRef.current.has(marker)) return;

    markedReadKeysRef.current.add(marker);
    markThreadRead.mutate(thread.id, {
      onError: () => {
        markedReadKeysRef.current.delete(marker);
      },
    });
  }, [markThreadRead, thread]);

  const handleLoadToolGroupMessages = useCallback(
    (entry: ThreadDetailToolGroupRow) => {
      if (!threadId) return;
      if (entry.messages.length > 0 || toolGroupMessagesById[entry.id]) return;
      if (loadingToolGroupIds.has(entry.id)) return;
      setLoadingToolGroupIds((prev) => new Set(prev).add(entry.id));
      void threadToolGroupMessages
        .mutateAsync({
          id: threadId,
          turnId: entry.turnId,
          sourceSeqStart: entry.sourceSeqStart,
          sourceSeqEnd: entry.sourceSeqEnd,
        })
        .then((response) => {
          setToolGroupMessagesById((prev) => ({
            ...prev,
            [entry.id]: response.messages,
          }));
        })
        .finally(() => {
          setLoadingToolGroupIds((prev) => {
            const next = new Set(prev);
            next.delete(entry.id);
            return next;
          });
        });
    },
    [
      loadingToolGroupIds,
      threadId,
      threadToolGroupMessages,
      toolGroupMessagesById,
    ],
  );

  const { containerRef, handleScroll: baseHandleScroll } = useAutoScroll(
    threadDetailRows,
    threadId,
  );
  const promptComposerRef = useRef<HTMLDivElement>(null);
  const promptComposerHeightRef = useRef<number | null>(null);
  const { showScrollToBottom, handleScroll, scrollToBottom } =
    useScrollToBottomIndicator({
      containerRef,
      onBaseScroll: baseHandleScroll,
      resetDep: threadId,
    });

  useLayoutEffect(() => {
    const scrollContainer = containerRef.current;
    const promptComposer = promptComposerRef.current;
    if (!scrollContainer || !promptComposer || typeof ResizeObserver === "undefined") {
      return;
    }

    promptComposerHeightRef.current = promptComposer.getBoundingClientRect().height;
    const observer = new ResizeObserver((entries) => {
      const nextHeight =
        entries[0]?.contentRect.height ?? promptComposer.getBoundingClientRect().height;
      const previousHeight = promptComposerHeightRef.current;
      promptComposerHeightRef.current = nextHeight;
      if (previousHeight === null) return;
      const heightDelta = nextHeight - previousHeight;
      if (Math.abs(heightDelta) < 0.5) return;
      const maxScrollOffset = scrollContainer.scrollHeight - scrollContainer.clientHeight;
      const distanceFromBottom = maxScrollOffset - scrollContainer.scrollTop;
      if (distanceFromBottom <= SCROLL_THRESHOLD) {
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
        return;
      }
      scrollContainer.scrollTop += heightDelta;
    });

    observer.observe(promptComposer);
    return () => {
      observer.disconnect();
      promptComposerHeightRef.current = null;
    };
  }, [containerRef, threadId]);

  const sendFollowUpInput = useCallback(
    async ({
      input,
      mode,
      model,
      reasoningLevel: executionReasoningLevel,
      sandboxMode: executionSandboxMode,
    }: {
      input: PromptInput[];
      mode?: "auto" | "steer";
      model?: string;
      reasoningLevel?: "low" | "medium" | "high" | "xhigh";
      sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
    }) => {
      if (!threadId || input.length === 0) return;
      if (mode !== "steer" && isThreadPrimaryCheckoutActive) {
        await demotePrimaryCheckout.mutateAsync({ id: threadId });
      }
      scrollToBottom();
      await tellThread.mutateAsync({
        id: threadId,
        input,
        ...(mode ? { mode } : {}),
        ...(mode === "steer"
          ? {}
          : {
              ...(model ? { model } : {}),
              ...(executionReasoningLevel ? { reasoningLevel: executionReasoningLevel } : {}),
              ...(executionSandboxMode ? { sandboxMode: executionSandboxMode } : {}),
            }),
      });
    },
    [
      demotePrimaryCheckout,
      isThreadPrimaryCheckoutActive,
      scrollToBottom,
      tellThread,
      threadId,
    ],
  );

  const handleAttachFiles = useCallback(async (files: File[]) => {
    if (!projectId || files.length === 0) return;

    setAttachmentError(null);
    for (const file of files) {
      try {
        const uploaded = await uploadPromptAttachment.mutateAsync({
          projectId,
          file,
        });
        promptDraft.addAttachment(uploaded);
      } catch (err) {
        setAttachmentError(err instanceof Error ? err.message : "Attachment upload failed");
        break;
      }
    }
  }, [projectId, promptDraft, uploadPromptAttachment]);

  if (!projectId || !threadId) {
    return (
      <PageShell contentClassName="min-h-full items-center justify-center">
        <p className="py-12 text-center text-sm text-destructive">Not found</p>
      </PageShell>
    );
  }
  if (isLoading) {
    return (
      <PageShell contentClassName="min-h-full items-center justify-center">
        <p className="py-12 text-center text-sm text-muted-foreground">Loading...</p>
      </PageShell>
    );
  }
  if (
    error ||
    !thread ||
    thread.projectId !== projectId
  ) {
    return (
      <PageShell contentClassName="min-h-full items-center justify-center">
        <p className="py-12 text-center text-sm text-destructive">
          {error ? error.message : "Not found"}
        </p>
      </PageShell>
    );
  }

  const isCreated = thread.status === "created";
  const isProvisioning = thread.status === "provisioning";
  const isProvisioningFailed = thread.status === "provisioning_failed";
  const queuedMessages = extractThreadQueuedMessages(thread);
  const isQueueMutationPending =
    enqueueThreadMessage.isPending ||
    sendQueuedThreadMessage.isPending ||
    deleteQueuedThreadMessage.isPending;
  const isFollowUpSubmitting =
    tellThread.isPending ||
    demotePrimaryCheckout.isPending ||
    enqueueThreadMessage.isPending;
  const canSendFollowUp = !isCreated && !isProvisioning;
  const promptPlaceholder =
    isCreated
      ? "Thread is being created..."
      : isProvisioning
      ? "Thread is provisioning..."
      : isProvisioningFailed
      ? "Retry provisioning by sending a message"
      : thread.status === "idle"
      ? "Ask for follow-up changes"
      : "Send a message to this thread...";
  const parentThreadId = thread.parentThreadId;
  const parentThreadDisplayName =
    parentThread?.title && parentThread.title.trim().length > 0
      ? parentThread.title
      : parentThreadId;
  const isPrimaryCheckoutActive = thread.primaryCheckout?.isActive === true;
  const showWorkspaceStatus =
    Boolean(threadWorkStatus) &&
    !(thread.archivedAt !== undefined && thread.environmentId === "local");
  const showThreadMetadata = Boolean(
    parentThreadId ||
      thread.archivedAt !== undefined ||
      thread.environmentId ||
      isPrimaryCheckoutActive ||
      showWorkspaceStatus,
  );
  const provisioningStatusLabel =
    isCreated
      ? "Created..."
      : isProvisioning
      ? "Provisioning..."
      : undefined;

  const handleSend = async () => {
    if (promptInput.length === 0) return;

    if (thread.status === "active") {
      try {
        await enqueueThreadMessage.mutateAsync({
          id: thread.id,
          input: promptInput,
          model: activeModel?.model ?? selectedModel,
          reasoningLevel,
          sandboxMode,
        });
        promptDraft.clear();
        setAttachmentError(null);
      } catch (err) {
        window.alert(err instanceof Error ? err.message : "Failed to queue follow-up");
      }
      return;
    }

    try {
      await sendFollowUpInput({
        input: promptInput,
        model: activeModel?.model ?? selectedModel,
        reasoningLevel,
        sandboxMode,
      });
      promptDraft.clear();
      setAttachmentError(null);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Failed to send follow-up");
    }
  };

  const handleSendQueuedImmediately = (messageId: string) => {
    const queuedMessage = queuedMessages.find((candidate) => candidate.id === messageId);
    if (!queuedMessage) return;

    setProcessingQueuedMessageId(messageId);
    void sendQueuedThreadMessage
      .mutateAsync({
        id: thread.id,
        queuedMessageId: messageId,
        mode: "steer-if-active",
      })
      .then(() => {
        setAttachmentError(null);
      })
      .catch((err) => {
        window.alert(
          err instanceof Error ? err.message : "Failed to send queued follow-up",
        );
      })
      .finally(() => {
        setProcessingQueuedMessageId((currentMessageId) =>
          currentMessageId === messageId ? null : currentMessageId,
        );
      });
  };

  const handleEditQueuedMessage = (messageId: string) => {
    const queuedMessage = queuedMessages.find((candidate) => candidate.id === messageId);
    if (!queuedMessage) return;

    setProcessingQueuedMessageId(messageId);
    void deleteQueuedThreadMessage
      .mutateAsync({
        id: thread.id,
        queuedMessageId: messageId,
      })
      .then(() => {
        const restoredDraft = queuedInputToDraft(queuedMessage.input);
        promptDraft.setText(restoredDraft.text);
        promptDraft.setAttachments(restoredDraft.attachments);
        setAttachmentError(null);
      })
      .catch((err) => {
        window.alert(
          err instanceof Error ? err.message : "Failed to edit queued follow-up",
        );
      })
      .finally(() => {
        setProcessingQueuedMessageId((currentMessageId) =>
          currentMessageId === messageId ? null : currentMessageId,
        );
      });
  };

  const handleDeleteQueuedMessage = (messageId: string) => {
    setProcessingQueuedMessageId(messageId);
    void deleteQueuedThreadMessage
      .mutateAsync({
        id: thread.id,
        queuedMessageId: messageId,
      })
      .catch((err) => {
        window.alert(
          err instanceof Error ? err.message : "Failed to delete queued follow-up",
        );
      })
      .finally(() => {
        setProcessingQueuedMessageId((currentMessageId) =>
          currentMessageId === messageId ? null : currentMessageId,
        );
      });
  };

  const conversationMain = (
    <>
      {showThreadMetadata ? (
        <section className="sticky top-0 z-10 shrink-0 bg-background pt-2">
          <DetailCard>
            {parentThreadId ? (
              <DetailRow
                label="Parent thread"
                valueClassName="min-w-0 truncate"
                align="center"
              >
                <Link
                  to={`/projects/${projectId}/threads/${parentThreadId}`}
                  className="underline underline-offset-2"
                >
                  {parentThreadDisplayName}
                </Link>
              </DetailRow>
            ) : null}
            {thread.environmentId ? (
              <DetailRow
                label="Environment"
                valueClassName="min-w-0 truncate"
                align="center"
              >
                <span>{thread.environmentId}</span>
              </DetailRow>
            ) : null}
            {thread.environmentId === "worktree" ? (
              <DetailRow
                label="Primary checkout"
                valueClassName="min-w-0"
                align="center"
              >
                <div className="flex w-full items-center justify-between gap-3">
                  <span className="truncate text-xs text-muted-foreground">
                    {isPrimaryCheckoutActive ? "Active" : "Not active"}
                  </span>
                  <button
                    type="button"
                    className="inline-flex shrink-0 items-center rounded-md border border-border/70 px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={
                      thread.archivedAt !== undefined ||
                      promoteThread.isPending ||
                      demotePrimaryCheckout.isPending
                    }
                    onClick={() => {
                      const action = isPrimaryCheckoutActive
                        ? demotePrimaryCheckout.mutateAsync({ id: thread.id })
                        : promoteThread.mutateAsync({ id: thread.id });
                      void action.catch((err) => {
                        window.alert(
                          err instanceof Error
                            ? err.message
                            : "Failed to update primary checkout state",
                        );
                      });
                    }}
                  >
                    {isPrimaryCheckoutActive ? "Demote" : "Promote"}
                  </button>
                </div>
              </DetailRow>
            ) : null}
            {showWorkspaceStatus && threadWorkStatus ? (
              <DetailRow
                label="Workspace status"
                valueClassName="min-w-0"
                align="center"
              >
                <StatusPillCommitPopover
                  status={threadWorkStatus}
                  label={threadWorkStatusLabel(threadWorkStatus, {
                    cleanLabel:
                      thread.environmentId === "worktree" ? "Clean, Up to date" : undefined,
                  })}
                  variant={threadWorkStatusVariant(threadWorkStatus)}
                  cleanTitle={thread.environmentId === "worktree" ? "Clean, Up to date" : undefined}
                  showMergeBaseDetails={thread.environmentId === "worktree"}
                  mergeBaseBranch={selectedMergeBaseBranch ?? threadWorkStatus.mergeBaseBranch}
                  mergeBaseBranchOptions={threadWorkStatus.mergeBaseBranches}
                  onMergeBaseBranchChange={
                    thread.environmentId === "worktree"
                      ? setSelectedMergeBaseBranch
                      : undefined
                  }
                  canCommit={threadWorkStatus.hasUncommittedChanges}
                  canSquashMerge={
                    thread.environmentId === "worktree" &&
                    (
                      threadWorkStatus.hasCommittedUnmergedChanges ||
                      threadWorkStatus.hasUncommittedChanges
                    )
                  }
                  isCommitting={commitThread.isPending}
                  isSquashMerging={squashMergeThread.isPending}
                  onCommit={async ({ includeUnstaged, message }) => {
                    if (!threadId) return;
                    await commitThread.mutateAsync({
                      id: threadId,
                      includeUnstaged,
                      ...(message ? { message } : {}),
                    });
                  }}
                  onSquashMerge={async ({
                    commitIfNeeded,
                    includeUnstaged,
                    commitMessage,
                    mergeBaseBranch,
                  }) => {
                    if (!threadId) return { message: "Thread unavailable", merged: false };
                    const result = await squashMergeThread.mutateAsync({
                      id: threadId,
                      commitIfNeeded,
                      includeUnstaged,
                      ...(commitMessage ? { commitMessage } : {}),
                      ...(mergeBaseBranch ? { mergeBaseBranch } : {}),
                    });
                    if (result.conflictFiles && result.conflictFiles.length > 0) {
                      const branch =
                        result.workStatus.mergeBaseBranch ??
                        mergeBaseBranch ??
                        threadWorkStatus.mergeBaseBranch ??
                        threadWorkStatus.defaultBranch ??
                        "main";
                      const fileList = result.conflictFiles.slice(0, 12).join(", ");
                      await tellThread.mutateAsync({
                        id: threadId,
                        input: [{
                          type: "text",
                          text:
                            `Squash merge into ${branch} reported conflicts (${fileList}). ` +
                            `Please merge ${branch} into this worktree branch, resolve conflicts, run relevant checks, and commit the fix. ` +
                            "When done, let me know so I can retry squash merge.",
                        }],
                      }).catch(() => undefined);
                    }
                    return { message: result.message, merged: result.merged };
                  }}
                />
              </DetailRow>
            ) : null}
            {thread.environmentId === "worktree" && threadWorkStatus?.workspaceRoot ? (
              <DetailRow
                label="Worktree"
                valueClassName="min-w-0"
                align="center"
              >
                <button
                  type="button"
                  className="w-full truncate text-left text-xs underline underline-offset-2"
                  title={threadWorkStatus.workspaceRoot}
                  onClick={() => {
                    void openPathInEditor(threadWorkStatus.workspaceRoot!, {
                      target: "directory",
                      command: getPathCommandForTarget("directory"),
                    });
                  }}
                >
                  {threadWorkStatus.workspaceRoot}
                  {threadWorkStatus.currentBranch
                    ? ` (${threadWorkStatus.currentBranch})`
                    : ""}
                </button>
              </DetailRow>
            ) : null}
            {thread.archivedAt !== undefined ? (
              <DetailRow
                label="Archived"
                valueClassName="min-w-0 truncate"
                align="center"
                className="group"
              >
                <ArchiveTimestampAction
                  isPending={
                    unarchiveThread.isPending &&
                    unarchiveThread.variables?.id === thread.id
                  }
                  onUnarchive={() => {
                    unarchiveThread.mutate({ id: thread.id });
                  }}
                />
              </DetailRow>
            ) : null}
          </DetailCard>
        </section>
      ) : null}
      <ConversationTimeline>
        {isTimelineLoading && threadDetailRows.length === 0 ? (
          <ConversationEmptyState message="Loading events..." />
        ) : threadDetailRows.length === 0 ? (
          <ConversationEmptyState message="No events yet" />
        ) : (
          threadDetailRows.map((entry) => {
            const isLatestActivity =
              shouldHighlightLatest && entry.id === latestActivityRowId;
            return entry.kind === "tool-group" ? (
              <ToolGroupEntry
                key={`${threadId}:${entry.id}`}
                projectId={projectId}
                entry={entry}
                messages={toolGroupMessagesById[entry.id] ?? entry.messages}
                isLoadingMessages={loadingToolGroupIds.has(entry.id)}
                onLoadMessages={() => handleLoadToolGroupMessages(entry)}
                isLatestActivity={isLatestActivity}
              />
            ) : (
              <ConversationEntry
                key={`${threadId}:${entry.id}`}
                message={entry.message}
                projectId={projectId}
                initialExpanded={isLatestActivity}
                preferOngoingLabels={isLatestActivity}
              />
            );
          })
        )}
      </ConversationTimeline>
      {thread.status === "active" ? (
        <ConversationWorkingIndicator isThinking={isReasoningBlockActive} />
      ) : null}
    </>
  );

  return (
    <PageShell
      scrollRef={containerRef}
      onScroll={handleScroll}
      contentClassName="gap-2 pt-0"
      footerUsesPromptPadding
      footer={
        <div ref={promptComposerRef}>
          <PromptComposerShell statusLabel={provisioningStatusLabel}>
            <ScrollToBottomButton
              visible={showScrollToBottom}
              onClick={scrollToBottom}
            />
            {threadWorkStatus && threadWorkStatus.workspaceChangedFiles > 0 ? (
              <div className="mb-2 rounded-md border border-border/60 bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
                <div className="flex items-center justify-between gap-3">
                  <button
                    type="button"
                    className="flex min-w-0 items-center gap-2 truncate text-left"
                    onClick={() => setIsChangeListExpanded((prev) => !prev)}
                  >
                    <span className="truncate">
                      {formatWorkspaceChangeSummary(threadWorkStatus)}
                    </span>
                    <ChevronDown
                      className={`size-3.5 shrink-0 transition-transform duration-200 ${
                        isChangeListExpanded ? "rotate-180" : ""
                      }`}
                    />
                  </button>
                  {thread.environmentId !== "worktree" ? (
                    <span className="shrink-0 text-xs text-muted-foreground/90">
                      Includes all threads in this working directory
                    </span>
                  ) : null}
                </div>
                <div
                  className={`overflow-hidden transition-all duration-200 ${
                    isChangeListExpanded ? "mt-2 max-h-40 border-t border-border/50 pt-1 opacity-100" : "max-h-0 opacity-0"
                  }`}
                >
                  <WorkspaceChangesList
                    files={threadWorkStatus.files}
                    workspaceRoot={threadWorkStatus.workspaceRoot}
                  />
                </div>
              </div>
            ) : null}
            <QueuedFollowUpList
              queuedMessages={queuedMessages}
              sendDisabled={!canSendFollowUp || isFollowUpSubmitting || isQueueMutationPending}
              actionDisabled={isFollowUpSubmitting || isQueueMutationPending}
              processingMessageId={processingQueuedMessageId}
              onSendImmediately={handleSendQueuedImmediately}
              onEdit={handleEditQueuedMessage}
              onDelete={handleDeleteQueuedMessage}
            />
            <PromptBox
              value={message}
              onChange={promptDraft.setText}
              onSubmit={handleSend}
              zenModeLayout="thread"
              onStop={
                thread.status === "active"
                  ? () => stopThread.mutate(thread.id)
                  : undefined
              }
              isSubmitting={isFollowUpSubmitting}
              submitDisabled={!canSendFollowUp || isFollowUpSubmitting}
              submitTitle={
                thread.status === "active"
                  ? "Queue follow-up (Enter)"
                  : "Submit (Enter)"
              }
              isRunning={thread.status === "active"}
              placeholder={promptPlaceholder}
              submitMode="enter"
              autoFocus
              mentionSuggestions={fileMentions.suggestions}
              mentionLoading={fileMentions.isLoading}
              mentionError={fileMentions.isError}
              onMentionQueryChange={fileMentions.setQuery}
              attachments={promptDraft.attachments}
              attachmentProjectId={projectId}
              onAttachFiles={handleAttachFiles}
              onRemoveAttachment={promptDraft.removeAttachment}
              isAttaching={uploadPromptAttachment.isPending}
              attachmentError={attachmentError}
              footerStart={
                <>
                  {supportsModelList ? (
                    <PromptOptionPicker
                      label="Model"
                      value={activeModel?.model ?? selectedModel}
                      options={modelOptions}
                      onChange={setSelectedModel}
                    />
                  ) : null}
                  {supportsReasoningLevels ? (
                    <PromptOptionPicker
                      label="Reasoning"
                      value={reasoningLevel}
                      options={reasoningOptions}
                      onChange={setReasoningLevel}
                    />
                  ) : null}
                  <PromptOptionPicker
                    label="Sandbox"
                    value={sandboxMode}
                    options={sandboxOptions}
                    onChange={setSandboxMode}
                  />
                </>
              }
            />
            {contextWindowUsage ? (
              <div className="mt-1 flex justify-end pr-0.5">
                <ThreadContextWindowIndicator usage={contextWindowUsage} />
              </div>
            ) : null}
          </PromptComposerShell>
        </div>
      }
    >
      {conversationMain}
    </PageShell>
  );
}
