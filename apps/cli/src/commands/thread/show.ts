import { Command } from "commander";
import {
  formatTimelineAsText,
  type TimelineFormat,
} from "@bb/core-ui";
import {
  type Environment,
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
import { createClient, type Client, unwrap } from "../../client.js";
import {
  outputJson,
  printContextLabel,
  requireThreadIdWithLabelOrSelf,
} from "../helpers.js";
import {
  type ThreadEnvironmentInfo,
  fetchEnvironmentInfo,
  printEnvironmentInfo,
} from "../environment-helpers.js";
import { statusText } from "./helpers.js";

interface ThreadShowCommandOptions {
  self?: boolean;
  workStatus?: boolean;
  gitDiff?: boolean;
  diffTarget?: string;
  diffSha?: string;
  diffMergeBase?: string;
  mergeBaseBranches?: boolean;
  json?: boolean;
}

interface ThreadLogCommandOptions {
  self?: boolean;
  json?: boolean;
  format?: string;
  limit?: string;
  afterSeq?: string;
}

interface ThreadOutputCommandOptions {
  json?: boolean;
}

interface ThreadStatusPayload {
  thread: Thread;
}

interface ThreadShowJsonPayload extends ThreadStatusPayload {
  environment: Environment | null;
  workStatus?: WorkspaceStatus | null;
  gitDiff?: ThreadGitDiffResponse;
  mergeBaseBranches?: string[];
}

type FetchedWorkStatus =
  | { available: true; status: WorkspaceStatus }
  | { available: false };

async function fetchWorkStatus(args: {
  client: Client;
  environmentId: string;
  mergeBaseBranch: string;
}): Promise<FetchedWorkStatus> {
  const environmentStatus = await unwrap<EnvironmentStatusResponse>(
    args.client.api.v1.environments[":id"].status.$get({
      param: { id: args.environmentId },
      query: { mergeBaseBranch: args.mergeBaseBranch },
    }),
  );
  if (environmentStatus.workspace === null) {
    return { available: false };
  }
  return { available: true, status: environmentStatus.workspace };
}

export function registerShowCommand(
  parent: Command,
  getUrl: () => string,
): void {
  parent
    .command("show [id]")
    .description("Show thread details (defaults to BB_THREAD_ID)")
    .option("--self", "Target the current thread (from BB_THREAD_ID)")
    .option("--json", "Print machine-readable JSON output")
    .option("--work-status", "Include work status (git state) in output")
    .option("--git-diff", "Include git diff in output")
    .option(
      "--diff-target <type>",
      "Diff target: uncommitted, branch_committed, all, or commit (used with --git-diff)",
      "all",
    )
    .option(
      "--diff-sha <sha>",
      "Commit SHA for --diff-target commit",
    )
    .option(
      "--diff-merge-base <branch>",
      "Merge base branch for --diff-target branch_committed or all",
    )
    .option("--merge-base-branches", "Include available merge-base branches in output")
    .action(action(async (id: string | undefined, opts: ThreadShowCommandOptions) => {
      const resolved = requireThreadIdWithLabelOrSelf(id, opts);
      const client = createClient(getUrl());
      const threadId = resolved.id;
      printContextLabel(resolved, "Thread", "BB_THREAD_ID", opts);
      const thread = await unwrap<Thread>(
        client.api.v1.threads[":id"].$get({ param: { id: threadId } }),
      );

      const statusPayload: ThreadStatusPayload = { thread };
      let environment: Environment | null | undefined;
      const getEnvironment = async () => {
        if (!thread.environmentId) {
          return null;
        }
        if (environment !== undefined) {
          return environment;
        }
        environment = await unwrap<Environment>(
          client.api.v1.environments[":id"].$get({
            param: { id: thread.environmentId },
          }),
        );
        return environment;
      };
      const requireMergeBaseBranch = async (override?: string) => {
        const environment = await getEnvironment();
        const mergeBaseBranch =
          override ??
          environment?.mergeBaseBranch ??
          environment?.defaultBranch ??
          undefined;
        if (!mergeBaseBranch) {
          throw new Error("Thread environment does not have a merge base branch");
        }
        return mergeBaseBranch;
      };

      let fetchedWorkStatus: FetchedWorkStatus | undefined;
      if (opts.workStatus && thread.environmentId) {
        const mergeBaseBranch = await requireMergeBaseBranch();
        fetchedWorkStatus = await fetchWorkStatus({
          client,
          environmentId: thread.environmentId,
          mergeBaseBranch,
        });
      }

      let gitDiff: ThreadGitDiffResponse | undefined;
      if (opts.gitDiff && thread.environmentId) {
        const diffTarget = (opts.diffTarget ?? "all").trim();
        const query = (() => {
          switch (diffTarget) {
            case "uncommitted":
              return { target: "uncommitted" as const };
            case "branch_committed":
              return {
                target: "branch_committed" as const,
                mergeBaseBranch: opts.diffMergeBase,
              };
            case "all":
              return {
                target: "all" as const,
                mergeBaseBranch: opts.diffMergeBase,
              };
            case "commit":
              if (!opts.diffSha) {
                throw new Error("--diff-sha is required when --diff-target commit is used");
              }
              return {
                target: "commit" as const,
                sha: opts.diffSha,
              };
            default:
              throw new Error(
                "Unsupported --diff-target. Use uncommitted, branch_committed, all, or commit.",
              );
          }
        })();
        const resolvedQuery =
          query.target === "branch_committed" || query.target === "all"
            ? {
                ...query,
                mergeBaseBranch: await requireMergeBaseBranch(query.mergeBaseBranch),
              }
            : query;
        gitDiff = await unwrap<ThreadGitDiffResponse>(
          client.api.v1.environments[":id"].diff.$get({
            param: { id: thread.environmentId },
            query: resolvedQuery,
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

      const environmentInfo = thread.environmentId
        ? await fetchEnvironmentInfo({ client, environmentId: thread.environmentId })
        : null;

      if (opts.json) {
        const jsonPayload: ThreadShowJsonPayload = {
          ...statusPayload,
          environment: await getEnvironment(),
        };
        if (fetchedWorkStatus !== undefined) {
          jsonPayload.workStatus = fetchedWorkStatus.available
            ? fetchedWorkStatus.status
            : null;
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

      printThreadStatus(statusPayload, environmentInfo);

      if (fetchedWorkStatus !== undefined) {
        if (fetchedWorkStatus.available) {
          const ws = fetchedWorkStatus.status;
          console.log("");
          console.log("Work status:");
          console.log(`  State:    ${ws.workingTree.state}`);
          if (ws.branch.currentBranch) {
            console.log(`  Branch:   ${ws.branch.currentBranch}`);
          }
          console.log(
            `  Changed files: ${ws.workingTree.files.length}`,
          );
          console.log(
            `  Insertions:    +${ws.workingTree.insertions}`,
          );
          console.log(
            `  Deletions:     -${ws.workingTree.deletions}`,
          );
          if (ws.mergeBase) {
            console.log(`  Merge base:   ${ws.mergeBase.mergeBaseBranch}`);
            console.log(
              `  Ahead: ${ws.mergeBase.aheadCount}  Behind: ${ws.mergeBase.behindCount}`,
            );
          }
        } else {
          console.log("");
          console.log("Work status: unavailable");
        }
      }

      if (gitDiff) {
        console.log("");
        console.log("Git diff:");
        if (gitDiff.files.trim().length > 0) {
          console.log(`  Files:\n${gitDiff.files.trimEnd()}`);
        }
        if (gitDiff.shortstat.trim().length > 0) {
          console.log(`  Summary: ${gitDiff.shortstat.trim()}`);
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
    .option("--self", "Target the current thread (from BB_THREAD_ID)")
    .option("--json", "Print machine-readable JSON output (alias for --format json)")
    .option(
      "--format <format>",
      "Output format: json (raw events), minimal (compact timeline), verbose (full timeline)",
      "minimal",
    )
    .option("--limit <count>", "Maximum number of events to return; json format only (default 100)")
    .option("--after-seq <seq>", "Return events after this sequence number; json format only")
    .action(action(async (id: string | undefined, opts: ThreadLogCommandOptions) => {
      const resolved = requireThreadIdWithLabelOrSelf(id, opts);
      const client = createClient(getUrl());
      const threadId = resolved.id;
      printContextLabel(resolved, "Thread", "BB_THREAD_ID", opts);
      const format = resolveTimelineFormat(opts);

      if (format !== "json" && (opts.limit || opts.afterSeq)) {
        throw new Error("--limit and --after-seq are only supported with --format json");
      }

      const events = await unwrap<ThreadEventRow[]>(
        client.api.v1.threads[":id"].events.$get({
          param: { id: threadId },
          query: {
            limit: String(opts.limit ?? 100),
            ...(opts.afterSeq ? { afterSeq: opts.afterSeq } : {}),
          },
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
      const color =
        process.stdout.isTTY === true &&
        !process.env.NO_COLOR;
      const text = formatTimelineAsText(timeline.rows, {
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

function printThreadStatus(
  payload: ThreadStatusPayload,
  environmentInfo: ThreadEnvironmentInfo | null,
): void {
  const { thread } = payload;
  console.log(`Thread: ${thread.id}`);
  console.log(`  Type: ${thread.type}`);
  console.log(`  Status: ${statusText(thread.status)}`);
  if (thread.title) {
    console.log(`  Title: ${thread.title}`);
  }
  console.log(`  Project: ${thread.projectId}`);
  if (thread.parentThreadId) {
    console.log(`  Parent: ${thread.parentThreadId}`);
  }
  if (thread.archivedAt !== null) {
    console.log(`  Archived: ${new Date(thread.archivedAt).toLocaleString()}`);
  }
  if (environmentInfo) {
    printEnvironmentInfo(environmentInfo);
  } else if (thread.environmentId) {
    console.log(`  Environment: ${thread.environmentId}`);
  }
  console.log(`  Created: ${new Date(thread.createdAt).toLocaleString()}`);
  console.log(`  Updated: ${new Date(thread.updatedAt).toLocaleString()}`);
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
