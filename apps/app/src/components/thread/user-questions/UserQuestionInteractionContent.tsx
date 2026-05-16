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
import { formatPendingInteractionUserQuestionOptionLabel } from "@bb/core-ui";
import { Button } from "@/components/ui/button.js";
import { useResolveThreadPendingInteraction } from "@/hooks/mutations/thread-interaction-mutations";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import { cn } from "@/lib/utils";

interface UserQuestionAnswerFormProps {
  className?: string;
  interactionId: string;
  questions: readonly PendingInteractionUserQuestionQuestion[];
  threadId: string;
}

interface UserQuestionAnswerSummaryListProps {
  answers: Record<string, PendingInteractionUserAnswer> | null;
  questions: readonly PendingInteractionUserQuestionQuestion[];
}

interface UserQuestionPromptListProps {
  questions: readonly PendingInteractionUserQuestionQuestion[];
}

interface UserQuestionLifecycleNoticeProps {
  message: string;
  statusReason: string | null;
  tone: "default" | "danger";
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

interface QuestionAnswerSummaryProps {
  answer: PendingInteractionUserAnswer | null;
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

interface QuestionPromptBlockProps {
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
  submitDisabled: boolean;
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
    submitDisabled,
    updateFreeTextAnswer,
    updateSelectedAnswer,
  };
}

export function UserQuestionAnswerForm({
  className,
  interactionId,
  questions,
  threadId,
}: UserQuestionAnswerFormProps) {
  const {
    disabled,
    formState,
    mutationErrorMessage,
    submitAnswer,
    submitDisabled,
    updateFreeTextAnswer,
    updateSelectedAnswer,
  } = useQuestionAnswerForm({ interactionId, questions, threadId });
  const handleSubmit = (event: QuestionAnswerFormSubmitEvent): void => {
    event.preventDefault();
    submitAnswer();
  };

  return (
    <form className={cn("space-y-3", className)} onSubmit={handleSubmit}>
      <div className="space-y-3">
        {questions.map((question) => (
          <QuestionInputBlock
            key={question.id}
            disabled={disabled}
            formState={formState}
            interactionId={interactionId}
            onFreeTextChange={updateFreeTextAnswer}
            onOptionToggle={updateSelectedAnswer}
            onSubmit={submitAnswer}
            question={question}
          />
        ))}
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button type="submit" size="sm" disabled={submitDisabled}>
          Submit answer
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

function QuestionAnswerSummary({
  answer,
  question,
}: QuestionAnswerSummaryProps) {
  const selectedLabels =
    answer?.selected.map((value) =>
      formatPendingInteractionUserQuestionOptionLabel({ question, value }),
    ) ?? [];
  const freeText = answer?.freeText ?? null;
  const hasAnswer = selectedLabels.length > 0 || freeText !== null;

  return (
    <div className="space-y-2 rounded-md border border-border bg-card px-4 py-3">
      <QuestionPrompt question={question} />
      {hasAnswer ? (
        <div className="space-y-1 text-sm text-foreground">
          {selectedLabels.length > 0 ? (
            <div>{selectedLabels.join(", ")}</div>
          ) : null}
          {freeText ? (
            <div className="whitespace-pre-wrap">{freeText}</div>
          ) : null}
        </div>
      ) : (
        <div className="text-sm text-muted-foreground">
          No answer recorded.
        </div>
      )}
    </div>
  );
}

function QuestionPromptBlock({ question }: QuestionPromptBlockProps) {
  const options = question.options ?? [];
  return (
    <div className="space-y-2 rounded-md border border-border bg-card px-4 py-3">
      <QuestionPrompt question={question} />
      {options.length > 0 ? (
        <ul className="grid gap-1.5 text-sm text-muted-foreground">
          {options.map((option) => (
            <li key={option.value}>
              <span className="font-medium text-foreground">
                {option.label}
              </span>
              {option.description ? (
                <span className="text-muted-foreground">
                  {" "}
                  {option.description}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function UserQuestionAnswerSummaryList({
  answers,
  questions,
}: UserQuestionAnswerSummaryListProps) {
  return (
    <div className="space-y-3">
      {questions.map((question) => (
        <QuestionAnswerSummary
          key={question.id}
          question={question}
          answer={answers?.[question.id] ?? null}
        />
      ))}
    </div>
  );
}

export function UserQuestionPromptList({
  questions,
}: UserQuestionPromptListProps) {
  return (
    <div className="space-y-3">
      {questions.map((question) => (
        <QuestionPromptBlock key={question.id} question={question} />
      ))}
    </div>
  );
}

export function UserQuestionLifecycleNotice({
  message,
  statusReason,
  tone,
}: UserQuestionLifecycleNoticeProps) {
  return (
    <div
      className={cn(
        "rounded-md border px-3 py-2 text-sm",
        tone === "danger"
          ? "border-destructive/30 bg-destructive/[0.06] text-destructive"
          : "border-border bg-card text-muted-foreground",
      )}
    >
      <div>{message}</div>
      {statusReason ? (
        <div className="mt-1 text-xs">{statusReason}</div>
      ) : null}
    </div>
  );
}
