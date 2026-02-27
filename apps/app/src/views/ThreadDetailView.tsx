import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  useThread,
  useThreadEvents,
  useTellThread,
  useStopThread,
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
import { useAutoScroll } from "@/hooks/useAutoScroll";
import { useScrollToBottomIndicator } from "@/hooks/useScrollToBottomIndicator";
import { usePromptModelReasoning } from "@/hooks/usePromptModelReasoning";
import { usePromptDraftStorage } from "@/hooks/usePromptDraftStorage";
import { useDebugMode } from "@/hooks/useDebugMode";
import { usePromptFileMentions } from "@/hooks/usePromptFileMentions";
import { PageShell } from "@/components/layout/PageShell";
import { DetailCard, DetailRow } from "@/components/shared/DetailCard";
import { ScrollToBottomButton } from "@/components/shared/ScrollToBottomButton";
import {
  ConversationEmptyState,
  ConversationTimeline,
  PromptComposerShell,
} from "@beanbag/ui-core";
import { toUIMessages } from "@beanbag/agent-core";
import {
  buildThreadDetailRows,
  type ThreadDetailToolGroupRow,
} from "./threadDetailRows";
import {
  findLatestActivityMessageId,
  findLatestActivityRowId,
  shouldHighlightLatestActivity,
} from "./threadDetailActivity";
import {
  createLatestInitialExpandedState,
  reduceLatestInitialExpandedState,
} from "@/lib/latestInitialExpanded";
import { promptDraftToInput } from "@/lib/prompt-draft";

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
  entry,
  isLatestActivity,
}: {
  entry: ThreadDetailToolGroupRow;
  isLatestActivity: boolean;
}) {
  const { isExpanded, onToggle } = useLatestInitialExpanded(isLatestActivity);
  const latestActivityMessageId = useMemo(
    () => findLatestActivityMessageId(entry.messages),
    [entry.messages],
  );
  const count = entry.summaryCount;
  const summaryContent = `${count} tools and changes`;
  const headerToneClass = getCollapsibleHeaderToneClass(isExpanded);

  return (
    <div className="group w-full" style={{ overflowAnchor: "none" }}>
      <div className="mr-auto w-full">
        <div className="rounded-md text-muted-foreground">
          <div className="px-2 py-1">
            <CollapsibleHeader
              isExpanded={isExpanded}
              onToggle={onToggle}
              toneClassName={headerToneClass}
              summaryContent={summaryContent}
            />
          </div>
          {isExpanded ? (
            <div className="px-2 pb-1">
              <div className="overflow-hidden rounded-md border border-border/60 bg-background/40">
                {entry.messages.map((message) => {
                  const isLatestMessage =
                    isLatestActivity &&
                    message.id === latestActivityMessageId;
                  return (
                    <ConversationEntry
                      key={message.id}
                      message={message}
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
  const { data: thread, isLoading, error } = useThread(threadId ?? "");
  const { data: parentThread } = useThread(thread?.parentThreadId ?? "");
  const { data: events } = useThreadEvents(threadId ?? "");
  const { data: defaultExecutionOptions } = useThreadDefaultExecutionOptions(
    threadId ?? "",
  );
  const { debugMode } = useDebugMode();
  const tellThread = useTellThread();
  const stopThread = useStopThread();
  const uploadPromptAttachment = useUploadPromptAttachment();
  const promptDraft = usePromptDraftStorage({ projectId, threadId });
  const fileMentions = usePromptFileMentions(projectId);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
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

  const uiMessages = useMemo(
    () =>
      toUIMessages(events, {
        includeDebugRawEvents: debugMode,
        includeOptionalOperations: false,
        threadStatus: thread?.status,
      }),
    [debugMode, events, thread?.status],
  );

  const visibleMessages = useMemo(
    () => uiMessages.filter((entry) => entry.kind !== "assistant-reasoning"),
    [uiMessages],
  );
  const threadDetailRows = useMemo(
    () => buildThreadDetailRows(visibleMessages),
    [visibleMessages],
  );
  const latestActivityRowId = useMemo(
    () => findLatestActivityRowId(threadDetailRows),
    [threadDetailRows],
  );
  const shouldHighlightLatest = useMemo(
    () => shouldHighlightLatestActivity(threadDetailRows, latestActivityRowId),
    [latestActivityRowId, threadDetailRows],
  );

  const isReasoningBlockActive = useMemo(
    () =>
      uiMessages.some(
        (entry) => entry.kind === "assistant-reasoning" && entry.status === "streaming",
      ),
    [uiMessages],
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
      scrollContainer.scrollTop += heightDelta;
    });

    observer.observe(promptComposer);
    return () => {
      observer.disconnect();
      promptComposerHeightRef.current = null;
    };
  }, [containerRef, threadId]);

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
  const showThreadMetadata = Boolean(parentThreadId || thread.environmentId);
  const provisioningStatusLabel =
    isCreated
      ? "Created..."
      : isProvisioning
      ? "Provisioning..."
      : undefined;

  const handleSend = () => {
    if (promptInput.length === 0) return;
    tellThread.mutate(
      {
        id: thread.id,
        input: promptInput,
        model: activeModel?.model ?? selectedModel,
        reasoningLevel,
        sandboxMode,
      },
      {
        onSuccess: () => {
          promptDraft.clear();
          setAttachmentError(null);
        },
      },
    );
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
          </DetailCard>
        </section>
      ) : null}
      <ConversationTimeline>
        {threadDetailRows.length === 0 ? (
          <ConversationEmptyState message="No events yet" />
        ) : (
          threadDetailRows.map((entry) => {
            const isLatestActivity =
              shouldHighlightLatest && entry.id === latestActivityRowId;
            return entry.kind === "tool-group" ? (
              <ToolGroupEntry
                key={`${threadId}:${entry.id}`}
                entry={entry}
                isLatestActivity={isLatestActivity}
              />
            ) : (
              <ConversationEntry
                key={`${threadId}:${entry.id}`}
                message={entry.message}
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
              isSubmitting={tellThread.isPending}
              submitDisabled={!canSendFollowUp}
              isRunning={thread.status === "active"}
              placeholder={promptPlaceholder}
              submitMode="enter"
              autoFocus
              mentionSuggestions={fileMentions.suggestions}
              mentionLoading={fileMentions.isLoading}
              mentionError={fileMentions.isError}
              onMentionQueryChange={fileMentions.setQuery}
              attachments={promptDraft.attachments}
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
          </PromptComposerShell>
        </div>
      }
    >
      {conversationMain}
    </PageShell>
  );
}
