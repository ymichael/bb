import type { PromptInput } from "@bb/core";
import { generateCodexCommitMessage } from "./codex-commit-message-generator.js";
import { generateCodexThreadTitle } from "./codex-title-generator.js";

const MAX_COMMIT_MESSAGE_CHARS = 120;

export interface LlmThreadTitleGenerationArgs {
  input: PromptInput[];
  cwd: string;
}

export interface LlmCommitMessageGenerationArgs {
  cwd: string;
  includeUnstaged?: boolean;
}

export type LlmThreadTitleGenerator = (
  args: LlmThreadTitleGenerationArgs,
) => Promise<string | undefined>;

export type LlmCommitMessageGenerator = (
  args: LlmCommitMessageGenerationArgs,
) => Promise<string | undefined>;

export interface LlmCompletionService {
  displayName: string;
  generateThreadTitle(args: LlmThreadTitleGenerationArgs): Promise<string | undefined>;
  generateCommitMessage(
    args: LlmCommitMessageGenerationArgs,
  ): Promise<string | undefined>;
}

export interface CreateLlmCompletionServiceOptions {
  displayName?: string;
  threadTitleGenerator: LlmThreadTitleGenerator;
  commitMessageGenerator: LlmCommitMessageGenerator;
}

function normalizeGeneratedTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeGeneratedCommitMessage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  if (normalized.length <= MAX_COMMIT_MESSAGE_CHARS) return normalized;
  return normalized.slice(0, MAX_COMMIT_MESSAGE_CHARS).trimEnd();
}

export function createLlmCompletionService(
  opts: CreateLlmCompletionServiceOptions,
): LlmCompletionService {
  return {
    displayName: opts.displayName ?? "LLM completion",
    async generateThreadTitle(
      args: LlmThreadTitleGenerationArgs,
    ): Promise<string | undefined> {
      const generated = await opts.threadTitleGenerator(args);
      return normalizeGeneratedTitle(generated);
    },
    async generateCommitMessage(
      args: LlmCommitMessageGenerationArgs,
    ): Promise<string | undefined> {
      const generated = await opts.commitMessageGenerator(args);
      return normalizeGeneratedCommitMessage(generated);
    },
  };
}

export function createCodexLlmCompletionService(): LlmCompletionService {
  return createLlmCompletionService({
    displayName: "Codex responses",
    threadTitleGenerator: generateCodexThreadTitle,
    commitMessageGenerator: generateCodexCommitMessage,
  });
}
