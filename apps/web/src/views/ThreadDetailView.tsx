import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useThread, useThreadEvents, useTellThread, useStopThread } from "../hooks/useApi";
import {
  ConversationEntry,
} from "@/components/messages/ConversationEntry";
import { ConversationWorkingIndicator } from "@/components/messages/ConversationWorkingIndicator";
import { PromptBox } from "@/components/promptbox/PromptBox";
import { PromptOptionPicker } from "@/components/promptbox/PromptOptionPicker";
import { useAutoScroll } from "@/hooks/useAutoScroll";
import { usePromptModelReasoning } from "@/hooks/usePromptModelReasoning";
import { ArrowDown, ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePromptDraftStorage } from "@/hooks/usePromptDraftStorage";
import { useDebugMode } from "@/hooks/useDebugMode";
import { usePromptFileMentions } from "@/hooks/usePromptFileMentions";
import { toUIMessages } from "@beanbag/core";
import { buildThreadDetailRows, type ThreadDetailToolGroupRow } from "./threadDetailRows";

const SCROLL_THRESHOLD = 40;
const HEADER_COLLAPSED_TONE_CLASS =
  "text-muted-foreground/70 transition-colors hover:text-foreground/90 focus-visible:text-foreground/90";
const HEADER_EXPANDED_TONE_CLASS = "text-foreground/90";
const HEADER_BUTTON_BASE_CLASS =
  "inline-flex max-w-full items-center gap-1 overflow-hidden py-0.5 text-left text-sm";
const HEADER_TEXT_CLASS = "min-w-0 truncate";
const HEADER_CHEVRON_COLLAPSED_CLASS =
  "size-4 shrink-0 opacity-0 transition-opacity group-hover:opacity-100";

