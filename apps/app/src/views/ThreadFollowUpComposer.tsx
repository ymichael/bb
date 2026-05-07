import { type ComponentProps, type ComponentType, type ReactNode } from "react";
import { HostStatusBadge } from "@/components/HostStatusIndicator";
import {
  CornerDownRight,
  GitMerge,
  Pencil,
  Trash2,
  ChevronDown,
} from "lucide-react";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import {
  type PermissionMode,
  type ReasoningLevel,
  type ServiceTier,
  type ThreadQueuedMessage,
  type ThreadRuntimeDisplayStatus,
  type WorkspaceFileStatus,
  type WorkspaceStatus,
} from "@bb/domain";
import {
  PromptBox,
  type PromptBoxAttachmentsConfig,
  type PromptBoxHistoryConfig,
  type PromptBoxMentionsConfig,
} from "@/components/promptbox/PromptBox";
import {
  PromptOptionDisplay,
  type PromptOption,
} from "@/components/promptbox/PromptOptionPicker";
import {
  PromptExecutionControls,
  PromptPermissionModePicker,
} from "@/components/promptbox/PromptExecutionControls";
import { useBottomAnchoredScroll } from "@/components/ui";
import { Button } from "@/components/ui";
import { ThreadTimelineScrollToBottomButton } from "./ThreadTimelineScrollToBottomButton";
import { WorkspaceChangesList } from "@/components/thread/WorkspaceChangesList";
import {
  getMergeBaseBranchCandidates,
  MergeBaseBranchPicker,
} from "@/components/thread/MergeBaseBranchPicker";
import { ThreadContextWindowIndicator } from "@/components/thread-timeline";
import { cn } from "@/lib/utils";
import {
  countQueuedMessageAttachments,
  formatQueuedFollowUpPreview,
} from "./threadQueuedMessages";

type PromptBoxWithScrollAnchorProps = ComponentProps<typeof PromptBox>;

