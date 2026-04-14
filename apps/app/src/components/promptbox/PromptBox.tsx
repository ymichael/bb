import { atom, useAtom } from "jotai"
import { RESET, atomWithStorage } from "jotai/utils"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent, type ReactNode } from "react"
import { ArrowUp, AudioLines, CornerDownLeft, Loader2, Maximize2, Mic, Minimize2, Paperclip, Square, X } from "lucide-react"
import type { PromptMentionSuggestion } from "@/hooks/usePromptMentions"
import { Button } from "@/components/ui/button"
import { useAutoGrow } from "@/hooks/useAutoGrow"
import { useVoiceInput } from "@/hooks/useVoiceInput"
import { transcribeVoiceInput } from "@/lib/api"
import { createJsonLocalStorage } from "@/lib/browser-storage"
import type { PromptDraftAttachment } from "@/lib/prompt-draft"
import { cn } from "@/lib/utils"
import { PromptAttachmentPreview } from "./PromptAttachmentPreview"
import { PromptMentionMenu } from "./PromptMentionMenu"
import { findActiveFileMention, insertFileMention, type ActiveFileMention } from "./file-mention"

const PROMPTBOX_MIN_HEIGHT = 68
const PROMPTBOX_MAX_HEIGHT = 158

type SubmitMode = "enter" | "mod-enter"
type ZenModeLayout = "thread" | "project-main"

const ZEN_MODE_STORAGE_KEY: Record<ZenModeLayout, string> = {
  thread: "bb.promptbox.zen-mode.thread",
  "project-main": "bb.promptbox.zen-mode.project-main",
}

const ZEN_MODE_HEIGHT_CLASS: Record<ZenModeLayout, string> = {
  thread: "h-[50dvh]",
  "project-main": "h-[70dvh]",
}

export interface PromptBoxSubmissionConfig {
  isSubmitting?: boolean
  disabled?: boolean
  title?: string
  mode?: SubmitMode
  isRunning?: boolean
  onStop?: () => void
}

export interface PromptBoxMentionsConfig {
  suggestions?: PromptMentionSuggestion[]
  searchScope?: "files" | "files-and-managers" | "files-and-threads"
  isLoading?: boolean
  isError?: boolean
  onQueryChange?: (query: string | null) => void
}

export interface PromptBoxAttachmentsConfig {
  items?: PromptDraftAttachment[]
  isAttaching?: boolean
  error?: string | null
  onAttachFiles?: (files: File[]) => void | Promise<void>
  onRemove?: (path: string) => void
  projectId?: string
}

export interface PromptBoxZenModeConfig {
  layout?: ZenModeLayout
  storageKey?: string | null
  resetKey?: string | number
  resetOnSubmit?: boolean
}

export interface PromptBoxProps {
  id?: string
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  placeholder?: string
  className?: string
  footerStart?: ReactNode
  autoFocus?: boolean
  submission?: PromptBoxSubmissionConfig
  mentions?: PromptBoxMentionsConfig
  attachments?: PromptBoxAttachmentsConfig
  zenMode?: PromptBoxZenModeConfig
}

interface DismissedMentionRange {
  start: number
  end: number
  hasLeftRange: boolean
}

type ZenModeUpdate =
  | boolean
  | typeof RESET
  | ((previous: boolean) => boolean | typeof RESET)

function createTransientZenModeAtom() {
  const baseAtom = atom(false)
  return atom(
    (get) => get(baseAtom),
    (get, set, update: ZenModeUpdate) => {
      const currentValue = get(baseAtom)
      const nextValue =
        typeof update === "function"
          ? update(currentValue)
          : update

      set(baseAtom, nextValue === RESET ? false : nextValue)
    },
  )
}

function summarizeVoiceErrorMessage(input: string): string {
  const normalized = input.replace(/\s+/g, " ").trim()
  const lowered = normalized.toLowerCase()

  if (
    lowered.includes("authentication failed") ||
    lowered.includes("not configured") ||
    lowered.includes("codex login") ||
    lowered.includes("openai_api_key")
  ) {
    return "Voice auth required. Run codex login or set OPENAI_API_KEY."
  }
  if (lowered.includes("rate limited")) {
    return "Voice transcription is rate limited. Try again shortly."
  }
  if (lowered.includes("temporarily unavailable")) {
    return "Voice transcription is unavailable. Try again."
  }
  if (lowered.includes("recording too short")) {
    return "Recording too short. Hold for at least 1 second."
  }
  if (lowered.includes("no audio was captured")) {
    return "No audio captured. Check your microphone and try again."
  }

  return normalized || "Voice input failed."
}

