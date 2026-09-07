import {
  MAX_OPTION_PREVIEW_LENGTH,
  type InteractionAnswer,
  type InteractionPayload,
  type InteractionQuestion,
  type InteractionResponse,
  type ToolInput,
  type ToolResult,
  type ToolResultAnnotation,
} from "./contracts.js";
import {
  NOT_UNIQUE_MESSAGE,
  TOO_FEW_OPTIONS_MESSAGE,
} from "./tool-definition.js";

export function validateToolInput(input: ToolInput): string | null {
  if (input.questions.some((question) => question.options.length < 2)) {
    return TOO_FEW_OPTIONS_MESSAGE;
  }
  const prompts = input.questions.map((question) => question.question);
  if (new Set(prompts).size !== prompts.length) return NOT_UNIQUE_MESSAGE;
  for (const question of input.questions) {
    const labels = question.options.map((option) => option.label);
    if (new Set(labels).size !== labels.length) return NOT_UNIQUE_MESSAGE;
  }
  return null;
}

export const MAX_INTERACTION_PAYLOAD_BYTES = 60 * 1024;

export class PreviewTooLargeError extends Error {
  constructor(byteLength: number) {
    super(
      `The questions are too large to display (${byteLength} bytes of option previews, limit ${MAX_INTERACTION_PAYLOAD_BYTES}). Shorten or drop the option previews and call the tool again.`,
    );
    this.name = "PreviewTooLargeError";
  }
}

function questionId(index: number): string {
  return `q${index}`;
}

function optionValue(index: number, optionIndex: number): string {
  return `${questionId(index)}o${optionIndex}`;
}

function normalizePreview(preview: string | undefined): string | undefined {
  if (preview === undefined) return undefined;
  const trimmed = preview.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, MAX_OPTION_PREVIEW_LENGTH);
}

export function buildInteractionPayload(input: ToolInput): InteractionPayload {
  return {
    questions: input.questions.map((question, index) => ({
      id: questionId(index),
      prompt: question.question,
      shortLabel: question.header,
      multiSelect: question.multiSelect,
      options: question.options.map((option, optionIndex) => {
        const preview = question.multiSelect
          ? undefined
          : normalizePreview(option.preview);
        return {
          value: optionValue(index, optionIndex),
          label: option.label,
          description: option.description,
          ...(preview === undefined ? {} : { preview }),
        };
      }),
      allowFreeText: true,
    })),
  };
}

export function assertInteractionPayloadFits(
  payload: InteractionPayload,
): void {
  const byteLength = new TextEncoder().encode(JSON.stringify(payload)).length;
  if (byteLength > MAX_INTERACTION_PAYLOAD_BYTES) {
    throw new PreviewTooLargeError(byteLength);
  }
}

export function buildInteractionTitle(payload: InteractionPayload): string {
  const [first] = payload.questions;
  if (payload.questions.length === 1 && first) return first.shortLabel;
  return `${payload.questions.length} questions`;
}

function selectedOptions(
  question: InteractionQuestion,
  answer: InteractionAnswer,
) {
  return answer.selected.flatMap((value) => {
    const option = question.options.find(
      (candidate) => candidate.value === value,
    );
    return option === undefined ? [] : [option];
  });
}

function buildAnswerText(
  question: InteractionQuestion,
  answer: InteractionAnswer,
): string {
  const labels = selectedOptions(question, answer).map(
    (option) => option.label,
  );
  if (labels.length > 0) {
    const selectedText = labels.join(", ");
    return answer.freeText
      ? `${selectedText}; ${answer.freeText}`
      : selectedText;
  }
  if (answer.freeText) return answer.freeText;
  return "";
}

function buildAnnotation(
  question: InteractionQuestion,
  answer: InteractionAnswer,
): ToolResultAnnotation | null {
  const notes =
    answer.selected.length > 0 && answer.freeText !== undefined
      ? answer.freeText
      : undefined;
  const previews = selectedOptions(question, answer).flatMap((option) =>
    option.preview === undefined ? [] : [option.preview],
  );
  const preview = previews.length > 0 ? previews.join("\n\n") : undefined;
  if (notes === undefined && preview === undefined) return null;
  return {
    ...(preview === undefined ? {} : { preview }),
    ...(notes === undefined ? {} : { notes }),
  };
}

export function buildToolResult(
  payload: InteractionPayload,
  response: InteractionResponse,
): ToolResult {
  const answers: Record<string, string> = {};
  const annotations: Record<string, ToolResultAnnotation> = {};
  let freeformResponse: string | undefined;
  for (const question of payload.questions) {
    const answer = response.answers[question.id];
    if (answer === undefined) continue;
    const text = buildAnswerText(question, answer);
    if (text.length === 0) continue;
    answers[question.prompt] = text;
    if (
      payload.questions.length === 1 &&
      answer.selected.length === 0 &&
      answer.freeText !== undefined
    ) {
      freeformResponse = answer.freeText;
    }
    const annotation = buildAnnotation(question, answer);
    if (annotation !== null) annotations[question.prompt] = annotation;
  }
  return {
    questions: payload.questions.map((question) => ({
      question: question.prompt,
      header: question.shortLabel,
      options: question.options.map((option) => ({
        label: option.label,
        description: option.description ?? option.label,
        ...(option.preview === undefined ? {} : { preview: option.preview }),
      })),
      multiSelect: question.multiSelect,
    })),
    answers,
    ...(freeformResponse === undefined ? {} : { response: freeformResponse }),
    ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
  };
}
