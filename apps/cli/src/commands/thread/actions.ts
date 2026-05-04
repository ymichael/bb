import { Command } from "commander";
import {
  type PermissionMode,
  type ReasoningLevel,
  type Thread,
  type ThreadStatus,
} from "@bb/domain";
import { assertNever } from "@bb/core-ui";
import { action } from "../../action.js";
import { createClient, unwrap } from "../../client.js";
import {
  confirmDestructiveAction,
  outputJson,
  parseReasoningLevel,
  prependErrorContext,
  requireThreadIdOrSelf,
} from "../helpers.js";
import { parsePermissionMode, PERMISSION_MODE_HELP } from "./helpers.js";

interface ThreadUpdateCommandOptions {
  self?: boolean;
  json?: boolean;
  title?: string;
  parentThread?: string;
  clearParentThread?: boolean;
}

interface ThreadArchiveCommandOptions {
  confirmAssignedChildThreads?: boolean;
  self?: boolean;
  force?: boolean;
  json?: boolean;
}

interface ThreadUnarchiveCommandOptions {
  self?: boolean;
  json?: boolean;
}

interface ThreadDeleteCommandOptions {
  confirmAssignedChildThreads?: boolean;
  yes?: boolean;
  json?: boolean;
}

interface ThreadTellCommandOptions {
  json?: boolean;
  model?: string;
  permissionMode?: string;
  reasoningLevel?: string;
  mode?: string;
}

interface ThreadStopCommandOptions {
  self?: boolean;
  json?: boolean;
}

interface PostThreadMessageArgs {
  getUrl: () => string;
  threadId: string;
  message: string;
  mode: "auto" | "steer";
  model?: string;
  permissionMode?: PermissionMode;
  reasoningLevel?: ReasoningLevel;
}

interface ThreadUpdateBody {
  title?: string;
  parentThreadId?: string | null;
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
    .option("--parent-thread <id>", "Set the managing parent thread id")
    .option("--clear-parent-thread", "Clear the managing parent thread id")
    .action(
      action(
        async (id: string | undefined, opts: ThreadUpdateCommandOptions) => {
          const client = createClient(getUrl());
          if (opts.parentThread && opts.clearParentThread) {
            throw new Error(
              "Cannot combine --parent-thread with --clear-parent-thread.",
            );
          }
          if (!opts.parentThread && !opts.clearParentThread && !opts.title) {
            throw new Error(
              "No changes requested. Provide --title, --parent-thread, or --clear-parent-thread.",
            );
          }

          const threadId = requireThreadIdOrSelf(id, opts);
          const body: ThreadUpdateBody = {};
          if (opts.title) {
            body.title = opts.title;
          }
          if (opts.parentThread) {
            body.parentThreadId = opts.parentThread;
          } else if (opts.clearParentThread) {
            body.parentThreadId = null;
          }

          const thread = await unwrap<Thread>(
            client.api.v1.threads[":id"].$patch({
              param: { id: threadId },
              json: body,
            }),
          );
          if (outputJson(opts, thread)) return;
          console.log(`Thread ${thread.id} updated`);
          if (opts.title) {
            console.log(`Title: ${thread.title ?? "<untitled>"}`);
          }
          if (opts.parentThread || opts.clearParentThread) {
            console.log(
              thread.parentThreadId
                ? `Managed by ${thread.parentThreadId}`
                : "No managing parent thread",
            );
          }
        },
      ),
    );