function ToolGroupEntry({ entry }: { entry: ThreadDetailToolGroupRow }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const count = entry.messages.length;
  const summaryContent = `${count} tools and changes`;
  const headerToneClass = isExpanded
    ? HEADER_EXPANDED_TONE_CLASS
    : HEADER_COLLAPSED_TONE_CLASS;

  return (
    <div className="group w-full" style={{ overflowAnchor: "none" }}>
      <div className="mr-auto w-full">
        <div className="rounded-md text-muted-foreground">
          <div className="px-2 py-1">
            <button
              type="button"
              onClick={() => setIsExpanded((prev) => !prev)}
              className={`${HEADER_BUTTON_BASE_CLASS} ${headerToneClass}`}
            >
              <span className={HEADER_TEXT_CLASS}>{summaryContent}</span>
              {isExpanded ? (
                <ChevronDown className="size-4 shrink-0" />
              ) : (
                <ChevronRight className={HEADER_CHEVRON_COLLAPSED_CLASS} />
              )}
            </button>
          </div>
          {isExpanded ? (
            <div className="px-2 pb-1">
              <div className="overflow-hidden rounded-md border border-border/60 bg-background/40">
                {entry.messages.map((message) => (
                  <ConversationEntry key={message.id} message={message} />
                ))}
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
  const { data: events } = useThreadEvents(threadId ?? "");
  const { debugMode } = useDebugMode();
  const tellThread = useTellThread();
  const stopThread = useStopThread();
  const promptDraft = usePromptDraftStorage({ projectId, threadId });
  const fileMentions = usePromptFileMentions(projectId);
  const message = promptDraft.value;
  const [showScrollToLatest, setShowScrollToLatest] = useState(false);
  const {
    selectedModel,
    setSelectedModel,
    reasoningLevel,
    setReasoningLevel,
    activeModel,
    modelOptions,
    reasoningOptions,
  } = usePromptModelReasoning();

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

  const isReasoningBlockActive = useMemo(
    () =>
      uiMessages.some(
        (entry) => entry.kind === "assistant-reasoning" && entry.status === "streaming",
      ),
    [uiMessages],
  );

  const { containerRef, handleScroll: baseHandleScroll } = useAutoScroll(
    threadDetailRows.length,
    threadId,
  );

  useEffect(() => {
    setShowScrollToLatest(false);
  }, [threadId]);

  const handleScroll = useCallback(() => {
    baseHandleScroll();
    const el = containerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowScrollToLatest(distanceFromBottom > SCROLL_THRESHOLD);
  }, [baseHandleScroll, containerRef]);

  const scrollToLatest = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setShowScrollToLatest(false);
  }, [containerRef]);

  if (!projectId || !threadId) {
    return <p className="text-sm text-destructive py-12 text-center">Not found</p>;
  }
  if (isLoading) return <p className="text-sm text-muted-foreground py-12 text-center">Loading...</p>;
  if (
    error ||
    !thread ||
    thread.projectId !== projectId
  ) {
    return (
      <p className="text-sm text-destructive py-12 text-center">
        {error ? error.message : "Not found"}
      </p>
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

  const handleSend = () => {
    const trimmed = message.trim();
    if (!trimmed) return;
    tellThread.mutate(
      {
        id: thread.id,
        input: [{ type: "text", text: trimmed }],
        model: activeModel?.model ?? selectedModel,
        reasoningLevel,
      },
      { onSuccess: () => promptDraft.clear() },
    );
  };

  return (
    <div className="-mx-4 -mt-4 flex h-full min-h-0 flex-1 flex-col overflow-hidden md:-mx-5 md:-mt-5">
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <div
          ref={containerRef}
          onScroll={handleScroll}
          className="min-h-0 flex-1 overflow-y-auto"
        >
          <div className="mx-auto flex w-full max-w-[800px] flex-col gap-1 px-4 pb-4 pt-2">
            {threadDetailRows.length === 0 ? (
              <div className="py-16 text-center text-sm text-muted-foreground">
                No events yet
              </div>
            ) : (
              threadDetailRows.map((entry) =>
                entry.kind === "tool-group" ? (
                  <ToolGroupEntry key={`${threadId}:${entry.id}`} entry={entry} />
                ) : (
                  <ConversationEntry
                    key={`${threadId}:${entry.id}`}
                    message={entry.message}
                  />
                ),
              )
            )}
            {thread.status === "active" ? (
              <ConversationWorkingIndicator isThinking={isReasoningBlockActive} />
            ) : null}
          </div>
        </div>

        <div className="shrink-0">
          <div className="chat-prompt-box mx-auto w-full max-w-[800px] bg-background px-4 pb-4 pt-2">
            {isCreated || isProvisioning || isProvisioningFailed ? (
              <div className="pb-2 text-xs text-muted-foreground">
                {isCreated
                  ? "Created..."
                  : isProvisioning
                  ? "Provisioning..."
                  : "Provisioning failed"}
              </div>
            ) : null}
            <div className="flex h-0 items-center justify-center">
              <button
                onClick={scrollToLatest}
                className={cn(
                  "z-20 -mt-20 flex size-8 items-center justify-center rounded-full border border-foreground/20 bg-background/80 shadow-md backdrop-blur-md transition-all duration-200 hover:border-foreground/30 hover:bg-background/90",
                  showScrollToLatest
                    ? "translate-y-0 opacity-100"
                    : "pointer-events-none translate-y-2 opacity-0",
                )}
                aria-label="Scroll to latest event"
                type="button"
              >
                <ArrowDown className="size-4" />
              </button>
            </div>
            <PromptBox
              value={message}
              onChange={promptDraft.setValue}
              onSubmit={handleSend}
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
              footerStart={
                <>
                  <PromptOptionPicker
                    label="Model"
                    value={activeModel?.model ?? selectedModel}
                    options={modelOptions}
                    onChange={setSelectedModel}
                  />
                  <PromptOptionPicker
                    label="Reasoning"
                    value={reasoningLevel}
                    options={reasoningOptions}
                    onChange={setReasoningLevel}
                  />
                </>
              }
            />
          </div>
        </div>
      </div>
    </div>
  );
}