export function PromptBox({
  id,
  value,
  onChange,
  onSubmit,
  placeholder = "What do you want to build?",
  className,
  footerStart,
  autoFocus = false,
  submission = {},
  mentions = {},
  attachments: attachmentConfig = {},
  zenMode = {},
}: PromptBoxProps) {
  const {
    isSubmitting = false,
    disabled: submitDisabled = false,
    title: submitTitle = "Submit (Enter)",
    mode: submitMode = "enter",
    isRunning = false,
    onStop,
  } = submission
  const {
    suggestions: mentionSuggestions = [],
    searchScope: mentionSearchScope = "files",
    isLoading: mentionLoading = false,
    isError: mentionError = false,
    onQueryChange: onMentionQueryChange,
  } = mentions
  const {
    items: attachments = [],
    isAttaching = false,
    error: attachmentError = null,
    onAttachFiles,
    onRemove: onRemoveAttachment,
    projectId: attachmentProjectId,
  } = attachmentConfig
  const {
    layout: zenModeLayout = "thread",
    storageKey: zenModeStorageKey,
    resetKey: zenModeResetKey,
    resetOnSubmit: resetZenModeOnSubmit = false,
  } = zenMode
  const formRef = useRef<HTMLFormElement>(null)
  const heightAnimationFromRef = useRef<number | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const attachmentInputRef = useRef<HTMLInputElement>(null)
  const valueRef = useRef(value)
  const resizeTextarea = useAutoGrow(textareaRef, {
    minHeight: PROMPTBOX_MIN_HEIGHT,
    maxHeight: PROMPTBOX_MAX_HEIGHT,
  })
  const mentionItemRefs = useRef<Array<HTMLButtonElement | null>>([])
  const mentionKeyRef = useRef("")
  const dismissedMentionRef = useRef<DismissedMentionRange | null>(null)
  const [activeMention, setActiveMention] = useState<ActiveFileMention | null>(null)
  const [selectedMentionIndex, setSelectedMentionIndex] = useState(0)
  const [expandedImageIndex, setExpandedImageIndex] = useState<number | null>(null)
  const resolvedZenModeStorageKey = zenModeStorageKey ?? ZEN_MODE_STORAGE_KEY[zenModeLayout]
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
  )
  const [isZenMode, setIsZenMode] = useAtom(zenModeAtom)

  useEffect(() => {
    if (!textareaRef.current) return
    if (isZenMode) {
      textareaRef.current.style.height = "100%"
      return
    }
    resizeTextarea(textareaRef.current)
  }, [isZenMode, resizeTextarea, value])

  useEffect(() => {
    valueRef.current = value
  }, [value])

  useEffect(() => {
    if (zenModeResetKey === undefined) return
    if (resolvedZenModeStorageKey) {
      setIsZenMode(RESET)
      return
    }
    setIsZenMode(false)
  }, [resolvedZenModeStorageKey, setIsZenMode, zenModeResetKey])

  useLayoutEffect(() => {
    const fromHeight = heightAnimationFromRef.current
    const formElement = formRef.current
    if (fromHeight === null || !formElement) return
    heightAnimationFromRef.current = null

    const previousTransition = formElement.style.transition
    const previousWillChange = formElement.style.willChange

    formElement.style.transition = "none"
    formElement.style.height = ""
    const toHeight = formElement.getBoundingClientRect().height
    formElement.style.height = `${fromHeight}px`
    formElement.getBoundingClientRect()
    formElement.style.willChange = "height"
    formElement.style.transition = "height 240ms cubic-bezier(0.22, 1, 0.36, 1)"
    formElement.style.height = `${toHeight}px`

    let isCleanedUp = false
    const cleanup = () => {
      if (isCleanedUp) return
      isCleanedUp = true
      formElement.style.transition = previousTransition
      formElement.style.willChange = previousWillChange
      formElement.style.height = ""
      formElement.removeEventListener("transitionend", handleTransitionEnd)
      window.clearTimeout(fallbackTimeout)
    }
    const handleTransitionEnd = (event: TransitionEvent) => {
      if (event.propertyName !== "height") return
      cleanup()
    }
    const fallbackTimeout = window.setTimeout(cleanup, 320)
    formElement.addEventListener("transitionend", handleTransitionEnd)

    return cleanup
  }, [isZenMode, zenModeLayout])

  const syncMentionState = useCallback((textarea: HTMLTextAreaElement) => {
    const caretPosition = textarea.selectionStart ?? textarea.value.length
    const dismissedMention = dismissedMentionRef.current

    if (dismissedMention) {
      const isWithinDismissedRange =
        caretPosition >= dismissedMention.start &&
        caretPosition <= dismissedMention.end

      if (!isWithinDismissedRange) {
        dismissedMentionRef.current = {
          ...dismissedMention,
          hasLeftRange: true,
        }
      } else if (dismissedMention.hasLeftRange) {
        dismissedMentionRef.current = null
      }
    }

    const shouldSuppressMention = Boolean(
      dismissedMentionRef.current &&
        caretPosition >= dismissedMentionRef.current.start &&
        caretPosition <= dismissedMentionRef.current.end &&
        !dismissedMentionRef.current.hasLeftRange
    )

    const nextMention = shouldSuppressMention
      ? null
      : findActiveFileMention(textarea.value, caretPosition)
    const nextKey = nextMention
      ? `${nextMention.start}:${nextMention.end}:${nextMention.query}`
      : ""
    if (nextKey !== mentionKeyRef.current) {
      mentionKeyRef.current = nextKey
      setSelectedMentionIndex(0)
    }
    setActiveMention(nextMention)

    onMentionQueryChange?.(nextMention ? nextMention.query : null)
  }, [onMentionQueryChange])

  useEffect(() => {
    if (!textareaRef.current) return
    syncMentionState(textareaRef.current)
  }, [syncMentionState, value])

  const trimmedValue = value.trim()
  const hasAttachments = attachments.length > 0
  const hasSubmittableInput = trimmedValue.length > 0 || hasAttachments
  const hasMentionContext = activeMention !== null
  const showMentionMenu = hasMentionContext
  const activeMentionQuery = activeMention?.query.trim() ?? ""
  const showQueryHint = activeMentionQuery.length === 0

  useEffect(() => {
    if (mentionSuggestions.length === 0) {
      setSelectedMentionIndex(0)
      return
    }
    if (selectedMentionIndex >= mentionSuggestions.length) {
      setSelectedMentionIndex(0)
    }
  }, [mentionSuggestions.length, selectedMentionIndex])

  useEffect(() => {
    mentionItemRefs.current = mentionItemRefs.current.slice(0, mentionSuggestions.length)
  }, [mentionSuggestions.length])

  useEffect(() => {
    if (!showMentionMenu || mentionSuggestions.length === 0) return
    const selectedItem = mentionItemRefs.current[selectedMentionIndex]
    if (!selectedItem) return
    selectedItem.scrollIntoView({
      block: "nearest",
    })
  }, [mentionSuggestions.length, selectedMentionIndex, showMentionMenu])

  const applyMention = useCallback((item: PromptMentionSuggestion) => {
    const textarea = textareaRef.current
    if (!textarea || !activeMention) return

    const mentionStart = activeMention.start
    const mentionEnd = mentionStart + item.replacement.length + 1
    const replacement = insertFileMention(value, activeMention, item.replacement)
    onChange(replacement.value)
    mentionKeyRef.current = ""
    dismissedMentionRef.current = {
      start: mentionStart,
      end: mentionEnd,
      hasLeftRange: false,
    }
    setActiveMention(null)
    setSelectedMentionIndex(0)
    onMentionQueryChange?.(null)

    requestAnimationFrame(() => {
      const nextTextarea = textareaRef.current
      if (!nextTextarea) return
      nextTextarea.focus()
      nextTextarea.setSelectionRange(
        replacement.caretPosition,
        replacement.caretPosition,
      )
      if (isZenMode) {
        nextTextarea.style.height = "100%"
      } else {
        resizeTextarea(nextTextarea)
      }
    })
  }, [activeMention, isZenMode, onChange, onMentionQueryChange, resizeTextarea, value])

  const insertVoiceTranscript = useCallback((transcript: string) => {
    const normalizedTranscript = transcript.replace(/\s+/g, " ").trim()
    if (normalizedTranscript.length === 0) return

    const textarea = textareaRef.current
    const currentValue = valueRef.current
    if (!textarea) {
      const nextValue =
        currentValue.length === 0 || /\s$/.test(currentValue)
          ? `${currentValue}${normalizedTranscript}`
          : `${currentValue} ${normalizedTranscript}`
      onChange(nextValue)
      return
    }

    const selectionStart = textarea.selectionStart ?? currentValue.length
    const selectionEnd = textarea.selectionEnd ?? selectionStart
    const before = currentValue.slice(0, selectionStart)
    const after = currentValue.slice(selectionEnd)
    const needsLeadingWhitespace = before.length > 0 && !/\s$/.test(before)
    const needsTrailingWhitespace = after.length > 0 && !/^\s/.test(after)
    const insertedText =
      `${needsLeadingWhitespace ? " " : ""}${normalizedTranscript}${needsTrailingWhitespace ? " " : ""}`
    const nextValue = `${before}${insertedText}${after}`
    const nextCursor = before.length + insertedText.length

    onChange(nextValue)
    requestAnimationFrame(() => {
      const nextTextarea = textareaRef.current
      if (!nextTextarea) return
      nextTextarea.focus()
      nextTextarea.setSelectionRange(nextCursor, nextCursor)
      if (isZenMode) {
        nextTextarea.style.height = "100%"
      } else {
        resizeTextarea(nextTextarea)
      }
      syncMentionState(nextTextarea)
    })
  }, [isZenMode, onChange, resizeTextarea, syncMentionState])

  const getVoicePromptContext = useCallback(() => {
    const currentValue = valueRef.current
    const textarea = textareaRef.current
    if (!textarea) {
      const trimmed = currentValue.trim()
      return trimmed.length > 0 ? trimmed : undefined
    }
    const selectionStart = textarea.selectionStart ?? currentValue.length
    const beforeCursor = currentValue.slice(0, selectionStart).trim()
    return beforeCursor.length > 0 ? beforeCursor : undefined
  }, [])

  const requestVoiceTranscription = useCallback(async ({
    file,
    promptContext,
    signal,
  }: {
    file: File
    promptContext?: string
    signal?: AbortSignal
  }) => {
    const transcription = await transcribeVoiceInput(file, promptContext, signal)
    return transcription.text
  }, [])

  const voiceInput = useVoiceInput({
    onTranscript: insertVoiceTranscript,
    onTranscribe: requestVoiceTranscription,
    getPromptContext: getVoicePromptContext,
  })
  const isVoiceRecording = voiceInput.isRecording
  const isVoiceProcessing = voiceInput.isProcessing
  const isVoiceBusy = isVoiceRecording || isVoiceProcessing
  const voiceErrorMessage = voiceInput.state === "error"
    ? summarizeVoiceErrorMessage(
      voiceInput.errorMessage ?? voiceInput.statusLabel ?? "Voice input failed."
    )
    : null
  const showVoiceActionGroup = isVoiceRecording || isVoiceProcessing
  const showStop = Boolean(isRunning && onStop && !hasSubmittableInput && !isVoiceBusy)
  const canSubmit = hasSubmittableInput && !isSubmitting && !submitDisabled && !isVoiceBusy
  const canStartVoiceInput = voiceInput.isSupported && !isSubmitting
  const effectiveSubmitMode: SubmitMode = submitMode
  const effectiveSubmitTitle = isZenMode
    ? submitTitle.replace(/^Submit\s+/, "")
    : submitTitle

  const emitAttachmentFiles = useCallback((files: File[]) => {
    if (!onAttachFiles || files.length === 0) return
    void onAttachFiles(files)
  }, [onAttachFiles])

  const submitPrompt = useCallback(() => {
    if (!canSubmit) return
    onSubmit()
    if (!resetZenModeOnSubmit || !isZenMode) return
    if (resolvedZenModeStorageKey) {
      setIsZenMode(RESET)
      return
    }
    setIsZenMode(false)
  }, [canSubmit, isZenMode, onSubmit, resetZenModeOnSubmit, resolvedZenModeStorageKey, setIsZenMode])

  const toggleZenMode = useCallback(() => {
    const textarea = textareaRef.current
    const formElement = formRef.current
    const selectionStart = textarea?.selectionStart ?? null
    const selectionEnd = textarea?.selectionEnd ?? null
    const scrollTop = textarea?.scrollTop ?? null
    heightAnimationFromRef.current = formElement?.getBoundingClientRect().height ?? null

    setIsZenMode((previous) => !previous)

    requestAnimationFrame(() => {
      const nextTextarea = textareaRef.current
      if (!nextTextarea) return
      nextTextarea.focus()
      if (selectionStart !== null && selectionEnd !== null) {
        nextTextarea.setSelectionRange(selectionStart, selectionEnd)
      }
      if (scrollTop !== null) {
        nextTextarea.scrollTop = scrollTop
      }
    })
  }, [setIsZenMode])

  const handleAttachmentInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const fileList = event.target.files
      if (!fileList || fileList.length === 0) return
      emitAttachmentFiles(Array.from(fileList))
      event.target.value = ""
    },
    [emitAttachmentFiles],
  )

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    submitPrompt()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (showMentionMenu) {
      if (event.key === "ArrowDown" && mentionSuggestions.length > 0) {
        event.preventDefault()
        setSelectedMentionIndex((prev) => (prev + 1) % mentionSuggestions.length)
        return
      }
      if (event.key === "ArrowUp" && mentionSuggestions.length > 0) {
        event.preventDefault()
        setSelectedMentionIndex((prev) =>
          (prev + mentionSuggestions.length - 1) % mentionSuggestions.length
        )
        return
      }
      if ((event.key === "Enter" || event.key === "Tab") && mentionSuggestions.length > 0) {
        event.preventDefault()
        const selected = mentionSuggestions[selectedMentionIndex] ?? mentionSuggestions[0]
        if (selected) {
          applyMention(selected)
        }
        return
      }
      if (event.key === "Escape") {
        event.preventDefault()
        mentionKeyRef.current = ""
        setActiveMention(null)
        onMentionQueryChange?.(null)
        return
      }
    }

    const withModifier = event.metaKey || event.ctrlKey
    if (isZenMode) return
    const isSubmitKey =
      effectiveSubmitMode === "mod-enter"
        ? withModifier && event.key === "Enter"
        : event.key === "Enter" && !event.shiftKey

    if (!isSubmitKey) return
    event.preventDefault()
    submitPrompt()
  }

  return (
    <form
      ref={formRef}
      onSubmit={handleSubmit}
      onDragOver={(event) => {
        if (!onAttachFiles) return
        event.preventDefault()
      }}
      onDrop={(event) => {
        if (!onAttachFiles) return
        event.preventDefault()
        if (!event.dataTransfer?.files || event.dataTransfer.files.length === 0) return
        emitAttachmentFiles(Array.from(event.dataTransfer.files))
      }}
      className={cn("relative w-full rounded-lg border border-input bg-background pb-2", isZenMode && "flex flex-col pb-3", isZenMode && ZEN_MODE_HEIGHT_CLASS[zenModeLayout], className)}
    >
      <Button
        type="button"
        size="icon"
        variant="ghost"
        onMouseDown={(event) => {
          event.preventDefault()
        }}
        onClick={toggleZenMode}
        title={isZenMode ? "Exit zen mode" : "Enter zen mode"}
        aria-label={isZenMode ? "Exit zen mode" : "Enter zen mode"}
        aria-pressed={isZenMode}
        className="absolute right-2 top-2 z-20 size-auto h-6 px-1.5 text-muted-foreground/40 hover:text-muted-foreground"
      >
        {isZenMode ? <Minimize2 className="size-3" /> : <Maximize2 className="size-3" />}
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
          onChange(event.target.value)
          if (isZenMode) {
            event.target.style.height = "100%"
          } else {
            resizeTextarea(event.target)
          }
          syncMentionState(event.target)
        }}
        onClick={(event) => {
          syncMentionState(event.currentTarget)
        }}
        onSelect={(event) => {
          syncMentionState(event.currentTarget)
        }}
        onBlur={() => {
          mentionKeyRef.current = ""
          if (dismissedMentionRef.current) {
            dismissedMentionRef.current = {
              ...dismissedMentionRef.current,
              hasLeftRange: true,
            }
          }
          setActiveMention(null)
          onMentionQueryChange?.(null)
        }}
        onPaste={(event) => {
          if (!onAttachFiles) return
          const clipboardItems = Array.from(event.clipboardData?.items ?? [])
          const pastedFiles = clipboardItems
            .filter((item) => item.kind === "file")
            .map((item) => item.getAsFile())
            .filter((file): file is File => file !== null)

          if (pastedFiles.length === 0) return
          event.preventDefault()
          emitAttachmentFiles(pastedFiles)
        }}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        rows={1}
        autoFocus={autoFocus}
        enterKeyHint="send"
        className={cn(
          "w-full resize-none overflow-y-auto bg-transparent px-4 pb-1 pr-14 pt-3 text-base leading-relaxed md:text-sm outline-none placeholder:text-muted-foreground/60",
          isZenMode && "min-h-0 flex-1 px-6 pb-3 pt-8"
        )}
        style={{
          minHeight: isZenMode ? "0px" : `${PROMPTBOX_MIN_HEIGHT}px`,
          height: isZenMode ? "100%" : undefined,
          maxHeight: isZenMode ? "none" : `${PROMPTBOX_MAX_HEIGHT}px`,
        }}
      />

      {showMentionMenu ? (
        <PromptMentionMenu
          showQueryHint={showQueryHint}
          mentionSearchScope={mentionSearchScope}
          mentionLoading={mentionLoading}
          mentionError={mentionError}
          mentionSuggestions={mentionSuggestions}
          selectedMentionIndex={selectedMentionIndex}
          mentionItemRefs={mentionItemRefs}
          onApplyMention={applyMention}
        />
      ) : null}

      <PromptAttachmentPreview
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
        <div className="flex min-w-0 flex-1 flex-row items-center gap-1" aria-live="polite">
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
            className="size-auto h-10 px-2.5 transition-all md:h-8 md:px-2"
          >
            {isAttaching ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Paperclip className="size-4" />
            )}
          </Button>
          {!showVoiceActionGroup ? (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              title={
                !voiceInput.isSupported
                  ? "Voice input is not supported in this browser"
                  : "Start voice input"
              }
              disabled={!canStartVoiceInput}
              onClick={voiceInput.start}
              className="size-auto h-10 px-2.5 transition-all md:h-8 md:px-2"
            >
              <Mic className="size-4" />
            </Button>
          ) : null}
          {showStop ? (
            <Button
              type="button"
              size="icon"
              variant="secondary"
              title="Stop run"
              onClick={onStop}
              className="size-auto h-10 px-2.5 transition-all md:h-8 md:px-2"
            >
              <Square className="size-3.5" fill="currentColor" strokeWidth={0} />
            </Button>
          ) : isVoiceRecording ? (
            <div className="relative inline-flex">
              <Button
                type="button"
                size="sm"
                variant="default"
                title="Stop and transcribe recording"
                onClick={voiceInput.stop}
                className="h-10 rounded-r-none px-2.5 md:h-8 md:px-2"
              >
                <AudioLines className="size-4 animate-pulse" />
              </Button>
              <Button
                type="button"
                size="sm"
                variant="default"
                title="Cancel recording"
                onClick={voiceInput.cancel}
                className="h-10 w-10 rounded-l-none border-l border-l-primary-foreground/20 px-0 transition-all hover:border-l-primary-foreground/30 md:h-8 md:w-8"
              >
                <X className="size-3.5" />
              </Button>
            </div>
          ) : isVoiceProcessing ? (
            <div className="relative inline-flex">
              <Button
                type="button"
                size="sm"
                variant="default"
                title="Transcribing voice input..."
                disabled
                className="h-10 rounded-r-none px-2.5 md:h-8 md:px-2"
              >
                <AudioLines className="size-4" />
                <Loader2 className="size-4 animate-spin" />
              </Button>
              <Button
                type="button"
                size="sm"
                variant="default"
                title="Cancel transcription"
                onClick={voiceInput.cancel}
                className="h-10 w-10 rounded-l-none border-l border-l-primary-foreground/20 px-0 transition-all hover:border-l-primary-foreground/30 md:h-8 md:w-8"
              >
                <X className="size-3.5" />
              </Button>
            </div>
          ) : (
            <Button
              type="submit"
              size="sm"
              variant="default"
              title={effectiveSubmitTitle}
              disabled={!canSubmit}
              className="h-10 px-2.5 transition-all md:h-8 md:px-2"
            >
              {isSubmitting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                isZenMode ? <ArrowUp className="size-4" /> : <CornerDownLeft className="size-4" />
              )}
            </Button>
          )}
        </div>
      </div>
    </form>
  )
}
