import type {
  PromptInput,
  ProvisioningTranscriptEntry,
} from "@bb/domain";
import type { AppDeps } from "../../types.js";
import {
  appendThreadProvisioningEvent,
} from "./thread-events.js";
import {
  applyGeneratedThreadTitle,
  generateThreadMetadataWithOutcome,
  type ThreadMetadataGenerationOutcome,
} from "./title-generation.js";

type ThreadMetadataInferenceDeps = Pick<AppDeps, "config" | "db" | "hub" | "logger">;

export const MANAGED_THREAD_METADATA_TIMEOUT_MS = 5_000;

export interface ThreadMetadataInferenceArgs {
  environmentId: string | null;
  generateBranchName: boolean;
  generateTitle: boolean;
  input: PromptInput[];
  timeoutMs?: number;
  threadId: string;
  writeTranscript: boolean;
}

export interface ThreadMetadataInferenceResult {
  branchSlug: string | null;
  eventSequence: number | null;
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

function metadataCompletedEntry(args: MetadataCompletedEntryArgs): ProvisioningTranscriptEntry {
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
      eventSequence: null,
      title: null,
      titleApplied: false,
    };
  }

  const startedAt = Date.now();
  if (args.writeTranscript && args.environmentId) {
    appendThreadProvisioningEvent(deps, {
      threadId: args.threadId,
      environmentId: args.environmentId,
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
    ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}),
  });

  const eventSequence =
    args.writeTranscript && args.environmentId
      ? appendThreadProvisioningEvent(deps, {
          threadId: args.threadId,
          environmentId: args.environmentId,
          status: "active",
          entries: [
            metadataCompletedEntry({
              generateBranchName: args.generateBranchName,
              generateTitle: args.generateTitle,
              outcome,
              startedAt,
            }),
          ],
        })
      : null;

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
    branchSlug:
      args.generateBranchName ? outcome.metadata?.branchSlug ?? null : null,
    eventSequence,
    title: args.generateTitle ? outcome.metadata?.title ?? null : null,
    titleApplied,
  };
}
