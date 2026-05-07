import { useRef, type ComponentProps, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import {
  type ThreadQueuedMessage,
  type ThreadRuntimeDisplayStatus,
  type WorkspaceFileStatus,
  type WorkspaceStatus,
} from "@bb/domain";
import {
  PromptBoxInternal,
  type AttachmentsConfig,
  type HistoryConfig,
  type MentionsConfig,
  type PromptBoxHandle,
} from "@/components/promptbox/PromptBoxInternal";
import { usePromptVoice } from "@/components/promptbox/usePromptVoice";
import { PermissionModePicker } from "@/components/pickers/PermissionModePicker";
import {
  ExecutionControls,
  type ExecutionControlsProps,
  type ExecutionPermissionConfig,
} from "@/components/promptbox/ExecutionControls";
import { useBottomAnchoredScroll } from "@/components/ui";
import { ThreadTimelineScrollToBottomButton } from "@/views/ThreadTimelineScrollToBottomButton";
import { WorkspaceChangesList } from "@/components/thread/WorkspaceChangesList";
import {
  getMergeBaseBranchCandidates,
  BranchPicker,
} from "@/components/pickers/BranchPicker";
import { ThreadContextWindowIndicator } from "@/components/thread-timeline";
import { cn } from "@/lib/utils";
import { QueuedMessagesList } from "@/components/promptbox/QueuedMessagesList";
import {
  ThreadEnvironmentSummary,
  type ThreadEnvironmentSummaryProps,
} from "@/components/promptbox/ThreadEnvironmentSummary";

type PromptBoxWithScrollAnchorProps = ComponentProps<typeof PromptBoxInternal>;

function PromptBoxWithScrollAnchor({
  onSubmit,
  ...promptBoxProps
}: PromptBoxWithScrollAnchorProps) {
  const bottomAnchor = useBottomAnchoredScroll();
  const handleSubmit = () => {
    onSubmit();
    bottomAnchor?.scrollToBottom();
  };
  return <PromptBoxInternal {...promptBoxProps} onSubmit={handleSubmit} />;
}


export interface ComposerAttachmentsProps {
  attachmentError: string | null;
  attachments: NonNullable<AttachmentsConfig["items"]>;
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
  onPromptBannerBranchPickerOpenChange?: (open: boolean) => void;
  onPromptGitStatsBannerClick: () => void;
  onToggleChangeListExpanded: () => void;
  promptBannerFiles?: WorkspaceFileStatus[];
  promptBannerMergeBaseBranch?: string;
  promptBannerSummary: ReactNode;
  showBranchComparisonUi: boolean;
  showPromptGitStatsBanner: boolean;
  workspaceStatus?: WorkspaceStatus | null;
}

/**
 * Discriminated state for the composer's submit affordances. Replaces the
 * previous canSendFollowUp / canQueueFollowUp / canStopRuntime / onStop
 * boolean soup. The caller computes one of these from runtimeDisplayStatus +
 * pending-interaction state and passes it down; the composer reads .kind to
 * render submit/queue/stop affordances.
 */
export type ComposerBlockedReason =
  | "pending-interaction"
  | "provisioning"
  | "stopping";

export type ComposerSubmitMode =
  /** Idle thread — submit creates a new turn; no stop affordance. */
  | { kind: "ready" }
  /** Runtime is active or host-reconnecting — submit queues the message; stop the runtime. */
  | { kind: "queue"; onStop: () => void }
  /** Runtime is waiting on the host — can't send/queue, but can stop. */
  | { kind: "stop-only"; onStop: () => void }
  /** Can't submit and can't stop — show why. */
  | { kind: "blocked"; reason: ComposerBlockedReason };

export interface ComposerCoreProps {
  history: HistoryConfig;
  /** True while the send/queue mutation is in flight. Orthogonal to submitMode. */
  isFollowUpSubmitting: boolean;
  message: string;
  onChangeMessage: (value: string) => void;
  onSubmit: () => void;
  promptPlaceholder: string;
  submitMode: ComposerSubmitMode;
  /** Used by the scroll-to-bottom button to know whether the runtime is actively streaming. */
  threadRuntimeDisplayStatus: ThreadRuntimeDisplayStatus;
}

type ContextWindowUsage = ComponentProps<
  typeof ThreadContextWindowIndicator
>["usage"];


export interface ComposerMentionsProps {
  mentionError: boolean;
  mentionLoading: boolean;
  mentionSuggestions: MentionsConfig["suggestions"];
  onMentionQueryChange: NonNullable<MentionsConfig["onQueryChange"]>;
}

export interface ComposerQueueProps {
  isQueueMutationPending: boolean;
  onDeleteQueuedMessage: (messageId: string) => void;
  onEditQueuedMessage: (messageId: string) => void;
  onSendQueuedImmediately: (messageId: string) => void;
  processingQueuedMessageId: string | null;
  queuedMessages: readonly ThreadQueuedMessage[];
}

export interface FollowUpPromptBoxProps {
  attachments: ComposerAttachmentsProps;
  banner: ComposerBannerProps;
  composer: ComposerCoreProps;
  /** Read-only environment strip rendered in the bottom row. Pass null to hide. */
  environmentSummary: ThreadEnvironmentSummaryProps | null;
  /** Token usage indicator shown to the right of the permission picker. */
  contextWindowUsage?: ContextWindowUsage;
  /**
   * Execution controls (provider + model + service tier + reasoning) rendered
   * in PromptBox's footer slot. The composer forces provider.readOnly because
   * follow-ups can't change provider — the thread is already committed.
   */
  execution: ExecutionControlsProps;
  /** Permission mode picker rendered in the bottom row. */
  permission: ExecutionPermissionConfig;
  mentions: ComposerMentionsProps;
  queue: ComposerQueueProps;
  /** zenMode resetKey — typically the active thread id, so zen-mode collapses on thread change. */
  zenModeResetKey: string | number | undefined;
}

export function FollowUpPromptBox({
  attachments,
  banner,
  composer,
  environmentSummary,
  contextWindowUsage,
  execution,
  permission,
  mentions,
  queue,
  zenModeResetKey,
}: FollowUpPromptBoxProps) {
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
  const submitMode = composer.submitMode;
  const canQueueFollowUp = submitMode.kind === "queue";
  const canSubmit =
    submitMode.kind === "ready" || submitMode.kind === "queue";
  const onStopRuntime =
    submitMode.kind === "queue" || submitMode.kind === "stop-only"
      ? submitMode.onStop
      : undefined;
  const canStopRuntime = onStopRuntime !== undefined;
  const promptBoxRef = useRef<PromptBoxHandle>(null);
  const voice = usePromptVoice(promptBoxRef);

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
                    <BranchPicker
                      value={banner.promptBannerMergeBaseBranch}
                      options={promptBannerMergeBaseCandidates}
                      variant="minimal"
                      loading={banner.mergeBaseBranchOptionsLoading}
                      onChange={(branch) => {
                        banner.onPromptBannerMergeBaseBranchChange?.(branch);
                      }}
                      onOpenChange={
                        banner.onPromptBannerBranchPickerOpenChange
                      }
                      className="max-w-[10rem]"
                      muted
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
        <QueuedMessagesList
          queuedMessages={queue.queuedMessages}
          sendDisabled={
            !canSubmit ||
            composer.isFollowUpSubmitting ||
            queue.isQueueMutationPending
          }
          actionDisabled={
            composer.isFollowUpSubmitting || queue.isQueueMutationPending
          }
          processingMessageId={queue.processingQueuedMessageId}
          onSendImmediately={queue.onSendQueuedImmediately}
          onEdit={queue.onEditQueuedMessage}
          onDelete={queue.onDeleteQueuedMessage}
        />
        <PromptBoxWithScrollAnchor
          promptBoxRef={promptBoxRef}
          voice={voice}
          value={composer.message}
          onChange={composer.onChangeMessage}
          onSubmit={composer.onSubmit}
          history={composer.history}
          placeholder={composer.promptPlaceholder}
          autoFocus
          submission={{
            onStop: onStopRuntime,
            isSubmitting: composer.isFollowUpSubmitting,
            disabled: !canSubmit || composer.isFollowUpSubmitting,
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
            resetKey: zenModeResetKey,
            resetOnSubmit: true,
          }}
          footerStart={
            <ExecutionControls
              {...execution}
              provider={{ ...execution.provider, readOnly: true }}
            />
          }
        />
        <div className="mt-1 flex min-h-6 items-center justify-between gap-2 pl-[15px] pr-3.5">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
            {environmentSummary ? (
              <ThreadEnvironmentSummary {...environmentSummary} />
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <PermissionModePicker
              value={permission.value}
              options={permission.options}
              onChange={permission.onChange}
              supported={permission.supported}
              className="h-6"
            />
            {contextWindowUsage ? (
              <ThreadContextWindowIndicator usage={contextWindowUsage} />
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}
