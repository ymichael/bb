import { type ComponentProps, type ComponentType, type RefObject } from "react";
import { CornerDownRight, Pencil, Trash2, ChevronDown } from "lucide-react";
import {
  type ReasoningLevel,
  type SandboxMode,
  type ServiceTier,
  type ThreadQueuedMessage,
} from "@beanbag/agent-core";
import { PromptBox } from "@/components/promptbox/PromptBox";
import { PromptModelPicker } from "@/components/promptbox/PromptModelPicker";
import {
  PromptOptionDisplay,
  PromptOptionPicker,
  type PromptOption,
} from "@/components/promptbox/PromptOptionPicker";
import { Button } from "@/components/ui/button";
import { ScrollToBottomButton } from "@/components/shared/ScrollToBottomButton";
import { WorkspaceChangesList } from "@/components/shared/WorkspaceChangesList";
import { ThreadContextWindowIndicator } from "@/components/thread/ThreadContextWindowIndicator";
import { PromptComposerShell } from "@beanbag/ui-core";
import { cn } from "@/lib/utils";
import {
  countQueuedMessageAttachments,
  formatQueuedFollowUpPreview,
} from "./threadQueuedMessages";
import { ConversationStatusIndicator } from "@/components/messages/ConversationStatusIndicator";

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
            <li key={queuedMessage.id} className="px-2.5 py-0.5">
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
                        <span className="shrink-0 text-muted-foreground">.</span>
                        <span className="shrink-0 text-muted-foreground">
                          {attachmentCount === 1
                            ? "1 attachment"
                            : `${attachmentCount} attachments`}
                        </span>
                      </>
                    ) : null}
                    {isProcessing ? (
                      <>
                        <span className="shrink-0 text-muted-foreground">.</span>
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
                    className="h-auto px-0 pr-1 text-xs text-muted-foreground underline"
                    disabled={sendDisabled || isProcessing}
                    onClick={() => onSendImmediately(queuedMessage.id)}
                  >
                    {isProcessing ? "Sending..." : "Send now"}
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="size-7 text-muted-foreground"
                    disabled={actionDisabled || isProcessing}
                    onClick={() => onEdit(queuedMessage.id)}
                    aria-label={`Edit queued message ${index + 1}`}
                    title="Edit queued message"
                  >
                    <Pencil className="size-3.5" />
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
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function ThreadFollowUpComposer({
  composerRef,
  provisioningStatusLabel,
  showScrollToBottom,
  onScrollToBottom,
  showPromptGitStatsBanner,
  isGitDiffPanelOpen,
  canExpandPromptChangeList,
  isChangeListExpanded,
  onToggleChangeListExpanded,
  promptBannerSummary,
  showBranchComparisonUi,
  promptBannerMergeBaseBranch,
  resolvedThreadWorkStatus,
  threadId,
  onPromptGitStatsBannerClick,
  onPromptBannerFileClick,
  queuedMessages,
  canSendFollowUp,
  isFollowUpSubmitting,
  isQueueMutationPending,
  processingQueuedMessageId,
  onSendQueuedImmediately,
  onEditQueuedMessage,
  onDeleteQueuedMessage,
  message,
  onChangeMessage,
  onSubmit,
  threadStatus,
  onStop,
  promptPlaceholder,
  mentionSuggestions,
  mentionLoading,
  mentionError,
  onMentionQueryChange,
  attachments,
  projectId,
  onAttachFiles,
  onRemoveAttachment,
  isAttaching,
  attachmentError,
  supportsModelList,
  activeModel,
  selectedModel,
  modelOptions,
  onSelectedModelChange,
  serviceTier,
  onServiceTierChange,
  supportsServiceTier,
  supportsReasoningLevels,
  reasoningLevel,
  reasoningOptions,
  onReasoningLevelChange,
  sandboxMode,
  sandboxOptions,
  onSandboxModeChange,
  environmentLabel,
  environmentIcon,
  contextWindowUsage,
}: {
  composerRef: RefObject<HTMLDivElement | null>;
  provisioningStatusLabel?: string;
  showScrollToBottom: boolean;
  onScrollToBottom: () => void;
  showPromptGitStatsBanner: boolean;
  isGitDiffPanelOpen: boolean;
  canExpandPromptChangeList: boolean;
  isChangeListExpanded: boolean;
  onToggleChangeListExpanded: () => void;
  promptBannerSummary: string;
  showBranchComparisonUi: boolean;
  promptBannerMergeBaseBranch?: string;
  resolvedThreadWorkStatus?: {
    files?: ComponentProps<typeof WorkspaceChangesList>["files"];
  } | null;
  threadId: string;
  onPromptGitStatsBannerClick: () => void;
  onPromptBannerFileClick: (file: { path: string }) => void;
  queuedMessages: readonly ThreadQueuedMessage[];
  canSendFollowUp: boolean;
  isFollowUpSubmitting: boolean;
  isQueueMutationPending: boolean;
  processingQueuedMessageId: string | null;
  onSendQueuedImmediately: (messageId: string) => void;
  onEditQueuedMessage: (messageId: string) => void;
  onDeleteQueuedMessage: (messageId: string) => void;
  message: string;
  onChangeMessage: (value: string) => void;
  onSubmit: () => void;
  threadStatus: string;
  onStop?: () => void;
  promptPlaceholder: string;
  mentionSuggestions: ComponentProps<typeof PromptBox>["mentionSuggestions"];
  mentionLoading: boolean;
  mentionError: boolean;
  onMentionQueryChange: NonNullable<ComponentProps<typeof PromptBox>["onMentionQueryChange"]>;
  attachments: NonNullable<ComponentProps<typeof PromptBox>["attachments"]>;
  projectId: string;
  onAttachFiles: (files: File[]) => void | Promise<void>;
  onRemoveAttachment: (path: string) => void;
  isAttaching: boolean;
  attachmentError: string | null;
  supportsModelList: boolean;
  activeModel?: { model: string } | null;
  selectedModel: string;
  modelOptions: ComponentProps<typeof PromptModelPicker>["options"];
  onSelectedModelChange: ComponentProps<typeof PromptModelPicker>["onChange"];
  serviceTier?: ServiceTier;
  onServiceTierChange: (value: ServiceTier | undefined) => void;
  supportsServiceTier: boolean;
  supportsReasoningLevels: boolean;
  reasoningLevel: ReasoningLevel;
  reasoningOptions: readonly PromptOption<ReasoningLevel>[];
  onReasoningLevelChange: (value: ReasoningLevel) => void;
  sandboxMode?: SandboxMode;
  sandboxOptions: readonly PromptOption<SandboxMode>[];
  onSandboxModeChange: (value: SandboxMode) => void;
  environmentLabel?: string;
  environmentIcon?: ComponentType<{ className?: string }>;
  contextWindowUsage?: ComponentProps<typeof ThreadContextWindowIndicator>["usage"];
}) {
  return (
    <div ref={composerRef}>
      <PromptComposerShell
        statusLabel={
          provisioningStatusLabel ? (
            <ConversationStatusIndicator label={provisioningStatusLabel} />
          ) : undefined
        }
      >
        <ScrollToBottomButton
          visible={showScrollToBottom}
          onClick={onScrollToBottom}
        />
        {showPromptGitStatsBanner ? (
          <div
            className={cn(
              "mb-2 rounded-md border border-border/60 bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground",
              !isGitDiffPanelOpen && "cursor-pointer transition-colors hover:bg-muted/55",
            )}
            onClick={onPromptGitStatsBannerClick}
          >
            <div className="flex items-center justify-between gap-3">
              {canExpandPromptChangeList ? (
                <button
                  type="button"
                  className="flex min-w-0 items-center gap-2 truncate text-left"
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggleChangeListExpanded();
                  }}
                >
                  <span className="truncate">{promptBannerSummary}</span>
                  <ChevronDown
                    className={cn(
                      "size-3.5 shrink-0 transition-transform duration-200",
                      isChangeListExpanded && "rotate-180",
                    )}
                  />
                </button>
              ) : (
                <span className="truncate">{promptBannerSummary}</span>
              )}
              {showBranchComparisonUi ? (
                <span className="shrink-0 text-xs text-muted-foreground/90">
                  {promptBannerMergeBaseBranch
                    ? `Merge base: ${promptBannerMergeBaseBranch}`
                    : "Merge base comparison"}
                </span>
              ) : (
                <span className="shrink-0 text-xs text-muted-foreground/90">
                  Includes all threads in this working directory
                </span>
              )}
            </div>
            {canExpandPromptChangeList && resolvedThreadWorkStatus ? (
              <div
                className={cn(
                  "grid overflow-hidden transition-[grid-template-rows,opacity,margin,padding,border-color] duration-200 ease-out",
                  isChangeListExpanded
                    ? "mt-2 grid-rows-[1fr] border-t border-border/50 pt-1 opacity-100"
                    : "grid-rows-[0fr] border-t border-transparent pt-0 opacity-0",
                )}
                onClick={(event) => {
                  event.stopPropagation();
                }}
              >
                <div className="overflow-hidden">
                  <WorkspaceChangesList
                    files={resolvedThreadWorkStatus.files ?? []}
                    threadId={threadId}
                    onFileClick={onPromptBannerFileClick}
                  />
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
        <QueuedFollowUpList
          queuedMessages={queuedMessages}
          sendDisabled={!canSendFollowUp || isFollowUpSubmitting || isQueueMutationPending}
          actionDisabled={isFollowUpSubmitting || isQueueMutationPending}
          processingMessageId={processingQueuedMessageId}
          onSendImmediately={onSendQueuedImmediately}
          onEdit={onEditQueuedMessage}
          onDelete={onDeleteQueuedMessage}
        />
        <PromptBox
          value={message}
          onChange={onChangeMessage}
          onSubmit={onSubmit}
          zenModeLayout="thread"
          zenModeStorageKey={null}
          zenModeResetKey={threadId}
          resetZenModeOnSubmit
          onStop={threadStatus === "active" ? onStop : undefined}
          isSubmitting={isFollowUpSubmitting}
          submitDisabled={!canSendFollowUp || isFollowUpSubmitting}
          submitTitle={
            threadStatus === "active" ? "Queue follow-up (Enter)" : "Submit (Enter)"
          }
          isRunning={threadStatus === "active"}
          placeholder={promptPlaceholder}
          submitMode="enter"
          autoFocus
          mentionSuggestions={mentionSuggestions}
          mentionLoading={mentionLoading}
          mentionError={mentionError}
          onMentionQueryChange={onMentionQueryChange}
          attachments={attachments}
          attachmentProjectId={projectId}
          onAttachFiles={onAttachFiles}
          onRemoveAttachment={onRemoveAttachment}
          isAttaching={isAttaching}
          attachmentError={attachmentError}
          footerStart={
            <>
              {supportsModelList && modelOptions.length > 0 ? (
                <PromptModelPicker
                  value={activeModel?.model ?? selectedModel}
                  options={modelOptions}
                  onChange={onSelectedModelChange}
                  fastModeEnabled={serviceTier === "fast"}
                  onFastModeChange={(enabled) =>
                    onServiceTierChange(enabled ? "fast" : undefined)
                  }
                  showFastModeToggle={supportsServiceTier}
                />
              ) : null}
              {supportsReasoningLevels && reasoningOptions.length > 0 ? (
                <PromptOptionPicker
                  label="Reasoning"
                  value={reasoningLevel}
                  options={reasoningOptions}
                  onChange={onReasoningLevelChange}
                />
              ) : null}
              <PromptOptionPicker
                label="Sandbox"
                value={sandboxMode ?? sandboxOptions[0]?.value ?? "workspace-write"}
                options={sandboxOptions}
                onChange={onSandboxModeChange}
              />
            </>
          }
        />
        {environmentLabel || contextWindowUsage ? (
          <div className="mt-1 flex items-center justify-between gap-2 px-3.5">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
              {environmentLabel ? (
                <PromptOptionDisplay
                  label="Environment"
                  value={environmentLabel}
                  icon={environmentIcon}
                  className="h-6 px-0"
                />
              ) : null}
            </div>
            {contextWindowUsage ? (
              <ThreadContextWindowIndicator usage={contextWindowUsage} />
            ) : null}
          </div>
        ) : null}
      </PromptComposerShell>
    </div>
  );
}
