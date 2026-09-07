import { Command } from "commander";
import { randomUUID } from "node:crypto";
import {
  threadVisibilitySchema,
  type PermissionMode,
  type ReasoningLevel,
  type ServiceTier,
  type ThreadVisibility,
} from "@bb/domain";
import { action } from "../../action.js";
import { createCliBbSdk } from "../../client.js";
import type { ThreadRetryResult, ThreadSendResult } from "@bb/sdk";
import type { QueuedMessageWaitingOn } from "@bb/domain";
import {
  confirmDestructiveAction,
  outputJson,
  parseReasoningLevel,
  prependErrorContext,
  requireThreadIdOrSelf,
} from "../helpers.js";
import {
  resolveContextThreadId,
  resolveExplicitIdFlag,
} from "../../context-env.js";
import {
  parsePermissionMode,
  parseServiceTier,
  PERMISSION_MODE_HELP,
  PLAN_HELP,
  buildPromptInputs,
  collectOption,
} from "./helpers.js";
import { SEND_AT_HELP, parseSendAt } from "./send-time.js";

interface ThreadUpdateCommandOptions {
  self?: boolean;
  json?: boolean;
  title?: string;
  parentThread?: string;
  clearParentThread?: boolean;
  section?: string;
  clearSection?: boolean;
  model?: string;
  reasoningLevel?: string;
  visibility?: string;
}

interface ThreadArchiveCommandOptions {
  self?: boolean;
  json?: boolean;
}

interface ThreadUnarchiveCommandOptions {
  self?: boolean;
  json?: boolean;
}

interface ThreadPinCommandOptions {
  self?: boolean;
  json?: boolean;
}

interface ThreadDeleteCommandOptions {
  confirmChildThreads?: boolean;
  yes?: boolean;
  json?: boolean;
}

interface ThreadTellCommandOptions {
  json?: boolean;
  model?: string;
  permissionMode?: string;
  reasoningLevel?: string;
  serviceTier?: string;
  mode?: string;
  plan?: boolean;
  file?: string[];
  image?: string[];
  sendAt?: string;
}

interface ThreadActionOptions {
  self?: boolean;
  json?: boolean;
}

interface ThreadRetryCommandOptions {
  self?: boolean;
  json?: boolean;
  turn?: string;
  sendAt?: string;
  reason?: string;
}

interface ThreadEditMessageCommandOptions {
  expectedRequestSequence?: string;
  json?: boolean;
  message: string;
  self?: boolean;
}

type ThreadTellDeliveryMode = "auto" | "queue" | "steer";

interface PostThreadMessageArgs {
  getUrl: () => string;
  threadId: string;
  message: string;
  mode: ThreadTellDeliveryMode;
  model?: string;
  permissionMode?: PermissionMode;
  reasoningLevel?: ReasoningLevel;
  serviceTier?: ServiceTier;
  senderThreadId?: string;
  plan?: boolean;
  files?: readonly string[];
  images?: readonly string[];
  sendAt?: number;
}

// The server's own answer plus the mode we asked for. `sendAt` used to be
// echoed back here so the outcome line could name the time; the queued arm of
// the response now carries it, along with the reason, so the CLI no longer
// has to reconstruct what happened from the flags it sent.
type PostThreadMessageResult = ThreadSendResult & {
  mode: ThreadTellDeliveryMode;
};

interface ThreadUpdateBody {
  title?: string;
  sectionId?: string | null;
  parentThreadId?: string | null;
  model?: string;
  reasoningLevel?: ReasoningLevel;
  visibility?: ThreadVisibility;
}

