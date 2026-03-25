import { Command } from "commander";
import {
  type Thread,
  type ThreadEventRow,
  type ThreadStatus,
  threadStatusSchema,
  threadStatusValues,
} from "@bb/domain";
import { assertNever } from "../../assert-never.js";
import { createClient, unwrap } from "../../client.js";
import {
  getErrorMessage,
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

class ThreadWaitInvalidRequestError extends Error {}
class ThreadWaitTimeoutError extends Error {}
class ThreadWaitUnreachableError extends Error {}

export function registerWaitCommand(
  parent: Command,
  getUrl: () => string,
): void {
  parent
    .command("wait [id]")
    .description("Wait for a thread status or event (defaults to BB_THREAD_ID)")
    .option("--status <status>", "Wait until the thread reaches this status")
    .option("--event <type>", "Wait until the thread log includes this event type")
    .option(
      "--timeout <seconds>",
      `Timeout in seconds (default: ${DEFAULT_THREAD_WAIT_TIMEOUT_SECONDS})`,
    )
    .option(
      "--poll-interval <ms>",
      `Polling interval in milliseconds (default: ${DEFAULT_THREAD_WAIT_POLL_INTERVAL_MS})`,
    )
    .option("--json", "Print machine-readable JSON output")
    .action(async (id: string | undefined, opts: ThreadWaitCommandOptions) => {
      const client = createClient(getUrl());
      try {
        const resolved = requireThreadIdWithLabel(id);
        const threadId = resolved.id;
        printContextLabel(resolved, "Thread", "BB_THREAD_ID", opts);
        const target = parseThreadWaitTarget(opts);
        const timeoutSeconds = parseThreadWaitTimeoutSeconds(opts.timeout);
        const pollIntervalMs = parseThreadWaitPollIntervalMs(opts.pollInterval);
        const deadline = Date.now() + timeoutSeconds * 1000;

        let afterSeq: number | undefined;
        while (true) {
          if (target.kind === "status") {
            const thread = await unwrap<Thread>(
              client.api.v1.threads[":id"].$get({ param: { id: threadId } }),
            );
            if (thread.status === target.status) {
              if (outputJson(opts, { threadId, matched: true, target })) return;
              console.log(`Thread ${threadId} reached status ${target.status}.`);
              return;
            }
            const unreachableReason = getThreadWaitUnreachableReason(
              threadId,
              thread.status,
              target.status,
            );
            if (unreachableReason) {
              throw new ThreadWaitUnreachableError(unreachableReason);
            }
          } else {
            const events = await unwrap<ThreadEventRow[]>(
              client.api.v1.threads[":id"].events.$get({
                param: { id: threadId },
                query: afterSeq !== undefined ? { afterSeq: String(afterSeq) } : {},
              }),
            );
            if (events.length > 0) {
              afterSeq = events[events.length - 1].seq;
            }
            const matched = events.find(
              (event) => event.type === target.eventType,
            );
            if (matched) {
              if (outputJson(opts, { threadId, matched: true, target })) return;
              console.log(
                `Thread ${threadId} observed event ${target.eventType} at seq ${matched.seq}.`,
              );
              return;
            }
          }

          if (Date.now() >= deadline) {
            throw new ThreadWaitTimeoutError(
              target.kind === "status"
                ? `Timed out waiting for thread ${threadId} to reach status ${target.status}.`
                : `Timed out waiting for thread ${threadId} event ${target.eventType}.`,
            );
          }

          await sleep(pollIntervalMs);
        }
      } catch (err: unknown) {
        if (err instanceof ThreadWaitTimeoutError) {
          console.error(`Error: ${err.message}`);
          process.exit(THREAD_WAIT_EXIT_CODE_TIMEOUT);
          return;
        }
        if (err instanceof ThreadWaitUnreachableError) {
          console.error(`Error: ${err.message}`);
          process.exit(THREAD_WAIT_EXIT_CODE_UNREACHABLE);
          return;
        }
        if (err instanceof ThreadWaitInvalidRequestError) {
          console.error(`Error: ${err.message}`);
          process.exit(THREAD_WAIT_EXIT_CODE_INVALID_REQUEST);
          return;
        }
        console.error(`Error: ${getErrorMessage(err)}`);
        process.exit(1);
      }
    });
}

function parseThreadWaitTarget(opts: ThreadWaitCommandOptions): ThreadWaitTarget {
  const hasStatus = Boolean(opts.status);
  const hasEvent = Boolean(opts.event);
  if (hasStatus === hasEvent) {
    throw new ThreadWaitInvalidRequestError(
      "Provide exactly one of --status or --event.",
    );
  }

  if (opts.status) {
    const parsed = threadStatusSchema.safeParse(opts.status);
    if (!parsed.success) {
      throw new ThreadWaitInvalidRequestError(
        `Invalid thread status '${opts.status}'. Expected one of ${threadStatusValues.join(", ")}.`,
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
