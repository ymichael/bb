import { atom, useAtom } from "jotai";
import { RESET, atomWithStorage } from "jotai/utils";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import type {
  MentionMenuState,
  PromptMentionSuggestion,
} from "@/components/promptbox/mentions/types";
import { Button } from "@/components/ui/button.js";
import { Icon } from "@/components/ui/icon.js";
import { COARSE_POINTER_PROMPT_ACTION_BUTTON_CLASS, COARSE_POINTER_PROMPT_COMBO_BUTTON_CLASS, COARSE_POINTER_PROMPT_ICON_ACTION_BUTTON_CLASS, COARSE_POINTER_TEXT_BASE_CLASS } from "@/components/ui/coarse-pointer-sizing.js";
import { useAutoGrow } from "@/hooks/useAutoGrow";
import { createJsonLocalStorage } from "@/lib/browser-storage";
import {
  arePromptDraftStatesEqual,
  isPromptDraftEmpty,
  type PromptDraftAttachment,
  type PromptDraftState,
} from "@/lib/prompt-draft";
import { cn } from "@/lib/utils";
import { AttachmentPreview } from "./AttachmentPreview";
import { MentionMenu } from "./mentions/MentionMenu";
import {
  findActiveFileMention,
  insertFileMention,
  type ActiveFileMention,
} from "./mentions/file-mention";

const PROMPTBOX_MIN_HEIGHT = 68;
const PROMPTBOX_MAX_HEIGHT = 158;

type SubmitMode = "enter" | "mod-enter";
type ZenModeLayout = "thread" | "project-main";

const ZEN_MODE_STORAGE_KEY: Record<ZenModeLayout, string> = {
  thread: "bb.promptbox.zen-mode.thread",
  "project-main": "bb.promptbox.zen-mode.project-main",
};

const ZEN_MODE_HEIGHT_CLASS: Record<ZenModeLayout, string> = {
  thread: "h-[50dvh]",
  "project-main": "h-[70dvh]",
};

export interface PromptBoxSubmissionConfig {
  isSubmitting?: boolean;
  disabled?: boolean;
  title?: string;
  mode?: SubmitMode;
  isRunning?: boolean;
  onStop?: () => void;
  onModifierSubmit?: () => void;
}

export interface MentionsConfig {
  suggestions: readonly PromptMentionSuggestion[];
  isLoading: boolean;
  isError: boolean;
  /** Called whenever the active @-mention query changes; null when no mention is active. */
  onQueryChange: (query: string | null) => void;
}

export interface AttachmentsConfig {
  items?: PromptDraftAttachment[];
  isAttaching?: boolean;
  error?: string | null;
  onAttachFiles?: (files: File[]) => void | Promise<void>;
  onRemove?: (path: string) => void;
  projectId?: string;
}

export interface PromptBoxZenModeConfig {
  layout?: ZenModeLayout;
  storageKey?: string | null;
  resetKey?: string | number;
  resetOnSubmit?: boolean;
}

export interface HistoryConfig {
  currentDraft: PromptDraftState;
  entries: readonly PromptDraftState[];
  onSelectEntry: (draft: PromptDraftState) => void;
  resetKey?: string | number;
}

export type PromptVoiceState =
  | "idle"
  | "recording"
  | "transcribing"
  | "error";

export interface PromptVoiceConfig {
  state: PromptVoiceState;
  /** Display-ready summary of the last error. Only set when state === "error". */
  errorMessage?: string;
  isSupported: boolean;
  start: () => void | Promise<void>;
  stop: () => void;
  cancel: () => void;
}

export interface PromptBoxHandle {
  /** Insert text at the textarea's current cursor position, with smart spacing. */
  insertTextAtCursor: (text: string) => void;
  /** Return the trimmed text before the cursor, used as voice transcript context. */
  getTextBeforeCursor: () => string | undefined;
}

export type MentionMenuPlacement = "top" | "bottom";