export function registerActionsCommands(
  parent: Command,
  getUrl: () => string,
): void {
  parent
    .command("update [id]")
    .description("Update a thread")
    .option("--self", "Target the current thread (from BB_THREAD_ID)")
    .option("--json", "Print machine-readable JSON output")
    .option("--title <title>", "Set the thread title")
    .option("--parent-thread <id>", "Set the parent thread id")
    .option("--clear-parent-thread", "Clear the parent thread id")
    .option("--section <id>", "Move the thread into a section")
    .option("--clear-section", "Remove the thread from its section")
    .option(
      "--model <model>",
      "Set the sticky model applied on the thread's next turn",
    )
    .option(
      "--reasoning-level <level>",
      "Set the sticky reasoning level applied on the thread's next turn: low, medium, high, xhigh, max (provider-dependent)",
    )
    .option("--visibility <visibility>", "Thread visibility: visible or hidden")
    .action(
      action(
        async (id: string | undefined, opts: ThreadUpdateCommandOptions) => {
          if (opts.parentThread && opts.clearParentThread) {
            throw new Error(
              "Cannot combine --parent-thread with --clear-parent-thread.",
            );
          }
          if (opts.section && opts.clearSection) {
            throw new Error("Cannot combine --section with --clear-section.");
          }
          const reasoningLevel = parseReasoningLevel(opts.reasoningLevel);
          const visibility =
            opts.visibility === undefined
              ? undefined
              : threadVisibilitySchema.parse(opts.visibility);
          if (
            !opts.parentThread &&
            !opts.clearParentThread &&
            !opts.section &&
            !opts.clearSection &&
            !opts.title &&
            !opts.model &&
            !reasoningLevel &&
            !visibility
          ) {
            throw new Error(
              "No changes requested. Provide --title, --parent-thread, --clear-parent-thread, --section, --clear-section, --model, --reasoning-level, or --visibility.",
            );
          }

          const threadId = requireThreadIdOrSelf(id, opts);
          const parentThreadId = resolveExplicitIdFlag({
            flagName: "--parent-thread",
            value: opts.parentThread,
          });
          const body: ThreadUpdateBody = {};
          if (opts.title) {
            body.title = opts.title;
          }
          if (parentThreadId) {
            body.parentThreadId = parentThreadId;
          } else if (opts.clearParentThread) {
            body.parentThreadId = null;
          }
          if (opts.section) {
            body.sectionId = resolveExplicitIdFlag({
              flagName: "--section",
              value: opts.section,
            });
          } else if (opts.clearSection) {
            body.sectionId = null;
          }
          if (opts.model) {
            body.model = opts.model;
          }
          if (reasoningLevel) {
            body.reasoningLevel = reasoningLevel;
          }
          if (visibility) {
            body.visibility = visibility;
          }

          const sdk = createCliBbSdk(getUrl());
          const thread = await sdk.threads.update({ threadId, ...body });
          if (outputJson(opts, thread)) return;
          console.log(`Thread ${thread.id} updated`);
          if (opts.title) {
            console.log(`Title: ${thread.title ?? "<untitled>"}`);
          }
          if (opts.parentThread || opts.clearParentThread) {
            console.log(
              thread.parentThreadId
                ? `Parent: ${thread.parentThreadId}`
                : "No parent thread",
            );
          }
          if (opts.section || opts.clearSection) {
            console.log(
              thread.sectionId ? `Section: ${thread.sectionId}` : "No section",
            );
          }
          if (opts.model) {
            console.log(`Model: ${opts.model}`);
          }
          if (reasoningLevel) {
            console.log(`Reasoning level: ${reasoningLevel}`);
          }
          if (visibility) {
            console.log(`Visibility: ${visibility}`);
          }
        },
      ),
    );

  parent
    .command("archive [id]")
    .description("Archive a thread")
    .option("--self", "Target the current thread (from BB_THREAD_ID)")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (id: string | undefined, opts: ThreadArchiveCommandOptions) => {
          const threadId = requireThreadIdOrSelf(id, opts);
          const sdk = createCliBbSdk(getUrl());
          let archivedThreadIds: string[] = [threadId];
          try {
            const result = await sdk.threads.archive({ threadId });
            archivedThreadIds = result.archivedThreadIds;
          } catch (err: unknown) {
            throw prependErrorContext(
              `Failed to archive thread ${threadId}`,
              err,
            );
          }
          if (
            outputJson(opts, {
              ok: true,
              threadId,
              archivedThreadIds,
            })
          ) {
            return;
          }
          const cascadedCount = archivedThreadIds.filter(
            (archivedId) => archivedId !== threadId,
          ).length;
          if (cascadedCount === 0) {
            console.log(`Thread ${threadId} archived`);
            return;
          }
          console.log(
            `Thread ${threadId} archived (${cascadedCount} related thread${cascadedCount === 1 ? "" : "s"} also archived)`,
          );
        },
      ),
    );

  parent
    .command("unarchive [id]")
    .description("Unarchive a thread")
    .option("--self", "Target the current thread (from BB_THREAD_ID)")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (id: string | undefined, opts: ThreadUnarchiveCommandOptions) => {
          const threadId = requireThreadIdOrSelf(id, opts);
          const sdk = createCliBbSdk(getUrl());
          await sdk.threads.unarchive({ threadId });
          if (outputJson(opts, { ok: true, threadId })) return;
          console.log(`Thread ${threadId} unarchived`);
        },
      ),
    );

  parent
    .command("pin [id]")
    .description("Pin a thread")
    .option("--self", "Target the current thread (from BB_THREAD_ID)")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (id: string | undefined, opts: ThreadPinCommandOptions) => {
        const threadId = requireThreadIdOrSelf(id, opts);
        const sdk = createCliBbSdk(getUrl());
        const thread = await sdk.threads.pin({ threadId });
        if (outputJson(opts, thread)) return;
        console.log(`Thread ${thread.id} pinned`);
      }),
    );

  parent
    .command("unpin [id]")
    .description("Unpin a thread")
    .option("--self", "Target the current thread (from BB_THREAD_ID)")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (id: string | undefined, opts: ThreadPinCommandOptions) => {
        const threadId = requireThreadIdOrSelf(id, opts);
        const sdk = createCliBbSdk(getUrl());
        const thread = await sdk.threads.unpin({ threadId });
        if (outputJson(opts, thread)) return;
        console.log(`Thread ${thread.id} unpinned`);
      }),
    );

  parent
    .command("delete <id>")
    .description("Delete a thread permanently")
    .option("--yes", "Skip the confirmation prompt")
    .option(
      "--confirm-child-threads",
      "Confirm deleting a thread with child threads",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (id: string, opts: ThreadDeleteCommandOptions) => {
        const sdk = createCliBbSdk(getUrl());
        try {
          const thread = await sdk.threads.get({ threadId: id });

          if (!opts.yes) {
            const confirmed = await confirmDestructiveAction(
              `Delete thread "${thread.title ?? thread.titleFallback ?? thread.id}" permanently? This cannot be undone.`,
            );
            if (!confirmed) {
              console.log(`Thread ${id} deletion cancelled`);
              return;
            }
          }

          await sdk.threads.delete({
            threadId: id,
            childThreadsConfirmed: opts.confirmChildThreads === true,
          });
        } catch (err: unknown) {
          throw prependErrorContext(`Failed to delete thread ${id}`, err);
        }
        if (outputJson(opts, { ok: true, threadId: id })) return;
        console.log(`Thread ${id} deleted`);
      }),
    );

  parent
    .command("edit-message [id]")
    .description("Replace an accepted user message and rerun from that point")
    .requiredOption("--message <text>", "Replacement message text")
    .option("--self", "Target the current thread (from BB_THREAD_ID)")
    .option(
      "--expected-request-sequence <sequence>",
      "Edit the message at this event sequence (default: the latest editable message)",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (
          id: string | undefined,
          opts: ThreadEditMessageCommandOptions,
        ) => {
          const threadId = requireThreadIdOrSelf(id, opts);
          const sdk = createCliBbSdk(getUrl());
          const expectedRequestSequence =
            opts.expectedRequestSequence === undefined
              ? undefined
              : Number(opts.expectedRequestSequence);
          if (
            expectedRequestSequence !== undefined &&
            (!Number.isInteger(expectedRequestSequence) ||
              expectedRequestSequence < 0)
          ) {
            throw new Error(
              "--expected-request-sequence must be a non-negative integer.",
            );
          }
          const senderThreadId = resolveSenderThreadId(threadId);
          const result = await sdk.threads.editMessage({
            threadId,
            operationId: randomUUID(),
            ...(expectedRequestSequence !== undefined
              ? { expectedRequestSequence }
              : {}),
            input: buildPromptInputs({ message: opts.message }),
            ...(senderThreadId !== undefined ? { senderThreadId } : {}),
          });
          if (outputJson(opts, { threadId, ...result })) {
            return;
          }
          console.log(
            `Thread ${threadId} message replaced; workspace changes were kept`,
          );
        },
      ),
    );

  parent
    .command("tell <id> <message>")
    .description("Send a follow-up message to a thread")
    .option("--json", "Print machine-readable JSON output")
    .option("--model <model>", "Model ID for this message")
    .option("--service-tier <tier>", "Service tier: fast or default")
    .option(
      "--reasoning-level <level>",
      "Reasoning level: low, medium, high, xhigh, max (provider-dependent)",
    )
    .option("--permission-mode <mode>", PERMISSION_MODE_HELP)
    .option(
      "--mode <mode>",
      "Message mode: steer (default), queue, or auto (steer a live turn, else start one)",
    )
    .option("--send-at <when>", SEND_AT_HELP)
    .option("--plan", PLAN_HELP)
    .option(
      "--file <path>",
      "Pass a host-readable absolute or uploaded attachment file path (repeatable)",
      collectOption,
      [],
    )
    .option(
      "--image <path>",
      "Pass a host-readable absolute or uploaded attachment image path (repeatable)",
      collectOption,
      [],
    )
    .action(
      action(
        async (id: string, message: string, opts: ThreadTellCommandOptions) => {
          const response = await postThreadMessage({
            getUrl,
            threadId: id,
            message,
            mode: resolveThreadMessageMode(opts.mode),
            model: opts.model,
            permissionMode: parsePermissionMode(opts.permissionMode),
            reasoningLevel: parseReasoningLevel(opts.reasoningLevel),
            serviceTier: parseServiceTier(opts.serviceTier),
            senderThreadId: resolveSenderThreadId(id),
            plan: opts.plan,
            files: opts.file,
            images: opts.image,
            ...(opts.sendAt === undefined
              ? {}
              : { sendAt: parseSendAt(opts.sendAt) }),
          });
          if (outputJson(opts, { threadId: id, ...response })) return;
          console.log(describeThreadTellOutcome(id, response));
        },
      ),
    );

  parent
    .command("retry [id]")
    .description("Retry the failed turn on a thread")
    .option("--self", "Target the current thread (from BB_THREAD_ID)")
    .option(
      "--turn <requestId>",
      "Retry this turn request id specifically; fails when it is not the thread's failed turn",
    )
    .option("--send-at <when>", SEND_AT_HELP)
    .option(
      "--reason <text>",
      "Why it is being retried, shown on the queued row",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (id: string | undefined, opts: ThreadRetryCommandOptions) => {
          const threadId = requireThreadIdOrSelf(id, opts);
          const sdk = createCliBbSdk(getUrl());
          const response = await sdk.threads.retry({
            threadId,
            ...(opts.turn === undefined ? {} : { turnRequestId: opts.turn }),
            ...(opts.sendAt === undefined
              ? {}
              : { sendAt: parseSendAt(opts.sendAt) }),
            ...(opts.reason === undefined ? {} : { reason: opts.reason }),
          });
          if (outputJson(opts, { threadId, ...response })) return;
          console.log(describeThreadRetryOutcome(threadId, response));
        },
      ),
    );

  parent
    .command("stop [id]")
    .description("Stop work and release the loaded agent runtime")
    .option("--self", "Target the current thread (from BB_THREAD_ID)")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (id: string | undefined, opts: ThreadActionOptions) => {
        const threadId = requireThreadIdOrSelf(id, opts);
        const sdk = createCliBbSdk(getUrl());
        await sdk.threads.stop({ threadId });
        if (outputJson(opts, { ok: true, threadId })) return;
        console.log(`Thread ${threadId} stopped`);
      }),
    );

  parent
    .command("compact [id]")
    .description("Request compaction of an idle or errored thread's context")
    .option("--self", "Target the current thread (from BB_THREAD_ID)")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (id: string | undefined, opts: ThreadActionOptions) => {
        const threadId = requireThreadIdOrSelf(id, opts);
        const sdk = createCliBbSdk(getUrl());
        await sdk.threads.compact({ threadId });
        if (outputJson(opts, { ok: true, threadId })) return;
        console.log(`Thread ${threadId} context compaction requested`);
      }),
    );

  parent
    .command("clear [id]")
    .description("Clear model context for an idle or failed thread")
    .option("--self", "Target the current thread (from BB_THREAD_ID)")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (id: string | undefined, opts: ThreadActionOptions) => {
        const threadId = requireThreadIdOrSelf(id, opts);
        const sdk = createCliBbSdk(getUrl());
        await sdk.threads.clearContext({ threadId });
        if (outputJson(opts, { ok: true, threadId })) return;
        console.log(`Thread ${threadId} context cleared`);
      }),
    );

  parent
    .command("cancel-plan [id]")
    .description("Ask the provider to exit the active Plan mode")
    .option("--self", "Target the current thread (from BB_THREAD_ID)")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (id: string | undefined, opts: ThreadActionOptions) => {
        const threadId = requireThreadIdOrSelf(id, opts);
        const sdk = createCliBbSdk(getUrl());
        await sdk.threads.cancelPlan({ threadId });
        if (outputJson(opts, { ok: true, threadId })) return;
        console.log(`Thread ${threadId} exited Plan mode`);
      }),
    );

  parent
    .command("clear-goal [id]")
    .description("Ask the provider to clear the active Goal")
    .option("--self", "Target the current thread (from BB_THREAD_ID)")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (id: string | undefined, opts: ThreadActionOptions) => {
        const threadId = requireThreadIdOrSelf(id, opts);
        const sdk = createCliBbSdk(getUrl());
        await sdk.threads.clearGoal({ threadId });
        if (outputJson(opts, { ok: true, threadId })) return;
        console.log(`Thread ${threadId} cleared its Goal`);
      }),
    );
}

