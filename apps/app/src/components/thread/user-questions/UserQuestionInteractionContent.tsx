import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { QUESTION_SELECT_APP_COMMAND_IDS } from "@bb/domain";
import type {
  PendingInteractionUserQuestionOption,
  PendingInteractionUserQuestionQuestion,
} from "@bb/domain";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { usePointerCoarse } from "@bb/shared-ui/hooks/use-pointer-coarse";
import { TabPill } from "@/components/ui/tab-pill.js";
import { useAutoGrow } from "@/hooks/useAutoGrow";
import { useResolveThreadPendingInteraction } from "@/hooks/mutations/thread-interaction-mutations";
import { useStopThread } from "@/hooks/mutations/thread-runtime-mutations";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  answerStateFor,
  buildUserAnswerResolution,
  createInitialFormState,
  isQuestionAnswered,
  type QuestionAnswerState,
  type QuestionFormState,
} from "./user-question-form-state.js";
import {
  useAppCommandContext,
  useAppCommandShortcuts,
  useIndexedAppCommandHandlers,
} from "@/components/commands/AppCommandProvider";
import type { AppShortcutPresentation } from "@/lib/app-keybindings";
import { useOptionalPaneContext } from "@/views/thread-detail/PaneContext";
import { useStickyFooterAvailableHeight } from "./useStickyFooterAvailableHeight.js";

interface UserQuestionAnswerFormProps {
  className?: string;
  interactionId: string;
  isResolving?: boolean;
  questions: readonly PendingInteractionUserQuestionQuestion[];
  shortcutsEnabled: boolean;
  threadId: string;
}

interface QuestionOptionRowProps {
  checked: boolean;
  label: string;
  description?: string;
  multiSelect: boolean;
  onSelect: () => void;
  shortcut?: AppShortcutPresentation;
}

interface QuestionTabsProps {
  currentIndex: number;
  formState: QuestionFormState;
  onSelect: (index: number) => void;
  questions: readonly PendingInteractionUserQuestionQuestion[];
}

interface QuestionInputBlockProps {
  disabled: boolean;
  question: PendingInteractionUserQuestionQuestion;
  state: QuestionAnswerState;
  onToggleOption: (optionValue: string) => void;
  onSelectOther: () => void;
  onFreeTextChange: (value: string) => void;
  onShortcutSubmit: () => void;
  shortcuts: ReadonlyMap<string, AppShortcutPresentation>;
}

const OTHER_OPTION_LABEL = "Other…";
const USER_QUESTION_FREE_TEXT_MIN_HEIGHT = 84;
const USER_QUESTION_FREE_TEXT_MAX_HEIGHT = 158;

type QuestionShortcutChoice =
  | { kind: "option"; value: string }
  | { kind: "other" }
  | null;

export function resolveQuestionShortcutChoice(
  question: PendingInteractionUserQuestionQuestion,
  index: number,
): QuestionShortcutChoice {
  const options = question.options ?? [];
  const option = options[index];
  if (option) return { kind: "option", value: option.value };
  if (
    index === options.length &&
    options.length > 0 &&
    question.allowFreeText
  ) {
    return { kind: "other" };
  }
  return null;
}

