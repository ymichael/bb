import { useRef, type ComponentProps, type ReactNode } from "react";
import { type ThreadRuntimeDisplayStatus } from "@bb/domain";
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
import { ThreadContextWindowIndicator } from "@/components/thread-timeline";

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


/**
 * Discriminated state for the composer's submit affordances. Replaces the
 * previous canSendFollowUp / canQueueFollowUp / canStopRuntime / onStop
 * boolean soup. The caller computes one of these from runtimeDisplayStatus +
 * pending-interaction state and passes it down; the composer reads .kind to
 * render submit/queue/stop affordances.
 */
export type FollowUpBlockedReason =
  | "pending-interaction"
  | "provisioning"
  | "stopping";

export type FollowUpSubmitMode =
  /** Idle thread — submit creates a new turn; no stop affordance. */
  | { kind: "ready" }
  /** Runtime is active or host-reconnecting — submit queues the message; stop the runtime. */
  | { kind: "queue"; onStop: () => void }
  /** Runtime is waiting on the host — can't send/queue, but can stop. */
  | { kind: "stop-only"; onStop: () => void }
  /** Can't submit and can't stop — show why. */
  | { kind: "blocked"; reason: FollowUpBlockedReason };

export interface FollowUpComposerProps {
  history: HistoryConfig;
  /** True while the send/queue mutation is in flight. Orthogonal to submitMode. */
  isFollowUpSubmitting: boolean;
  message: string;
  onChangeMessage: (value: string) => void;
  onSubmit: () => void;
  promptPlaceholder: string;
  submitMode: FollowUpSubmitMode;
  /** Used by the scroll-to-bottom button to know whether the runtime is actively streaming. */
  threadRuntimeDisplayStatus: ThreadRuntimeDisplayStatus;
}

type ContextWindowUsage = ComponentProps<
  typeof ThreadContextWindowIndicator
>["usage"];


export interface FollowUpPromptBoxProps {
  attachments: AttachmentsConfig;
  /**
   * Slot for the stack of context cards above the prompt input — today
   * <ContextBanner> + <QueuedMessagesList>, both wrapped in PromptStackCard
   * chrome. The caller composes whatever should render above the composer
   * and passes it as a single element. Pass null to hide the stack entirely.
   */
  stack: ReactNode | null;
  composer: FollowUpComposerProps;
  /** Slot for the read-only environment strip in the bottom row. Pass null to hide. */
  environmentSummary: ReactNode | null;
  /**
   * Token usage indicator shown to the right of the permission picker. Null
   * means no usage available yet (e.g. thread just created); the indicator is
   * hidden in that case.
   */
  contextWindowUsage: ContextWindowUsage | null;
  /**
   * Execution controls (provider + model + service tier + reasoning) rendered
   * in PromptBox's footer slot. Callers omit provider.onChange so the picker
   * renders the provider as locked — follow-ups can't change provider, the
   * thread is already committed.
   */
  execution: ExecutionControlsProps;
  /** Permission mode picker rendered in the bottom row. */
  permission: ExecutionPermissionConfig;
  mentions: MentionsConfig;
  /** zenMode resetKey — typically the active thread id, so zen-mode collapses on thread change. */
  zenModeResetKey: string | number;
}

export function FollowUpPromptBox({
  attachments,
  stack,
  composer,
  environmentSummary,
  contextWindowUsage,
  execution,
  permission,
  mentions,
  zenModeResetKey,
}: FollowUpPromptBoxProps) {
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
        {stack}
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
          mentions={mentions}
          attachments={attachments}
          zenMode={{
            layout: "thread",
            storageKey: null,
            resetKey: zenModeResetKey,
            resetOnSubmit: true,
          }}
          footerStart={<ExecutionControls {...execution} />}
        />
        <div className="mt-1 flex min-h-6 items-center justify-between gap-2 pl-[15px] pr-3.5">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
            {environmentSummary}
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
