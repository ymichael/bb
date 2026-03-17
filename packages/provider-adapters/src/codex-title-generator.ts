import type { PromptInput } from "@bb/core";
import { renderTemplate } from "@bb/templates";
import type { LlmThreadTitleGenerationArgs } from "./llm-completion.js";
import { generateOpenAIResponsesText } from "./openai-responses-model.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_PROMPT_CHARS = 1200;
const MAX_THREAD_NAME_LENGTH = 38;
const TITLE_MAX_OUTPUT_TOKENS = 120;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function extractPromptText(input: PromptInput[]): string {
  const textParts: string[] = [];
  for (const chunk of input) {
    if (chunk.type !== "text") continue;
    const trimmed = chunk.text.trim();
    if (!trimmed) continue;
    textParts.push(trimmed);
  }
  return textParts.join("\n\n");
}

function cleanPromptText(value: string): string {
  if (!value) return "";

  const withoutImages = value.replace(/\[image(?: x\d+)?\]/gi, " ");
  const withoutSkills = withoutImages.replace(
    /(^|\s)\$[A-Za-z0-9_-]+(?=\s|$)/g,
    " ",
  );
  const normalized = withoutSkills.replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_PROMPT_CHARS) return normalized;
  return normalized.slice(0, MAX_PROMPT_CHARS);
}

function buildRunMetadataPrompt(cleanedPrompt: string): string {
  return renderTemplate("codexRunMetadata", { cleanedPrompt });
}

function extractJsonValue(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;

  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function clampThreadTitle(title: string): string | undefined {
  const normalized = title.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  if (normalized.length <= MAX_THREAD_NAME_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_THREAD_NAME_LENGTH)}…`;
}

function parseRunMetadataTitle(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  const payload = extractJsonValue(trimmed);
  if (!payload) return undefined;

  const title = typeof payload.title === "string" ? payload.title : "";
  return clampThreadTitle(title);
}

function shouldSuppressTitleGenerationError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const normalizedMessage = error.message.toLowerCase();
  return (
    normalizedMessage.includes("openai api key is missing") ||
    normalizedMessage.includes("openai auth is missing") ||
    normalizedMessage.includes("timed out")
  );
}

export async function generateCodexThreadTitle(
  args: LlmThreadTitleGenerationArgs,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<string | undefined> {
  const rawPrompt = extractPromptText(args.input);
  const cleanedPrompt = cleanPromptText(rawPrompt);
  if (!cleanedPrompt) return undefined;

  const metadataPrompt = buildRunMetadataPrompt(cleanedPrompt);
  try {
    const result = await generateOpenAIResponsesText({
      prompt: metadataPrompt,
      timeoutMs,
      maxOutputTokens: TITLE_MAX_OUTPUT_TOKENS,
      temperature: 0,
    });
    return parseRunMetadataTitle(result.text);
  } catch (error) {
    if (shouldSuppressTitleGenerationError(error)) {
      return undefined;
    }
    throw error;
  }
}
