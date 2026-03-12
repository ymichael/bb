import { Command } from "commander";
import {
  type Thread,
  type ThreadEvent,
  type ThreadOperationResponse,
  type ThreadStatus,
} from "@beanbag/agent-core";
import { assertNever } from "../assert-never.js";
import { createClient, unwrap } from "../client.js";
import {
  resolveEnvironmentId,
  requireProjectId,
  requireThreadId,
  resolveProjectId,
  resolveThreadId,
} from "../context-env.js";

type ThreadStatusEventMode = "summary" | "raw";
type ThreadWaitTarget =
  | { kind: "status"; status: ThreadStatus }
  | { kind: "event"; eventType: string };

interface ThreadSessionsPayload {
  threadId: string;
  sessions: ThreadSessionDebugView[];
}

interface ThreadSessionDebugView {
  id: string;
  threadId: string;
  agentId: string;
  agentInstanceId: string;
  protocolVersion: number;
  status: "active" | "expired" | "closed" | "replaced";
  leaseExpiresAt: number;
  lastHeartbeatAt?: number;
  closedAt?: number;
  closeReason?:
    | "agent_shutdown"
    | "daemon_shutdown"
    | "lease_expired"
    | "newer_session"
    | "migration"
    | "internal_error";
  controlBaseUrl?: string;
  createdAt: number;
  updatedAt: number;
}

const THREAD_WAIT_EXIT_CODE_TIMEOUT = 2;
const THREAD_WAIT_EXIT_CODE_INVALID_REQUEST = 3;
const DEFAULT_THREAD_WAIT_TIMEOUT_SECONDS = 30;
const DEFAULT_THREAD_WAIT_POLL_INTERVAL_MS = 250;

class ThreadWaitTimeoutError extends Error {}

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

function parseThreadWaitTimeoutSeconds(rawValue: string | undefined): number {
  if (rawValue === undefined) return DEFAULT_THREAD_WAIT_TIMEOUT_SECONDS;
  const parsed = Number.parseFloat(rawValue);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("Timeout must be a non-negative number of seconds.");
  }
  return parsed;
}

function parseThreadWaitPollIntervalMs(rawValue: string | undefined): number {
  if (rawValue === undefined) return DEFAULT_THREAD_WAIT_POLL_INTERVAL_MS;
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error("Poll interval must be a positive integer number of milliseconds.");
  }
  return parsed;
}