function PromptBoxWithScrollAnchor({
  onSubmit,
  ...promptBoxProps
}: PromptBoxWithScrollAnchorProps) {
  const bottomAnchor = useBottomAnchoredScroll();
  const handleSubmit = () => {
    onSubmit();
    bottomAnchor?.scrollToBottom();
  };
  return <PromptBox {...promptBoxProps} onSubmit={handleSubmit} />;
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
        <p className="text-xs text-muted-foreground">
          Queued ({queuedMessages.length})
        </p>
      </div>
      <ul>
        {queuedMessages.map((queuedMessage, index) => {
          const preview = formatQueuedFollowUpPreview(queuedMessage.content);
          const attachmentCount = countQueuedMessageAttachments(
            queuedMessage.content,
          );
          const isProcessing = processingMessageId === queuedMessage.id;
          return (
            <li key={queuedMessage.id} className="px-2.5 py-0.5">
              <div className="flex items-center gap-1.5">
                <div className="p-0.5 text-muted-foreground">
                  <CornerDownRight className="size-3.5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-1 text-xs leading-4">
                    <p
                      className="min-w-0 truncate text-foreground"
                      title={preview}
                    >
                      {preview}
                    </p>
                    {attachmentCount > 0 ? (
                      <>
                        <span className="shrink-0 text-muted-foreground">
                          .
                        </span>
                        <span className="shrink-0 text-muted-foreground">
                          {attachmentCount === 1
                            ? "1 attachment"
                            : `${attachmentCount} attachments`}
                        </span>
                      </>
                    ) : null}
                    {isProcessing ? (
                      <>
                        <span className="shrink-0 text-muted-foreground">
                          .
                        </span>
                        <span className="shrink-0 text-muted-foreground">
                          Sending...
                        </span>
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

export interface ComposerAttachmentsProps {
  attachmentError: string | null;
  attachments: NonNullable<PromptBoxAttachmentsConfig["items"]>;
  isAttaching: boolean;
  onAttachFiles: (files: File[]) => void | Promise<void>;
  onRemoveAttachment: (path: string) => void;
  projectId: string;
}

export interface ComposerBannerProps {
  canExpandPromptChangeList: boolean;
  isChangeListExpanded: boolean;
  isDiffPanelActive: boolean;
  mergeBaseBranchOptions?: readonly string[];
  mergeBaseBranchOptionsLoading?: boolean;
  onPromptBannerFileClick: (file: { path: string }) => void;
  onPromptBannerMergeBaseBranchChange?: (branch: string) => void;
  onPromptBannerMergeBaseBranchPickerOpenChange?: (open: boolean) => void;
  onPromptGitStatsBannerClick: () => void;
  onToggleChangeListExpanded: () => void;
  promptBannerFiles?: WorkspaceFileStatus[];
  promptBannerMergeBaseBranch?: string;
  promptBannerSummary: ReactNode;
  showBranchComparisonUi: boolean;
  showPromptGitStatsBanner: boolean;
  workspaceStatus?: WorkspaceStatus | null;
}

export interface ComposerCoreProps {
  canSendFollowUp: boolean;
  history: PromptBoxHistoryConfig;
  isFollowUpSubmitting: boolean;
  message: string;
  onChangeMessage: (value: string) => void;
  onStop?: () => void;
  onSubmit: () => void;
  processingQueuedMessageId: string | null;
  promptPlaceholder: string;
  threadId: string;
  threadRuntimeDisplayStatus: ThreadRuntimeDisplayStatus;
}

export interface ComposerEnvironmentProps {
  contextWindowUsage?: ComponentProps<
    typeof ThreadContextWindowIndicator
  >["usage"];
  environmentBranchName?: string;
  environmentHostConnected?: boolean;
  environmentIcon?: ComponentType<{ className?: string }>;
  environmentLabel?: ReactNode;
}

export interface ComposerExecutionProps {
  activeModel?: { model: string } | null;
  hasMultipleProviders?: boolean;
  modelOptions: readonly PromptOption<string>[];
  onPermissionModeChange: (value: PermissionMode) => void;
  onReasoningLevelChange: (value: ReasoningLevel) => void;
  onSelectedModelChange: (value: string) => void;
  onServiceTierChange: (value: ServiceTier | undefined) => void;
  permissionMode?: PermissionMode;
  permissionModeOptions: readonly PromptOption<PermissionMode>[];
  providerDisplayName?: string;
  providerOptions?: readonly PromptOption<string>[];
  reasoningLevel: ReasoningLevel;
  reasoningOptions: readonly PromptOption<ReasoningLevel>[];
  selectedModel: string;
  selectedProviderId?: string;
  serviceTier?: ServiceTier;
  supportsPermissionModeSelection: boolean;
  supportsServiceTier: boolean;
  serviceTierSupportByProvider?: Record<string, boolean>;
}

export interface ComposerMentionsProps {
  mentionError: boolean;
  mentionLoading: boolean;
  mentionSuggestions: PromptBoxMentionsConfig["suggestions"];
  onMentionQueryChange: NonNullable<PromptBoxMentionsConfig["onQueryChange"]>;
}

export interface ComposerQueueProps {
  isQueueMutationPending: boolean;
  onDeleteQueuedMessage: (messageId: string) => void;
  onEditQueuedMessage: (messageId: string) => void;
  onSendQueuedImmediately: (messageId: string) => void;
  queuedMessages: readonly ThreadQueuedMessage[];
}

export interface ThreadFollowUpComposerProps {
  attachments: ComposerAttachmentsProps;
  banner: ComposerBannerProps;
  composer: ComposerCoreProps;
  environment: ComposerEnvironmentProps;
  execution: ComposerExecutionProps;
  mentions: ComposerMentionsProps;
  queue: ComposerQueueProps;
}

export function ThreadFollowUpComposer({
  attachments,
  banner,
  composer,
  environment,
  execution,
  mentions,
  queue,
}: ThreadFollowUpComposerProps) {
  const promptBannerMergeBaseCandidates = getMergeBaseBranchCandidates({
    mergeBaseBranch: banner.promptBannerMergeBaseBranch,
    mergeBaseBranchOptions: banner.mergeBaseBranchOptions,
  });
  const canSelectPromptBannerMergeBase = Boolean(
    banner.showBranchComparisonUi &&
    banner.promptBannerMergeBaseBranch &&
    banner.onPromptBannerMergeBaseBranchChange &&
    promptBannerMergeBaseCandidates.length > 0,
  );
  const canQueueFollowUp =
    composer.threadRuntimeDisplayStatus === "active" ||
    composer.threadRuntimeDisplayStatus === "host-reconnecting";
  const canStopRuntime =
    canQueueFollowUp ||
    composer.threadRuntimeDisplayStatus === "waiting-for-host";

  return (
    <>
      <ThreadTimelineScrollToBottomButton
        active={composer.threadRuntimeDisplayStatus === "active"}
      />
      <div className="space-y-2">
        {banner.showPromptGitStatsBanner ? (
          <div
            className={cn(
              "mb-2 rounded-md border border-border/60 bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground",
              !banner.isDiffPanelActive &&
                "cursor-pointer transition-colors hover:bg-muted/55",
            )}
            onClick={banner.onPromptGitStatsBannerClick}
          >
            <div className="flex items-center justify-between gap-3">
              {banner.canExpandPromptChangeList ? (
                <button
                  type="button"
                  className="flex min-w-0 items-center gap-2 truncate text-left"
                  onClick={(event) => {
                    event.stopPropagation();
                    banner.onToggleChangeListExpanded();
                  }}
                >
                  <span className="truncate">{banner.promptBannerSummary}</span>
                  <ChevronDown
                    className={cn(
                      "size-3.5 shrink-0 transition-transform duration-200",
                      banner.isChangeListExpanded && "rotate-180",
                    )}
                  />
                </button>
              ) : (
                <span className="truncate">{banner.promptBannerSummary}</span>
              )}
              {banner.showBranchComparisonUi ? (
                canSelectPromptBannerMergeBase &&
                banner.promptBannerMergeBaseBranch ? (
                  <div
                    className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground/90"
                    onClick={(event) => {
                      event.stopPropagation();
                    }}
                  >
                    <span className="shrink-0">Merge base:</span>
                    <MergeBaseBranchPicker
                      value={banner.promptBannerMergeBaseBranch}
                      options={promptBannerMergeBaseCandidates}
                      variant="minimal"
                      loading={banner.mergeBaseBranchOptionsLoading}
                      onChange={(branch) => {
                        banner.onPromptBannerMergeBaseBranchChange?.(branch);
                      }}
                      onOpenChange={
                        banner.onPromptBannerMergeBaseBranchPickerOpenChange
                      }
                      className="max-w-[10rem] text-muted-foreground/90"
                    />
                  </div>
                ) : (
                  <span className="shrink-0 text-xs text-muted-foreground/90">
                    {banner.promptBannerMergeBaseBranch
                      ? `Merge base: ${banner.promptBannerMergeBaseBranch}`
                      : "Merge base comparison"}
                  </span>
                )
              ) : (
                <span className="shrink-0 text-xs text-muted-foreground/90">
                  Includes all threads in this working directory
                </span>
              )}
            </div>
            {banner.canExpandPromptChangeList && banner.promptBannerFiles ? (
              <div
                className={cn(
                  "grid overflow-hidden transition-[grid-template-rows,opacity,margin,padding,border-color] duration-200 ease-out",
                  banner.isChangeListExpanded
                    ? "mt-2 grid-rows-[1fr] border-t border-border/50 pt-1 opacity-100"
                    : "grid-rows-[0fr] border-t border-transparent pt-0 opacity-0",
                )}
                onClick={(event) => {
                  event.stopPropagation();
                }}
              >
                <div className="overflow-hidden">
                  <WorkspaceChangesList
                    files={banner.promptBannerFiles}
                    onFileClick={banner.onPromptBannerFileClick}
                  />
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
        <QueuedFollowUpList
          queuedMessages={queue.queuedMessages}
          sendDisabled={
            !composer.canSendFollowUp ||
            composer.isFollowUpSubmitting ||
            queue.isQueueMutationPending
          }
          actionDisabled={
            composer.isFollowUpSubmitting || queue.isQueueMutationPending
          }
          processingMessageId={composer.processingQueuedMessageId}
          onSendImmediately={queue.onSendQueuedImmediately}
          onEdit={queue.onEditQueuedMessage}
          onDelete={queue.onDeleteQueuedMessage}
        />
        <PromptBoxWithScrollAnchor
          value={composer.message}
          onChange={composer.onChangeMessage}
          onSubmit={composer.onSubmit}
          history={composer.history}
          placeholder={composer.promptPlaceholder}
          autoFocus
          submission={{
            onStop: canStopRuntime ? composer.onStop : undefined,
            isSubmitting: composer.isFollowUpSubmitting,
            disabled:
              !composer.canSendFollowUp || composer.isFollowUpSubmitting,
            title: canQueueFollowUp
              ? "Queue follow-up (Enter)"
              : "Submit (Enter)",
            isRunning: canStopRuntime,
            mode: "enter",
          }}
          mentions={{
            suggestions: mentions.mentionSuggestions,
            isLoading: mentions.mentionLoading,
            isError: mentions.mentionError,
            onQueryChange: mentions.onMentionQueryChange,
          }}
          attachments={{
            items: attachments.attachments,
            projectId: attachments.projectId,
            onAttachFiles: attachments.onAttachFiles,
            onRemove: attachments.onRemoveAttachment,
            isAttaching: attachments.isAttaching,
            error: attachments.attachmentError,
          }}
          zenMode={{
            layout: "thread",
            storageKey: null,
            resetKey: composer.threadId,
            resetOnSubmit: true,
          }}
          footerStart={
            <PromptExecutionControls
              provider={{
                hasMultiple: execution.hasMultipleProviders,
                options: execution.providerOptions,
                selectedId: execution.selectedProviderId,
                displayName: execution.providerDisplayName,
                readOnly: true,
              }}
              model={{
                active: execution.activeModel,
                selected: execution.selectedModel,
                options: execution.modelOptions,
                onChange: execution.onSelectedModelChange,
              }}
              serviceTier={{
                value: execution.serviceTier,
                onChange: execution.onServiceTierChange,
                supported: execution.supportsServiceTier,
                supportByProvider: execution.serviceTierSupportByProvider,
              }}
              reasoning={{
                value: execution.reasoningLevel,
                options: execution.reasoningOptions,
                onChange: execution.onReasoningLevelChange,
              }}
            />
          }
        />
        <div className="mt-1 flex min-h-6 items-center justify-between gap-2 pl-[15px] pr-3.5">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
            {environment.environmentLabel ||
            environment.environmentHostConnected !== undefined ? (
              <div className="flex min-w-0 items-center gap-2 pr-1.5">
                {environment.environmentLabel ? (
                  <PromptOptionDisplay
                    label="Environment"
                    value={
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate">
                          {environment.environmentLabel}
                        </span>
                        {environment.environmentHostConnected !== undefined ? (
                          <HostStatusBadge
                            connected={environment.environmentHostConnected}
                            className="translate-y-px"
                          />
                        ) : null}
                      </span>
                    }
                    icon={environment.environmentIcon}
                    className="h-6 min-w-[80px]"
                  />
                ) : environment.environmentHostConnected !== undefined ? (
                  <HostStatusBadge
                    connected={environment.environmentHostConnected}
                  />
                ) : null}
                {environment.environmentBranchName ? (
                  <button
                    type="button"
                    className="hidden min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground/75 transition-colors hover:bg-accent hover:text-foreground md:flex"
                    title={`Copy branch name: ${environment.environmentBranchName}`}
                    onClick={() => {
                      const branchName = environment.environmentBranchName;
                      if (!branchName) return;
                      void copyToClipboardWithToast(branchName, {
                        successMessage: "Branch name copied",
                        errorMessage: "Failed to copy branch name",
                      });
                    }}
                  >
                    <GitMerge className="size-3.5 shrink-0" />
                    <span className="truncate">
                      {environment.environmentBranchName}
                    </span>
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <PromptPermissionModePicker
              value={execution.permissionMode}
              options={execution.permissionModeOptions}
              onChange={execution.onPermissionModeChange}
              supported={execution.supportsPermissionModeSelection}
              className="h-6"
            />
            {environment.contextWindowUsage ? (
              <ThreadContextWindowIndicator
                usage={environment.contextWindowUsage}
              />
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}
