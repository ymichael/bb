import { Command } from "commander";
import {
  parseThreadEventRow,
  type Thread,
  type ThreadStatus,
  threadStatusSchema,
  threadStatusValues,
} from "@bb/domain";
import { assertNever } from "@bb/core-ui";
import type { ThreadEventWaitQuery } from "@bb/server-contract";
import { action, CliExitError } from "../../action.js";
import { createClient, unwrap } from "../../client.js";
import {
  outputJson,
  printContextLabel,
  requireThreadIdWithLabel,
} from "../helpers.js";
import {
  DEFAULT_THREAD_WAIT_POLL_INTERVAL_MS,
  DEFAULT_THREAD_WAIT_TIMEOUT_SECONDS,
  parseThreadWaitPollIntervalMs,
  parseThreadWaitTimeoutSeconds,
  THREAD_WAIT_EXIT_CODE_INVALID_REQUEST,
  THREAD_WAIT_EXIT_CODE_TIMEOUT,
  THREAD_WAIT_EXIT_CODE_UNREACHABLE,
  type ThreadWaitTarget,
} from "./helpers.js";

interface ThreadWaitCommandOptions {
  status?: string;
  event?: string;
  timeout?: string;
  pollInterval?: string;
  json?: boolean;
}

export function registerWaitCommand(
  parent: Command,
  getUrl: () => string,
): void {
  parent
    .command("wait [id]")
    .description("Wait for a thread status or event (defaults to BB_THREAD_ID)")
    .option("--status <status>", "Wait until the thread reaches this status")
    .option(
      "--event <type>",
      "Wait until the thread log includes this event type",
    )
    .option(
      "--timeout <seconds>",
      `Timeout in seconds (default: ${DEFAULT_THREAD_WAIT_TIMEOUT_SECONDS})`,
    )
    .option(
      "--poll-interval <ms>",
      `Polling interval in milliseconds (default: ${DEFAULT_THREAD_WAIT_POLL_INTERVAL_MS})`,
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (id: string | undefined, opts: ThreadWaitCommandOptions) => {
        const client = createClient(getUrl());
        const resolved = requireThreadIdWithLabel(id);
        const threadId = resolved.id;
        printContextLabel(resolved, "Thread", "BB_THREAD_ID", opts);
        const target = parseThreadWaitTarget(opts);
        const timeoutSeconds = parseThreadWaitTimeoutSeconds(opts.timeout);
        const pollIntervalMs = parseThreadWaitPollIntervalMs(opts.pollInterval);
        const deadline = Date.now() + timeoutSeconds * 1000;

        while (true) {
          if (target.kind === "status") {
            const thread = await unwrap<Thread>(
              client.api.v1.threads[":id"].$get({ param: { id: threadId } }),
            );
            if (thread.status === target.status) {
              if (outputJson(opts, { threadId, matched: true, target })) return;
              console.log(
                `Thread ${threadId} reached status ${target.status}.`,
              );
              return;
            }
            const unreachableReason = getThreadWaitUnreachableReason(
              threadId,
              thread.status,
              target.status,
            );
            if (unreachableReason) {
              throw new CliExitError(
                unreachableReason,
                THREAD_WAIT_EXIT_CODE_UNREACHABLE,
              );
            }

            if (Date.now() >= deadline) {
              throw new CliExitError(
                `Timed out waiting for thread ${threadId} to reach status ${target.status}.`,
                THREAD_WAIT_EXIT_CODE_TIMEOUT,
              );
            }

            await sleep(pollIntervalMs);
          } else {
            const remainingMs = Math.max(0, deadline - Date.now());
            const waitMs = Math.floor(Math.min(remainingMs, 30_000));

            const waitQuery: ThreadEventWaitQuery = {
              type: target.eventType,
              waitMs: String(waitMs),
            };

            const response = await client.api.v1.threads[
              ":id"
            ].events.wait.$get({
              param: { id: threadId },
              query: waitQuery,
            });

            // Server returns 204 (no content) on timeout — the typed contract
            // only declares the 200 shape, so widen the status to number.
            const statusCode: number = response.status;
            if (statusCode === 204) {
              if (Date.now() >= deadline) {
                throw new CliExitError(
                  `Timed out waiting for thread ${threadId} event ${target.eventType}.`,
                  THREAD_WAIT_EXIT_CODE_TIMEOUT,
                );
              }
              await sleep(pollIntervalMs);
              continue;
            } else if (!response.ok) {
              const body = await response.text();
              throw new Error(
                `Wait request failed with ${statusCode}: ${body}`,
              );
            }

            const matched = parseThreadEventRow(await response.json());
            if (outputJson(opts, { threadId, matched: true, target })) return;
            console.log(
              `Thread ${threadId} observed event ${target.eventType} at seq ${matched.seq}.`,
            );
            return;
          }
        }
      }),
    );
}

function parseThreadWaitTarget(
  opts: ThreadWaitCommandOptions,
): ThreadWaitTarget {
  const hasStatus = Boolean(opts.status);
  const hasEvent = Boolean(opts.event);
  if (hasStatus === hasEvent) {
    throw new CliExitError(
      "Provide exactly one of --status or --event.",
      THREAD_WAIT_EXIT_CODE_INVALID_REQUEST,
    );
  }

  if (opts.status) {
    const parsed = threadStatusSchema.safeParse(opts.status);
    if (!parsed.success) {
      throw new CliExitError(
        `Invalid thread status '${opts.status}'. Expected one of ${threadStatusValues.join(", ")}.`,
        THREAD_WAIT_EXIT_CODE_INVALID_REQUEST,
      );
    }
    return { kind: "status", status: parsed.data };
  }

  return {
    kind: "event",
    eventType: opts.event ?? "",
  };
}

function getThreadWaitUnreachableReason(
  threadId: string,
  currentStatus: ThreadStatus,
  targetStatus: ThreadStatus,
): string | undefined {
  if (currentStatus === targetStatus || targetStatus !== "idle") {
    return undefined;
  }

  switch (currentStatus) {
    case "error":
      return (
        `Thread ${threadId} is in status error and will not reach idle by waiting alone. ` +
        `Inspect it with 'bb thread show ${threadId}' and recover by sending a follow-up.`
      );
    case "created":
    case "provisioning":
    case "idle":
    case "active":
      return undefined;
    default:
      return assertNever(currentStatus);
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
