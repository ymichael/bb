import type { FollowUpSubmitMode } from "@bb/client-core";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type FocusEvent as ReactFocusEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import type {
  PromptTextMention,
  ThreadRuntimeDisplayStatus,
  ThreadTimelineActivePromptMode,
} from "@bb/domain";
import type { ComposerView, PluginComposerScope } from "@get-bb/plugin-sdk";
import type { ComposerTextEffectSource } from "@/lib/composer-text-effects";
import { isKeyboardFocusTarget } from "@/components/layout/useMobileVisualViewportHeight";
import { ComposerBannersSlot } from "@/components/plugin/PluginComposerBanners";
import {
  PluginComposerHostProvider,
  PluginComposerViewProvider,
  type PluginComposerHost,
  usePluginComposerHostDraft,
  usePluginComposerViewModel,
} from "@/components/plugin/plugin-composer-host";
import {
  ComposerExtensionHost,
  useComposerExtensionController,
} from "@/components/plugin/ComposerExtensionHost";
import {
  PromptBoxInternal,
  type AttachmentsConfig,
  type HistoryConfig,
  type PromptBoxAction,
  type PromptBoxHandle,
  type TypeaheadConfig,
} from "@/components/promptbox/PromptBoxInternal";
import { usePromptVoice } from "@/components/promptbox/usePromptVoice";
import { PermissionModePicker } from "@/components/pickers/PermissionModePicker";
import {
  ExecutionControls,
  type ExecutionControlsProps,
  type ExecutionPermissionConfig,
} from "@/components/promptbox/ExecutionControls";
import { useBottomAnchoredScroll } from "@/components/ui/bottom-anchored-scroll-body.js";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import { usePointerCoarse } from "@bb/shared-ui/hooks/use-pointer-coarse";
import { ThreadTimelineScrollToBottomButton } from "@/views/thread-detail/ThreadTimelineScrollToBottomButton";
import { useOptionalPaneContext } from "@/views/thread-detail/PaneContext";
import { ThreadContextWindowIndicator } from "@/components/thread/timeline";
import { PROMPT_STACK_TRACK_CLASS } from "@/components/promptbox/banner/PromptStackCard";
import { THREAD_PROMPT_CONTEXT_BANNER_ROW_HEIGHT } from "@/components/promptbox/banner/ThreadPromptContextBanner";
import {
  isPlanModePrompt,
  permissionDisplayForActivePromptMode,
  permissionDisplayForPromptMode,
  shouldDisablePermissionPickerForActivePromptMode,
} from "@bb/client-core";

type PromptBoxWithScrollAnchorProps = ComponentProps<
  typeof PromptBoxInternal
> & {
  scrollToBottomOnModifierSubmit?: boolean;
  scrollToBottomOnSubmit?: boolean;
};

function PromptBoxWithScrollAnchor({
  onSubmit,
  scrollToBottomOnModifierSubmit = true,
  scrollToBottomOnSubmit = true,
  submission,
  ...promptBoxProps
}: PromptBoxWithScrollAnchorProps) {
  const bottomAnchor = useBottomAnchoredScroll();
  const handleSubmit = () => {
    onSubmit();
    if (scrollToBottomOnSubmit) {
      bottomAnchor?.scrollToBottom();
    }
  };
  const handleModifierSubmit =
    submission?.onModifierSubmit === undefined
      ? undefined
      : () => {
          submission.onModifierSubmit?.();
          if (scrollToBottomOnModifierSubmit) {
            bottomAnchor?.scrollToBottom();
          }
        };
  const anchoredSubmission =
    submission === undefined
      ? undefined
      : {
          ...submission,
          ...(handleModifierSubmit
            ? { onModifierSubmit: handleModifierSubmit }
            : {}),
        };
  return (
    <PromptBoxInternal
      {...promptBoxProps}
      onSubmit={handleSubmit}
      submission={anchoredSubmission}
    />
  );
}

