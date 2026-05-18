import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import type {
  PendingInteractionUserAnswer,
  PendingInteractionUserQuestionOption,
  PendingInteractionUserQuestionQuestion,
  UserQuestionPendingInteractionResolution,
} from "@bb/domain";
import { Button } from "@/components/ui/button.js";
import { Icon } from "@/components/ui/icon.js";
import { useResolveThreadPendingInteraction } from "@/hooks/mutations/thread-interaction-mutations";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import { cn } from "@/lib/utils";

interface UserQuestionAnswerFormProps {
  className?: string;
  interactionId: string;
  /**
   * The interaction has reached `status: "resolving"` — the server is in the
   * middle of delivering the answer to the provider. Keeps the form chrome on
   * screen with everything disabled and a spinner in the submit button,
   * instead of swapping the form out for a separate notice.
   */
  isResolving?: boolean;
  questions: readonly PendingInteractionUserQuestionQuestion[];
  threadId: string;
}

interface QuestionPromptProps {
  question: PendingInteractionUserQuestionQuestion;
}

interface QuestionInputBlockProps {
  disabled: boolean;
  formState: QuestionFormState;
  interactionId: string;
  onFreeTextChange: (input: UpdateQuestionFreeTextInput) => void;
  onOptionToggle: (input: ToggleQuestionOptionInput) => void;
  onSubmit: () => void;
  question: PendingInteractionUserQuestionQuestion;
}

interface QuestionOptionInputProps {
  checked: boolean;
  disabled: boolean;
  inputName: string;
  onOptionToggle: (input: ToggleQuestionOptionInput) => void;
  option: PendingInteractionUserQuestionOption;
  question: PendingInteractionUserQuestionQuestion;
}

interface QuestionFormState {
  freeTextByQuestionId: Record<string, string>;
  selectedValuesByQuestionId: Record<string, string[]>;
}

interface ToggleQuestionOptionInput {
  optionValue: string;
  question: PendingInteractionUserQuestionQuestion;
}

interface UpdateQuestionFreeTextInput {
  questionId: string;
  value: string;
}

interface SelectedValuesInput {
  formState: QuestionFormState;
  question: PendingInteractionUserQuestionQuestion;
}

interface FreeTextInput {
  formState: QuestionFormState;
  question: PendingInteractionUserQuestionQuestion;
}

interface ToggleSelectedValuesInput {
  optionValue: string;
  question: PendingInteractionUserQuestionQuestion;
  selectedValues: readonly string[];
}

interface ValidSelectedValuesInput {
  question: PendingInteractionUserQuestionQuestion;
  selectedValues: readonly string[];
}

interface QuestionAnsweredInput {
  formState: QuestionFormState;
  question: PendingInteractionUserQuestionQuestion;
}

interface BuildResolutionInput {
  formState: QuestionFormState;
  questions: readonly PendingInteractionUserQuestionQuestion[];
}

interface UseQuestionAnswerFormInput {
  interactionId: string;
  questions: readonly PendingInteractionUserQuestionQuestion[];
  threadId: string;
}

interface UseQuestionAnswerFormResult {
  disabled: boolean;
  formState: QuestionFormState;
  mutationErrorMessage: string | null;
  submitAnswer: () => void;
  updateFreeTextAnswer: (input: UpdateQuestionFreeTextInput) => void;
  updateSelectedAnswer: (input: ToggleQuestionOptionInput) => void;
}

type QuestionAnswerFormSubmitEvent = FormEvent<HTMLFormElement>;
type QuestionFreeTextKeyDownEvent = KeyboardEvent<HTMLTextAreaElement>;

const EMPTY_SELECTED_VALUES: readonly string[] = [];

function createInitialFormState(): QuestionFormState {
  return {
    freeTextByQuestionId: {},
    selectedValuesByQuestionId: {},
  };
}

function selectedValuesForQuestion({
  formState,
  question,
}: SelectedValuesInput): readonly string[] {
  return (
    formState.selectedValuesByQuestionId[question.id] ?? EMPTY_SELECTED_VALUES
  );
}

function freeTextForQuestion({ formState, question }: FreeTextInput): string {
  return formState.freeTextByQuestionId[question.id] ?? "";
}

function validSelectedValues({
  question,
  selectedValues,
}: ValidSelectedValuesInput): string[] {
  const optionValues = new Set(
    (question.options ?? []).map((option) => option.value),
  );
  return selectedValues.filter((value) => optionValues.has(value));
}

function toggleSelectedValues({
  optionValue,
  question,
  selectedValues,
}: ToggleSelectedValuesInput): string[] {
  if (!question.multiSelect) {
    return [optionValue];
  }
  if (selectedValues.includes(optionValue)) {
    return selectedValues.filter((value) => value !== optionValue);
  }
  return [...selectedValues, optionValue];
}

