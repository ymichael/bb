import { Command } from "commander";
import {
  formatTimelineAsText,
  type TimelineFormat,
} from "@bb/core-ui";
import {
  type Thread,
  type ThreadEventRow,
  type ThreadGitDiffResponse,
  type WorkspaceStatus,
} from "@bb/domain";
import type {
  EnvironmentStatusResponse,
  ThreadTimelineResponse,
} from "@bb/server-contract";
import { action } from "../../action.js";
import { createClient, unwrap } from "../../client.js";
import {
  outputJson,
  printContextLabel,
  requireThreadIdWithLabel,
} from "../helpers.js";
import {
  parseRecentEventsCount,
  parseThreadStatusEventMode,
  statusText,
  type ThreadStatusEventMode,
} from "./helpers.js";

interface ThreadShowCommandOptions {
  recentEvents?: string;
  eventMode?: string;
  includeLowSignal?: boolean;
  workStatus?: boolean;
  gitDiff?: boolean;
  diffSelection?: string;
  diffMergeBase?: string;
  mergeBaseBranches?: boolean;
  json?: boolean;
}

interface ThreadLogCommandOptions {
  json?: boolean;
  format?: string;
}

interface ThreadOutputCommandOptions {
  json?: boolean;
}

interface ThreadStatusPayload {
  thread: Thread;
  recentEvents?: {
    requestedCount: number;
    eventMode: ThreadStatusEventMode;
    includeLowSignal: boolean;
    events: ThreadEventRow[];
  };
}

interface ThreadShowJsonPayload extends ThreadStatusPayload {
  workStatus?: WorkspaceStatus | null;
  gitDiff?: ThreadGitDiffResponse;
  mergeBaseBranches?: string[];
}