const FOLLOW_UP_PROMPT_BOX_DEFAULT_MIN_HEIGHT = 68;
const FOLLOW_UP_PROMPT_BOX_ELASTIC_TARGET_HEIGHT =
  FOLLOW_UP_PROMPT_BOX_DEFAULT_MIN_HEIGHT +
  THREAD_PROMPT_CONTEXT_BANNER_ROW_HEIGHT;
const COMPOSER_OVERLAY_TRIGGER_SELECTOR = "[aria-haspopup]";
const OPEN_COMPOSER_OVERLAY_TRIGGER_SELECTOR = `${COMPOSER_OVERLAY_TRIGGER_SELECTOR}[aria-expanded="true"]`;
const MOBILE_KEYBOARD_VIEWPORT_MIN_DELTA_PX = 80;
const MOBILE_FOCUS_EXPANSION_FALLBACK_MS = 350;
const MOBILE_KEYBOARD_DISMISSAL_FALLBACK_MS = 750;
const DEFAULT_FOLLOW_UP_COMPOSER_SCOPE = {
  kind: "new-thread",
  projectId: null,
} as const;

export type {
  FollowUpBlockedReason,
  FollowUpSubmitMode,
} from "@bb/client-core";

export interface FollowUpComposerProps {
  history: HistoryConfig;
  isFollowUpSubmitting: boolean;
  message: string;
  mentionRanges: readonly PromptTextMention[];
  onChangeMessage: (value: string, mentionRanges: PromptTextMention[]) => void;
  onModifierSubmit: () => void;
  onSubmit: () => void;
  onEscape?: () => void;
  submitTitle?: string;
  compactPromptPlaceholder: string;
  promptPlaceholder: string;
  canModifierSubmit: boolean;
  steerActiveThreadOnEnter: boolean;
  submitMode: FollowUpSubmitMode;
  threadRuntimeDisplayStatus: ThreadRuntimeDisplayStatus;
}

type ContextWindowUsage = ComponentProps<
  typeof ThreadContextWindowIndicator
>["usage"];

export interface FollowUpPromptBoxProps {
  id?: string;
  attachments: AttachmentsConfig;
  stack: ReactNode | null;
  activePromptMode?: ThreadTimelineActivePromptMode | null;
  composer: FollowUpComposerProps | null;
  environmentSummary: ReactNode | null;
  contextWindowUsage: ContextWindowUsage | null;
  execution: ExecutionControlsProps;
  permission: ExecutionPermissionConfig;
  readOnly?: boolean;
  executionReadOnly?: boolean;
  permissionReadOnly?: boolean;
  typeahead: TypeaheadConfig;
  promptActions?: readonly PromptBoxAction[];
  suppressPluginComposerCustomizations?: boolean;
  pluginComposerHost?: PluginComposerHost | null;
  pluginComposerScope?: PluginComposerScope | null;
  textEffects?: readonly ComposerTextEffectSource[];
  collapseResetKey: string | number;
  focusEndKey?: string | number;
  isPrimaryComposer?: boolean;
  showScrollToBottomButton?: boolean;
  pendingInteraction?: ReactNode;
}

type FollowUpPromptBoxWithComposerProps = Omit<
  FollowUpPromptBoxProps,
  "composer"
> & {
  composer: FollowUpComposerProps;
};

