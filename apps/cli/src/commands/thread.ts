import { Command } from "commander";
import {
  assertNever,
  type Thread,
  type ThreadEvent,
  type ThreadOperationResponse,
  type ThreadStatus,
} from "@beanbag/agent-core";
import { createClient, unwrap } from "../client.js";
import {
  requireProjectId,
  requireThreadId,
  resolveProjectId,
  resolveThreadId,
} from "../context-env.js";

type ThreadStatusEventMode = "summary" | "raw";

function normalizeThreadEventType(type: string): string {
  return type.toLowerCase().replaceAll(".", "/");
}

function isLowSignalThreadStatusEventType(type: string): boolean {
  const normalized = normalizeThreadEventType(type);
  if (normalized.startsWith("client/")) return true;
  if (
    normalized === "turn/start" ||
    normalized === "turn/started" ||
    normalized === "turn/end" ||
    normalized === "turn/completed"
  ) {
    return true;
  }
  if (normalized === "item/started") return true;
  if (normalized.endsWith("/delta")) return true;
  if (normalized === "thread/tokenusage/updated") return true;
  return false;
}

function parseRecentEventsCount(rawCount: string): number {
  const parsed = Number.parseInt(rawCount, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("Recent events count must be a positive integer.");
  }
  return parsed;
}

function parseThreadStatusEventMode(
  rawMode: string | undefined,
): ThreadStatusEventMode {
  const normalized = (rawMode ?? "summary").trim().toLowerCase();
  if (normalized === "summary" || normalized === "raw") {
    return normalized;
  }
  throw new Error(`Invalid event mode '${rawMode}'. Expected 'summary' or 'raw'.`);
}

function printThreadOperationResult(result: ThreadOperationResponse): void {
  const flags = [
    result.queued ? "queued" : "dispatched",
    ...(result.demotedPrimaryCheckout ? ["demoted-primary-checkout"] : []),
  ];
  if (flags.length === 0) {
    console.log(result.message);
    return;
  }
  console.log(`${result.message} [${flags.join(", ")}]`);
}

