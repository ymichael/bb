import { Command } from "commander";
import {
  type SpawnThreadRequest,
  type Thread,
  type ThreadEvent,
  type ThreadGitDiffResponse,
  type ThreadStatus,
  type ThreadWorkStatus,
  type TimelineFormat,
  type Project,
  normalizeThreadEventType,
  toUIMessages,
  formatTimelineAsText,
  formatEnvironmentDisplay,
} from "@bb/core";
import { assertNever } from "../assert-never.js";
import { createClient, unwrap } from "../client.js";
import {
  confirmDestructiveAction,
  getErrorMessage,
  outputJson,
  resolveThreadIdOrSelf,
  resolveThreadIdWithLabel,
  resolveProjectIdWithLabel,
  printContextLabel,
} from "./helpers.js";
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
  environmentId: string;
  sessions: ThreadSessionDebugView[];
}

interface ThreadSessionDebugView {
  id: string;
  environmentId: string;
  agentId: string;
  agentInstanceId: string;
  protocolVersion: number;
  status: "active" | "expired" | "closed" | "replaced";
  leaseExpiresAt: number;
  lastHeartbeatAt?: number;
  closedAt?: number;
  closeReason?:
    | "agent_shutdown"
    | "server_shutdown"
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

function looksLikePath(value: string): boolean {
  return value.includes("/") || value.startsWith(".") || value.startsWith("~");
}

function buildSpawnEnvironmentSelection(args: {
  environmentValue?: string;
  newEnvironmentKind?: string;
}): Pick<
  SpawnThreadRequest,
  "environmentId" | "environmentDescriptor" | "environmentCreationArgs"
> {
  const environmentValue = args.environmentValue?.trim();
  const newEnvironmentKind = args.newEnvironmentKind?.trim();

  if (environmentValue && newEnvironmentKind) {
    throw new Error("Cannot combine --environment with --new-environment.");
  }
  if (newEnvironmentKind) {
    return {
      environmentCreationArgs: {
        kind: newEnvironmentKind,
      },
    };
  }
  if (!environmentValue) {
    return {};
  }
  if (looksLikePath(environmentValue)) {
    return {
      environmentDescriptor: {
        type: "path",
        path: environmentValue,
      },
    };
  }
  return {
    environmentId: environmentValue,
  };
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

export function registerThreadCommands(program: Command, getUrl: () => string): void {
  const thread = program.command("thread").description("Manage threads");
  const postThreadMessage = async (
    threadId: string,
    message: string,
    options?: {
      mode?: "steer";
      model?: string;
      reasoningLevel?: string;
    },
  ): Promise<{ ok: boolean }> => {
    const client = createClient(getUrl());
    return unwrap<{ ok: boolean }>(
      client.api.v1.threads[":id"].tell.$post({
        param: { id: threadId },
        json: {
          input: [{ type: "text", text: message }],
          ...(options?.mode ? { mode: options.mode } : {}),
          ...(options?.model ? { model: options.model } : {}),
          ...(options?.reasoningLevel ? { reasoningLevel: options.reasoningLevel as "low" | "medium" | "high" | "xhigh" } : {}),
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
    .option("--json", "Print machine-readable JSON output")
    .action(
      async (
        id: string | undefined,
        opts: {
          status?: string;
          event?: string;
          timeout?: string;
          pollInterval?: string;
          json?: boolean;
        },
      ) => {
        const client = createClient(getUrl());
        try {
          const resolved = resolveThreadIdWithLabel(id);
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
                console.log(
                  `Thread ${threadId} reached status ${target.status}.`,
                );
                return;
              }
            } else {
              const events = await unwrap<ThreadEvent[]>(
                client.api.v1.threads[":id"].events.$get({
                  param: { id: threadId },
                  query: afterSeq !== undefined ? { afterSeq: String(afterSeq) } : {},
                }),
              );
              if (events.length > 0) {
                afterSeq = events[events.length - 1].seq;
              }
              const matched = events.find(
                (event) =>
                  normalizeThreadEventType(event.type) === target.eventType,
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
          console.error(`Error: ${getErrorMessage(err)}`);
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
      "--environment <id-or-path>",
      "Existing environment UUID or unmanaged workspace path",
    )
    .option(
      "--new-environment <kind>",
      "Create a new managed environment of the given kind (for example worktree or docker)",
    )
    .option(
      "--parent-thread <id>",
      "Parent thread ID for worker thread links (defaults to BB_THREAD_ID)",
    )
    .option(
      "--provider <id>",
      "Provider ID for the thread (e.g. codex, claude-code, pi)",
    )
    .option("--model <model>", "Model ID for the thread")
    .option(
      "--reasoning-level <level>",
      "Reasoning level: low, medium, high, xhigh",
    )
    .option("--title <title>", "Thread title")
    .option(
      "--service-tier <tier>",
      "Service tier: fast or flex",
    )
    .option(
      "--sandbox-mode <mode>",
      "Sandbox mode: read-only, workspace-write, or danger-full-access",
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
      newEnvironment?: string;
      parentThread?: string;
      provider?: string;
      model?: string;
      reasoningLevel?: string;
      title?: string;
      serviceTier?: string;
      sandboxMode?: string;
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
        const environmentValue = resolveEnvironmentId(opts.environment);
        const environmentSelection = buildSpawnEnvironmentSelection({
          environmentValue,
          newEnvironmentKind: opts.newEnvironment,
        });
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
              ...(opts.provider ? { providerId: opts.provider } : {}),
              ...(opts.model ? { model: opts.model } : {}),
              ...(opts.reasoningLevel ? { reasoningLevel: opts.reasoningLevel as "low" | "medium" | "high" | "xhigh" } : {}),
              ...(opts.title ? { title: opts.title } : {}),
              ...(opts.serviceTier ? { serviceTier: opts.serviceTier as "fast" | "flex" } : {}),
              ...(opts.sandboxMode ? { sandboxMode: opts.sandboxMode as "read-only" | "workspace-write" | "danger-full-access" } : {}),
              ...environmentSelection,
              ...(parentThreadId ? { parentThreadId } : {}),
            },
          }),
        );
        if (outputJson(opts, thread)) return;
        console.log(`Thread spawned: ${thread.id}`);
        if (
          thread.parentThreadId &&
          thread.parentThreadId === resolveThreadId()
        ) {
          console.log("You will be notified when this thread is done.");
        }
        printThread(thread);
      } catch (err: unknown) {
        console.error(`Error: ${getErrorMessage(err)}`);
        process.exit(1);
      }
    });

  thread
    .command("list")
    .description("List threads")
    .option("--project <id>", "Filter by project ID (defaults to BB_PROJECT_ID)")
    .option("--parent-thread <id>", "Filter by managing parent thread ID")
    .option("--include-archived", "Include archived threads in the listing")
    .option("--include-work-status", "Include work status columns in output")
    .option("--json", "Print machine-readable JSON output")
    .action(async (opts: { project?: string; parentThread?: string; includeArchived?: boolean; includeWorkStatus?: boolean; json?: boolean }) => {
      const client = createClient(getUrl());
      try {
        const resolvedProject = opts.project
          ? { id: opts.project, source: "arg" as const }
          : process.env.BB_PROJECT_ID?.trim()
            ? { id: process.env.BB_PROJECT_ID.trim(), source: "env" as const }
            : undefined;
        const projectId = resolvedProject?.id;
        if (resolvedProject) {
          printContextLabel(resolvedProject, "Project", "BB_PROJECT_ID", opts);
        }
        const parentThreadId = resolveThreadId(opts.parentThread);
        const threads = await unwrap<Thread[]>(
          client.api.v1.threads.$get({
            query: {
              ...(projectId ? { projectId } : {}),
              ...(parentThreadId ? { parentThreadId } : {}),
              ...(opts.includeArchived ? { includeArchived: "true" as const } : {}),
              ...(opts.includeWorkStatus ? { includeWorkStatus: "true" as const } : {}),
            },
          }),
        );
        if (outputJson(opts, threads)) return;
        if (threads.length === 0) {
          console.log("No threads found");
          return;
        }
        printThreadTable(threads, opts.includeWorkStatus);
      } catch (err: unknown) {
        console.error(`Error: ${getErrorMessage(err)}`);
        process.exit(1);
      }
    });

  thread
    .command("sessions [id]")
    .description("Show env-daemon sessions for a thread (defaults to BB_THREAD_ID)")
    .option("--json", "Print machine-readable JSON output")
    .action(async (id: string | undefined, opts: { json?: boolean }) => {
      try {
        const resolved = resolveThreadIdWithLabel(id);
        const threadId = resolved.id;
        printContextLabel(resolved, "Thread", "BB_THREAD_ID", opts);
        const client = createClient(getUrl());
        const thread = await unwrap<Thread>(
          client.api.v1.threads[":id"].$get({ param: { id: threadId } }),
        );
        const environmentId = (thread as Thread & { attachedEnvironment?: { id: string } }).attachedEnvironment?.id;
        if (!environmentId) {
          console.error("Thread has no attached environment");
          process.exit(1);
        }
        const response = await unwrap<ThreadSessionsPayload>(
          client.api.v1.environments[":id"]["env-daemon"].sessions.$get({
            param: { id: environmentId },
          }),
        );
        if (outputJson(opts, response)) return;
        printThreadSessions(response);
      } catch (err: unknown) {
        console.error(`Error: ${getErrorMessage(err)}`);
        process.exit(1);
      }
    });

  const threadShowAction = async (
    id: string | undefined,
    opts: {
      recentEvents?: string;
      eventMode?: string;
      includeLowSignal?: boolean;
      workStatus?: boolean;
      gitDiff?: boolean;
      diffSelection?: string;
      diffMergeBase?: string;
      mergeBaseBranches?: boolean;
      json?: boolean;
    },
  ): Promise<void> => {
    const client = createClient(getUrl());
    try {
      const resolved = resolveThreadIdWithLabel(id);
      const threadId = resolved.id;
      printContextLabel(resolved, "Thread", "BB_THREAD_ID", opts);
      const recentEvents =
        opts.recentEvents === undefined
          ? undefined
          : parseRecentEventsCount(opts.recentEvents);
      const eventMode = parseThreadStatusEventMode(opts.eventMode);
      const thread = await unwrap<Thread>(
        client.api.v1.threads[":id"].$get({ param: { id: threadId } }),
      );

      // Fetch project root path for environment display labels
      let projectRootPath: string | undefined;
      if (thread.projectId) {
        try {
          const project = await unwrap<Project>(
            client.api.v1.projects[":id"].$get({ param: { id: thread.projectId } }),
          );
          projectRootPath = project.rootPath;
        } catch {
          // Project fetch failed; environment labels will be less specific
        }
      }

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

      let workStatus: ThreadWorkStatus | null | undefined;
      if (opts.workStatus) {
        workStatus = await unwrap<ThreadWorkStatus | null>(
          client.api.v1.threads[":id"]["work-status"].$get({
            param: { id: threadId },
            query: {},
          }),
        );
      }

      let gitDiff: ThreadGitDiffResponse | undefined;
      if (opts.gitDiff) {
        const query: Record<string, string> = {};
        if (opts.diffSelection) {
          query.selection = opts.diffSelection;
        }
        if (opts.diffMergeBase) {
          query.mergeBaseBranch = opts.diffMergeBase;
        }
        gitDiff = await unwrap<ThreadGitDiffResponse>(
          client.api.v1.threads[":id"]["git-diff"].$get({
            param: { id: threadId },
            query,
          }),
        );
      }

      let mergeBaseBranches: string[] | undefined;
      if (opts.mergeBaseBranches) {
        mergeBaseBranches = await unwrap<string[]>(
          client.api.v1.threads[":id"]["merge-base-branches"].$get({
            param: { id: threadId },
          }),
        );
      }

      if (opts.json) {
        const jsonPayload: Record<string, unknown> = { ...statusPayload };
        if (workStatus !== undefined) {
          jsonPayload.workStatus = workStatus;
        }
        if (gitDiff !== undefined) {
          jsonPayload.gitDiff = gitDiff;
        }
        if (mergeBaseBranches !== undefined) {
          jsonPayload.mergeBaseBranches = mergeBaseBranches;
        }
        outputJson({ json: true }, jsonPayload);
        return;
      }

      printThreadStatus(statusPayload, projectRootPath);

      if (workStatus) {
        console.log("");
        console.log("Work status:");
        console.log(`  State:    ${workStatus.state}`);
        if (workStatus.currentBranch) {
          console.log(`  Branch:   ${workStatus.currentBranch}`);
        }
        console.log(`  Changed files: ${workStatus.changedFiles} (workspace: ${workStatus.workspaceChangedFiles})`);
        console.log(`  Insertions:    +${workStatus.insertions} (workspace: +${workStatus.workspaceInsertions})`);
        console.log(`  Deletions:     -${workStatus.deletions} (workspace: -${workStatus.workspaceDeletions})`);
        console.log(`  Ahead: ${workStatus.aheadCount}  Behind: ${workStatus.behindCount}`);
      } else if (opts.workStatus && workStatus === null) {
        console.log("");
        console.log("Work status: unavailable");
      }

      if (gitDiff) {
        console.log("");
        console.log("Git diff:");
        console.log(`  Mode: ${gitDiff.mode}`);
        if (gitDiff.currentBranch) {
          console.log(`  Branch: ${gitDiff.currentBranch}`);
        }
        if (gitDiff.mergeBaseBranch) {
          console.log(`  Merge base branch: ${gitDiff.mergeBaseBranch}`);
        }
        if (gitDiff.commits.length > 0) {
          console.log(`  Commits: ${gitDiff.commits.length}`);
          for (const commit of gitDiff.commits) {
            console.log(`    ${commit.shortSha} ${commit.subject}`);
          }
        }
        if (gitDiff.diff) {
          console.log("");
          console.log(gitDiff.diff);
        }
        if (gitDiff.truncated) {
          console.log("  (diff truncated)");
        }
      }

      if (mergeBaseBranches !== undefined) {
        console.log("");
        if (mergeBaseBranches.length === 0) {
          console.log("Merge-base branches: none");
        } else {
          console.log("Merge-base branches:");
          for (const branch of mergeBaseBranches) {
            console.log(`  ${branch}`);
          }
        }
      }
    } catch (err: unknown) {
      console.error(`Error: ${getErrorMessage(err)}`);
      process.exit(1);
    }
  };

  thread
    .command("show [id]")
    .description("Show thread details (defaults to BB_THREAD_ID)")
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
    .option("--work-status", "Include work status (git state) in output")
    .option("--git-diff", "Include git diff in output")
    .option(
      "--diff-selection <type>",
      "Diff selection type: combined or commit (used with --git-diff)",
    )
    .option(
      "--diff-merge-base <branch>",
      "Merge base branch for diff (used with --git-diff)",
    )
    .option("--merge-base-branches", "Include available merge-base branches in output")
    .action(threadShowAction);

  thread
    .command("update [id]")
    .description("Update a thread")
    .option("--self", "Target the current thread (from BB_THREAD_ID)")
    .option("--json", "Print machine-readable JSON output")
    .option("--title <title>", "Set the thread title")
    .option("--merge-base-branch <branch>", "Set the merge base branch")
    .option("--parent-thread <id>", "Set the managing parent thread id")
    .option("--clear-parent-thread", "Clear the managing parent thread id")
    .action(
      async (
        id: string | undefined,
        opts: {
          self?: boolean;
          json?: boolean;
          title?: string;
          mergeBaseBranch?: string;
          parentThread?: string;
          clearParentThread?: boolean;
        },
      ) => {
        const client = createClient(getUrl());
        try {
          if (opts.parentThread && opts.clearParentThread) {
            throw new Error(
              "Cannot combine --parent-thread with --clear-parent-thread.",
            );
          }
          if (!opts.parentThread && !opts.clearParentThread && !opts.title && !opts.mergeBaseBranch) {
            throw new Error(
              "No changes requested. Provide --title, --merge-base-branch, --parent-thread, or --clear-parent-thread.",
            );
          }

          const threadId = resolveThreadIdOrSelf(id, opts);
          const body: Record<string, unknown> = {};
          if (opts.title) {
            body.title = opts.title;
          }
          if (opts.mergeBaseBranch) {
            body.mergeBaseBranch = opts.mergeBaseBranch;
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
          if (opts.mergeBaseBranch) {
            console.log(`Merge base branch: ${thread.mergeBaseBranch ?? opts.mergeBaseBranch}`);
          }
          if (opts.parentThread || opts.clearParentThread) {
            console.log(
              thread.parentThreadId
                ? `Managed by ${thread.parentThreadId}`
                : "No managing parent thread",
            );
          }
        } catch (err: unknown) {
          console.error(`Error: ${getErrorMessage(err)}`);
          process.exit(1);
        }
      },
    );

  thread
    .command("archive [id]")
    .description("Archive a thread")
    .option("--self", "Target the current thread (from BB_THREAD_ID)")
    .option(
      "--force",
      "Archive even when the thread workspace has uncommitted or unmerged work",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(async (id: string | undefined, opts: { self?: boolean; force?: boolean; json?: boolean }) => {
      try {
        const threadId = resolveThreadIdOrSelf(id, opts);
        const client = createClient(getUrl());
        await unwrap<{ ok: boolean }>(
          client.api.v1.threads[":id"].archive.$post({
            param: { id: threadId },
            json: opts.force ? { force: true } : {},
          }),
        );
        if (outputJson(opts, { ok: true, threadId })) return;
        console.log(`Thread ${threadId} archived`);
      } catch (err: unknown) {
        console.error(`Error: ${getErrorMessage(err)}`);
        process.exit(1);
      }
    });

  thread
    .command("unarchive [id]")
    .description("Unarchive a thread")
    .option("--self", "Target the current thread (from BB_THREAD_ID)")
    .option("--json", "Print machine-readable JSON output")
    .action(async (id: string | undefined, opts: { self?: boolean; json?: boolean }) => {
      const client = createClient(getUrl());
      try {
        const threadId = resolveThreadIdOrSelf(id, opts);
        await unwrap<{ ok: boolean }>(
          client.api.v1.threads[":id"].unarchive.$post({
            param: { id: threadId },
          }),
        );
        if (outputJson(opts, { ok: true, threadId })) return;
        console.log(`Thread ${threadId} unarchived`);
      } catch (err: unknown) {
        console.error(`Error: ${getErrorMessage(err)}`);
        process.exit(1);
      }
    });

  thread
    .command("delete <id>")
    .description("Delete a thread permanently")
    .option("--yes", "Skip the confirmation prompt")
    .option("--json", "Print machine-readable JSON output")
    .action(async (id: string, opts: { yes?: boolean; json?: boolean }) => {
      const client = createClient(getUrl());
      try {
        const threadId = id;
        const thread = await unwrap<Thread>(
          client.api.v1.threads[":id"].$get({ param: { id: threadId } }),
        );

        if (!opts.yes) {
          const confirmed = await confirmDestructiveAction(
            `Delete thread "${thread.title ?? thread.titleFallback ?? thread.id}" permanently? This cannot be undone.`,
          );
          if (!confirmed) {
            console.log(`Thread ${threadId} deletion cancelled`);
            return;
          }
        }

        await unwrap<{ ok: boolean }>(
          client.api.v1.threads[":id"].$delete({
            param: { id: threadId },
          }),
        );
        if (outputJson(opts, { ok: true, threadId })) return;
        console.log(`Thread ${threadId} deleted`);
      } catch (err: unknown) {
        console.error(`Error: ${getErrorMessage(err)}`);
        process.exit(1);
      }
    });

  const tellAction = async (
    id: string,
    message: string,
    opts: { json?: boolean; model?: string; reasoningLevel?: string; mode?: string },
  ): Promise<void> => {
    try {
      const mode = opts.mode === "steer" ? "steer" as const : undefined;
      const response = await postThreadMessage(id, message, {
        mode,
        model: opts.model,
        reasoningLevel: opts.reasoningLevel,
      });
      if (outputJson(opts, { threadId: id, ...response })) return;
      console.log(mode === "steer" ? `Thread ${id} steered` : `Thread ${id} updated`);
    } catch (err: unknown) {
      console.error(`Error: ${getErrorMessage(err)}`);
      process.exit(1);
    }
  };

  thread
    .command("tell <id> <message>")
    .description("Send a follow-up message to a thread")
    .option("--json", "Print machine-readable JSON output")
    .option("--model <model>", "Model ID for this message")
    .option(
      "--reasoning-level <level>",
      "Reasoning level: low, medium, high, xhigh",
    )
    .option("--mode <mode>", "Message mode (e.g. steer)")
    .action(tellAction);

  thread
    .command("stop [id]")
    .description("Stop an active thread")
    .option("--self", "Target the current thread (from BB_THREAD_ID)")
    .option("--json", "Print machine-readable JSON output")
    .action(async (id: string | undefined, opts: { self?: boolean; json?: boolean }) => {
      const client = createClient(getUrl());
      try {
        const threadId = resolveThreadIdOrSelf(id, opts);
        await unwrap<{ ok: boolean }>(
          client.api.v1.threads[":id"].stop.$post({ param: { id: threadId } }),
        );
        if (outputJson(opts, { ok: true, threadId })) return;
        console.log(`Thread ${threadId} stopped`);
      } catch (err: unknown) {
        console.error(`Error: ${getErrorMessage(err)}`);
        process.exit(1);
      }
    });

  thread
    .command("log [id]")
    .description("Show thread event log (defaults to BB_THREAD_ID)")
    .option("--json", "Print machine-readable JSON output (alias for --format json)")
    .option(
      "--format <format>",
      "Output format: json (raw events), minimal (compact timeline), verbose (full timeline)",
      "minimal",
    )
    .action(
      async (
        id: string | undefined,
        opts: { json?: boolean; format?: string },
      ) => {
        const client = createClient(getUrl());
        try {
          const resolved = resolveThreadIdWithLabel(id);
          const threadId = resolved.id;
          printContextLabel(resolved, "Thread", "BB_THREAD_ID", opts);
          const format: TimelineFormat = opts.json
            ? "json"
            : ((opts.format ?? "minimal") as TimelineFormat);

          const events = await unwrap<ThreadEvent[]>(
            client.api.v1.threads[":id"].events.$get({
              param: { id: threadId },
              query: {},
            }),
          );

          if (format === "json") {
            console.log(JSON.stringify(events, null, 2));
            return;
          }

          const messages = toUIMessages(events, { threadStatus: "idle" });
          const color =
            process.stdout.isTTY === true &&
            !process.env.NO_COLOR;
          const text = formatTimelineAsText(messages, {
            verbose: format === "verbose",
            color,
          });
          console.log(text);
        } catch (err: unknown) {
          console.error(`Error: ${getErrorMessage(err)}`);
          process.exit(1);
        }
      },
    );

  thread
    .command("output [id]")
    .description("Get the final output of a thread (defaults to BB_THREAD_ID)")
    .option("--json", "Print machine-readable JSON output")
    .action(async (id: string | undefined, opts: { json?: boolean }) => {
      const client = createClient(getUrl());
      try {
        const resolved = resolveThreadIdWithLabel(id);
        const threadId = resolved.id;
        printContextLabel(resolved, "Thread", "BB_THREAD_ID", opts);
        const result = await unwrap<{ output: string }>(
          client.api.v1.threads[":id"].output.$get({ param: { id: threadId } }),
        );
        if (outputJson(opts, result)) return;
        console.log(result.output);
      } catch (err: unknown) {
        console.error(`Error: ${getErrorMessage(err)}`);
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

function printThreadTable(threads: Thread[], includeWorkStatus?: boolean): void {
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

  const headerCols = [
    "ID".padEnd(idWidth),
    "Project".padEnd(projectWidth),
    "Status".padEnd(statusWidth),
  ];

  if (includeWorkStatus) {
    headerCols.push(
      "Work".padEnd(10),
      "Branch".padEnd(20),
      "Files".padEnd(5),
      "+/-".padEnd(10),
    );
  }

  const header = headerCols.join("  ");

  console.log("");
  console.log(header);
  console.log("-".repeat(header.length));

  for (const thread of threads) {
    const renderedStatus =
      thread.archivedAt !== undefined
        ? `${statusText(thread.status)} (archived)`
        : statusText(thread.status);
    const rowCols = [
      thread.id.padEnd(idWidth),
      thread.projectId.padEnd(projectWidth),
      renderedStatus.padEnd(statusWidth),
    ];

    if (includeWorkStatus) {
      const ws = thread.workStatus;
      if (ws) {
        rowCols.push(
          ws.state.padEnd(10),
          (ws.currentBranch ?? "-").padEnd(20),
          String(ws.changedFiles).padEnd(5),
          `+${ws.insertions}/-${ws.deletions}`.padEnd(10),
        );
      } else {
        rowCols.push("-".padEnd(10), "-".padEnd(20), "-".padEnd(5), "-".padEnd(10));
      }
    }

    const row = rowCols.join("  ");
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

function printThreadStatus(payload: ThreadStatusPayload, projectRootPath?: string): void {
  const { thread } = payload;
  console.log(`Thread ${thread.id}`);
  console.log(`Status ${statusText(thread.status)}`);
  console.log(`Project ${thread.projectId}`);
  if (thread.parentThreadId) {
    console.log(`Parent ${thread.parentThreadId}`);
  }
  if (thread.archivedAt !== undefined) {
    console.log(`Archived: ${new Date(thread.archivedAt).toLocaleString()}`);
  }
  if (thread.attachedEnvironment) {
    const envDisplay = formatEnvironmentDisplay(thread.attachedEnvironment, projectRootPath);
    console.log(`Environment ${envDisplay.label}`);
    console.log(`  ID: ${envDisplay.id}`);
    if (envDisplay.path) {
      console.log(`  Path: ${envDisplay.path}`);
    }
  }
  console.log(`Created ${new Date(thread.createdAt).toLocaleString()}`);
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
  console.log(`Environment ${payload.environmentId} env-daemon sessions`);
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
