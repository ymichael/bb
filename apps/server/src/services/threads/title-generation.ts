import { renderTemplate } from "@bb/templates";
import {
  getEnvironment,
  getThread,
  updateThread,
} from "@bb/db";
import type { PromptInput } from "@bb/domain";
import type { AppDeps } from "../../types.js";
import { Type } from "@mariozechner/pi-ai";
import {
  InferenceTimeoutError,
  inferenceComplete,
} from "../ai/inference.js";
import { queueThreadRenameCommand } from "./thread-commands.js";

const MIN_TITLE_GENERATION_WORDS = 5;
const MAX_BRANCH_SLUG_LENGTH = 48;

type ThreadMetadataGenerationDeps = Pick<AppDeps, "config" | "logger">;
type ThreadTitleApplyDeps = Pick<AppDeps, "db" | "hub">;
type ThreadTitleGenerationDeps = Pick<AppDeps, "config" | "db" | "hub" | "logger">;

export interface ApplyGeneratedThreadTitleArgs {
  threadId: string;
  title: string;
}

export interface ThreadMetadataGenerationArgs {
  input: PromptInput[];
  threadId: string;
  timeoutMs?: number;
}

export interface ThreadTitleGenerationArgs {
  input: PromptInput[];
  threadId: string;
}

export interface GeneratedThreadMetadata {
  branchSlug?: string;
  title?: string;
}

export type ThreadMetadataGenerationOutcomeReason =
  | "empty-input"
  | "failed"
  | "inference-unavailable"
  | "too-short"
  | "timeout";

export interface ThreadMetadataGenerationOutcome {
  durationMs: number;
  metadata: GeneratedThreadMetadata | null;
  reason?: ThreadMetadataGenerationOutcomeReason;
}

interface RawGeneratedThreadMetadata {
  branchSlug?: string;
  title?: string;
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

export function shouldGenerateThreadTitle(input: PromptInput[]): boolean {
  const text = cleanPromptText(input);
  if (text.length === 0) {
    return false;
  }

  return text.split(/\s+/u).length >= MIN_TITLE_GENERATION_WORDS;
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
  branchSlug: Type.Optional(Type.String()),
  title: Type.Optional(Type.String()),
});

function normalizeGeneratedThreadMetadata(
  parsed: RawGeneratedThreadMetadata | null,
): GeneratedThreadMetadata | null {
  if (!parsed) {
    return null;
  }

  const title = parsed.title?.trim();
  const branchSlug = parsed.branchSlug
    ? sanitizeGeneratedBranchSlug(parsed.branchSlug)
    : null;
  if (!title && !branchSlug) {
    return null;
  }

  return {
    ...(branchSlug ? { branchSlug } : {}),
    ...(title ? { title } : {}),
  };
}

export async function generateThreadMetadataWithOutcome(
  deps: ThreadMetadataGenerationDeps,
  args: ThreadMetadataGenerationArgs,
): Promise<ThreadMetadataGenerationOutcome> {
  const startedAt = Date.now();
  const fallback = deriveTitleFallback(args.input);
  const complete = (
    metadata: GeneratedThreadMetadata | null,
    reason?: ThreadMetadataGenerationOutcomeReason,
  ): ThreadMetadataGenerationOutcome => ({
    durationMs: Date.now() - startedAt,
    metadata,
    ...(reason ? { reason } : {}),
  });

  if (!fallback) {
    return complete(null, "empty-input");
  }
  if (!shouldGenerateThreadTitle(args.input)) {
    return complete(null, "too-short");
  }

  try {
    const prompt = renderTemplate("generateThreadMetadata", {
      cleanedPrompt: fallback,
    });

    const parsed = await inferenceComplete(deps, {
      prompt,
      schema: threadMetadataSchema,
      ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}),
    });

    const metadata = normalizeGeneratedThreadMetadata(parsed);
    return complete(metadata, metadata ? undefined : "inference-unavailable");
  } catch (error) {
    if (error instanceof InferenceTimeoutError) {
      deps.logger.info(
        { threadId: args.threadId, timeoutMs: error.timeoutMs },
        "Thread metadata inference timed out",
      );
      return complete(null, "timeout");
    }

    deps.logger.warn(
      { err: error, threadId: args.threadId },
      "Failed to generate thread metadata",
    );
    return complete(null, "failed");
  }
}

export async function generateThreadMetadata(
  deps: ThreadMetadataGenerationDeps,
  args: ThreadMetadataGenerationArgs,
): Promise<GeneratedThreadMetadata | null> {
  const outcome = await generateThreadMetadataWithOutcome(deps, args);
  return outcome.metadata;
}

export function applyGeneratedThreadTitle(
  deps: ThreadTitleApplyDeps,
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

export async function generateThreadTitle(
  deps: ThreadTitleGenerationDeps,
  args: ThreadTitleGenerationArgs,
): Promise<void> {
  const thread = getThread(deps.db, args.threadId);
  if (!thread || thread.title) {
    return;
  }

  const metadata = await generateThreadMetadata(deps, args);
  if (!metadata?.title) {
    return;
  }

  try {
    if (!applyGeneratedThreadTitle(deps, {
      threadId: args.threadId,
      title: metadata.title,
    })) {
      return;
    }

    const titledThread = getThread(deps.db, args.threadId);
    const environment =
      titledThread?.environmentId ? getEnvironment(deps.db, titledThread.environmentId) : null;
    if (
      !titledThread ||
      !environment ||
      titledThread.status === "created" ||
      titledThread.status === "provisioning"
    ) {
      return;
    }

    queueThreadRenameCommand(deps, {
      environment: {
        id: environment.id,
        hostId: environment.hostId,
      },
      threadId: titledThread.id,
      title: metadata.title,
    });
  } catch (error) {
    deps.logger.warn(
      { err: error, threadId: args.threadId },
      "Failed to generate thread title",
    );
  }
}