async function postThreadMessage(
  args: PostThreadMessageArgs,
): Promise<PostThreadMessageResult> {
  const sdk = createCliBbSdk(args.getUrl());
  const response = await sdk.threads.send({
    threadId: args.threadId,
    input: buildPromptInputs({
      message: args.message,
      plan: args.plan,
      files: args.files,
      images: args.images,
    }),
    mode:
      args.mode === "steer"
        ? "steer-if-active"
        : args.mode === "auto"
          ? "auto"
          : "queue-if-active",
    ...(args.model ? { model: args.model } : {}),
    ...(args.permissionMode ? { permissionMode: args.permissionMode } : {}),
    ...(args.reasoningLevel ? { reasoningLevel: args.reasoningLevel } : {}),
    ...(args.serviceTier ? { serviceTier: args.serviceTier } : {}),
    ...(args.senderThreadId ? { senderThreadId: args.senderThreadId } : {}),
    ...(args.sendAt === undefined ? {} : { sendAt: args.sendAt }),
  });
  return { ...response, mode: args.mode };
}

function describeThreadTellOutcome(
  threadId: string,
  response: PostThreadMessageResult,
): string {
  if (response.delivery === "queued") {
    // The server says WHY it is waiting, so the CLI does not have to guess
    // from the flags it happened to send. `bb thread queue list` shows the
    // same reason for the row afterwards.
    return `Thread ${threadId} message queued (${describeQueueWait(response.queuedMessage)}); it dispatches when that clears`;
  }
  return response.mode === "steer"
    ? `Thread ${threadId} steered`
    : `Thread ${threadId} updated`;
}