function parseThreadWaitTarget(opts: {
  status?: string;
  event?: string;
}): ThreadWaitTarget {
  const hasStatus = Boolean(opts.status);
  const hasEvent = Boolean(opts.event);
  if (hasStatus === hasEvent) {
    throw new Error("Provide exactly one of --status or --event.");
  }

  if (opts.status) {
    switch (opts.status) {
      case "created":
      case "provisioning":
      case "provisioned":
      case "provisioning_failed":
      case "error":
      case "idle":
      case "active":
        return { kind: "status", status: opts.status };
      default:
        throw new Error(
          `Invalid thread status '${opts.status}'. Expected one of created, provisioning, provisioned, provisioning_failed, error, idle, active.`,
        );
    }
  }

  return {
    kind: "event",
    eventType: normalizeThreadEventType(opts.event ?? ""),
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function printThreadOperationResult(result: ThreadOperationResponse): void {
  const flags = [
    result.executionStatus,
    ...(result.demotedPrimaryCheckout ? ["demoted-primary-checkout"] : []),
  ];
  console.log(`${result.message} [${flags.join(", ")}]`);
}

function buildThreadRouteUrl(baseUrl: string, threadId: string, suffix: string): URL {
  return new URL(
    `/api/v1/threads/${encodeURIComponent(threadId)}/${suffix}`,
    baseUrl,
  );
}

export function registerThreadCommands(program: Command, getUrl: () => string): void {
  const thread = program.command("thread").description("Manage threads");
  const postThreadMessage = async (
    threadId: string,
    message: string,
    mode?: "steer",
  ): Promise<{ ok: boolean }> => {
    const client = createClient(getUrl());
    return unwrap<{ ok: boolean }>(
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
    .action(
      async (
        id: string | undefined,
        opts: {
          status?: string;
          event?: string;
          timeout?: string;
          pollInterval?: string;
        },
      ) => {
        const client = createClient(getUrl());
        try {
          const threadId = requireThreadId(id);
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
                console.log(
                  `Thread ${threadId} reached status ${target.status}.`,
                );
                return;
              }
            } else {
              const events = await unwrap<ThreadEvent[]>(
                client.api.v1.threads[":id"].events.$get({
                  param: { id: threadId },
                  query: {},
                }),
              );
              const matched = events.find(
                (event) =>
                  normalizeThreadEventType(event.type) === target.eventType,
              );
              if (matched) {
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
          if (err instanceof Error && err.message.startsWith("Provide exactly one of")) {
            console.error(`Error: ${err.message}`);
            process.exit(THREAD_WAIT_EXIT_CODE_INVALID_REQUEST);
            return;
          }
          if (err instanceof Error && err.message.startsWith("Invalid thread status")) {
            console.error(`Error: ${err.message}`);
            process.exit(THREAD_WAIT_EXIT_CODE_INVALID_REQUEST);
            return;
          }
          console.error(`Error: ${(err as Error).message}`);
          process.exit(1);
        }
      },
    );

  thread
    .command("spawn")
    .description("Spawn a new thread for a project")
    .option("--prompt <prompt>", "Initial prompt for the thread")
    .option("--json", "Print machine-readable JSON output")
    .option("--project <id>", "Project ID (defaults to BB_PROJECT_ID)")
    .option(
      "--environment <id>",
      "Environment ID (defaults to BEANBAG_ENVIRONMENT when set)",
    )
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
      json?: boolean;
      project?: string;
      environment?: string;
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
        const environmentId = resolveEnvironmentId(opts.environment);
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
              ...(environmentId ? { environmentId } : {}),
              ...(parentThreadId ? { parentThreadId } : {}),
            },
          }),
        );
        if (opts.json) {
          console.log(JSON.stringify(thread, null, 2));
          return;
        }
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
    .command("sessions [id]")
    .description("Show environment-agent sessions for a thread (defaults to BB_THREAD_ID)")
    .option("--json", "Print machine-readable JSON output")
    .action(async (id: string | undefined, opts: { json?: boolean }) => {
      try {
        const threadId = requireThreadId(id);
        const response = await unwrap<ThreadSessionsPayload>(
          fetch(buildThreadRouteUrl(getUrl(), threadId, "environment-agent/sessions")),
        );
        if (opts.json) {
          console.log(JSON.stringify(response, null, 2));
          return;
        }
        printThreadSessions(response);
      } catch (err: unknown) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  thread
    .command("status [id]")
    .description("Show thread status (defaults to BB_THREAD_ID)")
    .option("--json", "Print machine-readable JSON output")
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
          json?: boolean;
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
          const includeLowSignal = Boolean(opts.includeLowSignal);
          const statusPayload = buildThreadStatusPayload(thread, events, {
            recentEvents,
            eventMode,
            includeLowSignal,
          });
          if (opts.json) {
            console.log(JSON.stringify(statusPayload, null, 2));
            return;
          }
          printThreadStatus(statusPayload);
        } catch (err: unknown) {
          console.error(`Error: ${(err as Error).message}`);
          process.exit(1);
        }
      },
    );

  thread
    .command("show [id]")
    .description("Show thread details (defaults to BB_THREAD_ID)")
    .option("--json", "Print machine-readable JSON output")
    .action(async (id: string | undefined, opts: { json?: boolean }) => {
      const client = createClient(getUrl());
      try {
        const threadId = requireThreadId(id);
        const thread = await unwrap<Thread>(
          client.api.v1.threads[":id"].$get({ param: { id: threadId } }),
        );
        if (opts.json) {
          console.log(JSON.stringify(thread, null, 2));
          return;
        }
        printThread(thread);
      } catch (err: unknown) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  thread
    .command("archive [id]")
    .description("Archive a thread (defaults to BB_THREAD_ID)")
    .option(
      "--force",
      "Archive even when the thread workspace has uncommitted or unmerged work",
    )
    .action(async (id: string | undefined, opts: { force?: boolean }) => {
      try {
        const threadId = requireThreadId(id);
        const requestInit: RequestInit = opts.force
          ? {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ force: true }),
            }
          : { method: "POST" };
        await unwrap<{ ok: boolean }>(
          fetch(buildThreadRouteUrl(getUrl(), threadId, "archive"), requestInit),
        );
        console.log(`Thread ${threadId} archived`);
      } catch (err: unknown) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  thread
    .command("unarchive [id]")
    .description("Unarchive a thread (defaults to BB_THREAD_ID)")
    .action(async (id: string | undefined) => {
      const client = createClient(getUrl());
      try {
        const threadId = requireThreadId(id);
        await unwrap<{ ok: boolean }>(
          client.api.v1.threads[":id"].unarchive.$post({
            param: { id: threadId },
          }),
        );
        console.log(`Thread ${threadId} unarchived`);
      } catch (err: unknown) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  thread
    .command("tell <id> <message>")
    .description("Send a follow-up message to a thread")
    .option("--json", "Print machine-readable JSON output")
    .action(async (id: string, message: string, opts: { json?: boolean }) => {
      try {
        const response = await postThreadMessage(id, message);
        if (opts.json) {
          console.log(JSON.stringify({ threadId: id, ...response }, null, 2));
          return;
        }
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
    .option("--json", "Print machine-readable JSON output")
    .action(async (id: string | undefined, opts: { json?: boolean }) => {
      const client = createClient(getUrl());
      try {
        const threadId = requireThreadId(id);
        const events = await unwrap<ThreadEvent[]>(
          client.api.v1.threads[":id"].events.$get({
            param: { id: threadId },
            query: {},
          }),
        );
        if (opts.json) {
          console.log(JSON.stringify(events, null, 2));
          return;
        }
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
    .option("--json", "Print machine-readable JSON output")
    .action(async (id: string | undefined, opts: { json?: boolean }) => {
      const client = createClient(getUrl());
      try {
        const threadId = requireThreadId(id);
        const result = await unwrap<{ output: string }>(
          client.api.v1.threads[":id"].output.$get({ param: { id: threadId } }),
        );
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
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
    case "provisioned":
      return "provisioned";
    case "provisioning_failed":
      return "provisioning_failed";
    case "error":
      return "error";
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
  if (thread.archivedAt !== undefined) {
    console.log(`  Archived: ${new Date(thread.archivedAt).toLocaleString()}`);
  }
  console.log(`  Created:  ${new Date(thread.createdAt).toLocaleString()}`);
  console.log(`  Updated:  ${new Date(thread.updatedAt).toLocaleString()}`);
  console.log("");
}

function printThreadTable(threads: Thread[]): void {
  const idWidth = Math.max(4, ...threads.map((t) => t.id.length));
  const statusWidth = Math.max(
    12,
    ...threads.map((thread) =>
      thread.archivedAt !== undefined
        ? `${statusText(thread.status)} (archived)`.length
        : statusText(thread.status).length
    ),
  );
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
    const renderedStatus =
      thread.archivedAt !== undefined
        ? `${statusText(thread.status)} (archived)`
        : statusText(thread.status);
    const row = [
      thread.id.padEnd(idWidth),
      thread.projectId.padEnd(projectWidth),
      renderedStatus.padEnd(statusWidth),
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

interface ThreadStatusPayload {
  thread: Thread;
  recentEvents?: {
    requestedCount: number;
    eventMode: ThreadStatusEventMode;
    includeLowSignal: boolean;
    events: ThreadEvent[];
  };
}

function buildThreadStatusPayload(
  thread: Thread,
  events: ThreadEvent[],
  opts?: {
    recentEvents?: number;
    eventMode: ThreadStatusEventMode;
    includeLowSignal: boolean;
  },
): ThreadStatusPayload {
  const recentEventCount = opts?.recentEvents;
  if (recentEventCount === undefined) {
    return { thread };
  }

  const eventMode = opts?.eventMode ?? "summary";
  const includeLowSignal = opts?.includeLowSignal ?? false;
  const filteredEvents = includeLowSignal
    ? events
    : events.filter((event) => !isLowSignalThreadStatusEventType(event.type));

  return {
    thread,
    recentEvents: {
      requestedCount: recentEventCount,
      eventMode,
      includeLowSignal,
      events: filteredEvents.slice(-recentEventCount),
    },
  };
}

function printThreadStatus(payload: ThreadStatusPayload): void {
  const { thread } = payload;
  console.log(`Thread ${thread.id}`);
  console.log(`Status ${statusText(thread.status)}`);
  console.log(`Project ${thread.projectId}`);
  if (thread.parentThreadId) {
    console.log(`Parent ${thread.parentThreadId}`);
  }
  console.log(`Updated ${new Date(thread.updatedAt).toLocaleString()}`);

  const recentEvents = payload.recentEvents;
  if (recentEvents === undefined) return;

  console.log("");
  console.log("Recent events:");
  if (recentEvents.events.length === 0) return;

  if (recentEvents.eventMode === "raw") {
    for (const event of recentEvents.events) {
      printEvent(event);
    }
    return;
  }

  for (const event of recentEvents.events) {
    const at = new Date(event.createdAt).toLocaleTimeString();
    console.log(`- ${at} ${event.type}`);
  }
}

function printThreadSessions(payload: ThreadSessionsPayload): void {
  console.log(`Thread ${payload.threadId} environment-agent sessions`);
  if (payload.sessions.length === 0) {
    console.log("No sessions found");
    return;
  }

  for (const session of payload.sessions) {
    console.log("");
    console.log(`- Session ${session.id}`);
    console.log(`  Status ${session.status}`);
    console.log(`  Agent ${session.agentId} (${session.agentInstanceId})`);
    console.log(`  Lease expires ${new Date(session.leaseExpiresAt).toLocaleString()}`);
    if (session.lastHeartbeatAt !== undefined) {
      console.log(`  Last heartbeat ${new Date(session.lastHeartbeatAt).toLocaleString()}`);
    }
    if (session.closedAt !== undefined) {
      console.log(`  Closed ${new Date(session.closedAt).toLocaleString()}`);
    }
    if (session.closeReason) {
      console.log(`  Close reason ${session.closeReason}`);
    }
    if (session.controlBaseUrl) {
      console.log(`  Control endpoint ${session.controlBaseUrl}`);
    }
  }
}