function QuestionOptionRow({
  checked,
  label,
  description,
  multiSelect,
  onSelect,
  shortcut,
}: QuestionOptionRowProps) {
  return (
    <button
      type="button"
      aria-pressed={checked}
      aria-keyshortcuts={shortcut?.ariaKeyshortcuts}
      onClick={onSelect}
      className={cn(
        "flex w-full items-start gap-2.5 rounded-md px-2.5 py-1.5 text-left transition-colors",
        checked ? "bg-surface-selected" : "hover:bg-state-hover",
      )}
    >
      <span
        className={cn(
          "mt-0.5 flex size-4 shrink-0 items-center justify-center border",
          multiSelect ? "rounded" : "rounded-full",
          checked
            ? "border-primary bg-primary text-primary-foreground"
            : "border-input",
        )}
      >
        {checked ? <Icon name="Check" className="size-3" aria-hidden /> : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">
          {label}
        </span>
        {description ? (
          <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
            {description}
          </span>
        ) : null}
      </span>
      {shortcut ? (
        <kbd
          aria-hidden="true"
          className="mt-0.5 shrink-0 text-xs font-normal text-subtle-foreground"
        >
          {shortcut.label}
        </kbd>
      ) : null}
    </button>
  );
}

function QuestionTabs({
  currentIndex,
  formState,
  onSelect,
  questions,
}: QuestionTabsProps) {
  return (
    <div className="mb-2 flex shrink-0 items-center gap-2">
      {}
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {questions.map((question, index) => {
          const answered = isQuestionAnswered(
            question,
            answerStateFor(formState, question),
          );
          return (
            <TabPill
              key={question.id}
              label={question.shortLabel ?? `Question ${index + 1}`}
              labelClassName={answered ? "line-through" : undefined}
              title={question.prompt}
              isActive={index === currentIndex}
              onSelect={() => onSelect(index)}
              closeAction={null}
            />
          );
        })}
      </div>
      <span className="shrink-0 text-xs text-muted-foreground">
        {currentIndex + 1} of {questions.length}
      </span>
    </div>
  );
}

function QuestionInputBlock({
  disabled,
  question,
  state,
  onToggleOption,
  onSelectOther,
  onFreeTextChange,
  onShortcutSubmit,
  shortcuts,
}: QuestionInputBlockProps) {
  const freeTextRef = useRef<HTMLTextAreaElement>(null);
  const isPointerCoarse = usePointerCoarse();
  const resizeFreeTextArea = useAutoGrow(freeTextRef, {
    minHeight: USER_QUESTION_FREE_TEXT_MIN_HEIGHT,
    maxHeight: USER_QUESTION_FREE_TEXT_MAX_HEIGHT,
  });
  const options = question.options ?? [];
  const freeTextLabel = `${question.shortLabel ?? question.prompt} answer`;

  useLayoutEffect(() => {
    if (!state.otherSelected) return;
    resizeFreeTextArea();
  }, [question.id, resizeFreeTextArea, state.otherSelected, state.otherText]);

  const handleFreeTextKeyDown = (
    event: KeyboardEvent<HTMLTextAreaElement>,
  ): void => {
    if (
      event.nativeEvent.isComposing ||
      event.key !== "Enter" ||
      (!event.metaKey && !event.ctrlKey)
    ) {
      return;
    }
    event.preventDefault();
    onShortcutSubmit();
  };
  return (
    <fieldset disabled={disabled} className="min-w-0">
      <legend className="sr-only">{question.prompt}</legend>
      <div className="text-sm font-semibold text-foreground">
        {question.prompt}
      </div>
      <div className="mt-2 space-y-0.5">
        {options.map((option: PendingInteractionUserQuestionOption, index) => (
          <QuestionOptionRow
            key={option.value}
            checked={state.selected.includes(option.value)}
            label={option.label}
            description={option.description}
            multiSelect={question.multiSelect}
            onSelect={() => onToggleOption(option.value)}
            shortcut={shortcuts.get(String(index))}
          />
        ))}
        {question.allowFreeText && options.length > 0 ? (
          <QuestionOptionRow
            checked={state.otherSelected}
            label={OTHER_OPTION_LABEL}
            multiSelect={question.multiSelect}
            onSelect={onSelectOther}
            shortcut={shortcuts.get(String(options.length))}
          />
        ) : null}
      </div>
      {state.otherSelected ? (
        <textarea
          ref={freeTextRef}
          aria-label={freeTextLabel}
          value={state.otherText}
          rows={1}
          autoFocus={!isPointerCoarse}
          autoComplete="off"
          onChange={(event) => {
            onFreeTextChange(event.target.value);
            resizeFreeTextArea(event.target);
          }}
          onKeyDown={handleFreeTextKeyDown}
          placeholder="Type your own answer…"
          className="mt-2 w-full resize-none overflow-y-auto rounded-md border border-border bg-surface-raised px-3 py-2 text-sm leading-relaxed text-foreground placeholder:text-muted-foreground focus-visible:border-ring/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/40"
          style={{
            minHeight: `${USER_QUESTION_FREE_TEXT_MIN_HEIGHT}px`,
            maxHeight: `${USER_QUESTION_FREE_TEXT_MAX_HEIGHT}px`,
          }}
        />
      ) : null}
    </fieldset>
  );
}

export function UserQuestionAnswerForm({
  className,
  interactionId,
  isResolving = false,
  questions,
  shortcutsEnabled,
  threadId,
}: UserQuestionAnswerFormProps) {
  const [formState, setFormState] = useState<QuestionFormState>(() =>
    createInitialFormState(questions),
  );
  const [currentIndex, setCurrentIndex] = useState(0);
  const [activeInteractionId, setActiveInteractionId] = useState(interactionId);
  const rootRef = useRef<HTMLDivElement>(null);
  const availableHeight = useStickyFooterAvailableHeight(rootRef);
  const resolvePendingInteraction = useResolveThreadPendingInteraction();
  const stopThread = useStopThread();
  const questionSelectionShortcuts = useAppCommandShortcuts(
    QUESTION_SELECT_APP_COMMAND_IDS,
  );

  if (activeInteractionId !== interactionId) {
    setActiveInteractionId(interactionId);
    setFormState(createInitialFormState(questions));
    setCurrentIndex(0);
  }

  const totalQuestions = questions.length;
  const currentQuestion = questions[currentIndex] ?? null;
  const isFirst = currentIndex === 0;
  const isLast = currentIndex === totalQuestions - 1;
  const allAnswered = useMemo(
    () =>
      totalQuestions > 0 &&
      questions.every((question) =>
        isQuestionAnswered(question, answerStateFor(formState, question)),
      ),
    [formState, questions, totalQuestions],
  );

  const mutationErrorMessage = resolvePendingInteraction.error
    ? getMutationErrorMessage({
        error: resolvePendingInteraction.error,
        fallbackMessage: "Failed to submit answer",
        lifecycleOperation: "resolve_interaction",
      })
    : null;
  const disabled = resolvePendingInteraction.isPending || isResolving;
  const choiceShortcuts = useMemo(() => {
    const shortcuts = new Map<string, AppShortcutPresentation>();
    QUESTION_SELECT_APP_COMMAND_IDS.forEach((command, index) => {
      const shortcut = questionSelectionShortcuts.get(command);
      if (shortcut) shortcuts.set(String(index), shortcut);
    });
    return shortcuts;
  }, [questionSelectionShortcuts]);

  const updateQuestionState = (
    question: PendingInteractionUserQuestionQuestion,
    update: (state: QuestionAnswerState) => QuestionAnswerState,
  ): void => {
    setFormState((current) => ({
      ...current,
      [question.id]: update(answerStateFor(current, question)),
    }));
  };

  const handleToggleOption = (
    question: PendingInteractionUserQuestionQuestion,
    optionValue: string,
  ): void => {
    updateQuestionState(question, (state) => {
      if (question.multiSelect) {
        const selected = state.selected.includes(optionValue)
          ? state.selected.filter((value) => value !== optionValue)
          : [...state.selected, optionValue];
        return { ...state, selected };
      }
      return { ...state, selected: [optionValue], otherSelected: false };
    });
  };

  const handleSelectOther = (
    question: PendingInteractionUserQuestionQuestion,
  ): void => {
    updateQuestionState(question, (state) =>
      question.multiSelect
        ? { ...state, otherSelected: !state.otherSelected }
        : { ...state, selected: [], otherSelected: true },
    );
  };

  const handleFreeTextChange = (
    question: PendingInteractionUserQuestionQuestion,
    value: string,
  ): void => {
    updateQuestionState(question, (state) => ({ ...state, otherText: value }));
  };

  const submitAnswer = (): void => {
    if (disabled || !allAnswered) {
      return;
    }
    void resolvePendingInteraction
      .mutateAsync({
        threadId,
        interactionId,
        resolution: buildUserAnswerResolution(questions, formState),
      })
      .catch(() => {});
  };

  const handleAdvance = (): void => {
    if (isLast) {
      submitAnswer();
      return;
    }
    setCurrentIndex((index) => Math.min(index + 1, totalQuestions - 1));
  };

  const handleCancel = (): void => {
    stopThread.mutate(threadId);
  };

  const isFocusedPane = useOptionalPaneContext()?.isFocused ?? true;
  const selectChoiceAt = (index: number): boolean => {
    if (!isFocusedPane || disabled || !shortcutsEnabled || !currentQuestion) {
      return false;
    }
    const choice = resolveQuestionShortcutChoice(currentQuestion, index);
    if (choice?.kind === "option") {
      handleToggleOption(currentQuestion, choice.value);
      return true;
    }
    if (choice?.kind === "other") {
      handleSelectOther(currentQuestion);
      return true;
    }
    return false;
  };

  useAppCommandContext(
    "questionOpen",
    currentQuestion !== null && !disabled && shortcutsEnabled,
  );
  useIndexedAppCommandHandlers(
    QUESTION_SELECT_APP_COMMAND_IDS,
    selectChoiceAt,
    100,
    shortcutsEnabled,
  );

  if (!currentQuestion) {
    return null;
  }

  const currentState = answerStateFor(formState, currentQuestion);

  return (
    <div
      ref={rootRef}
      className={cn(
        "flex min-h-0 flex-col text-xs text-muted-foreground",
        availableHeight === null && "max-h-[calc(100dvh-6rem)]",
        className,
      )}
      style={
        availableHeight === null
          ? undefined
          : { maxHeight: `${availableHeight}px` }
      }
    >
      {totalQuestions > 1 ? (
        <QuestionTabs
          currentIndex={currentIndex}
          formState={formState}
          onSelect={setCurrentIndex}
          questions={questions}
        />
      ) : null}
      <div className="min-h-0 overflow-y-auto overscroll-contain touch-pan-y">
        <QuestionInputBlock
          disabled={disabled}
          question={currentQuestion}
          state={currentState}
          onToggleOption={(optionValue) =>
            handleToggleOption(currentQuestion, optionValue)
          }
          onSelectOther={() => handleSelectOther(currentQuestion)}
          onFreeTextChange={(value) =>
            handleFreeTextChange(currentQuestion, value)
          }
          onShortcutSubmit={handleAdvance}
          shortcuts={choiceShortcuts}
        />
      </div>
      <div className="mt-3 flex shrink-0 items-center justify-between gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled || stopThread.isPending}
          onClick={handleCancel}
        >
          Cancel
        </Button>
        <div className="flex items-center gap-2">
          {!isFirst ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => setCurrentIndex((index) => Math.max(index - 1, 0))}
            >
              Back
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            disabled={disabled || (isLast && !allAnswered)}
            onClick={handleAdvance}
          >
            {isResolving ? (
              <Icon name="Spinner" className="size-3 animate-spin" />
            ) : null}
            {isLast ? "Submit answer" : "Next"}
          </Button>
        </div>
      </div>
      {mutationErrorMessage ? (
        <div className="mt-2 shrink-0 rounded-md border border-surface-destructive-border bg-surface-destructive px-3 py-2 text-xs text-destructive-text">
          {mutationErrorMessage}
        </div>
      ) : null}
    </div>
  );
}
