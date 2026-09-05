import type { PromptInput, ProvisioningTranscriptEntry } from "@bb/domain";
import type { LoggedWorkSessionDeps } from "../../types.js";
import { appendThreadProvisioningEvent } from "./thread-events.js";
import {
  applyGeneratedThreadTitle,
  generateThreadMetadataWithOutcome,
  type ThreadMetadataGenerationOutcome,
} from "./title-generation.js";
import { runtimeErrorLogFields } from "../lib/error-log-fields.js";
import { INFERENCE_POLICY } from "../ai/inference.js";

interface ThreadMetadataInferenceArgs {
  environmentId: string | null;
  input: PromptInput[];
  provisioningId: string;
  threadId: string;
  writeTranscript: boolean;
}

interface ThreadMetadataInferenceResult {
  titleApplied: boolean;
  title: string | null;
}

interface MetadataCompletedEntryArgs {
  outcome: ThreadMetadataGenerationOutcome;
  startedAt: number;
}

function metadataCompletedEntry(
  args: MetadataCompletedEntryArgs,
): ProvisioningTranscriptEntry {
  const titleGenerated = Boolean(args.outcome.metadata?.title);
  return {
    type: "step",
    key: "metadata-completed",
    text: titleGenerated ? "Generated title" : "No title generated",
    status: "completed",
    startedAt: args.startedAt,
    metadata: {
      durationMs: args.outcome.durationMs,
      titleGenerated,
      ...(args.outcome.reason ? { reason: args.outcome.reason } : {}),
    },
  };
}

export async function inferThreadMetadata(
  deps: LoggedWorkSessionDeps,
  args: ThreadMetadataInferenceArgs,
): Promise<ThreadMetadataInferenceResult> {
  const startedAt = Date.now();
  const provisioningId = args.provisioningId;
  if (args.writeTranscript) {
    appendThreadProvisioningEvent(deps, {
      threadId: args.threadId,
      environmentId: args.environmentId,
      provisioningId,
      status: "active",
      entries: [
        {
          type: "step",
          key: "metadata-started",
          text: "Generating title",
          status: "started",
          startedAt,
        },
      ],
    });
  }

  const outcome = await generateThreadMetadataWithOutcome(deps, {
    input: args.input,
    threadId: args.threadId,
    timeoutMaxAttempts: INFERENCE_POLICY.threadMetadata.maxAttempts,
    timeoutMs: INFERENCE_POLICY.threadMetadata.timeoutMs,
  });

  if (args.writeTranscript) {
    appendThreadProvisioningEvent(deps, {
      threadId: args.threadId,
      environmentId: args.environmentId,
      provisioningId,
      status: "active",
      entries: [
        metadataCompletedEntry({ outcome, startedAt }),
      ],
    });
  }

  let titleApplied = false;
  if (outcome.metadata?.title) {
    try {
      titleApplied = applyGeneratedThreadTitle(deps, {
        threadId: args.threadId,
        title: outcome.metadata.title,
      });
    } catch (error) {
      deps.logger.warn(
        {
          threadId: args.threadId,
          ...runtimeErrorLogFields(deps.config, error),
        },
        "Failed to apply generated thread title",
      );
    }
  }

  return {
    title: outcome.metadata?.title ?? null,
    titleApplied,
  };
}
