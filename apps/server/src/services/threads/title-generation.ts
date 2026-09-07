import { renderTemplate } from "@bb/templates";
import { getThread, updateThread } from "@bb/db";
import type { PromptInput } from "@bb/domain";
import type { AppDeps, LoggedWorkSessionDeps } from "../../types.js";
import { Type } from "@earendil-works/pi-ai";
import {
  INFERENCE_POLICY,
  InferenceTimeoutError,
  inferenceCompleteWithFallback,
} from "../ai/inference.js";

const MAX_GENERATED_TITLE_LENGTH = 36;
const MAX_BRANCH_SLUG_LENGTH = 48;
const MAX_TITLE_INFERENCE_USER_PROMPT_LENGTH = 4_000;

interface ApplyGeneratedThreadTitleArgs {
  threadId: string;
  title: string;
}

interface ThreadMetadataGenerationArgs {
  input: PromptInput[];
  threadId: string;
  timeoutMaxAttempts?: number;
  timeoutMs?: number;
}

interface GeneratedThreadMetadata {
  branchSlug?: string;
  title?: string;
}

type ThreadMetadataGenerationOutcomeReason =
  | "empty-input"
  | "failed"
  | "inference-unavailable"
  | "timeout";

export interface ThreadMetadataGenerationOutcome {
  durationMs: number;
  metadata: GeneratedThreadMetadata | null;
  reason?: ThreadMetadataGenerationOutcomeReason;
}

interface RawGeneratedThreadMetadata {
  title: string;
}

function cleanPromptText(input: PromptInput[]): string {
  return input
    .filter((part) => part.type === "text")
    .map((part) => part.text.trim())
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function deriveTitleFallback(input: PromptInput[]): string | null {
  const text = cleanPromptText(input);
  if (text.length === 0) {
    return null;
  }
  return text.length <= 80 ? text : `${text.slice(0, 77)}...`;
}

export function sanitizeGeneratedTitle(value: string): string | null {
  const title = value.trim().replace(/\s+/gu, " ");
  if (title.length === 0) {
    return null;
  }
  if (title.length <= MAX_GENERATED_TITLE_LENGTH) {
    return title;
  }

  const candidate = title.slice(0, MAX_GENERATED_TITLE_LENGTH + 1);
  const lastSpace = candidate.lastIndexOf(" ");
  return lastSpace > 0
    ? candidate.slice(0, lastSpace)
    : candidate.slice(0, MAX_GENERATED_TITLE_LENGTH);
}

export function sanitizeGeneratedBranchSlug(value: string): string | null {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, MAX_BRANCH_SLUG_LENGTH)
    .replace(/-+$/u, "");

  return slug.length > 0 ? slug : null;
}

const threadMetadataSchema = Type.Object({
  title: Type.String({
    minLength: 1,
  }),
});

function normalizeGeneratedThreadMetadata(
  parsed: RawGeneratedThreadMetadata | null,
): GeneratedThreadMetadata | null {
  if (!parsed) {
    return null;
  }

  const title = parsed.title ? sanitizeGeneratedTitle(parsed.title) : null;
  const branchSlug = title ? sanitizeGeneratedBranchSlug(title) : null;
  if (!title && !branchSlug) {
    return null;
  }

  return {
    ...(branchSlug ? { branchSlug } : {}),
    ...(title ? { title } : {}),
  };
}

export async function generateThreadMetadataWithOutcome(
  deps: LoggedWorkSessionDeps,
  args: ThreadMetadataGenerationArgs,
): Promise<ThreadMetadataGenerationOutcome> {
  const startedAt = Date.now();
  const userPrompt = cleanPromptText(args.input).slice(
    0,
    MAX_TITLE_INFERENCE_USER_PROMPT_LENGTH,
  );
  const complete = (
    metadata: GeneratedThreadMetadata | null,
    reason?: ThreadMetadataGenerationOutcomeReason,
  ): ThreadMetadataGenerationOutcome => ({
    durationMs: Date.now() - startedAt,
    metadata,
    ...(reason ? { reason } : {}),
  });

  if (!userPrompt) {
    return complete(null, "empty-input");
  }

  const prompt = renderTemplate("generateThreadTitle", {
    userPrompt,
  });
  const maxAttempts = Math.max(1, args.timeoutMaxAttempts ?? 1);

  try {
    const inference = await inferenceCompleteWithFallback(deps, {
      label: "Thread metadata inference",
      logContext: { threadId: args.threadId },
      maxAttempts,
      prompt,
      retryDelayMs: INFERENCE_POLICY.threadMetadata.retryDelayMs,
      schema: threadMetadataSchema,
      timeoutMs: args.timeoutMs ?? INFERENCE_POLICY.threadMetadata.timeoutMs,
    });
    const metadata = normalizeGeneratedThreadMetadata(inference);
    return complete(metadata, metadata ? undefined : "inference-unavailable");
  } catch (error) {
    return complete(
      null,
      error instanceof InferenceTimeoutError ? "timeout" : "failed",
    );
  }
}

export function applyGeneratedThreadTitle(
  deps: Pick<AppDeps, "db" | "hub">,
  args: ApplyGeneratedThreadTitleArgs,
): boolean {
  const title = args.title.trim();
  if (title.length === 0) {
    return false;
  }

  const currentThread = getThread(deps.db, args.threadId);
  if (!currentThread || currentThread.title) {
    return false;
  }

  updateThread(deps.db, deps.hub, args.threadId, {
    title,
  });

  return true;
}