export interface PromptBoxInternalProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  className?: string;
  footerStart?: ReactNode;
  autoFocus?: boolean;
  submission?: PromptBoxSubmissionConfig;
  /**
   * Minimum textarea height in pixels. Defaults to PROMPTBOX_MIN_HEIGHT.
   * Callers may pass a smaller value to make room for siblings that grow
   * above the textarea (see FollowUpPromptBox's elastic compensation for
   * the context banner stack) — total prompt-area height stays constant.
   */
  minHeight?: number;
  mentions: MentionsConfig;
  /**
   * Where the @-mention menu floats relative to the prompt box.
   * "top" floats it above (used by FollowUp where the prompt sits at the
   * bottom of the thread), "bottom" floats it below (used by NewThread
   * where the prompt sits at the top of the project view).
   */
  mentionMenuPlacement: MentionMenuPlacement;
  attachments?: AttachmentsConfig;
  zenMode?: PromptBoxZenModeConfig;
  history?: HistoryConfig;
  /** When omitted, the mic button is hidden. Wrappers wire this via usePromptVoice. */
  voice?: PromptVoiceConfig;
  promptBoxRef?: Ref<PromptBoxHandle>;
}

interface DismissedMentionRange {
  start: number;
  end: number;
  hasLeftRange: boolean;
}

type ZenModeUpdate =
  | boolean
  | typeof RESET
  | ((previous: boolean) => boolean | typeof RESET);

function createTransientZenModeAtom() {
  const baseAtom = atom(false);
  return atom(
    (get) => get(baseAtom),
    (get, set, update: ZenModeUpdate) => {
      const currentValue = get(baseAtom);
      const nextValue =
        typeof update === "function" ? update(currentValue) : update;

      set(baseAtom, nextValue === RESET ? false : nextValue);
    },
  );
}

