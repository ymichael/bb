import { renderTemplate } from "@bb/templates";
import type { AppDeps } from "../../types.js";
import { Type } from "@mariozechner/pi-ai";
import { InferenceTimeoutError, inferenceComplete } from "./inference.js";

const commitMessageSchema = Type.Object({
  message: Type.String({ minLength: 1 }),
});

type CommitMessageGenerationDeps = Pick<AppDeps, "config" | "logger">;
type CommitMessageGenerationReason = "failed" | "no-result" | "timeout";

interface GenerateCommitMessageArgs {
  diffDescription: string;
  shortstat: string;
  files: string;
  patch: string;
}

interface CommitMessageGenerationOutcome {
  attempts: number;
  durationMs: number;
  message: string | null;
  reason?: CommitMessageGenerationReason;
}

const COMMIT_MESSAGE_TIMEOUT_MS = 5_000;
// Two 5s attempts preserve the previous 10s worst-case fallback budget while
// recovering transient provider stalls.
const COMMIT_MESSAGE_TIMEOUT_MAX_ATTEMPTS = 2;

async function generateCommitMessageWithOutcome(
  deps: CommitMessageGenerationDeps,
  args: GenerateCommitMessageArgs,
): Promise<CommitMessageGenerationOutcome> {
  const startedAt = Date.now();
  const complete = (
    message: string | null,
    attempts: number,
    reason?: CommitMessageGenerationReason,
  ): CommitMessageGenerationOutcome => ({
    attempts,
    durationMs: Date.now() - startedAt,
    message,
    ...(reason ? { reason } : {}),
  });

  const prompt = renderTemplate("generateCommitMessage", {
    diffDescription: args.diffDescription,
    shortstat: args.shortstat,
    files: args.files,
    patch: args.patch,
  });

  for (
    let attempt = 1;
    attempt <= COMMIT_MESSAGE_TIMEOUT_MAX_ATTEMPTS;
    attempt += 1
  ) {
    try {
      const result = await inferenceComplete(deps, {
        prompt,
        schema: commitMessageSchema,
        timeoutMs: COMMIT_MESSAGE_TIMEOUT_MS,
      });

      if (!result) {
        const outcome = complete(null, attempt, "no-result");
        deps.logger.warn(
          {
            attempts: outcome.attempts,
            durationMs: outcome.durationMs,
            reason: outcome.reason,
          },
          "Commit message inference returned no result",
        );
        return outcome;
      }

      const outcome = complete(result.message, attempt);
      if (attempt > 1) {
        deps.logger.info(
          {
            attempts: outcome.attempts,
            durationMs: outcome.durationMs,
            maxAttempts: COMMIT_MESSAGE_TIMEOUT_MAX_ATTEMPTS,
            reason: "timeout",
            timeoutMs: COMMIT_MESSAGE_TIMEOUT_MS,
          },
          "Commit message inference completed after timeout retry",
        );
      }
      return outcome;
    } catch (error) {
      const err =
        error instanceof Error
          ? error
          : new Error("Non-Error thrown during commit message generation");
      if (err instanceof InferenceTimeoutError) {
        if (attempt < COMMIT_MESSAGE_TIMEOUT_MAX_ATTEMPTS) {
          deps.logger.info(
            {
              attempt,
              maxAttempts: COMMIT_MESSAGE_TIMEOUT_MAX_ATTEMPTS,
              reason: "timeout",
              timeoutMs: err.timeoutMs,
            },
            "Commit message inference timed out; retrying",
          );
          continue;
        }

        const outcome = complete(null, attempt, "timeout");
        deps.logger.info(
          {
            attempts: outcome.attempts,
            durationMs: outcome.durationMs,
            maxAttempts: COMMIT_MESSAGE_TIMEOUT_MAX_ATTEMPTS,
            reason: outcome.reason,
            timeoutMs: err.timeoutMs,
          },
          "Commit message inference timed out",
        );
        return outcome;
      }

      const reason: CommitMessageGenerationReason = "failed";
      const outcome = complete(null, attempt, reason);
      deps.logger.warn(
        {
          attempts: outcome.attempts,
          durationMs: outcome.durationMs,
          err,
          reason: outcome.reason,
        },
        "Failed to generate commit message",
      );
      return outcome;
    }
  }

  return complete(null, COMMIT_MESSAGE_TIMEOUT_MAX_ATTEMPTS, "failed");
}

export async function generateCommitMessage(
  deps: CommitMessageGenerationDeps,
  args: GenerateCommitMessageArgs,
): Promise<string | null> {
  const outcome = await generateCommitMessageWithOutcome(deps, args);
  return outcome.message;
}