export function registerShowCommand(
  parent: Command,
  getUrl: () => string,
): void {
  parent
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
    .action(action(async (id: string | undefined, opts: ThreadShowCommandOptions) => {
      const client = createClient(getUrl());
      const resolved = requireThreadIdWithLabel(id);
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

      const events =
        recentEvents === undefined
          ? []
          : await unwrap<ThreadEventRow[]>(
              client.api.v1.threads[":id"].events.$get({
                param: { id: threadId },
                query: {},
              }),
            );
      const statusPayload = buildThreadStatusPayload(thread, events, {
        recentEvents,
        eventMode,
        includeLowSignal: Boolean(opts.includeLowSignal),
      });

      let workStatus: WorkspaceStatus | null | undefined;
      if (opts.workStatus && thread.environmentId) {
        const environmentStatus = await unwrap<EnvironmentStatusResponse>(
          client.api.v1.environments[":id"].status.$get({
            param: { id: thread.environmentId },
            query: {},
          }),
        );
        workStatus = environmentStatus.workspace;
      }

      let gitDiff: ThreadGitDiffResponse | undefined;
      if (opts.gitDiff && thread.environmentId) {
        gitDiff = await unwrap<ThreadGitDiffResponse>(
          client.api.v1.environments[":id"].diff.$get({
            param: { id: thread.environmentId },
            query: {
              ...(opts.diffSelection ? { selection: opts.diffSelection } : {}),
              ...(opts.diffMergeBase
                ? { mergeBaseBranch: opts.diffMergeBase }
                : {}),
            },
          }),
        );
      }

      let mergeBaseBranches: string[] | undefined;
      if (opts.mergeBaseBranches && thread.environmentId) {
        mergeBaseBranches = await unwrap<string[]>(
          client.api.v1.environments[":id"].diff.branches.$get({
            param: { id: thread.environmentId },
          }),
        );
      }

      if (opts.json) {
        const jsonPayload: ThreadShowJsonPayload = { ...statusPayload };
        if (workStatus !== undefined) {
          jsonPayload.workStatus = workStatus;
        }
        if (gitDiff !== undefined) {
          jsonPayload.gitDiff = gitDiff;
        }
        if (mergeBaseBranches !== undefined) {
          jsonPayload.mergeBaseBranches = mergeBaseBranches;
        }
        outputJson(opts, jsonPayload);
        return;
      }

      printThreadStatus(statusPayload);

      if (workStatus) {
        console.log("");
        console.log("Work status:");
        console.log(`  State:    ${workStatus.state}`);
        if (workStatus.currentBranch) {
          console.log(`  Branch:   ${workStatus.currentBranch}`);
        }
        console.log(
          `  Changed files: ${workStatus.changedFiles} (workspace: ${workStatus.workspaceChangedFiles})`,
        );
        console.log(
          `  Insertions:    +${workStatus.insertions} (workspace: +${workStatus.workspaceInsertions})`,
        );
        console.log(
          `  Deletions:     -${workStatus.deletions} (workspace: -${workStatus.workspaceDeletions})`,
        );
        console.log(
          `  Ahead: ${workStatus.aheadCount}  Behind: ${workStatus.behindCount}`,
        );
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
    }));

  parent
    .command("log [id]")
    .description("Show thread event log (defaults to BB_THREAD_ID)")
    .option("--json", "Print machine-readable JSON output (alias for --format json)")
    .option(
      "--format <format>",
      "Output format: json (raw events), minimal (compact timeline), verbose (full timeline)",
      "minimal",
    )
    .action(action(async (id: string | undefined, opts: ThreadLogCommandOptions) => {
      const client = createClient(getUrl());
      const resolved = requireThreadIdWithLabel(id);
      const threadId = resolved.id;
      printContextLabel(resolved, "Thread", "BB_THREAD_ID", opts);
      const format = resolveTimelineFormat(opts);

      const events = await unwrap<ThreadEventRow[]>(
        client.api.v1.threads[":id"].events.$get({
          param: { id: threadId },
          query: {},
        }),
      );

      if (format === "json") {
        console.log(JSON.stringify(events, null, 2));
        return;
      }

      const timeline = await unwrap<ThreadTimelineResponse>(
        client.api.v1.threads[":id"].timeline.$get({
          param: { id: threadId },
          query: {},
        }),
      );
      const messages = timeline.rows.flatMap((row) =>
        row.kind === "message" ? [row.message] : row.messages,
      );
      const color =
        process.stdout.isTTY === true &&
        !process.env.NO_COLOR;
      const text = formatTimelineAsText(messages, {
        verbose: format === "verbose",
        color,
      });
      console.log(text);
    }));

  parent
    .command("output <id>")
    .description("Get the final output of a thread")
    .option("--json", "Print machine-readable JSON output")
    .action(action(async (id: string, opts: ThreadOutputCommandOptions) => {
      const client = createClient(getUrl());
      const result = await unwrap<{ output: string | null }>(
        client.api.v1.threads[":id"].output.$get({
          param: { id },
        }),
      );
      if (outputJson(opts, result)) return;
      if (result.output) {
        console.log(result.output);
      } else {
        console.log("(no output)");
      }
    }));
}

function isLowSignalThreadStatusEventType(type: string): boolean {
  if (type.startsWith("client/")) return true;
  if (
    type === "turn/start" ||
    type === "turn/started" ||
    type === "turn/completed"
  ) {
    return true;
  }
  if (type === "item/started") return true;
  if (type.endsWith("/delta")) return true;
  if (type === "thread/tokenUsage/updated") return true;
  return false;
}

function buildThreadStatusPayload(
  thread: Thread,
  events: ThreadEventRow[],
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
  if (thread.archivedAt !== null) {
    console.log(`Archived: ${new Date(thread.archivedAt).toLocaleString()}`);
  }
  if (thread.environmentId) {
    console.log(`Environment ${thread.environmentId}`);
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

function printEvent(event: ThreadEventRow): void {
  const time = new Date(event.createdAt).toLocaleTimeString();
  const data =
    typeof event.data === "string"
      ? event.data
      : JSON.stringify(event.data, null, 2);

  if (event.type === "error") {
    console.log(`time=${time} level=error data=${data}`);
    return;
  }

  console.log(`time=${time} type=${event.type} data=${data}`);
}

function resolveTimelineFormat(opts: ThreadLogCommandOptions): TimelineFormat {
  if (opts.json) {
    return "json";
  }
  const normalized = (opts.format ?? "minimal").trim().toLowerCase();
  if (normalized === "json") {
    return "json";
  }
  if (normalized === "verbose") {
    return "verbose";
  }
  return "minimal";
}
