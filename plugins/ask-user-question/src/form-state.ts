import type {
  InteractionAnswer,
  InteractionQuestion,
  InteractionResponse,
} from "./contracts.js";

export interface QuestionAnswerState {
  selected: string[];
  otherSelected: boolean;
  otherText: string;
}

export type QuestionFormState = Record<string, QuestionAnswerState>;

function questionHasOptions(question: InteractionQuestion): boolean {
  return question.options.length > 0;
}

export function createInitialFormState(
  questions: readonly InteractionQuestion[],
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
  question: InteractionQuestion,
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
  question: InteractionQuestion,
  selectedValues: readonly string[],
): string[] {
  const optionValues = new Set(question.options.map((option) => option.value));
  return selectedValues.filter((value) => optionValues.has(value));
}

export function isQuestionAnswered(
  question: InteractionQuestion,
  state: QuestionAnswerState,
): boolean {
  if (validSelectedValues(question, state.selected).length > 0) return true;
  return state.otherSelected && state.otherText.trim().length > 0;
}

function buildQuestionAnswer(
  question: InteractionQuestion,
  state: QuestionAnswerState,
): InteractionAnswer {
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

export function buildInteractionResponse(
  questions: readonly InteractionQuestion[],
  formState: QuestionFormState,
): InteractionResponse {
  const answers: Record<string, InteractionAnswer> = {};
  for (const question of questions) {
    answers[question.id] = buildQuestionAnswer(
      question,
      answerStateFor(formState, question),
    );
  }
  return { answers };
}

export type QuestionShortcutChoice =
  | { kind: "option"; value: string }
  | { kind: "other" }
  | null;

export function resolveQuestionShortcutChoice(
  question: InteractionQuestion,
  index: number,
): QuestionShortcutChoice {
  const option = question.options[index];
  if (option) return { kind: "option", value: option.value };
  if (
    index === question.options.length &&
    question.options.length > 0 &&
    question.allowFreeText
  ) {
    return { kind: "other" };
  }
  return null;
}