export function registerThreadCommands(program: Command, getUrl: () => string): void {
  const thread = program.command("thread").description("Manage threads");
  thread.addHelpText(
    "after",
    [
      "",
      "Migration note:",
      "  Legacy direct git routes (/threads/:id/commit and /threads/:id/squash-merge)",
      "  are deprecated. Use `thread commit` and `thread squash-merge`.",
      "",
    ].join("\n"),
  );
  const postThreadMessage = async (
    threadId: string,
    message: string,
    mode?: "steer",
  ): Promise<void> => {
    const client = createClient(getUrl());
    await unwrap<{ ok: boolean }>(
      client.api.v1.threads[":id"].tell.$post({
        param: { id: threadId },
        json: {
          input: [{ type: "text", text: message }],
          ...(mode ? { mode } : {}),
        },
      }),
    );
  };

  thread
    .command("spawn")
    .description("Spawn a new thread for a project")
    .option("--prompt <prompt>", "Initial prompt for the thread")
    .option("--project <id>", "Project ID (defaults to BB_PROJECT_ID)")
    .option(
      "--parent-thread <id>",
      "Parent thread ID for worker thread links (defaults to BB_THREAD_ID)",
    )
    .option(
      "--no-context-parent-thread",
      "Do not default parent thread context to BB_THREAD_ID",
    )
    .action(async (opts: {
      prompt?: string;
      project?: string;
      parentThread?: string;
      contextParentThread?: boolean;
    }) => {
      const client = createClient(getUrl());
      try {
        if (opts.parentThread && opts.contextParentThread === false) {
          throw new Error(
            "Cannot combine --parent-thread with --no-context-parent-thread.",
          );
        }

        const projectId = requireProjectId(opts.project);
        const parentThreadId =
          opts.parentThread ??
          (opts.contextParentThread === false
            ? undefined
            : resolveThreadId());
        const thread = await unwrap<Thread>(
          client.api.v1.threads.$post({
            json: {
              projectId,
              input: opts.prompt
                ? [{ type: "text", text: opts.prompt }]
                : undefined,
              ...(parentThreadId ? { parentThreadId } : {}),
            },
          }),
        );
        console.log(`Thread spawned: ${thread.id}`);
        if (
          thread.parentThreadId &&
          thread.parentThreadId === resolveThreadId()
        ) {
          console.log("You will be notified when this thread is done.");
        }
        printThread(thread);
      } catch (err: unknown) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  thread
    .command("list")
    .description("List threads")
    .option("--project <id>", "Filter by project ID (defaults to BB_PROJECT_ID)")
    .action(async (opts: { project?: string }) => {
      const client = createClient(getUrl());
      try {
        const projectId = resolveProjectId(opts.project);
        const threads = await unwrap<Thread[]>(
          client.api.v1.threads.$get({
            query: { projectId },
          }),
        );
        if (threads.length === 0) {
          console.log("No threads found");
          return;
        }
        printThreadTable(threads);
      } catch (err: unknown) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  thread
    .command("status [id]")
    .description("Show thread status (defaults to BB_THREAD_ID)")
    .option("--recent-events <count>", "Include last N thread events")
    .option(
      "--event-mode <mode>",
      "summary|raw event formatting for --recent-events",
      "summary",
    )
    .option(
      "--include-low-signal",
      "Include low-signal internal lifecycle events in recent events",
    )
    .action(
      async (
        id: string | undefined,
        opts: {
          recentEvents?: string;
          eventMode?: string;
          includeLowSignal?: boolean;
        },
      ) => {
        const client = createClient(getUrl());
        try {
          const threadId = requireThreadId(id);
          const recentEvents =
            opts.recentEvents === undefined
              ? undefined
              : parseRecentEventsCount(opts.recentEvents);
          const eventMode = parseThreadStatusEventMode(opts.eventMode);
          const thread = await unwrap<Thread>(
            client.api.v1.threads[":id"].$get({ param: { id: threadId } }),
          );
          const events =
            recentEvents === undefined
              ? []
              : await unwrap<ThreadEvent[]>(
                  client.api.v1.threads[":id"].events.$get({
                    param: { id: threadId },
                    query: {},
                  }),
                );
          printThreadStatus(thread, events, {
            recentEvents,
            eventMode,
            includeLowSignal: Boolean(opts.includeLowSignal),
          });
        } catch (err: unknown) {
          console.error(`Error: ${(err as Error).message}`);
          process.exit(1);
        }
      },
    );

  thread
    .command("show [id]")
    .description("Show thread details (defaults to BB_THREAD_ID)")
    .action(async (id: string | undefined) => {
      const client = createClient(getUrl());
      try {
        const threadId = requireThreadId(id);
        const thread = await unwrap<Thread>(
          client.api.v1.threads[":id"].$get({ param: { id: threadId } }),
        );
        printThread(thread);
      } catch (err: unknown) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  thread
    .command("tell <id> <message>")
    .description("Send a follow-up message to a thread")
    .action(async (id: string, message: string) => {
      try {
        await postThreadMessage(id, message);
        console.log(`Thread ${id} updated`);
      } catch (err: unknown) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  thread
    .command("steer <id> <message>")
    .description("Steer a thread with an additional message")
    .action(async (id: string, message: string) => {
      try {
        await postThreadMessage(id, message, "steer");
        console.log(`Thread ${id} steered`);
      } catch (err: unknown) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  thread
    .command("commit <id>")
    .description("Request an agent-driven commit operation for a thread")
    .option("--message <message>", "Commit message hint")
    .option("--staged-only", "Commit only currently staged changes")
    .action(async (
      id: string,
      opts: {
        message?: string;
        stagedOnly?: boolean;
      },
    ) => {
      const client = createClient(getUrl());
      try {
        const result = await unwrap<ThreadOperationResponse>(
          client.api.v1.threads[":id"].operations.$post({
            param: { id },
            json: {
              operation: "commit",
              options: {
                includeUnstaged: opts.stagedOnly ? false : true,
                ...(opts.message ? { message: opts.message } : {}),
              },
            },
          }),
        );
        printThreadOperationResult(result);
      } catch (err: unknown) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  thread
    .command("squash-merge <id>")
    .description("Request an agent-driven squash-merge operation for a thread")
    .option("--commit-if-needed", "Allow a prep commit before squash merge")
    .option("--staged-only", "Use only staged changes for the prep commit")
    .option("--commit-message <message>", "Prep commit message hint")
    .option("--squash-message <message>", "Squash commit message hint")
    .option("--merge-base-branch <branch>", "Merge-base branch hint")
    .action(async (
      id: string,
      opts: {
        commitIfNeeded?: boolean;
        stagedOnly?: boolean;
        commitMessage?: string;
        squashMessage?: string;
        mergeBaseBranch?: string;
      },
    ) => {
      const client = createClient(getUrl());
      try {
        const result = await unwrap<ThreadOperationResponse>(
          client.api.v1.threads[":id"].operations.$post({
            param: { id },
            json: {
              operation: "squash_merge",
              options: {
                commitIfNeeded: opts.commitIfNeeded === true,
                includeUnstaged: opts.stagedOnly ? false : true,
                ...(opts.commitMessage ? { commitMessage: opts.commitMessage } : {}),
                ...(opts.squashMessage ? { squashMessage: opts.squashMessage } : {}),
                ...(opts.mergeBaseBranch ? { mergeBaseBranch: opts.mergeBaseBranch } : {}),
              },
            },
          }),
        );
        printThreadOperationResult(result);
      } catch (err: unknown) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  thread
    .command("stop <id>")
    .description("Stop an active thread")
    .action(async (id: string) => {
      const client = createClient(getUrl());
      try {
        await unwrap<{ ok: boolean }>(
          client.api.v1.threads[":id"].stop.$post({ param: { id } }),
        );
        console.log(`Thread ${id} stopped`);
      } catch (err: unknown) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  thread
    .command("promote <id>")
    .description("Promote a worktree thread into the primary checkout")
    .action(async (id: string) => {
      const client = createClient(getUrl());
      try {
        const result = await unwrap<{ ok: true; promoted: boolean; message: string }>(
          client.api.v1.threads[":id"].promote.$post({
            param: { id },
          }),
        );
        console.log(result.message);
      } catch (err: unknown) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  thread
    .command("demote [id]")
    .description("Demote the currently promoted thread from the primary checkout")
    .option("--project <id>", "Project ID (defaults to BB_PROJECT_ID when id is omitted)")
    .action(async (id: string | undefined, opts: { project?: string }) => {
      const client = createClient(getUrl());
      try {
        const threadId = (() => {
          if (id) return id;
          const fallbackFromContext = resolveThreadId();
          if (fallbackFromContext) return fallbackFromContext;
          const projectId = requireProjectId(opts.project);
          return unwrap<Thread[]>(
            client.api.v1.threads.$get({
              query: { projectId },
            }),
          ).then((threads) => {
            const active = threads.find((thread) => thread.primaryCheckout?.isActive);
            if (!active) {
              throw new Error("Primary checkout is already demoted.");
            }
            return active.id;
          });
        })();
        const resolvedThreadId = typeof threadId === "string"
          ? threadId
          : await threadId;
        const result = await unwrap<{ ok: true; demoted: boolean; message: string }>(
          client.api.v1.threads[":id"]["demote-primary"].$post({
            param: { id: resolvedThreadId },
          }),
        );
        console.log(result.message);
      } catch (err: unknown) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  thread
    .command("promote-status")
    .description("Show which thread is active in the primary checkout")
    .option("--project <id>", "Project ID (defaults to BB_PROJECT_ID)")
    .action(async (opts: { project?: string }) => {
      const client = createClient(getUrl());
      try {
        const projectId = requireProjectId(opts.project);
        const threads = await unwrap<Thread[]>(
          client.api.v1.threads.$get({
            query: { projectId },
          }),
        );
        const active = threads.find((thread) => thread.primaryCheckout?.isActive);
        if (!active) {
          console.log("Primary checkout: demoted");
          return;
        }
        console.log(`Primary checkout: ${active.id}`);
        if (active.title) {
          console.log(`Title: ${active.title}`);
        }
      } catch (err: unknown) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  thread
    .command("log [id]")
    .description("Show thread event log (defaults to BB_THREAD_ID)")
    .action(async (id: string | undefined) => {
      const client = createClient(getUrl());
      try {
        const threadId = requireThreadId(id);
        const events = await unwrap<ThreadEvent[]>(
          client.api.v1.threads[":id"].events.$get({
            param: { id: threadId },
            query: {},
          }),
        );
        for (const event of events) {
          printEvent(event);
        }
      } catch (err: unknown) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  thread
    .command("output [id]")
    .description("Get the final output of a thread (defaults to BB_THREAD_ID)")
    .action(async (id: string | undefined) => {
      const client = createClient(getUrl());
      try {
        const threadId = requireThreadId(id);
        const result = await unwrap<{ output: string }>(
          client.api.v1.threads[":id"].output.$get({ param: { id: threadId } }),
        );
        console.log(result.output);
      } catch (err: unknown) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}

export function statusText(status: ThreadStatus): string {
  switch (status) {
    case "created":
      return "created";
    case "provisioning":
      return "provisioning";
    case "provisioning_failed":
      return "provisioning_failed";
    case "idle":
      return "idle";
    case "active":
      return "active";
    default:
      return assertNever(status);
  }
}

function printThread(thread: Thread): void {
  console.log("");
  console.log(`  ID:       ${thread.id}`);
  console.log(`  Project:  ${thread.projectId}`);
  console.log(`  Status:   ${statusText(thread.status)}`);
  console.log(`  Created:  ${new Date(thread.createdAt).toLocaleString()}`);
  console.log(`  Updated:  ${new Date(thread.updatedAt).toLocaleString()}`);
  console.log("");
}

function printThreadTable(threads: Thread[]): void {
  const idWidth = Math.max(4, ...threads.map((t) => t.id.length));
  const statusWidth = 12;
  const projectWidth = Math.max(7, ...threads.map((t) => t.projectId.length));

  const header = [
    "ID".padEnd(idWidth),
    "Project".padEnd(projectWidth),
    "Status".padEnd(statusWidth),
  ].join("  ");

  console.log("");
  console.log(header);
  console.log("-".repeat(header.length));

  for (const thread of threads) {
    const row = [
      thread.id.padEnd(idWidth),
      thread.projectId.padEnd(projectWidth),
      statusText(thread.status).padEnd(statusWidth),
    ].join("  ");
    console.log(row);
  }
  console.log("");
}

function printEvent(event: ThreadEvent): void {
  const time = new Date(event.createdAt).toLocaleTimeString();
  const data = typeof event.data === "string" ? event.data : JSON.stringify(event.data, null, 2);

  if (event.type === "error") {
    console.log(`time=${time} level=error data=${data}`);
    return;
  }

  console.log(`time=${time} type=${event.type} data=${data}`);
}

function printThreadStatus(
  thread: Thread,
  events: ThreadEvent[],
  opts?: {
    recentEvents?: number;
    eventMode: ThreadStatusEventMode;
    includeLowSignal: boolean;
  },
): void {
  console.log(`Thread ${thread.id}`);
  console.log(`Status ${statusText(thread.status)}`);
  console.log(`Project ${thread.projectId}`);
  if (thread.parentThreadId) {
    console.log(`Parent ${thread.parentThreadId}`);
  }
  console.log(`Updated ${new Date(thread.updatedAt).toLocaleString()}`);

  const recentEventCount = opts?.recentEvents;
  if (recentEventCount === undefined) return;
  const eventMode = opts?.eventMode ?? "summary";

  const includeLowSignal = opts?.includeLowSignal ?? false;
  const filteredEvents = includeLowSignal
    ? events
    : events.filter((event) => !isLowSignalThreadStatusEventType(event.type));
  const recentEvents = filteredEvents.slice(-recentEventCount);

  console.log("");
  console.log("Recent events:");
  if (recentEvents.length === 0) return;

  if (eventMode === "raw") {
    for (const event of recentEvents) {
      printEvent(event);
    }
    return;
  }

  for (const event of recentEvents) {
    const at = new Date(event.createdAt).toLocaleTimeString();
    console.log(`- ${at} ${event.type}`);
  }
}