export function PromptBoxInternal({
  id,
  value,
  onChange,
  onSubmit,
  placeholder = "Ask anything. @ to mention files",
  className,
  footerStart,
  autoFocus = false,
  submission = {},
  minHeight = PROMPTBOX_MIN_HEIGHT,
  mentions,
  mentionMenuPlacement,
  attachments: attachmentConfig = {},
  zenMode = {},
  history,
  voice,
  promptBoxRef,
}: PromptBoxInternalProps) {
  const {
    isSubmitting = false,
    disabled: submitDisabled = false,
    title: submitTitle = "Submit (Enter)",
    mode: submitMode = "enter",
    isRunning = false,
    onStop,
    onModifierSubmit,
  } = submission;
  const {
    suggestions: mentionSuggestions,
    isLoading: mentionLoading,
    isError: mentionError,
    onQueryChange: onMentionQueryChange,
  } = mentions;
  const {
    items: attachments = [],
    isAttaching = false,
    error: attachmentError = null,
    onAttachFiles,
    onRemove: onRemoveAttachment,
    projectId: attachmentProjectId,
  } = attachmentConfig;
  const {
    layout: zenModeLayout = "thread",
    storageKey: zenModeStorageKey,
    resetKey: zenModeResetKey,
    resetOnSubmit: resetZenModeOnSubmit = false,
  } = zenMode;
  const formRef = useRef<HTMLFormElement>(null);
  const heightAnimationFromRef = useRef<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const valueRef = useRef(value);
  const resizeTextarea = useAutoGrow(textareaRef, {
    minHeight,
    maxHeight: PROMPTBOX_MAX_HEIGHT,
  });
  const mentionKeyRef = useRef("");
  const dismissedMentionRef = useRef<DismissedMentionRange | null>(null);
  const [activeMention, setActiveMention] = useState<ActiveFileMention | null>(
    null,
  );
  const [selectedMentionIndex, setSelectedMentionIndex] = useState(0);
  const [expandedImageIndex, setExpandedImageIndex] = useState<number | null>(
    null,
  );
  const [activeHistoryIndex, setActiveHistoryIndex] = useState<number | null>(
    null,
  );
  const [temporaryHistoryDraft, setTemporaryHistoryDraft] =
    useState<PromptDraftState | null>(null);
  const [recalledHistoryDraft, setRecalledHistoryDraft] =
    useState<PromptDraftState | null>(null);
  const resolvedZenModeStorageKey =
    zenModeStorageKey ?? ZEN_MODE_STORAGE_KEY[zenModeLayout];
  const zenModeAtom = useMemo(
    () =>
      resolvedZenModeStorageKey
        ? atomWithStorage<boolean>(
            resolvedZenModeStorageKey,
            false,
            createJsonLocalStorage<boolean>(),
            {
              getOnInit: true,
            },
          )
        : createTransientZenModeAtom(),
    [resolvedZenModeStorageKey],
  );
  const [isZenMode, setIsZenMode] = useAtom(zenModeAtom);
  const autoFocusScopeKey = history?.resetKey;

  useLayoutEffect(() => {
    if (!autoFocus) return;
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.focus();
    const caretPosition = textarea.value.length;
    textarea.setSelectionRange(caretPosition, caretPosition);
  }, [autoFocus, autoFocusScopeKey]);

  useEffect(() => {
    if (!textareaRef.current) return;
    if (isZenMode) {
      textareaRef.current.style.height = "100%";
      return;
    }
    resizeTextarea(textareaRef.current);
  }, [isZenMode, resizeTextarea, value]);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  useEffect(() => {
    if (zenModeResetKey === undefined) return;
    if (resolvedZenModeStorageKey) {
      setIsZenMode(RESET);
      return;
    }
    setIsZenMode(false);
  }, [resolvedZenModeStorageKey, setIsZenMode, zenModeResetKey]);

  const resetHistorySession = useCallback(() => {
    setActiveHistoryIndex(null);
    setTemporaryHistoryDraft(null);
    setRecalledHistoryDraft(null);
  }, []);

  useEffect(() => {
    if (!history) {
      resetHistorySession();
      return;
    }
    if (history.entries.length === 0) {
      resetHistorySession();
      return;
    }
    if (
      activeHistoryIndex !== null &&
      activeHistoryIndex >= history.entries.length
    ) {
      resetHistorySession();
    }
  }, [activeHistoryIndex, history, resetHistorySession]);

  useEffect(() => {
    resetHistorySession();
  }, [history?.resetKey, resetHistorySession]);

  useEffect(() => {
    if (!history || activeHistoryIndex === null || !recalledHistoryDraft) {
      return;
    }
    const activeHistoryEntry = history.entries[activeHistoryIndex];
    if (
      !activeHistoryEntry ||
      !arePromptDraftStatesEqual(activeHistoryEntry, recalledHistoryDraft)
    ) {
      resetHistorySession();
      return;
    }
    if (arePromptDraftStatesEqual(history.currentDraft, recalledHistoryDraft)) {
      return;
    }
    resetHistorySession();
  }, [activeHistoryIndex, history, recalledHistoryDraft, resetHistorySession]);

  useLayoutEffect(() => {
    const fromHeight = heightAnimationFromRef.current;
    const formElement = formRef.current;
    if (fromHeight === null || !formElement) return;
    heightAnimationFromRef.current = null;

    const previousTransition = formElement.style.transition;
    const previousWillChange = formElement.style.willChange;

    formElement.style.transition = "none";
    formElement.style.height = "";
    const toHeight = formElement.getBoundingClientRect().height;
    formElement.style.height = `${fromHeight}px`;
    formElement.getBoundingClientRect();
    formElement.style.willChange = "height";
    formElement.style.transition =
      "height 240ms cubic-bezier(0.22, 1, 0.36, 1)";
    formElement.style.height = `${toHeight}px`;

    let isCleanedUp = false;
    const cleanup = () => {
      if (isCleanedUp) return;
      isCleanedUp = true;
      formElement.style.transition = previousTransition;
      formElement.style.willChange = previousWillChange;
      formElement.style.height = "";
      formElement.removeEventListener("transitionend", handleTransitionEnd);
      window.clearTimeout(fallbackTimeout);
    };
    const handleTransitionEnd = (event: TransitionEvent) => {
      if (event.propertyName !== "height") return;
      cleanup();
    };
    const fallbackTimeout = window.setTimeout(cleanup, 320);
    formElement.addEventListener("transitionend", handleTransitionEnd);

    return cleanup;
  }, [isZenMode, zenModeLayout]);

  const syncMentionState = useCallback(
    (textarea: HTMLTextAreaElement) => {
      const caretPosition = textarea.selectionStart ?? textarea.value.length;
      const dismissedMention = dismissedMentionRef.current;

      if (dismissedMention) {
        const isWithinDismissedRange =
          caretPosition >= dismissedMention.start &&
          caretPosition <= dismissedMention.end;

        if (!isWithinDismissedRange) {
          dismissedMentionRef.current = {
            ...dismissedMention,
            hasLeftRange: true,
          };
        } else if (dismissedMention.hasLeftRange) {
          dismissedMentionRef.current = null;
        }
      }

      const shouldSuppressMention = Boolean(
        dismissedMentionRef.current &&
        caretPosition >= dismissedMentionRef.current.start &&
        caretPosition <= dismissedMentionRef.current.end &&
        !dismissedMentionRef.current.hasLeftRange,
      );

      const nextMention = shouldSuppressMention
        ? null
        : findActiveFileMention(textarea.value, caretPosition);
      const nextKey = nextMention
        ? `${nextMention.start}:${nextMention.end}:${nextMention.query}`
        : "";
      if (nextKey !== mentionKeyRef.current) {
        mentionKeyRef.current = nextKey;
        setSelectedMentionIndex(0);
      }
      setActiveMention(nextMention);

      onMentionQueryChange(nextMention ? nextMention.query : null);
    },
    [onMentionQueryChange],
  );

  useEffect(() => {
    if (!textareaRef.current) return;
    syncMentionState(textareaRef.current);
  }, [syncMentionState, value]);

  const trimmedValue = value.trim();
  const hasAttachments = attachments.length > 0;
  const hasSubmittableInput = trimmedValue.length > 0 || hasAttachments;
  const showMentionMenu = activeMention !== null;
  const activeMentionQuery = activeMention?.query.trim() ?? "";
  const mentionMenuState: MentionMenuState =
    activeMentionQuery.length === 0
      ? { kind: "hint" }
      : mentionLoading
        ? { kind: "loading" }
        : mentionError
          ? { kind: "error" }
          : { kind: "results", suggestions: mentionSuggestions };

  useEffect(() => {
    if (mentionSuggestions.length === 0) {
      setSelectedMentionIndex(0);
      return;
    }
    if (selectedMentionIndex >= mentionSuggestions.length) {
      setSelectedMentionIndex(0);
    }
  }, [mentionSuggestions.length, selectedMentionIndex]);

  const applyMention = useCallback(
    (item: PromptMentionSuggestion) => {
      const textarea = textareaRef.current;
      if (!textarea || !activeMention) return;

      const mentionStart = activeMention.start;
      const replacement = insertFileMention(
        value,
        activeMention,
        item.replacement,
      );
      onChange(replacement.value);
      mentionKeyRef.current = "";
      dismissedMentionRef.current = {
        start: mentionStart,
        end: mentionStart + replacement.insertedLength,
        hasLeftRange: false,
      };
      setActiveMention(null);
      setSelectedMentionIndex(0);
      onMentionQueryChange(null);

      requestAnimationFrame(() => {
        const nextTextarea = textareaRef.current;
        if (!nextTextarea) return;
        nextTextarea.focus();
        nextTextarea.setSelectionRange(
          replacement.caretPosition,
          replacement.caretPosition,
        );
        if (isZenMode) {
          nextTextarea.style.height = "100%";
        } else {
          resizeTextarea(nextTextarea);
        }
      });
    },
    [
      activeMention,
      isZenMode,
      onChange,
      onMentionQueryChange,
      resizeTextarea,
      value,
    ],
  );

  const insertTextAtCursor = useCallback(
    (rawText: string) => {
      const normalizedText = rawText.replace(/\s+/g, " ").trim();
      if (normalizedText.length === 0) return;

      const textarea = textareaRef.current;
      const currentValue = valueRef.current;
      if (!textarea) {
        const nextValue =
          currentValue.length === 0 || /\s$/.test(currentValue)
            ? `${currentValue}${normalizedText}`
            : `${currentValue} ${normalizedText}`;
        onChange(nextValue);
        return;
      }

      const selectionStart = textarea.selectionStart ?? currentValue.length;
      const selectionEnd = textarea.selectionEnd ?? selectionStart;
      const before = currentValue.slice(0, selectionStart);
      const after = currentValue.slice(selectionEnd);
      const needsLeadingWhitespace = before.length > 0 && !/\s$/.test(before);
      const needsTrailingWhitespace = after.length > 0 && !/^\s/.test(after);
      const insertedText = `${needsLeadingWhitespace ? " " : ""}${normalizedText}${needsTrailingWhitespace ? " " : ""}`;
      const nextValue = `${before}${insertedText}${after}`;
      const nextCursor = before.length + insertedText.length;

      onChange(nextValue);
      requestAnimationFrame(() => {
        const nextTextarea = textareaRef.current;
        if (!nextTextarea) return;
        nextTextarea.focus();
        nextTextarea.setSelectionRange(nextCursor, nextCursor);
        if (isZenMode) {
          nextTextarea.style.height = "100%";
        } else {
          resizeTextarea(nextTextarea);
        }
        syncMentionState(nextTextarea);
      });
    },
    [isZenMode, onChange, resizeTextarea, syncMentionState],
  );

  const getTextBeforeCursor = useCallback((): string | undefined => {
    const currentValue = valueRef.current;
    const textarea = textareaRef.current;
    if (!textarea) {
      const trimmed = currentValue.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    }
    const selectionStart = textarea.selectionStart ?? currentValue.length;
    const beforeCursor = currentValue.slice(0, selectionStart).trim();
    return beforeCursor.length > 0 ? beforeCursor : undefined;
  }, []);

  useImperativeHandle(
    promptBoxRef,
    () => ({
      insertTextAtCursor,
      getTextBeforeCursor,
    }),
    [insertTextAtCursor, getTextBeforeCursor],
  );

  const isVoiceRecording = voice?.state === "recording";
  const isVoiceProcessing = voice?.state === "transcribing";
  const isVoiceBusy = isVoiceRecording || isVoiceProcessing;
  const voiceErrorMessage =
    voice?.state === "error" ? voice.errorMessage ?? "Voice input failed." : null;
  const showVoiceActionGroup = isVoiceRecording || isVoiceProcessing;
  const canSubmit =
    hasSubmittableInput && !isSubmitting && !submitDisabled && !isVoiceBusy;
  const canModifierSubmit =
    onModifierSubmit !== undefined &&
    !isSubmitting &&
    !submitDisabled &&
    !isVoiceBusy;
  const showStop = Boolean(isRunning && onStop && !canSubmit && !isVoiceBusy);
  const canStartVoiceInput =
    voice !== undefined && voice.isSupported && !isSubmitting;
  const effectiveSubmitMode: SubmitMode = submitMode;
  const effectiveSubmitTitle = isZenMode
    ? submitTitle.replace(/^Submit\s+/, "")
    : submitTitle;

  const emitAttachmentFiles = useCallback(
    (files: File[]) => {
      if (!onAttachFiles || files.length === 0) return;
      void onAttachFiles(files);
    },
    [onAttachFiles],
  );

  const resetZenModeAfterSubmit = useCallback(() => {
    if (!resetZenModeOnSubmit || !isZenMode) return;
    if (resolvedZenModeStorageKey) {
      setIsZenMode(RESET);
      return;
    }
    setIsZenMode(false);
  }, [
    isZenMode,
    resetZenModeOnSubmit,
    resolvedZenModeStorageKey,
    setIsZenMode,
  ]);

  const submitPrompt = useCallback(() => {
    if (!canSubmit) return;
    onSubmit();
    resetZenModeAfterSubmit();
  }, [canSubmit, onSubmit, resetZenModeAfterSubmit]);

  const submitModifierPrompt = useCallback(() => {
    if (!canModifierSubmit || !onModifierSubmit) return;
    onModifierSubmit();
    resetZenModeAfterSubmit();
  }, [canModifierSubmit, onModifierSubmit, resetZenModeAfterSubmit]);

  const applyHistoryDraft = useCallback(
    (draft: PromptDraftState) => {
      if (!history) {
        return;
      }

      history.onSelectEntry(draft);
      requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (!textarea) {
          return;
        }

        textarea.focus();
        const caretPosition = textarea.value.length;
        textarea.setSelectionRange(caretPosition, caretPosition);
        if (isZenMode) {
          textarea.style.height = "100%";
        } else {
          resizeTextarea(textarea);
        }
        syncMentionState(textarea);
      });
    },
    [history, isZenMode, resizeTextarea, syncMentionState],
  );

  const toggleZenMode = useCallback(() => {
    const textarea = textareaRef.current;
    const formElement = formRef.current;
    const selectionStart = textarea?.selectionStart ?? null;
    const selectionEnd = textarea?.selectionEnd ?? null;
    const scrollTop = textarea?.scrollTop ?? null;
    heightAnimationFromRef.current =
      formElement?.getBoundingClientRect().height ?? null;

    setIsZenMode((previous) => !previous);

    requestAnimationFrame(() => {
      const nextTextarea = textareaRef.current;
      if (!nextTextarea) return;
      nextTextarea.focus();
      if (selectionStart !== null && selectionEnd !== null) {
        nextTextarea.setSelectionRange(selectionStart, selectionEnd);
      }
      if (scrollTop !== null) {
        nextTextarea.scrollTop = scrollTop;
      }
    });
  }, [setIsZenMode]);

  const handleAttachmentInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const fileList = event.target.files;
      if (!fileList || fileList.length === 0) return;
      emitAttachmentFiles(Array.from(fileList));
      event.target.value = "";
    },
    [emitAttachmentFiles],
  );

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submitPrompt();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const selectionStart = event.currentTarget.selectionStart;
    const selectionEnd = event.currentTarget.selectionEnd;
    const hasCollapsedSelection =
      selectionStart !== null &&
      selectionEnd !== null &&
      selectionStart === selectionEnd;
    const hasArrowNavigationModifier =
      event.shiftKey || event.altKey || event.metaKey || event.ctrlKey;
    const hasCursorAtEnd =
      hasCollapsedSelection &&
      selectionStart === event.currentTarget.value.length;
    const activeHistoryEntry =
      history && activeHistoryIndex !== null
        ? history.entries[activeHistoryIndex]
        : null;
    const hasSelectedHistoryEntry = Boolean(
      history &&
      activeHistoryEntry !== null &&
      activeHistoryEntry !== undefined &&
      arePromptDraftStatesEqual(history.currentDraft, activeHistoryEntry),
    );
    const canNavigateHistory =
      history !== undefined &&
      !hasArrowNavigationModifier &&
      hasCursorAtEnd &&
      (isPromptDraftEmpty(history.currentDraft) || hasSelectedHistoryEntry);
    const canNavigateMentions =
      showMentionMenu && !hasArrowNavigationModifier && !canNavigateHistory;

    if (showMentionMenu) {
      if (
        event.key === "ArrowDown" &&
        canNavigateMentions &&
        mentionSuggestions.length > 0
      ) {
        event.preventDefault();
        setSelectedMentionIndex(
          (prev) => (prev + 1) % mentionSuggestions.length,
        );
        return;
      }
      if (
        event.key === "ArrowUp" &&
        canNavigateMentions &&
        mentionSuggestions.length > 0
      ) {
        event.preventDefault();
        setSelectedMentionIndex(
          (prev) =>
            (prev + mentionSuggestions.length - 1) % mentionSuggestions.length,
        );
        return;
      }
      if (
        (event.key === "Enter" || event.key === "Tab") &&
        mentionSuggestions.length > 0
      ) {
        event.preventDefault();
        const selected =
          mentionSuggestions[selectedMentionIndex] ?? mentionSuggestions[0];
        if (selected) {
          applyMention(selected);
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        mentionKeyRef.current = "";
        setActiveMention(null);
        onMentionQueryChange(null);
        return;
      }
    }

    if (history) {
      if (
        event.key === "ArrowUp" &&
        canNavigateHistory &&
        history.entries.length > 0
      ) {
        event.preventDefault();
        const nextHistoryIndex =
          activeHistoryIndex === null
            ? 0
            : Math.min(activeHistoryIndex + 1, history.entries.length - 1);
        if (activeHistoryIndex === null) {
          setTemporaryHistoryDraft(history.currentDraft);
        }
        setActiveHistoryIndex(nextHistoryIndex);
        const nextDraft = history.entries[nextHistoryIndex];
        setRecalledHistoryDraft(nextDraft);
        applyHistoryDraft(nextDraft);
        return;
      }

      if (
        event.key === "ArrowDown" &&
        canNavigateHistory &&
        activeHistoryIndex !== null
      ) {
        event.preventDefault();
        if (activeHistoryIndex === 0) {
          if (temporaryHistoryDraft) {
            applyHistoryDraft(temporaryHistoryDraft);
          }
          resetHistorySession();
          return;
        }

        const nextHistoryIndex = activeHistoryIndex - 1;
        setActiveHistoryIndex(nextHistoryIndex);
        const nextDraft = history.entries[nextHistoryIndex];
        setRecalledHistoryDraft(nextDraft);
        applyHistoryDraft(nextDraft);
        return;
      }
    }

    const isModifierSubmitKey =
      event.key === "Enter" &&
      event.metaKey &&
      !event.shiftKey &&
      !event.altKey &&
      !event.ctrlKey;
    if (isModifierSubmitKey && onModifierSubmit) {
      event.preventDefault();
      submitModifierPrompt();
      return;
    }

    const withModifier = event.metaKey || event.ctrlKey;
    if (isZenMode) return;
    const isSubmitKey =
      effectiveSubmitMode === "mod-enter"
        ? withModifier && event.key === "Enter"
        : event.key === "Enter" && !event.shiftKey;

    if (!isSubmitKey) return;
    event.preventDefault();
    submitPrompt();
  };

  return (
    <form
      ref={formRef}
      onSubmit={handleSubmit}
      onDragOver={(event) => {
        if (!onAttachFiles) return;
        event.preventDefault();
      }}
      onDrop={(event) => {
        if (!onAttachFiles) return;
        event.preventDefault();
        if (!event.dataTransfer?.files || event.dataTransfer.files.length === 0)
          return;
        emitAttachmentFiles(Array.from(event.dataTransfer.files));
      }}
      className={cn(
        "relative w-full rounded-lg border border-input bg-background pb-2",
        isZenMode && "flex flex-col pb-3",
        isZenMode && ZEN_MODE_HEIGHT_CLASS[zenModeLayout],
        className,
      )}
    >
      <Button
        type="button"
        size="icon"
        variant="ghost"
        onMouseDown={(event) => {
          event.preventDefault();
        }}
        onClick={toggleZenMode}
        title={isZenMode ? "Exit zen mode" : "Enter zen mode"}
        aria-label={isZenMode ? "Exit zen mode" : "Enter zen mode"}
        aria-pressed={isZenMode}
        className="absolute right-2 top-2 z-20 size-auto h-6 px-1.5 text-muted-foreground/40 hover:text-muted-foreground"
      >
        {isZenMode ? (
          <Icon name="Minimize2" className="size-3" />
        ) : (
          <Icon name="Maximize2" className="size-3" />
        )}
      </Button>
      <input
        ref={attachmentInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleAttachmentInputChange}
      />
      <textarea
        ref={textareaRef}
        id={id}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          if (isZenMode) {
            event.target.style.height = "100%";
          } else {
            resizeTextarea(event.target);
          }
          syncMentionState(event.target);
        }}
        onClick={(event) => {
          syncMentionState(event.currentTarget);
        }}
        onSelect={(event) => {
          syncMentionState(event.currentTarget);
        }}
        onBlur={() => {
          mentionKeyRef.current = "";
          if (dismissedMentionRef.current) {
            dismissedMentionRef.current = {
              ...dismissedMentionRef.current,
              hasLeftRange: true,
            };
          }
          setActiveMention(null);
          onMentionQueryChange(null);
        }}
        onPaste={(event) => {
          if (!onAttachFiles) return;
          const clipboardItems = Array.from(event.clipboardData?.items ?? []);
          const pastedFiles = clipboardItems
            .filter((item) => item.kind === "file")
            .map((item) => item.getAsFile())
            .filter((file): file is File => file !== null);

          if (pastedFiles.length === 0) return;
          event.preventDefault();
          emitAttachmentFiles(pastedFiles);
        }}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        rows={1}
        autoFocus={autoFocus}
        aria-keyshortcuts={onModifierSubmit ? "Meta+Enter" : undefined}
        enterKeyHint="send"
        className={cn(
          "w-full resize-none overflow-y-auto bg-transparent px-4 pb-1 pr-14 pt-3 leading-relaxed outline-none placeholder:select-none placeholder:text-muted-foreground/60",
          COARSE_POINTER_TEXT_BASE_CLASS,
          isZenMode && "min-h-0 flex-1 px-6 pb-3 pt-8",
        )}
        style={{
          minHeight: isZenMode ? "0px" : `${minHeight}px`,
          height: isZenMode ? "100%" : undefined,
          maxHeight: isZenMode ? "none" : `${PROMPTBOX_MAX_HEIGHT}px`,
        }}
      />

      {showMentionMenu ? (
        <div
          className={cn(
            // Zen mode: menu floats inside the form, anchored just above
            // the action footer so it stays visible. The form's pb-3 +
            // ~36px button row sets the bottom offset.
            // Normal mode: menu floats outside the form (above or below).
            // -left-px / -right-px aligns the menu with the form's outer
            // edge (form has a 1px border; left-0/right-0 would otherwise
            // sit inside it, leaving the banner above peeking out 1px on
            // each side).
            "absolute -left-px -right-px z-20",
            isZenMode
              ? "bottom-14 px-3"
              : mentionMenuPlacement === "top"
                ? "bottom-full mb-2"
                : "top-full mt-2",
          )}
        >
          <MentionMenu
            state={mentionMenuState}
            selectedIndex={selectedMentionIndex}
            onApply={applyMention}
          />
        </div>
      ) : null}

      <AttachmentPreview
        attachments={attachments}
        attachmentProjectId={attachmentProjectId}
        expandedImageIndex={expandedImageIndex}
        onExpandedImageIndexChange={setExpandedImageIndex}
        onRemoveAttachment={onRemoveAttachment}
      />

      {attachmentError ? (
        <div className="mx-3 mb-1 mt-1 text-xs text-destructive">
          {attachmentError}
        </div>
      ) : null}

      {voiceErrorMessage ? (
        <div className="mx-3 mb-1 mt-1 rounded-md border border-destructive/30 bg-destructive/[0.06] px-2 py-1 text-xs text-destructive">
          <span className="block truncate" title={voiceErrorMessage}>
            {voiceErrorMessage}
          </span>
        </div>
      ) : null}

      <div className="flex flex-row items-center gap-3 px-3.5 pt-1.5">
        <div
          className="flex min-w-0 flex-1 flex-row items-center gap-1"
          aria-live="polite"
        >
          {footerStart}
        </div>
        <div className="flex shrink-0 flex-row items-center gap-1">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            title="Attach files"
            disabled={!onAttachFiles || isAttaching}
            onClick={() => attachmentInputRef.current?.click()}
            className={COARSE_POINTER_PROMPT_ICON_ACTION_BUTTON_CLASS}
          >
            {isAttaching ? (
              <Icon name="Spinner" className="size-4 animate-spin" />
            ) : (
              <Icon name="Paperclip" className="size-4" />
            )}
          </Button>
          {voice && !showVoiceActionGroup ? (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              title={
                !voice.isSupported
                  ? "Voice input is not supported in this browser"
                  : "Start voice input"
              }
              disabled={!canStartVoiceInput}
              onClick={voice.start}
              className={COARSE_POINTER_PROMPT_ICON_ACTION_BUTTON_CLASS}
            >
              <Icon name="Mic" className="size-4" />
            </Button>
          ) : null}
          {showStop ? (
            <Button
              type="button"
              size="icon"
              variant="secondary"
              title="Stop run"
              onClick={onStop}
              className={COARSE_POINTER_PROMPT_ICON_ACTION_BUTTON_CLASS}
            >
              <Icon
                name="Square"
                className="size-3.5 fill-current [&_*]:stroke-0"
              />
            </Button>
          ) : voice && isVoiceRecording ? (
            <div className="relative inline-flex">
              <Button
                type="button"
                size="sm"
                variant="default"
                title="Stop and transcribe recording"
                onClick={voice.stop}
                className={cn(
                  "rounded-r-none",
                  COARSE_POINTER_PROMPT_ACTION_BUTTON_CLASS,
                )}
              >
                <Icon name="AudioLines" className="size-4 animate-pulse" />
              </Button>
              <Button
                type="button"
                size="sm"
                variant="default"
                title="Cancel recording"
                onClick={voice.cancel}
                className={COARSE_POINTER_PROMPT_COMBO_BUTTON_CLASS}
              >
                <Icon name="X" className="size-3.5" />
              </Button>
            </div>
          ) : voice && isVoiceProcessing ? (
            <div className="relative inline-flex">
              <Button
                type="button"
                size="sm"
                variant="default"
                title="Transcribing voice input..."
                disabled
                className={cn(
                  "rounded-r-none",
                  COARSE_POINTER_PROMPT_ACTION_BUTTON_CLASS,
                )}
              >
                <Icon name="AudioLines" className="size-4" />
                <Icon name="Spinner" className="size-4 animate-spin" />
              </Button>
              <Button
                type="button"
                size="sm"
                variant="default"
                title="Cancel transcription"
                onClick={voice.cancel}
                className={COARSE_POINTER_PROMPT_COMBO_BUTTON_CLASS}
              >
                <Icon name="X" className="size-3.5" />
              </Button>
            </div>
          ) : (
            <Button
              type="submit"
              size="sm"
              variant="default"
              title={effectiveSubmitTitle}
              disabled={!canSubmit}
              className={COARSE_POINTER_PROMPT_ACTION_BUTTON_CLASS}
            >
              {isSubmitting ? (
                <Icon name="Spinner" className="size-4 animate-spin" />
              ) : isZenMode ? (
                <Icon name="ArrowUp" className="size-4" />
              ) : (
                <Icon name="CornerDownLeft" className="size-4" />
              )}
            </Button>
          )}
        </div>
      </div>
    </form>
  );
}
