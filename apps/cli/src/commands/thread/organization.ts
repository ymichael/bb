import { Command } from "commander";
import { updateThreadTabsRequestSchema } from "@bb/server-contract";
import {
  queuedMessageWaitHolderSchema,
  type PromptInput,
  type QueuedMessageWaitHolder,
} from "@bb/domain";
import type { ThreadQueuedMessagesResult } from "@bb/sdk";
import { renderBorderlessTable } from "../../table.js";
import { describeQueueWait } from "./actions.js";
import { formatQueueSendCountdown } from "./send-time.js";
import { action } from "../../action.js";
import { createCliBbSdk } from "../../client.js";
import {
  confirmDestructiveAction,
  outputJson,
  requireThreadIdOrSelf,
} from "../helpers.js";
import { buildPromptInputs, collectOption } from "./helpers.js";

interface JsonOptions {
  json?: boolean;
}

interface SelfOptions extends JsonOptions {
  self?: boolean;
}

interface SectionDeleteOptions extends JsonOptions {
  yes?: boolean;
}

interface SearchOptions extends JsonOptions {
  limit?: string;
}

interface HistoryOptions extends JsonOptions {
  limit?: string;
}

interface QueueListOptions extends JsonOptions {
  waitHolder?: string;
}

interface QueueCreateOptions extends JsonOptions {
  model?: string;
}

interface QueueUpdateOptions extends JsonOptions {
  file?: string[];
  image?: string[];
}

interface QueueSendOptions extends JsonOptions {
  mode?: "auto" | "steer";
}

interface QueueReorderOptions extends JsonOptions {
  after?: string;
  before?: string;
  groupBoundary?: string;
}

interface QueueGroupOptions extends JsonOptions {
  prefix: string;
}

interface ReorderPinnedOptions extends JsonOptions {
  after?: string;
  before?: string;
}

const THREAD_SEARCH_LIMIT_PER_GROUP_MAX = 50;

function parsePositiveInteger(
  value: string | undefined,
  flag: string,
  maximum?: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/u.test(value) || Number(value) < 1) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  if (maximum !== undefined && Number(value) > maximum) {
    throw new Error(`${flag} must be at most ${maximum}.`);
  }
  return value;
}

function printHumanJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

const MAX_QUEUE_TEXT_WIDTH = 40;

/**
 * The queue as a table rather than raw JSON.
 *
 * `Waiting on` and `Send at` are the two columns that make a queued row
 * legible: without them a queued message and one blocked behind a rate-limit
 * window look identical, which is exactly the confusion the typed waits exist
 * to remove.
 */
function printQueueTable(rows: ThreadQueuedMessagesResult): void {
  const now = Date.now();
  const table = rows.map((row) => [
    row.id,
    row.threadId,
    truncateQueueCell(queuedMessagePreview(row.content)),
    truncateQueueCell(describeQueueWait(row)),
    formatQueueSendCountdown(row.sendAt, now),
  ]);
  console.log("");
  console.log(
    renderBorderlessTable(
      {
        head: ["ID", "Thread", "Message", "Waiting on", "Send at"],
        colWidths: [
          queueColumnWidth(table, 0, 2),
          queueColumnWidth(table, 1, 6),
          queueColumnWidth(table, 2, 7),
          queueColumnWidth(table, 3, 10),
          queueColumnWidth(table, 4, 7),
        ],
      },
      table,
    ),
  );
  console.log("");
}

function queuedMessagePreview(content: PromptInput[]): string {
  const text = content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join(" ");
  return text.trim() === "" ? "(no text)" : text;
}

function queueColumnWidth(
  rows: string[][],
  index: number,
  headWidth: number,
): number {
  return Math.max(headWidth, ...rows.map((row) => row[index]!.length));
}

function truncateQueueCell(value: string): string {
  const singleLine = value.replace(/\s+/gu, " ");
  if (singleLine.length <= MAX_QUEUE_TEXT_WIDTH) return singleLine;
  return `${singleLine.slice(0, MAX_QUEUE_TEXT_WIDTH - 1)}…`;
}

