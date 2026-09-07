import { z } from "zod";
import {
  MAX_OPTION_PREVIEW_LENGTH,
  MAX_OPTIONS,
  MAX_QUESTIONS,
} from "@bb/plugin-interaction-contracts";

export {
  ASK_USER_QUESTION_RENDERER_ID,
  MAX_OPTION_PREVIEW_LENGTH,
  interactionPayloadSchema,
  interactionResponseSchema,
  type InteractionAnswer,
  type InteractionOption,
  type InteractionPayload,
  type InteractionQuestion,
  type InteractionResponse,
} from "@bb/plugin-interaction-contracts";

const nonBlank = (value: string) => value.trim().length > 0;

const toolOptionSchema = z.object({
  label: z.string().min(1).refine(nonBlank, "Option labels cannot be blank"),
  description: z
    .string()
    .min(1)
    .refine(nonBlank, "Option descriptions cannot be blank"),
  preview: z.string().max(MAX_OPTION_PREVIEW_LENGTH).optional(),
});

const toolQuestionSchema = z.object({
  question: z.string().min(1).refine(nonBlank, "Questions cannot be blank"),
  header: z.string().min(1).refine(nonBlank, "Headers cannot be blank"),
  options: z.array(toolOptionSchema).min(1).max(MAX_OPTIONS),
  multiSelect: z.boolean().default(false),
});

export const toolInputSchema = z.object({
  questions: z.array(toolQuestionSchema).min(1).max(MAX_QUESTIONS),
});
export type ToolInput = z.infer<typeof toolInputSchema>;

interface ToolResultQuestion {
  question: string;
  header: string;
  options: Array<{ label: string; description: string; preview?: string }>;
  multiSelect: boolean;
}

export interface ToolResultAnnotation {
  preview?: string;
  notes?: string;
}

export interface ToolResult {
  questions: ToolResultQuestion[];
  answers: Record<string, string>;
  response?: string;
  annotations?: Record<string, ToolResultAnnotation>;
}
