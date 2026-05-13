import type { PromptInput, ProvisioningTranscriptEntry } from "@bb/domain";
import type { AppDeps } from "../../types.js";
import { appendThreadProvisioningEvent } from "./thread-events.js";
import {
  applyGeneratedThreadTitle,
  generateThreadMetadataWithOutcome,
  type ThreadMetadataGenerationOutcome,
} from "./title-generation.js";

type ThreadMetadataInferenceDeps = Pick<
  AppDeps,
  "config" | "db" | "hub" | "logger"
>;

// Two 2.5s attempts preserve roughly the old 5s managed provisioning
// blocking budget while recovering transient metadata inference timeouts.
export const MANAGED_THREAD_METADATA_TIMEOUT_MS = 2_500;
export const MANAGED_THREAD_METADATA_TIMEOUT_MAX_ATTEMPTS = 2;

export interface ThreadMetadataInferenceArgs {
  environmentId: string | null;
  generateBranchName: boolean;
  generateTitle: boolean;
  input: PromptInput[];
  provisioningId: string | null;
  timeoutMaxAttempts?: number;
  timeoutMs?: number;
  threadId: string;
  writeTranscript: boolean;
}

export interface ThreadMetadataInferenceResult {
  branchSlug: string | null;
  titleApplied: boolean;
  title: string | null;
}

interface MetadataTextArgs {
  generateBranchName: boolean;
  generateTitle: boolean;
  outcome: ThreadMetadataGenerationOutcome;
}

interface MetadataRequirements {
  generateBranchName: boolean;
  generateTitle: boolean;
}

interface MetadataCompletedEntryArgs extends MetadataTextArgs {
  startedAt: number;
}

function metadataStartedText(args: MetadataRequirements): string {
  if (args.generateTitle && args.generateBranchName) {
    return "Generating title and branch name";
  }
  if (args.generateBranchName) {
    return "Generating branch name";
  }
  return "Generating title";
}

function metadataCompletedText(args: MetadataTextArgs): string {
  const hasTitle = args.generateTitle && Boolean(args.outcome.metadata?.title);
  const hasBranchName =
    args.generateBranchName && Boolean(args.outcome.metadata?.branchSlug);

  if (hasTitle && hasBranchName) {
    return "Generated title and branch name";
  }
  if (hasTitle) {
    return "Generated title";
  }
  if (hasBranchName) {
    return "Generated branch name";
  }
  if (args.generateBranchName) {
    return "Using fallback branch name";
  }
  return "No title generated";
}

function metadataCompletedEntry(
  args: MetadataCompletedEntryArgs,
): ProvisioningTranscriptEntry {
  return {
    type: "step",
    key: "metadata-completed",
    text: metadataCompletedText(args),
    status: "completed",
    startedAt: args.startedAt,
    metadata: {
      durationMs: args.outcome.durationMs,
      branchNameGenerated:
        args.generateBranchName && Boolean(args.outcome.metadata?.branchSlug),
      titleGenerated:
        args.generateTitle && Boolean(args.outcome.metadata?.title),
      ...(args.outcome.reason ? { reason: args.outcome.reason } : {}),
    },
  };
}

export async function inferThreadMetadata(
  deps: ThreadMetadataInferenceDeps,
  args: ThreadMetadataInferenceArgs,
): Promise<ThreadMetadataInferenceResult> {
  if (!args.generateTitle && !args.generateBranchName) {
    return {
      branchSlug: null,
      title: null,
      titleApplied: false,
    };
  }

  const startedAt = Date.now();
  const provisioningId = args.provisioningId;
  const transcriptEnvironmentId = args.writeTranscript
    ? args.environmentId
    : null;
  if (transcriptEnvironmentId) {
    if (provisioningId === null) {
      throw new Error("Cannot write provisioning transcript without an id");
    }
    appendThreadProvisioningEvent(deps, {
      threadId: args.threadId,
      environmentId: transcriptEnvironmentId,
      provisioningId,
      status: "active",
      entries: [
        {
          type: "step",
          key: "metadata-started",
          text: metadataStartedText(args),
          status: "started",
          startedAt,
        },
      ],
    });
  }

  const outcome = await generateThreadMetadataWithOutcome(deps, {
    input: args.input,
    threadId: args.threadId,
    ...(args.timeoutMaxAttempts !== undefined
      ? { timeoutMaxAttempts: args.timeoutMaxAttempts }
      : {}),
    ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}),
  });

  if (transcriptEnvironmentId && provisioningId) {
    appendThreadProvisioningEvent(deps, {
      threadId: args.threadId,
      environmentId: transcriptEnvironmentId,
      provisioningId,
      status: "active",
      entries: [
        metadataCompletedEntry({
          generateBranchName: args.generateBranchName,
          generateTitle: args.generateTitle,
          outcome,
          startedAt,
        }),
      ],
    });
  }

  let titleApplied = false;
  if (args.generateTitle && outcome.metadata?.title) {
    try {
      titleApplied = applyGeneratedThreadTitle(deps, {
        threadId: args.threadId,
        title: outcome.metadata.title,
      });
    } catch (error) {
      deps.logger.warn(
        { err: error, threadId: args.threadId },
        "Failed to apply generated thread title",
      );
    }
  }

  return {
    branchSlug: args.generateBranchName
      ? (outcome.metadata?.branchSlug ?? null)
      : null,
    title: args.generateTitle ? (outcome.metadata?.title ?? null) : null,
    titleApplied,
  };
}
