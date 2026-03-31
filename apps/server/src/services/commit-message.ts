import { complete } from "@mariozechner/pi-ai";
import { renderTemplate } from "@bb/templates";
import { z } from "zod";
import type { AppDeps } from "../types.js";
import { extractAssistantText, getInferenceModel } from "./inference.js";

const commitMessageResponseSchema = z.object({
  message: z.string().min(1),
});

interface GenerateCommitMessageArgs {
  diffDescription: string;
  shortstat: string;
  files: string;
  patch: string;
}

const COMMIT_MESSAGE_TIMEOUT_MS = 10_000;

export async function generateCommitMessage(
  deps: Pick<AppDeps, "config" | "logger">,
  args: GenerateCommitMessageArgs,
): Promise<string | null> {
  try {
    const model = getInferenceModel(deps);
    if (!model) {
      return null;
    }

    const prompt = renderTemplate("generateCommitMessage", {
      diffDescription: args.diffDescription,
      shortstat: args.shortstat,
      files: args.files,
      patch: args.patch,
    });

    const response = await Promise.race([
      complete(model, {
        messages: [
          {
            role: "user",
            content: prompt,
            timestamp: Date.now(),
          },
        ],
      }),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Commit message generation timed out")),
          COMMIT_MESSAGE_TIMEOUT_MS,
        );
        timer.unref();
      }),
    ]);

    const text = extractAssistantText(response);
    const parsed = commitMessageResponseSchema.parse(JSON.parse(text));
    return parsed.message;
  } catch (error) {
    deps.logger.warn({ err: error }, "Failed to generate commit message");
    return null;
  }
}