function updateSelectedValues(
  currentState: QuestionFormState,
  input: ToggleQuestionOptionInput,
): QuestionFormState {
  const selectedValues = selectedValuesForQuestion({
    formState: currentState,
    question: input.question,
  });
  return {
    ...currentState,
    selectedValuesByQuestionId: {
      ...currentState.selectedValuesByQuestionId,
      [input.question.id]: toggleSelectedValues({
        optionValue: input.optionValue,
        question: input.question,
        selectedValues,
      }),
    },
  };
}

function updateFreeText(
  currentState: QuestionFormState,
  input: UpdateQuestionFreeTextInput,
): QuestionFormState {
  return {
    ...currentState,
    freeTextByQuestionId: {
      ...currentState.freeTextByQuestionId,
      [input.questionId]: input.value,
    },
  };
}

function isQuestionAnswered({
  formState,
  question,
}: QuestionAnsweredInput): boolean {
  const selectedValues = validSelectedValues({
    question,
    selectedValues: selectedValuesForQuestion({ formState, question }),
  });
  if (selectedValues.length > 0) {
    return true;
  }
  return (
    question.allowFreeText &&
    freeTextForQuestion({ formState, question }).trim().length > 0
  );
}

function buildUserAnswerResolution({
  formState,
  questions,
}: BuildResolutionInput): UserQuestionPendingInteractionResolution {
  const answers: Record<string, PendingInteractionUserAnswer> = {};
  for (const question of questions) {
    const selected = validSelectedValues({
      question,
      selectedValues: selectedValuesForQuestion({ formState, question }),
    });
    const freeText = freeTextForQuestion({ formState, question }).trim();
    answers[question.id] =
      question.allowFreeText && freeText.length > 0
        ? { selected, freeText }
        : { selected };
  }
  return {
    kind: "user_answer",
    answers,
  };
}

function QuestionPrompt({ question }: QuestionPromptProps) {
  return (
    <div className="min-w-0">
      {question.shortLabel ? (
        <div className="text-xs font-medium uppercase text-muted-foreground">
          {question.shortLabel}
        </div>
      ) : null}
      <div className="text-sm font-semibold text-foreground">
        {question.prompt}
      </div>
    </div>
  );
}