/**
 * What the retry did. A retry is a dispatch like any other, so it either went
 * or is waiting — and when it is waiting the server says why, exactly as `tell`
 * reports a queued send.
 */
function describeThreadRetryOutcome(
  threadId: string,
  response: ThreadRetryResult,
): string {
  const turn = `turn ${response.turnRequestId} (attempt ${response.attempt})`;
  return response.delivery === "queued"
    ? `Thread ${threadId} retry of ${turn} queued (${describeQueueWait(response)}); it dispatches when that clears`
    : `Thread ${threadId} retrying ${turn}`;
}

/** One short phrase for a queued row's wait, shared by `tell` and `queue`. */
export function describeQueueWait(row: {
  sendAt: number | null;
  waitingOn: QueuedMessageWaitingOn | null;
}): string {
  const waitingOn = row.waitingOn ?? { kind: "thread-busy" as const };
  switch (waitingOn.kind) {
    case "time":
      return row.sendAt === null
        ? "scheduled"
        : `scheduled for ${new Date(row.sendAt).toLocaleString()}`;
    case "thread-busy":
      return "waiting for the current turn to finish";
    case "turn-starting":
      return "waiting for the current turn to start";
    case "provisioning":
      return "waiting for the workspace";
    case "host-offline":
      return `waiting for ${waitingOn.hostName} to reconnect`;
    case "interaction":
      return "waiting for a pending interaction";
    case "plugin":
      return `${waitingOn.pluginId}: ${waitingOn.reason}`;
  }
}

function resolveSenderThreadId(targetThreadId: string): string | undefined {
  const senderThreadId = resolveContextThreadId();
  if (!senderThreadId || senderThreadId === targetThreadId) {
    return undefined;
  }
  return senderThreadId;
}

function resolveThreadMessageMode(
  value: string | undefined,
): ThreadTellDeliveryMode {
  if (value === undefined) return "steer";
  const normalized = value.trim().toLowerCase();
  if (normalized === "steer") return "steer";
  if (normalized === "steer-if-active") return "steer";
  if (normalized === "queue") return "queue";
  if (normalized === "queue-if-active") return "queue";
  if (normalized === "auto") return "auto";
  throw new Error(
    `Invalid message mode '${value}'. Expected 'queue', 'steer', or 'auto'.`,
  );
}