function FollowUpPromptBoxStackOnly({
  stack,
  pluginComposerHost,
  pluginComposerScope,
}: Pick<
  FollowUpPromptBoxProps,
  "stack" | "pluginComposerHost" | "pluginComposerScope"
>) {
  const composerScope =
    pluginComposerScope ?? pluginComposerHost?.scope ?? null;
  const hostDraft = usePluginComposerHostDraft(pluginComposerHost ?? null);
  const composerView = usePluginComposerViewModel({
    scope: composerScope ?? DEFAULT_FOLLOW_UP_COMPOSER_SCOPE,
    layout: "expanded",
    text: hostDraft?.text ?? "",
    attachmentCount: hostDraft?.attachments.length ?? 0,
    isRunning: false,
    isSubmitting: false,
  });
  if (!stack && !composerScope) {
    return null;
  }
  return (
    <PluginComposerViewProvider value={composerView}>
      <PluginComposerHostProvider value={pluginComposerHost ?? null}>
        <div data-promptbox-shell="" className="space-y-2">
          <div className={`grid gap-2 ${PROMPT_STACK_TRACK_CLASS}`}>
            {composerScope ? (
              <ComposerBannersSlot>{stack}</ComposerBannersSlot>
            ) : (
              stack
            )}
          </div>
        </div>
      </PluginComposerHostProvider>
    </PluginComposerViewProvider>
  );
}