  parent
    .command("archive [id]")
    .description("Archive a thread")
    .option("--self", "Target the current thread (from BB_THREAD_ID)")
    .option(
      "--force",
      "Archive even when the thread workspace has uncommitted or unmerged work",
    )
    .option(
      "--confirm-assigned-child-threads",
      "Confirm archiving a manager with assigned child threads",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (id: string | undefined, opts: ThreadArchiveCommandOptions) => {
          const threadId = requireThreadIdOrSelf(id, opts);
          const client = createClient(getUrl());
          try {
            await unwrap<{ ok: boolean }>(
              client.api.v1.threads[":id"].archive.$post({
                param: { id: threadId },
                json: {
                  force: opts.force === true,
                  managerChildThreadsConfirmed:
                    opts.confirmAssignedChildThreads === true,
                },
              }),
            );
          } catch (err: unknown) {
            throw prependErrorContext(
              `Failed to archive thread ${threadId}`,
              err,
            );
          }
          if (outputJson(opts, { ok: true, threadId })) return;
          console.log(`Thread ${threadId} archived`);
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
          const client = createClient(getUrl());
          const threadId = requireThreadIdOrSelf(id, opts);
          await unwrap<{ ok: boolean }>(
            client.api.v1.threads[":id"].unarchive.$post({
              param: { id: threadId },
            }),
          );
          if (outputJson(opts, { ok: true, threadId })) return;
          console.log(`Thread ${threadId} unarchived`);
        },
      ),
    );

  parent
    .command("delete <id>")
    .description("Delete a thread permanently")
    .option("--yes", "Skip the confirmation prompt")
    .option(
      "--confirm-assigned-child-threads",
      "Confirm deleting a manager with assigned child threads",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (id: string, opts: ThreadDeleteCommandOptions) => {
        const client = createClient(getUrl());
        try {
          const thread = await unwrap<Thread>(
            client.api.v1.threads[":id"].$get({ param: { id } }),
          );

          if (!opts.yes) {
            const confirmed = await confirmDestructiveAction(
              `Delete thread "${thread.title ?? thread.titleFallback ?? thread.id}" permanently? This cannot be undone.`,
            );
            if (!confirmed) {
              console.log(`Thread ${id} deletion cancelled`);
              return;
            }
          }

          await unwrap<{ ok: boolean }>(
            client.api.v1.threads[":id"].$delete({
              param: { id },
              json: {
                managerChildThreadsConfirmed:
                  opts.confirmAssignedChildThreads === true,
              },
            }),
          );
        } catch (err: unknown) {
          throw prependErrorContext(`Failed to delete thread ${id}`, err);
        }
        if (outputJson(opts, { ok: true, threadId: id })) return;
        console.log(`Thread ${id} deleted`);
      }),
    );

  parent
    .command("tell <id> <message>")
    .description("Send a follow-up message to a thread")
    .option("--json", "Print machine-readable JSON output")
    .option("--model <model>", "Model ID for this message")
    .option(
      "--reasoning-level <level>",
      "Reasoning level: low, medium, high, xhigh",
    )
    .option("--permission-mode <mode>", PERMISSION_MODE_HELP)
    .option("--mode <mode>", "Message mode (e.g. steer)")
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
          });
          if (outputJson(opts, { threadId: id, ...response })) return;
          console.log(
            response.mode === "steer"
              ? `Thread ${id} steered`
              : `Thread ${id} updated`,
          );
        },
      ),
    );

  parent
    .command("stop [id]")
    .description("Stop an active thread")
    .option("--self", "Target the current thread (from BB_THREAD_ID)")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (id: string | undefined, opts: ThreadStopCommandOptions) => {
        const client = createClient(getUrl());
        const threadId = requireThreadIdOrSelf(id, opts);
        const thread = await unwrap<Thread>(
          client.api.v1.threads[":id"].$get({ param: { id: threadId } }),
        );
        const blockedReason = getThreadStopBlockedReason(
          threadId,
          thread.status,
        );
        if (blockedReason) {
          throw new Error(blockedReason);
        }
        await unwrap<{ ok: boolean }>(
          client.api.v1.threads[":id"].stop.$post({ param: { id: threadId } }),
        );
        if (outputJson(opts, { ok: true, threadId })) return;
        console.log(`Thread ${threadId} stopped`);
      }),
    );
}

async function postThreadMessage(
  args: PostThreadMessageArgs,
): Promise<{ ok: boolean; mode?: "steer" }> {
  const client = createClient(args.getUrl());
  const response = await unwrap<{ ok: boolean }>(
    client.api.v1.threads[":id"].send.$post({
      param: { id: args.threadId },
      json: {
        input: [{ type: "text", text: args.message }],
        mode: args.mode,
        ...(args.model ? { model: args.model } : {}),
        ...(args.permissionMode ? { permissionMode: args.permissionMode } : {}),
        ...(args.reasoningLevel ? { reasoningLevel: args.reasoningLevel } : {}),
      },
    }),
  );
  return {
    ...response,
    ...(args.mode === "steer" ? { mode: "steer" as const } : {}),
  };
}

function resolveThreadMessageMode(value: string | undefined): "auto" | "steer" {
  if (value === undefined) return "auto";
  const normalized = value.trim().toLowerCase();
  if (normalized === "steer") return "steer";
  if (normalized === "auto") return "auto";
  throw new Error(
    `Invalid message mode '${value}'. Expected 'auto' or 'steer'.`,
  );
}

function getThreadStopBlockedReason(
  threadId: string,
  status: ThreadStatus,
): string | undefined {
  switch (status) {
    case "created":
    case "provisioning":
    case "active":
      return undefined;
    case "idle":
      return `Thread ${threadId} is already idle.`;
    case "error":
      return (
        `Thread ${threadId} is in status error. ` +
        `Do not stop it to force idle; inspect it with 'bb thread show ${threadId}' and recover by sending a follow-up.`
      );
    default:
      return assertNever(status);
  }
}
