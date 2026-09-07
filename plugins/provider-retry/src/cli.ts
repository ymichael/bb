import type { BbPluginApi, PluginCliContext } from "@get-bb/plugin-sdk";
import {
  findQueuedRetry,
  listQueuedRetries,
  type QueuedRetry,
} from "./queued-retries.js";

function requestedThreadId(
  argv: string[],
  context: PluginCliContext,
): string | null {
  return (
    argv.find((value) => !value.startsWith("--")) ?? context.threadId ?? null
  );
}

function textQueuedRetry(queued: QueuedRetry): string {
  const retry =
    queued.sendAt === null
      ? "pending"
      : `retrying ${new Date(queued.sendAt).toISOString()}`;
  return `${queued.threadId}\t${queued.id}\t${retry}`;
}

/**
 * A view over the queued retries this plugin asked for.
 *
 * Every subcommand reads the queue itself — rows whose payload is `retry`,
 * because a scheduled retry waits on the clock, not on a wait this plugin
 * holds — which is why there is no state here to consult: the server owns the
 * schedule, and this reads and acts on it. `retry` is a Send-now and `cancel`
 * is a cancel, so both do exactly what the queued card's buttons do.
 */
export function registerProviderRetryCli(bb: BbPluginApi): void {
  bb.cli.register({
    name: "provider-retry",
    summary: "Manage pending automatic provider retries",
    commands: [
      {
        name: "status",
        summary: "Show pending automatic provider retries",
        usage: "bb provider-retry status [thread-id] [--json]",
      },
      {
        name: "cancel",
        summary: "Cancel a pending automatic provider retry",
        usage: "bb provider-retry cancel <thread-id> [--json]",
      },
      {
        name: "retry",
        summary: "Send a pending provider retry now instead of waiting",
        usage: "bb provider-retry retry <thread-id> [--json]",
      },
    ],
    async run(argv, context) {
      const [command, ...args] = argv;
      if (command !== "status" && command !== "cancel" && command !== "retry") {
        return {
          exitCode: 2,
          stderr:
            "Usage: bb provider-retry <status|cancel|retry> [thread-id] [--json]\n",
        };
      }
      const json = args.includes("--json");
      const threadId = requestedThreadId(args, context);

      if (command === "status") {
        const queued = await listQueuedRetries(
          bb,
          threadId === null ? undefined : threadId,
        );
        if (json) {
          return {
            exitCode: 0,
            stdout: `${JSON.stringify({ retries: queued }, null, 2)}\n`,
          };
        }
        return {
          exitCode: 0,
          stdout:
            queued.length === 0
              ? "No provider retries are pending.\n"
              : `${queued.map(textQueuedRetry).join("\n")}\n`,
        };
      }

      if (threadId === null) {
        return {
          exitCode: 2,
          stderr: `A thread id is required: bb provider-retry ${command} <thread-id>\n`,
        };
      }
      const queued = await findQueuedRetry(bb, threadId);
      if (queued === null) {
        return json
          ? {
              exitCode: 1,
              stdout: `${JSON.stringify({ ok: false, threadId }, null, 2)}\n`,
            }
          : {
              exitCode: 1,
              stderr: `No pending provider retry exists for ${threadId}.\n`,
            };
      }
      if (command === "cancel") {
        await bb.sdk.threads.queuedMessages.delete({
          threadId: queued.threadId,
          queuedMessageId: queued.id,
        });
      } else {
        // Send now: bypasses this plugin's own wait and the row's schedule,
        // which is exactly what "retry it now" means.
        await bb.sdk.threads.queuedMessages.send({
          threadId: queued.threadId,
          queuedMessageId: queued.id,
          mode: "auto",
        });
      }
      if (json) {
        return {
          exitCode: 0,
          stdout: `${JSON.stringify({ ok: true, threadId, queuedMessageId: queued.id }, null, 2)}\n`,
        };
      }
      return {
        exitCode: 0,
        stdout:
          command === "cancel"
            ? `Cancelled provider retry for ${threadId}.\n`
            : `Retrying ${threadId} now.\n`,
      };
    },
  });
}