function QuestionOptionInput({
  checked,
  disabled,
  inputName,
  onOptionToggle,
  option,
  question,
}: QuestionOptionInputProps) {
  const inputType = question.multiSelect ? "checkbox" : "radio";
  return (
    <label
      className={cn(
        "flex min-w-0 cursor-pointer items-start gap-2 rounded-md border px-3 py-2 transition-colors",
        checked
          ? "border-primary/40 bg-primary/10 text-foreground"
          : "border-border bg-background/70 text-muted-foreground hover:bg-state-hover hover:text-foreground",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      <input
        type={inputType}
        name={inputName}
        value={option.value}
        checked={checked}
        disabled={disabled}
        onChange={() =>
          onOptionToggle({
            question,
            optionValue: option.value,
          })
        }
        className="mt-0.5 size-4 shrink-0 accent-primary"
      />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{option.label}</span>
        {option.description ? (
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {option.description}
          </span>
        ) : null}
      </span>
    </label>
  );
}

function QuestionInputBlock({
  disabled,
  formState,
  interactionId,
  onFreeTextChange,
  onOptionToggle,
  onSubmit,
  question,
}: QuestionInputBlockProps) {
  const selectedValues = selectedValuesForQuestion({ formState, question });
  const freeText = freeTextForQuestion({ formState, question });
  const inputName = `${interactionId}-${question.id}`;
  const options = question.options ?? [];
  const freeTextLabel = `${question.shortLabel ?? question.prompt} answer`;
  const handleFreeTextKeyDown = (event: QuestionFreeTextKeyDownEvent): void => {
    if (
      event.nativeEvent.isComposing ||
      event.key !== "Enter" ||
      (!event.metaKey && !event.ctrlKey)
    ) {
      return;
    }
    event.preventDefault();
    onSubmit();
  };

  return (
    <fieldset className="space-y-2 rounded-md border border-border bg-card px-4 py-3">
      <legend className="sr-only">{question.prompt}</legend>
      <QuestionPrompt question={question} />

      {options.length > 0 ? (
        <div className="grid gap-2">
          {options.map((option) => (
            <QuestionOptionInput
              key={option.value}
              checked={selectedValues.includes(option.value)}
              disabled={disabled}
              inputName={inputName}
              onOptionToggle={onOptionToggle}
              option={option}
              question={question}
            />
          ))}
        </div>
      ) : null}

      {question.allowFreeText ? (
        <textarea
          aria-label={freeTextLabel}
          value={freeText}
          disabled={disabled}
          rows={3}
          onChange={(event) =>
            onFreeTextChange({
              questionId: question.id,
              value: event.target.value,
            })
          }
          onKeyDown={handleFreeTextKeyDown}
          className="min-h-20 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          placeholder="Add an answer"
        />
      ) : null}
    </fieldset>
  );
}

function useQuestionAnswerForm({
  interactionId,
  questions,
  threadId,
}: UseQuestionAnswerFormInput): UseQuestionAnswerFormResult {
  const [formState, setFormState] = useState<QuestionFormState>(
    createInitialFormState,
  );
  const resolvePendingInteraction = useResolveThreadPendingInteraction();

  useEffect(() => {
    setFormState(createInitialFormState());
  }, [interactionId]);

  const canSubmit = useMemo(
    () =>
      questions.length > 0 &&
      questions.every((question) =>
        isQuestionAnswered({ formState, question }),
      ),
    [formState, questions],
  );
  const mutationErrorMessage = resolvePendingInteraction.error
    ? getMutationErrorMessage({
        error: resolvePendingInteraction.error,
        fallbackMessage: "Failed to submit answer.",
      })
    : null;
  const disabled = resolvePendingInteraction.isPending;
  const submitDisabled = disabled || !canSubmit;

  const updateSelectedAnswer = (input: ToggleQuestionOptionInput): void => {
    setFormState((currentState) => updateSelectedValues(currentState, input));
  };
  const updateFreeTextAnswer = (input: UpdateQuestionFreeTextInput): void => {
    setFormState((currentState) => updateFreeText(currentState, input));
  };
  const submitAnswer = (): void => {
    if (submitDisabled) {
      return;
    }
    const resolution = buildUserAnswerResolution({
      formState,
      questions,
    });
    void resolvePendingInteraction
      .mutateAsync({
        threadId,
        interactionId,
        resolution,
      })
      .catch(() => {});
  };

  return {
    disabled,
    formState,
    mutationErrorMessage,
    submitAnswer,
    updateFreeTextAnswer,
    updateSelectedAnswer,
  };
}

export function UserQuestionAnswerForm({
  className,
  interactionId,
  isResolving = false,
  questions,
  threadId,
}: UserQuestionAnswerFormProps) {
  const {
    disabled: mutationDisabled,
    formState,
    mutationErrorMessage,
    submitAnswer,
    updateFreeTextAnswer,
    updateSelectedAnswer,
  } = useQuestionAnswerForm({ interactionId, questions, threadId });
  const disabled = mutationDisabled || isResolving;
  const [currentIndex, setCurrentIndex] = useState(0);

  useEffect(() => {
    setCurrentIndex(0);
  }, [interactionId]);

  const totalQuestions = questions.length;
  const currentQuestion = questions[currentIndex] ?? null;
  const isLastQuestion = currentIndex === totalQuestions - 1;
  const isCurrentAnswered = currentQuestion
    ? isQuestionAnswered({ formState, question: currentQuestion })
    : false;

  const handleBack = (): void => {
    setCurrentIndex((index) => Math.max(index - 1, 0));
  };
  const handleAdvance = (): void => {
    if (isLastQuestion) {
      submitAnswer();
      return;
    }
    setCurrentIndex((index) => Math.min(index + 1, totalQuestions - 1));
  };
  const handleSubmit = (event: QuestionAnswerFormSubmitEvent): void => {
    event.preventDefault();
    handleAdvance();
  };

  if (!currentQuestion) {
    return null;
  }

  return (
    <form className={cn("space-y-3", className)} onSubmit={handleSubmit}>
      {totalQuestions > 1 ? (
        <QuestionStepperIndicator
          currentIndex={currentIndex}
          totalQuestions={totalQuestions}
        />
      ) : null}
      <QuestionInputBlock
        disabled={disabled}
        formState={formState}
        interactionId={interactionId}
        onFreeTextChange={updateFreeTextAnswer}
        onOptionToggle={updateSelectedAnswer}
        onSubmit={handleAdvance}
        question={currentQuestion}
      />
      <div className="flex items-center justify-end gap-2">
        {currentIndex > 0 ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={handleBack}
          >
            Back
          </Button>
        ) : null}
        <Button
          type="submit"
          size="sm"
          disabled={disabled || !isCurrentAnswered}
        >
          {isResolving ? (
            <Icon name="Spinner" className="size-3 animate-spin" />
          ) : null}
          {isLastQuestion ? "Submit answer" : "Next"}
        </Button>
      </div>
      {mutationErrorMessage ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/[0.06] px-3 py-2 text-xs text-destructive">
          {mutationErrorMessage}
        </div>
      ) : null}
    </form>
  );
}

interface QuestionStepperIndicatorProps {
  currentIndex: number;
  totalQuestions: number;
}

function QuestionStepperIndicator({
  currentIndex,
  totalQuestions,
}: QuestionStepperIndicatorProps) {
  return (
    <div className="flex items-center justify-between text-xs text-muted-foreground">
      <span>
        Question {currentIndex + 1} of {totalQuestions}
      </span>
      <div className="flex items-center gap-1.5" aria-hidden>
        {Array.from({ length: totalQuestions }).map((_, index) => (
          <span
            key={index}
            className={cn(
              "size-1.5 rounded-full transition-colors",
              index === currentIndex
                ? "bg-foreground"
                : index < currentIndex
                  ? "bg-foreground/60"
                  : "bg-foreground/25",
            )}
          />
        ))}
      </div>
    </div>
  );
}