/**
 * Wait holders are a prefixed set, so a typo fails here with the shape spelled
 * out rather than as an opaque 400 from the list route.
 */
function parseWaitHolder(value: string): QueuedMessageWaitHolder {
  const parsed = queuedMessageWaitHolderSchema.safeParse(value.trim());
  if (parsed.success) return parsed.data;
  throw new Error(
    `Invalid --wait-holder value '${value}'. Expected 'plugin:<plugin-id>'.`,
  );
}

export function registerOrganizationCommands(
  parent: Command,
  getUrl: () => string,
): void {
  const section = parent
    .command("section")
    .description("Manage thread sections");

  section
    .command("list")
    .description("List thread sections")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: JsonOptions) => {
        const sections = await createCliBbSdk(getUrl()).threadSections.list();
        if (outputJson(opts, sections)) return;
        if (sections.length === 0) {
          console.log("No thread sections found");
          return;
        }
        for (const item of sections) console.log(`${item.id}\t${item.name}`);
      }),
    );

  section
    .command("create <name>")
    .description("Create a thread section")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (name: string, opts: JsonOptions) => {
        const result = await createCliBbSdk(getUrl()).threadSections.create({
          name,
        });
        if (outputJson(opts, result)) return;
        console.log(`Thread section ${result.id} created: ${result.name}`);
      }),
    );

  section
    .command("rename <id> <name>")
    .description("Rename a thread section")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (id: string, name: string, opts: JsonOptions) => {
        const result = await createCliBbSdk(getUrl()).threadSections.update({
          id,
          name,
        });
        if (outputJson(opts, result)) return;
        console.log(`Thread section ${result.id} renamed: ${result.name}`);
      }),
    );

  section
    .command("delete <id>")
    .description("Delete a thread section and remove its thread assignments")
    .option("--yes", "Skip the confirmation prompt")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (id: string, opts: SectionDeleteOptions) => {
        if (
          !opts.yes &&
          !(await confirmDestructiveAction(`Delete thread section ${id}?`))
        )
          return;
        const result = await createCliBbSdk(getUrl()).threadSections.delete({
          id,
        });
        if (outputJson(opts, result)) return;
        console.log(
          `Thread section ${result.id} deleted; ${result.updatedThreadCount} thread(s) unsectioned`,
        );
      }),
    );

  parent
    .command("search <query>")
    .description("Search threads and messages")
    .option(
      "--limit <count>",
      `Maximum results per group (1-${THREAD_SEARCH_LIMIT_PER_GROUP_MAX})`,
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (query: string, opts: SearchOptions) => {
        const result = await createCliBbSdk(getUrl()).threads.search({
          query,
          limitPerGroup: parsePositiveInteger(
            opts.limit,
            "--limit",
            THREAD_SEARCH_LIMIT_PER_GROUP_MAX,
          ),
        });
        if (outputJson(opts, result)) return;
        printHumanJson(result);
      }),
    );

  parent
    .command("history <id>")
    .description("List a thread's prompt history")
    .option("--limit <count>", "Maximum history entries")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (id: string, opts: HistoryOptions) => {
        const result = await createCliBbSdk(getUrl()).threads.promptHistory({
          threadId: id,
          limit: parsePositiveInteger(opts.limit, "--limit"),
        });
        if (outputJson(opts, result)) return;
        printHumanJson(result);
      }),
    );

  for (const [name, markRead] of [
    ["read", true],
    ["unread", false],
  ] as const) {
    parent
      .command(`${name} [id]`)
      .description(`Mark a thread ${name}`)
      .option("--self", "Target the current thread (from BB_THREAD_ID)")
      .option("--json", "Print machine-readable JSON output")
      .action(
        action(async (id: string | undefined, opts: SelfOptions) => {
          const threadId = requireThreadIdOrSelf(id, opts);
          const sdk = createCliBbSdk(getUrl());
          const result = markRead
            ? await sdk.threads.markRead({ threadId })
            : await sdk.threads.markUnread({ threadId });
          if (outputJson(opts, result)) return;
          console.log(`Thread ${threadId} marked ${name}`);
        }),
      );
  }

  parent
    .command("reorder-pinned <id>")
    .description("Move a pinned thread between adjacent pinned threads")
    .option("--after <id>", "Previous pinned thread, or omit for the start")
    .option("--before <id>", "Next pinned thread, or omit for the end")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (id: string, opts: ReorderPinnedOptions) => {
        const result = await createCliBbSdk(getUrl()).threads.reorderPinned({
          threadId: id,
          previousThreadId: opts.after ?? null,
          nextThreadId: opts.before ?? null,
        });
        if (outputJson(opts, result)) return;
        console.log(`Pinned thread ${id} reordered`);
      }),
    );

  const queue = parent
    .command("queue")
    .description("Manage queued thread messages");
  queue
    .command("list [threadId]")
    .description(
      "List queued messages; omit the thread to list every one",
    )
    .option(
      "--wait-holder <holder>",
      "Filter to rows one plugin is holding: plugin:<plugin-id>",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (threadId: string | undefined, opts: QueueListOptions) => {
          const sdk = createCliBbSdk(getUrl());
          // A thread argument keeps the thread-scoped route, which is the one
          // that returns queue ORDER; the cross-thread route answers "what is
          // queued anywhere" and is ordered by age instead.
          const result =
            threadId === undefined
              ? await sdk.threads.queue.list({
                  ...(opts.waitHolder
                    ? { waitHolder: parseWaitHolder(opts.waitHolder) }
                    : {}),
                })
              : await sdk.threads.queuedMessages.list({ threadId });
          if (outputJson(opts, result)) return;
          if (result.length === 0) {
            console.log("No queued messages found");
            return;
          }
          printQueueTable(result);
        },
      ),
    );
  queue
    .command("create <threadId> <message>")
    .description("Create a queued text message")
    .option("--model <model>", "Model override for the queued message")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (threadId: string, message: string, opts: QueueCreateOptions) => {
          const result = await createCliBbSdk(
            getUrl(),
          ).threads.queuedMessages.create({
            threadId,
            input: [{ type: "text", text: message, mentions: [] }],
            ...(opts.model ? { model: opts.model } : {}),
          });
          if (outputJson(opts, result)) return;
          console.log(
            `Queued message ${result.id} created for thread ${threadId}`,
          );
        },
      ),
    );
  queue
    .command("update <threadId> <messageId> <message>")
    .description("Update a queued message in place")
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
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (
          threadId: string,
          messageId: string,
          message: string,
          opts: QueueUpdateOptions,
        ) => {
          const queuedMessages =
            createCliBbSdk(getUrl()).threads.queuedMessages;
          const existing = (await queuedMessages.list({ threadId })).find(
            (queuedMessage) => queuedMessage.id === messageId,
          );
          if (!existing) {
            throw new Error(
              `Queued message ${messageId} not found on thread ${threadId}.`,
            );
          }
          const result = await queuedMessages.update({
            threadId,
            queuedMessageId: messageId,
            expectedUpdatedAt: existing.updatedAt,
            input: buildPromptInputs({
              message,
              files: opts.file,
              images: opts.image,
            }),
          });
          if (outputJson(opts, result)) return;
          console.log(`Queued message ${messageId} updated`);
        },
      ),
    );
  queue
    .command("send <threadId> <messageId>")
    .description("Send and remove a queued message")
    .option("--mode <mode>", "Delivery mode: auto or steer", "auto")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (threadId: string, messageId: string, opts: QueueSendOptions) => {
          if (opts.mode !== "auto" && opts.mode !== "steer")
            throw new Error("--mode must be auto or steer.");
          const result = await createCliBbSdk(
            getUrl(),
          ).threads.queuedMessages.send({
            threadId,
            queuedMessageId: messageId,
            mode: opts.mode,
          });
          if (outputJson(opts, result)) return;
          if (result.delivery === "queued") {
            console.log(
              `Queued message ${messageId} is still queued (${describeQueueWait(result.queuedMessage)})`,
            );
            return;
          }
          console.log(`Queued message ${messageId} sent`);
        },
      ),
    );
  queue
    .command("delete <threadId> <messageId>")
    .description("Delete a queued message")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (threadId: string, messageId: string, opts: JsonOptions) => {
        const result = await createCliBbSdk(
          getUrl(),
        ).threads.queuedMessages.delete({
          threadId,
          queuedMessageId: messageId,
        });
        if (outputJson(opts, result)) return;
        console.log(`Queued message ${messageId} deleted`);
      }),
    );
  queue
    .command("reorder <threadId> <messageId>")
    .description("Move a queued message between adjacent messages")
    .option("--after <id>", "Previous queued message, or omit for the start")
    .option("--before <id>", "Next queued message, or omit for the end")
    .option("--group-boundary <id>", "Current group-boundary message id")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (
          threadId: string,
          messageId: string,
          opts: QueueReorderOptions,
        ) => {
          const result = await createCliBbSdk(
            getUrl(),
          ).threads.queuedMessages.reorder({
            threadId,
            queuedMessageId: messageId,
            previousQueuedMessageId: opts.after ?? null,
            nextQueuedMessageId: opts.before ?? null,
            ...(opts.groupBoundary
              ? { groupBoundaryQueuedMessageId: opts.groupBoundary }
              : {}),
          });
          if (outputJson(opts, result)) return;
          console.log(`Queued message ${messageId} reordered`);
        },
      ),
    );
  queue
    .command("group <threadId> <boundaryMessageId>")
    .description("Set the grouped queued-message prefix")
    .requiredOption(
      "--prefix <ids>",
      "Comma-separated expected grouped-prefix ids",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (
          threadId: string,
          boundaryMessageId: string,
          opts: QueueGroupOptions,
        ) => {
          const prefix = opts.prefix
            .split(",")
            .map((id) => id.trim())
            .filter(Boolean);
          if (prefix.length === 0)
            throw new Error("--prefix must contain at least one message id.");
          const result = await createCliBbSdk(
            getUrl(),
          ).threads.queuedMessages.setGroupBoundary({
            threadId,
            groupBoundaryQueuedMessageId: boundaryMessageId,
            expectedGroupedPrefixQueuedMessageIds: prefix,
          });
          if (outputJson(opts, result)) return;
          console.log(
            `Queued message group boundary set to ${boundaryMessageId}`,
          );
        },
      ),
    );

  const tabs = parent
    .command("tabs")
    .description("Inspect and update persisted thread panel tabs");
  tabs
    .command("show <threadId>")
    .description("Show persisted panel tabs")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (threadId: string, opts: JsonOptions) => {
        const result = await createCliBbSdk(getUrl()).threads.tabs.get({
          threadId,
        });
        if (outputJson(opts, result)) return;
        printHumanJson(result);
      }),
    );
  tabs
    .command("set <threadId>")
    .description("Replace persisted panel tabs with revision checking")
    .requiredOption("--expected-revision <number>", "Current tab revision")
    .requiredOption("--tabs-json <json>", "JSON array of tab descriptors")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (
          threadId: string,
          opts: JsonOptions & {
            expectedRevision: string;
            tabsJson: string;
          },
        ) => {
          const request = updateThreadTabsRequestSchema.parse({
            expectedRevision: Number(opts.expectedRevision),
            tabs: JSON.parse(opts.tabsJson),
          });
          const result = await createCliBbSdk(getUrl()).threads.tabs.update({
            threadId,
            ...request,
          });
          if (outputJson(opts, result)) return;
          console.log(
            `Thread ${threadId} tabs updated to revision ${result.revision}`,
          );
        },
      ),
    );
}
