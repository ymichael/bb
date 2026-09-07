import type {
  PendingInteractionUserAnswer,
  PendingInteractionUserQuestionQuestion,
  UserQuestionPendingInteractionResolution,
} from "@bb/domain";

export interface QuestionAnswerState {
  selected: string[];
  otherSelected: boolean;
  otherText: string;
}

export type QuestionFormState = Record<string, QuestionAnswerState>;

function questionHasOptions(
  question: PendingInteractionUserQuestionQuestion,
): boolean {
  return (question.options?.length ?? 0) > 0;
}

export function createInitialFormState(
  questions: readonly PendingInteractionUserQuestionQuestion[],
): QuestionFormState {
  const state: QuestionFormState = {};
  for (const question of questions) {
    state[question.id] = {
      selected: [],
      otherSelected: !questionHasOptions(question),
      otherText: "",
    };
  }
  return state;
}

export function answerStateFor(
  formState: QuestionFormState,
  question: PendingInteractionUserQuestionQuestion,
): QuestionAnswerState {
  return (
    formState[question.id] ?? {
      selected: [],
      otherSelected: !questionHasOptions(question),
      otherText: "",
    }
  );
}

function validSelectedValues(
  question: PendingInteractionUserQuestionQuestion,
  selectedValues: readonly string[],
): string[] {
  const optionValues = new Set(
    (question.options ?? []).map((option) => option.value),
  );
  return selectedValues.filter((value) => optionValues.has(value));
}

export function isQuestionAnswered(
  question: PendingInteractionUserQuestionQuestion,
  state: QuestionAnswerState,
): boolean {
  if (validSelectedValues(question, state.selected).length > 0) {
    return true;
  }
  return state.otherSelected && state.otherText.trim().length > 0;
}

function buildQuestionAnswer(
  question: PendingInteractionUserQuestionQuestion,
  state: QuestionAnswerState,
): PendingInteractionUserAnswer {
  const freeText = state.otherText.trim();
  const includeFreeText = state.otherSelected && freeText.length > 0;
  if (question.multiSelect) {
    const selected = validSelectedValues(question, state.selected);
    return includeFreeText ? { selected, freeText } : { selected };
  }
  if (state.otherSelected) {
    return includeFreeText ? { selected: [], freeText } : { selected: [] };
  }
  return { selected: validSelectedValues(question, state.selected) };
}

export function buildUserAnswerResolution(
  questions: readonly PendingInteractionUserQuestionQuestion[],
  formState: QuestionFormState,
): UserQuestionPendingInteractionResolution {
  const answers: Record<string, PendingInteractionUserAnswer> = {};
  for (const question of questions) {
    answers[question.id] = buildQuestionAnswer(
      question,
      answerStateFor(formState, question),
    );
  }
  return { kind: "user_answer", answers };
}