function FollowUpPromptBoxWithComposer({
  id,
  attachments,
  stack,
  activePromptMode,
  composer,
  environmentSummary,
  contextWindowUsage,
  execution,
  permission,
  readOnly,
  executionReadOnly,
  permissionReadOnly,
  typeahead,
  promptActions,
  suppressPluginComposerCustomizations,
  pluginComposerHost,
  pluginComposerScope,
  textEffects,
  collapseResetKey,
  focusEndKey,
  isPrimaryComposer = true,
  showScrollToBottomButton = true,
  pendingInteraction = null,
}: FollowUpPromptBoxWithComposerProps) {
  const submitMode = composer.submitMode;
  const hasPendingInteraction =
    pendingInteraction !== null && pendingInteraction !== undefined;
  const canQueueFollowUp = submitMode.kind === "queue";
  const canSubmit = submitMode.kind === "ready" || submitMode.kind === "queue";
  const isStopping =
    submitMode.kind === "blocked" && submitMode.reason === "stopping";
  const isLoadingExecutionOptions =
    submitMode.kind === "blocked" &&
    submitMode.reason === "loading-execution-options";
  const isLoadingPendingInteractions =
    submitMode.kind === "blocked" &&
    submitMode.reason === "loading-pending-interactions";
  const isProvisioning =
    submitMode.kind === "blocked" && submitMode.reason === "provisioning";
  const isUnavailable =
    submitMode.kind === "blocked" && submitMode.reason === "unavailable";
  const onStopRuntime =
    submitMode.kind === "queue" || submitMode.kind === "stop-only"
      ? submitMode.onStop
      : undefined;
  const canStopRuntime = onStopRuntime !== undefined;
  const attachmentCount = attachments.items?.length ?? 0;
  const composerScope =
    pluginComposerScope ?? pluginComposerHost?.scope ?? null;
  const [composerLayout, setComposerLayout] =
    useState<ComposerView["layout"]>("expanded");
  const composerView = usePluginComposerViewModel({
    scope: composerScope ?? DEFAULT_FOLLOW_UP_COMPOSER_SCOPE,
    layout: composerLayout,
    text: composer.message,
    attachmentCount,
    isRunning: canStopRuntime,
    isSubmitting: composer.isFollowUpSubmitting || isStopping,
  });
  const promptBoxRef = useRef<PromptBoxHandle>(null);
  const paneContext = useOptionalPaneContext();
  const isFocusedPane = paneContext?.isFocused ?? true;
  const focusDefault = useCallback(() => {
    promptBoxRef.current?.focusEnd();
    return promptBoxRef.current !== null;
  }, []);
  const voice = usePromptVoice(promptBoxRef);
  const isCompactViewport = useIsCompactViewport();
  const isPointerCoarse = usePointerCoarse();
  const composerInteractionRef = useRef<HTMLDivElement>(null);
  const interactionExpandedRef = useRef(false);
  const pendingFocusExpansionCleanupRef = useRef<(() => void) | null>(null);
  const pendingFocusLossCleanupRef = useRef<(() => void) | null>(null);
  const pressedOverlayTriggerRef = useRef(false);
  const pressedOverlayTriggerCleanupRef = useRef<(() => void) | null>(null);
  const [isInteractionExpanded, setIsInteractionExpanded] = useState(false);
  const [widePromptBoxCollapsedFor, setWidePromptBoxCollapsedFor] = useState<
    string | number | null
  >(null);
  const isWidePromptBoxCollapsed =
    widePromptBoxCollapsedFor === collapseResetKey;
  const isComposerExpanded =
    !isWidePromptBoxCollapsed && (isInteractionExpanded || attachmentCount > 0);
  const isPromptBoxCompact =
    isWidePromptBoxCollapsed || (isCompactViewport && !isComposerExpanded);
  const compactConfig = useMemo(
    () =>
      isCompactViewport || isWidePromptBoxCollapsed
        ? {
            isCompact: isPromptBoxCompact,
            placeholder: composer.compactPromptPlaceholder,
          }
        : undefined,
    [
      composer.compactPromptPlaceholder,
      isCompactViewport,
      isPromptBoxCompact,
      isWidePromptBoxCollapsed,
    ],
  );
  const setInteractionExpanded = useCallback((nextExpanded: boolean) => {
    if (interactionExpandedRef.current === nextExpanded) return;
    interactionExpandedRef.current = nextExpanded;
    promptBoxRef.current?.captureHeightForLayoutChange();
    setIsInteractionExpanded(nextExpanded);
  }, []);
  const cancelPendingFocusExpansion = useCallback(() => {
    pendingFocusExpansionCleanupRef.current?.();
    pendingFocusExpansionCleanupRef.current = null;
  }, []);
  const cancelPendingFocusLoss = useCallback(() => {
    const cleanup = pendingFocusLossCleanupRef.current;
    pendingFocusLossCleanupRef.current = null;
    cleanup?.();
  }, []);
  const cancelPressedOverlayTrigger = useCallback(() => {
    const cleanup = pressedOverlayTriggerCleanupRef.current;
    pressedOverlayTriggerCleanupRef.current = null;
    cleanup?.();
  }, []);
  const handleComposerPointerDown = useCallback(
    (event: ReactPointerEvent) => {
      const target = event.target;
      if (
        !(target instanceof Element) ||
        !target.closest(COMPOSER_OVERLAY_TRIGGER_SELECTOR)
      ) {
        return;
      }

      cancelPressedOverlayTrigger();
      pressedOverlayTriggerRef.current = true;
      let releaseTimeout: number | null = null;
      const removeReleaseListeners = () => {
        window.removeEventListener("pointerup", finishRelease, true);
        window.removeEventListener("pointercancel", finishRelease, true);
      };
      const finishRelease = () => {
        removeReleaseListeners();
        releaseTimeout = window.setTimeout(() => {
          releaseTimeout = null;
          pressedOverlayTriggerRef.current = false;
          pressedOverlayTriggerCleanupRef.current = null;
        });
      };
      const cleanup = () => {
        removeReleaseListeners();
        if (releaseTimeout !== null) {
          window.clearTimeout(releaseTimeout);
        }
        pressedOverlayTriggerRef.current = false;
      };

      window.addEventListener("pointerup", finishRelease, {
        capture: true,
        once: true,
      });
      window.addEventListener("pointercancel", finishRelease, {
        capture: true,
        once: true,
      });
      pressedOverlayTriggerCleanupRef.current = cleanup;
    },
    [cancelPressedOverlayTrigger],
  );
  const handleComposerFocus = useCallback(
    (event: ReactFocusEvent) => {
      cancelPendingFocusLoss();
      setWidePromptBoxCollapsedFor(null);
      if (interactionExpandedRef.current) return;
      if (
        !isCompactViewport ||
        !isPointerCoarse ||
        !isKeyboardFocusTarget(event.target) ||
        !window.visualViewport
      ) {
        setInteractionExpanded(true);
        return;
      }
      if (pendingFocusExpansionCleanupRef.current) return;

      const visualViewport = window.visualViewport;
      const initialViewportHeight = visualViewport.height;
      let animationFrame: number | null = null;
      let fallbackTimeout: number | null = null;
      let hasFinished = false;
      const removeSignals = () => {
        visualViewport.removeEventListener("resize", handleViewportResize);
        if (fallbackTimeout !== null) {
          window.clearTimeout(fallbackTimeout);
          fallbackTimeout = null;
        }
      };
      const cleanup = () => {
        removeSignals();
        if (animationFrame !== null) {
          window.cancelAnimationFrame(animationFrame);
          animationFrame = null;
        }
      };
      const finishExpansion = () => {
        if (hasFinished) return;
        hasFinished = true;
        removeSignals();
        animationFrame = window.requestAnimationFrame(() => {
          animationFrame = null;
          pendingFocusExpansionCleanupRef.current = null;
          setInteractionExpanded(true);
        });
      };
      const handleViewportResize = () => {
        if (
          initialViewportHeight - visualViewport.height <
          MOBILE_KEYBOARD_VIEWPORT_MIN_DELTA_PX
        ) {
          return;
        }
        finishExpansion();
      };

      visualViewport.addEventListener("resize", handleViewportResize);
      fallbackTimeout = window.setTimeout(
        finishExpansion,
        MOBILE_FOCUS_EXPANSION_FALLBACK_MS,
      );
      pendingFocusExpansionCleanupRef.current = cleanup;
    },
    [
      cancelPendingFocusLoss,
      isCompactViewport,
      isPointerCoarse,
      setInteractionExpanded,
    ],
  );
  const scheduleCollapseAfterFocusLoss = useCallback(
    (event: ReactFocusEvent) => {
      cancelPendingFocusLoss();
      const dismissedKeyboard = isKeyboardFocusTarget(event.target);
      const focusLossFrame = window.requestAnimationFrame(() => {
        pendingFocusLossCleanupRef.current = null;
        const composerElement = composerInteractionRef.current;
        if (!composerElement) return;

        if (composerElement.contains(document.activeElement)) return;

        if (pressedOverlayTriggerRef.current) return;

        if (
          composerElement.querySelector(OPEN_COMPOSER_OVERLAY_TRIGGER_SELECTOR)
        ) {
          return;
        }

        const collapse = () => {
          cancelPendingFocusExpansion();
          setInteractionExpanded(false);
        };
        const focusSettledOnDocument =
          document.activeElement === document.body ||
          document.activeElement === document.documentElement;
        const visualViewport = window.visualViewport;
        if (
          !dismissedKeyboard ||
          !focusSettledOnDocument ||
          !isCompactViewport ||
          !isPointerCoarse ||
          !visualViewport
        ) {
          collapse();
          return;
        }

        const keyboardViewportHeight = visualViewport.height;
        let fallbackTimeout: number | null = null;
        let hasFinished = false;
        const cleanup = () => {
          visualViewport.removeEventListener("resize", handleViewportResize);
          if (fallbackTimeout !== null) {
            window.clearTimeout(fallbackTimeout);
            fallbackTimeout = null;
          }
        };
        const finishCollapse = () => {
          if (hasFinished) return;
          hasFinished = true;
          cleanup();
          pendingFocusLossCleanupRef.current = null;
          collapse();
        };
        const handleViewportResize = () => {
          if (
            visualViewport.height - keyboardViewportHeight <
            MOBILE_KEYBOARD_VIEWPORT_MIN_DELTA_PX
          ) {
            return;
          }
          finishCollapse();
        };

        visualViewport.addEventListener("resize", handleViewportResize);
        fallbackTimeout = window.setTimeout(
          finishCollapse,
          MOBILE_KEYBOARD_DISMISSAL_FALLBACK_MS,
        );
        pendingFocusLossCleanupRef.current = cleanup;
      });
      pendingFocusLossCleanupRef.current = () => {
        window.cancelAnimationFrame(focusLossFrame);
      };
    },
    [
      cancelPendingFocusExpansion,
      cancelPendingFocusLoss,
      isCompactViewport,
      isPointerCoarse,
      setInteractionExpanded,
    ],
  );
  const collapseWidePromptBox = useCallback(() => {
    cancelPendingFocusExpansion();
    cancelPendingFocusLoss();
    interactionExpandedRef.current = false;
    setIsInteractionExpanded(false);
    setWidePromptBoxCollapsedFor(collapseResetKey);
  }, [cancelPendingFocusExpansion, cancelPendingFocusLoss, collapseResetKey]);
  const collapseIfFocused = useCallback(() => {
    const activeElement = document.activeElement;
    if (
      !(activeElement instanceof HTMLElement) ||
      !composerInteractionRef.current?.contains(activeElement)
    ) {
      return false;
    }
    promptBoxRef.current?.captureHeightForLayoutChange();
    activeElement.blur();
    collapseWidePromptBox();
    return true;
  }, [collapseWidePromptBox]);
  const extensionController = useComposerExtensionController({
    host: pluginComposerHost ?? null,
    view: composerView,
    isFocused: isFocusedPane,
    isPrimary: isPrimaryComposer,
    collapseIfFocused,
    focusDefault,
  });
  useEffect(
    () => () => {
      cancelPendingFocusExpansion();
      cancelPendingFocusLoss();
      cancelPressedOverlayTrigger();
    },
    [
      cancelPendingFocusExpansion,
      cancelPendingFocusLoss,
      cancelPressedOverlayTrigger,
    ],
  );
  const steerOnPrimarySubmit =
    submitMode.kind === "queue" && composer.steerActiveThreadOnEnter;
  const isSteeringWhenReady =
    steerOnPrimarySubmit &&
    (composer.threadRuntimeDisplayStatus === "provisioning" ||
      composer.threadRuntimeDisplayStatus === "starting");
  const onPrimarySubmit = steerOnPrimarySubmit
    ? composer.onModifierSubmit
    : composer.onSubmit;
  const onModifierSubmit = composer.canModifierSubmit
    ? steerOnPrimarySubmit
      ? composer.onSubmit
      : composer.onModifierSubmit
    : undefined;
  const executionControlsDisabled =
    (executionReadOnly ?? readOnly ?? false) || hasPendingInteraction;
  const footerStart = useMemo(
    () => (
      <ExecutionControls {...execution} disabled={executionControlsDisabled} />
    ),
    [execution, executionControlsDisabled],
  );
  const selectedProviderPlanModeCopy = execution.provider.options?.find(
    (option) => option.value === execution.provider.selectedId,
  )?.planModeCopy;
  const promptModeInput = useMemo(
    () => ({
      planModeCopy: selectedProviderPlanModeCopy,
      value: composer.message,
      mentionRanges: composer.mentionRanges,
    }),
    [composer.mentionRanges, composer.message, selectedProviderPlanModeCopy],
  );
  const permissionDisplayOverride = useMemo(
    () =>
      permissionDisplayForActivePromptMode(
        activePromptMode,
        selectedProviderPlanModeCopy,
      ) ?? permissionDisplayForPromptMode(promptModeInput),
    [activePromptMode, promptModeInput, selectedProviderPlanModeCopy],
  );
  const permissionPickerDisabledByPlanMode =
    shouldDisablePermissionPickerForActivePromptMode(activePromptMode) ||
    isPlanModePrompt(promptModeInput);
  const permissionReadOnlyResolved =
    (permissionReadOnly ?? readOnly ?? false) || hasPendingInteraction;
  const permissionPickerDisabled =
    permissionReadOnlyResolved || permissionPickerDisabledByPlanMode;
  const permissionControl = useMemo(
    () => (
      <PermissionModePicker
        value={permission.value}
        options={permission.options}
        onChange={permission.onChange}
        supported={permission.supported}
        disabled={permissionPickerDisabled}
        showChevronWhenDisabled={permissionPickerDisabledByPlanMode}
        displayOverride={permissionDisplayOverride}
        className="h-6"
      />
    ),
    [
      permission.onChange,
      permission.options,
      permission.supported,
      permission.value,
      permissionDisplayOverride,
      permissionPickerDisabledByPlanMode,
      permissionPickerDisabled,
    ],
  );
  const stackRef = useRef<HTMLDivElement>(null);
  const lastStackHeightRef = useRef(0);
  const [stackHeight, setStackHeight] = useState(0);
  const applyStackHeight = useCallback((measured: number) => {
    if (lastStackHeightRef.current === measured) return;
    lastStackHeightRef.current = measured;
    setStackHeight(measured);
  }, []);

  useLayoutEffect(() => {
    const element = stackRef.current;
    if (element) {
      applyStackHeight(element.offsetHeight);
    }
  }, [applyStackHeight]);

  useEffect(() => {
    const element = stackRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries.find((candidate) => candidate.target === element);
      if (!entry) return;
      const borderBoxSize = Array.isArray(entry.borderBoxSize)
        ? entry.borderBoxSize[0]
        : entry.borderBoxSize;
      applyStackHeight(borderBoxSize?.blockSize ?? entry.contentRect.height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [applyStackHeight]);
  const elasticTextareaMinHeight =
    stack === null
      ? FOLLOW_UP_PROMPT_BOX_DEFAULT_MIN_HEIGHT
      : Math.max(
          FOLLOW_UP_PROMPT_BOX_DEFAULT_MIN_HEIGHT,
          FOLLOW_UP_PROMPT_BOX_ELASTIC_TARGET_HEIGHT - stackHeight,
        );

  const composerElement = (
    <div
      ref={composerInteractionRef}
      className="relative z-20"
      data-follow-up-composer=""
      data-follow-up-composer-expanded={isComposerExpanded ? "" : undefined}
      hidden={hasPendingInteraction}
      onBlurCapture={scheduleCollapseAfterFocusLoss}
      onFocusCapture={handleComposerFocus}
      onPointerDownCapture={handleComposerPointerDown}
    >
      <PromptBoxWithScrollAnchor
        id={id}
        promptBoxRef={promptBoxRef}
        voice={voice}
        minHeight={elasticTextareaMinHeight}
        value={composer.message}
        mentionRanges={composer.mentionRanges}
        onChange={composer.onChangeMessage}
        onSubmit={onPrimarySubmit}
        onEscape={composer.onEscape}
        blurOnPointerSubmit={isCompactViewport && isPointerCoarse}
        textEffects={textEffects}
        onComposerLayoutChange={setComposerLayout}
        scrollToBottomOnSubmit={
          submitMode.kind !== "queue" || steerOnPrimarySubmit
        }
        scrollToBottomOnModifierSubmit={!steerOnPrimarySubmit}
        history={composer.history}
        focusEndKey={focusEndKey}
        placeholder={composer.promptPlaceholder}
        containerCompactPlaceholder={composer.compactPromptPlaceholder}
        heightAnimationKey={isComposerExpanded ? "expanded" : "compact"}
        mentionMenuPlacement="top"
        submission={{
          onStop: onStopRuntime,
          isSubmitting: composer.isFollowUpSubmitting || isStopping,
          disabled:
            !canSubmit ||
            composer.isFollowUpSubmitting ||
            (steerOnPrimarySubmit && !composer.canModifierSubmit),
          onModifierSubmit,
          title: composer.isFollowUpSubmitting
            ? "Submitting..."
            : canSubmit && composer.submitTitle !== undefined
              ? composer.submitTitle
              : canQueueFollowUp
                ? steerOnPrimarySubmit
                  ? isSteeringWhenReady
                    ? "Steer when ready (Enter)"
                    : "Steer current run (Enter)"
                  : "Queue follow-up (Enter)"
                : isStopping
                  ? "Stopping run..."
                  : isLoadingExecutionOptions
                    ? "Loading models..."
                    : isLoadingPendingInteractions
                      ? "Checking pending interactions..."
                      : isProvisioning
                        ? "Provisioning..."
                        : isUnavailable
                          ? "Unavailable"
                          : "Submit (Enter)",
          isRunning: canStopRuntime,
        }}
        typeahead={typeahead}
        attachments={attachments}
        promptActions={promptActions}
        suppressPluginComposerCustomizations={
          suppressPluginComposerCustomizations
        }
        compact={compactConfig}
        editorLayout="thread"
        onCollapse={isCompactViewport ? undefined : collapseWidePromptBox}
        footerStart={footerStart}
      />
      {!isPromptBoxCompact ? (
        <div
          data-follow-up-composer-footer=""
          className="mt-1 flex min-h-6 max-h-6 select-none items-center justify-between gap-2 overflow-hidden pl-[15px] pr-3.5 opacity-100 transition-[max-height,min-height,margin-top,opacity] duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none"
        >
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
            {environmentSummary}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {permissionControl}
            {contextWindowUsage ? (
              <ThreadContextWindowIndicator usage={contextWindowUsage} />
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );

  return (
    <ComposerExtensionHost
      controller={extensionController}
      defaultRenderer={
        <DefaultFollowUpComposer
          active={composer.threadRuntimeDisplayStatus === "active"}
          composerElement={composerElement}
          hasPluginComposerScope={composerScope !== null}
          isPrimaryComposer={isPrimaryComposer}
          pendingInteraction={pendingInteraction}
          showScrollToBottomButton={showScrollToBottomButton}
          stack={stack}
          stackRef={stackRef}
        />
      }
    />
  );
}

interface DefaultFollowUpComposerProps {
  active: boolean;
  composerElement: ReactNode;
  hasPluginComposerScope: boolean;
  isPrimaryComposer: boolean;
  pendingInteraction?: ReactNode;
  showScrollToBottomButton: boolean;
  stack: ReactNode | null;
  stackRef: RefObject<HTMLDivElement | null>;
}

function DefaultFollowUpComposer({
  active,
  composerElement,
  hasPluginComposerScope,
  isPrimaryComposer,
  pendingInteraction = null,
  showScrollToBottomButton,
  stack,
  stackRef,
}: DefaultFollowUpComposerProps) {
  return (
    <>
      {showScrollToBottomButton ? (
        <ThreadTimelineScrollToBottomButton active={active} />
      ) : null}
      <div
        data-app-composer=""
        data-app-composer-role={isPrimaryComposer ? "primary" : "secondary"}
        data-promptbox-shell=""
        className="space-y-2"
      >
        <div
          ref={stackRef}
          className={`grid gap-2 ${PROMPT_STACK_TRACK_CLASS}`}
        >
          {hasPluginComposerScope ? (
            <ComposerBannersSlot>{stack}</ComposerBannersSlot>
          ) : (
            stack
          )}
          {pendingInteraction}
        </div>
        <div data-follow-up-composer-anchor="">{composerElement}</div>
      </div>
    </>
  );
}

export const FollowUpPromptBox = memo(function FollowUpPromptBox(
  props: FollowUpPromptBoxProps,
) {
  if (props.composer === null) {
    return (
      <FollowUpPromptBoxStackOnly
        stack={props.stack}
        pluginComposerHost={props.pluginComposerHost}
        pluginComposerScope={props.pluginComposerScope}
      />
    );
  }
  return <FollowUpPromptBoxWithComposer {...props} composer={props.composer} />;
});
