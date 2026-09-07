import { Command } from "commander";
import {
  formatThreadTimelineText,
  type ThreadTimelineTextFormat,
} from "@bb/thread-view";
import {
  resolveEnvironmentMergeBaseBranch,
  type Environment,
  type Thread,
  type ThreadEventRow,
  type ThreadGitDiffResponse,
  type ThreadPullRequest,
  type ThreadTimelinePendingTodos,
  type WorkspaceStatus,
} from "@bb/domain";
import type { BbSdk } from "@bb/sdk";
import type {
  EnvironmentDiffQuery,
  ThreadTimelineResponse,
} from "@bb/server-contract";
import { action } from "../../action.js";
import { createCliBbSdk } from "../../client.js";
import {
  getErrorMessage,
  outputJson,
  requireThreadIdOrSelf,
} from "../helpers.js";
import {
  type ThreadEnvironmentInfo,
  fetchEnvironmentInfo,
  printEnvironmentInfo,
} from "../environment-helpers.js";
import { fetchThreadPendingTodos, printPendingTodos } from "./pending-todos.js";

interface ThreadShowCommandOptions {
  self?: boolean;
  workStatus?: boolean;
  gitDiff?: boolean;
  diffTarget?: string;
  diffSha?: string;
  diffMergeBase?: string;
  json?: boolean;
}

interface ThreadLogCommandOptions {
  self?: boolean;
  json?: boolean;
  format?: string;
  limit?: string;
  afterSeq?: string;
  all?: boolean;
}

const THREAD_LOG_DEFAULT_EVENT_LIMIT = 100;
const THREAD_LOG_ALL_EVENTS_PAGE_SIZE = 1000;
const THREAD_LOG_TIMELINE_SEGMENT_LIMIT_MAX = 100;

interface ThreadOutputCommandOptions {
  json?: boolean;
  self?: boolean;
}

interface ThreadStatusPayload {
  thread: Thread;
}

type ThreadShowEnvironmentJsonPayload = Environment & {
  pullRequest: ThreadShowPullRequestPayload;
};

interface ThreadShowJsonPayload extends ThreadStatusPayload {
  environment: ThreadShowEnvironmentJsonPayload | null;
  pendingTodos: ThreadTimelinePendingTodos | null;
  workStatus?: WorkspaceStatus | null;
  gitDiff?: ThreadGitDiffResponse | null;
}

interface ThreadShowPullRequestPayload {
  status: "available" | "none" | "unavailable";
  pullRequest: ThreadPullRequest | null;
  message?: string;
}

type FetchedWorkStatus =
  | { available: true; status: WorkspaceStatus }
  | { available: false; message: string };

type FetchedGitDiff =
  | { available: true; diff: ThreadGitDiffResponse }
  | { available: false; message: string };

type FetchedPullRequest = ThreadShowPullRequestPayload;

type CliEnvironmentDiffQuery =
  | { target: "uncommitted" }
  | { mergeBaseBranch?: string; target: "branch_committed" }
  | { mergeBaseBranch?: string; target: "all" }
  | { sha: string; target: "commit" };

async function fetchWorkStatus(args: {
  environmentId: string;
  mergeBaseBranch: string;
  sdk: BbSdk;
}): Promise<FetchedWorkStatus> {
  const environmentStatus = await args.sdk.environments.status({
    environmentId: args.environmentId,
    mergeBaseBranch: args.mergeBaseBranch,
  });
  if (environmentStatus.outcome === "available") {
    return { available: true, status: environmentStatus.workspace };
  }
  if (environmentStatus.outcome === "not_applicable") {
    return { available: false, message: environmentStatus.message };
  }
  return { available: false, message: environmentStatus.failure.message };
}

async function fetchGitDiff(args: {
  environmentId: string;
  query: EnvironmentDiffQuery;
  sdk: BbSdk;
}): Promise<FetchedGitDiff> {
  const environmentDiff = await args.sdk.environments.diff({
    environmentId: args.environmentId,
    ...args.query,
  });
  if (environmentDiff.outcome === "available") {
    return { available: true, diff: environmentDiff.diff };
  }
  if (environmentDiff.outcome === "not_applicable") {
    return { available: false, message: environmentDiff.message };
  }
  return { available: false, message: environmentDiff.failure.message };
}

async function fetchPullRequest(args: {
  environmentId: string;
  sdk: BbSdk;
}): Promise<FetchedPullRequest> {
  try {
    const response = await args.sdk.environments.pullRequest({
      environmentId: args.environmentId,
    });
    if (response.outcome === "available") {
      return {
        status: "available",
        pullRequest: response.pullRequest,
      };
    }
    if (response.outcome === "unavailable") {
      return {
        status: "unavailable",
        pullRequest: null,
        message: response.message,
      };
    }
    return {
      status: "none",
      pullRequest: null,
    };
  } catch (err) {
    return {
      status: "unavailable",
      pullRequest: null,
      message: getErrorMessage(err),
    };
  }
}

function threadShowEnvironmentJson(
  environment: Environment | null,
  pullRequest: FetchedPullRequest | null,
): ThreadShowEnvironmentJsonPayload | null {
  if (!environment) {
    return null;
  }
  return {
    ...environment,
    pullRequest: pullRequest ?? {
      status: "unavailable",
      pullRequest: null,
      message: "Pull request lookup was not run.",
    },
  };
}

export function registerShowCommand(
  parent: Command,
  getUrl: () => string,
): void {
  parent
    .command("show [id]")
    .description("Show thread details and pull request status")
    .option("--self", "Target the current thread (from BB_THREAD_ID)")
    .option("--json", "Print machine-readable JSON output")
    .option("--work-status", "Include work status (git state) in output")
    .option("--git-diff", "Include git diff in output")
    .option(
      "--diff-target <type>",
      "Diff target: uncommitted, branch_committed, all, or commit (used with --git-diff)",
      "all",
    )
    .option("--diff-sha <sha>", "Commit SHA for --diff-target commit")
    .option(
      "--diff-merge-base <branch>",
      "Merge base branch for --diff-target branch_committed or all",
    )
    .action(
      action(async (id: string | undefined, opts: ThreadShowCommandOptions) => {
        const threadId = requireThreadIdOrSelf(id, opts);
        const sdk = createCliBbSdk(getUrl());
        const thread = await sdk.threads.get({ threadId });

        const statusPayload: ThreadStatusPayload = { thread };
        let environment: Environment | null | undefined;
        const getEnvironment = async () => {
          if (!thread.environmentId) {
            return null;
          }
          if (environment !== undefined) {
            return environment;
          }
          environment = await sdk.environments.get({
            environmentId: thread.environmentId,
          });
          return environment;
        };
        const requireMergeBaseBranch = async (override?: string) => {
          const environment = await getEnvironment();
          const mergeBaseBranch =
            override ?? resolveEnvironmentMergeBaseBranch(environment);
          if (!mergeBaseBranch) {
            throw new Error(
              "Thread environment does not have a merge base branch",
            );
          }
          return mergeBaseBranch;
        };

        let fetchedWorkStatus: FetchedWorkStatus | undefined;
        if (opts.workStatus && thread.environmentId) {
          const mergeBaseBranch = await requireMergeBaseBranch();
          fetchedWorkStatus = await fetchWorkStatus({
            environmentId: thread.environmentId,
            mergeBaseBranch,
            sdk,
          });
        }

        let fetchedGitDiff: FetchedGitDiff | undefined;
        if (opts.gitDiff && thread.environmentId) {
          const diffTarget = (opts.diffTarget ?? "all").trim();
          const query: CliEnvironmentDiffQuery = (() => {
            switch (diffTarget) {
              case "uncommitted":
                return { target: "uncommitted" };
              case "branch_committed":
                return {
                  target: "branch_committed",
                  mergeBaseBranch: opts.diffMergeBase,
                };
              case "all":
                return {
                  target: "all",
                  mergeBaseBranch: opts.diffMergeBase,
                };
              case "commit":
                if (!opts.diffSha) {
                  throw new Error(
                    "--diff-sha is required when --diff-target commit is used",
                  );
                }
                return {
                  target: "commit",
                  sha: opts.diffSha,
                };
              default:
                throw new Error(
                  "Unsupported --diff-target. Use uncommitted, branch_committed, all, or commit.",
                );
            }
          })();
          const resolvedQuery: EnvironmentDiffQuery =
            query.target === "branch_committed" || query.target === "all"
              ? {
                  target: query.target,
                  mergeBaseBranch: await requireMergeBaseBranch(
                    query.mergeBaseBranch,
                  ),
                }
              : query;
          fetchedGitDiff = await fetchGitDiff({
            environmentId: thread.environmentId,
            query: resolvedQuery,
            sdk,
          });
        }

        const fetchedPullRequest = thread.environmentId
          ? await fetchPullRequest({
              environmentId: thread.environmentId,
              sdk,
            })
          : null;

        const environmentInfo = thread.environmentId
          ? await fetchEnvironmentInfo({
              environmentId: thread.environmentId,
              sdk,
            })
          : null;

        const pendingTodos = await fetchThreadPendingTodos({
          sdk,
          threadId,
        });

        if (opts.json) {
          const environment = await getEnvironment();
          const jsonPayload: ThreadShowJsonPayload = {
            ...statusPayload,
            environment: threadShowEnvironmentJson(
              environment,
              fetchedPullRequest,
            ),
            pendingTodos,
          };
          if (fetchedWorkStatus !== undefined) {
            jsonPayload.workStatus = fetchedWorkStatus.available
              ? fetchedWorkStatus.status
              : null;
          }
          if (fetchedGitDiff !== undefined) {
            jsonPayload.gitDiff = fetchedGitDiff.available
              ? fetchedGitDiff.diff
              : null;
          }
          outputJson(opts, jsonPayload);
          return;
        }

        printThreadStatus(statusPayload, environmentInfo, fetchedPullRequest);

        printPendingTodos(pendingTodos);

        if (fetchedWorkStatus !== undefined) {
          if (fetchedWorkStatus.available) {
            const ws = fetchedWorkStatus.status;
            console.log("");
            console.log("Work status:");
            console.log(`  State:    ${ws.workingTree.state}`);
            if (ws.branch.currentBranch) {
              console.log(`  Branch:   ${ws.branch.currentBranch}`);
            }
            console.log(`  Changed files: ${ws.workingTree.files.length}`);
            if (ws.workingTree.lineStatsComplete) {
              console.log(`  Insertions:    +${ws.workingTree.insertions}`);
              console.log(`  Deletions:     -${ws.workingTree.deletions}`);
            } else {
              console.log("  Line stats: unavailable for untracked files");
            }
            if (ws.mergeBase) {
              console.log(`  Merge base:   ${ws.mergeBase.mergeBaseBranch}`);
              console.log(
                `  Ahead: ${ws.mergeBase.aheadCount}  Behind: ${ws.mergeBase.behindCount}`,
              );
            }
          } else {
            console.log("");
            console.log(`Work status: ${fetchedWorkStatus.message}`);
          }
        }

        if (fetchedGitDiff) {
          console.log("");
          if (fetchedGitDiff.available) {
            const gitDiff = fetchedGitDiff.diff;
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
          } else {
            console.log(`Git diff: ${fetchedGitDiff.message}`);
          }
        }
      }),
    );

  parent
    .command("log [id]")
    .description("Show thread event log")
    .option("--self", "Target the current thread (from BB_THREAD_ID)")
    .option(
      "--json",
      "Print machine-readable JSON output (alias for --format json)",
    )
    .option(
      "--format <format>",
      "Output format: json (raw events), minimal (compact timeline), verbose (expanded timeline)",
      "minimal",
    )
    .option(
      "--limit <count>",
      `Maximum entries to print: events for json (oldest first, default ${THREAD_LOG_DEFAULT_EVENT_LIMIT}); user-message turns for minimal/verbose (newest first, default 20, max ${THREAD_LOG_TIMELINE_SEGMENT_LIMIT_MAX})`,
    )
    .option(
      "--after-seq <seq>",
      "Return events after this sequence number; json format only",
    )
    .option(
      "--all",
      "Print the whole thread by paging through every entry (cannot be combined with --limit)",
    )
    .action(
      action(async (id: string | undefined, opts: ThreadLogCommandOptions) => {
        const threadId = requireThreadIdOrSelf(id, opts);
        const sdk = createCliBbSdk(getUrl());
        const format = resolveThreadTimelineTextFormat(opts);

        if (opts.all && opts.limit !== undefined) {
          throw new Error("--all cannot be combined with --limit");
        }
        if (format !== "json" && opts.afterSeq !== undefined) {
          throw new Error("--after-seq is only supported with --format json");
        }

        if (format === "json") {
          const events = opts.all
            ? await listAllThreadLogEvents(sdk, threadId, opts.afterSeq)
            : await listThreadLogEventsPage(sdk, {
                threadId,
                limit: parseThreadLogLimit(
                  opts.limit,
                  THREAD_LOG_DEFAULT_EVENT_LIMIT,
                ),
                afterSeq: opts.afterSeq,
              });
          console.log(JSON.stringify(events.rows, null, 2));
          if (events.hasMore) {
            const lastSeq = events.rows[events.rows.length - 1]?.seq;
            console.error(
              `Showing the oldest ${events.rows.length} events${
                opts.afterSeq === undefined ? "" : ` after seq ${opts.afterSeq}`
              }; more exist. Use --after-seq ${lastSeq} for the next page or --all for the whole thread.`,
            );
          }
          return;
        }

        const segmentLimit = opts.all
          ? THREAD_LOG_TIMELINE_SEGMENT_LIMIT_MAX
          : parseThreadLogLimit(opts.limit, null);
        if (
          segmentLimit !== null &&
          segmentLimit > THREAD_LOG_TIMELINE_SEGMENT_LIMIT_MAX
        ) {
          throw new Error(
            `--limit must be at most ${THREAD_LOG_TIMELINE_SEGMENT_LIMIT_MAX} for minimal/verbose formats; use --all for the whole thread.`,
          );
        }
        const timelineQuery = {
          threadId,
          ...(format === "verbose"
            ? { includeNestedRows: "true" as const }
            : {}),
          ...(segmentLimit === null
            ? {}
            : { segmentLimit: String(segmentLimit) }),
        };
        const timeline: ThreadTimelineResponse =
          await sdk.threads.timeline(timelineQuery);
        let rows = timeline.rows;
        let page = timeline.timelinePage;
        while (opts.all && page.hasOlderRows && page.olderCursor !== null) {
          const older: ThreadTimelineResponse = await sdk.threads.timeline({
            ...timelineQuery,
            beforeAnchorSeq: String(page.olderCursor.anchorSeq),
            beforeAnchorId: page.olderCursor.anchorId,
          });
          rows = [...older.rows, ...rows];
          page = older.timelinePage;
        }
        const color = process.stdout.isTTY === true && !process.env.NO_COLOR;
        const text = formatThreadTimelineText(rows, {
          verbose: format === "verbose",
          color,
        });
        const notice = page.hasOlderRows
          ? `(Showing the newest ${page.returnedSegmentCount} user-message turns; older history omitted. Use --limit <n> (max ${THREAD_LOG_TIMELINE_SEGMENT_LIMIT_MAX}) or --all to see more.)`
          : null;
        console.log(notice === null ? text : `${text}\n\n${notice}`);
      }),
    );

  parent
    .command("output [id]")
    .description("Get the final output of a thread")
    .option("--self", "Target the current thread (from BB_THREAD_ID)")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (id: string | undefined, opts: ThreadOutputCommandOptions) => {
          const threadId = requireThreadIdOrSelf(id, opts);
          const sdk = createCliBbSdk(getUrl());
          const result = await sdk.threads.output({ threadId });
          if (outputJson(opts, result)) return;
          if (result.output) {
            console.log(result.output);
          } else {
            console.log("(no output)");
          }
        },
      ),
    );
}

function printThreadStatus(
  payload: ThreadStatusPayload,
  environmentInfo: ThreadEnvironmentInfo | null,
  pullRequest: FetchedPullRequest | null,
): void {
  const { thread } = payload;
  console.log(`Thread: ${thread.id}`);
  console.log(`  Status: ${thread.status}`);
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
  if (thread.pinnedAt !== null) {
    console.log(`  Pinned: ${new Date(thread.pinnedAt).toLocaleString()}`);
  }
  if (environmentInfo) {
    printEnvironmentInfo(environmentInfo);
    printEnvironmentPullRequest(pullRequest);
  } else if (thread.environmentId) {
    console.log(`  Environment: ${thread.environmentId}`);
    printEnvironmentPullRequest(pullRequest);
  }
  console.log(`  Created: ${new Date(thread.createdAt).toLocaleString()}`);
  console.log(`  Updated: ${new Date(thread.updatedAt).toLocaleString()}`);
}

function printEnvironmentPullRequest(
  pullRequest: FetchedPullRequest | null,
): void {
  if (!pullRequest) {
    return;
  }

  if (pullRequest.status === "unavailable") {
    console.log("    Pull request: unavailable");
    if (pullRequest.message) {
      console.log(`      ${pullRequest.message}`);
    }
    return;
  }

  if (pullRequest.status === "none") {
    console.log("    Pull request: none");
    return;
  }

  const pr = pullRequest.pullRequest;
  if (!pr) {
    console.log("    Pull request: none");
    return;
  }
  console.log(`    Pull request: #${pr.number} ${pr.state} - ${pr.title}`);
  console.log(`    URL:          ${pr.url}`);
  console.log(`    Branch:       ${pr.headRefName} -> ${pr.baseRefName}`);
  console.log(`    Attention:    ${pr.attention}`);
  console.log(
    `    Checks:       ${pr.checks.state} (${pr.checks.passedCount} passed, ` +
      `${pr.checks.failedCount} failed, ${pr.checks.pendingCount} pending, ` +
      `${pr.checks.totalCount} total)`,
  );
  console.log(
    `    Review:       ${pr.review.state} (${pr.review.reviewRequestCount} requested)`,
  );
  console.log(`    Merge:        ${pr.mergeability.state}`);
}

function parseThreadLogLimit<TDefault extends number | null>(
  value: string | undefined,
  defaultLimit: TDefault,
): number | TDefault {
  if (value === undefined) return defaultLimit;
  if (!/^\d+$/u.test(value) || Number(value) < 1) {
    throw new Error("--limit must be a positive integer.");
  }
  return Number(value);
}

interface ThreadLogEventsPage {
  rows: ThreadEventRow[];
  hasMore: boolean;
}

async function listThreadLogEventsPage(
  sdk: BbSdk,
  args: { threadId: string; limit: number; afterSeq: string | undefined },
): Promise<ThreadLogEventsPage> {
  const rows = await sdk.threads.events.list({
    threadId: args.threadId,
    limit: String(args.limit + 1),
    ...(args.afterSeq === undefined ? {} : { afterSeq: args.afterSeq }),
  });
  const hasMore = rows.length > args.limit;
  return { rows: hasMore ? rows.slice(0, args.limit) : rows, hasMore };
}

async function listAllThreadLogEvents(
  sdk: BbSdk,
  threadId: string,
  afterSeq: string | undefined,
): Promise<ThreadLogEventsPage> {
  const rows: ThreadEventRow[] = [];
  let cursor = afterSeq;
  for (;;) {
    const page = await sdk.threads.events.list({
      threadId,
      limit: String(THREAD_LOG_ALL_EVENTS_PAGE_SIZE),
      ...(cursor === undefined ? {} : { afterSeq: cursor }),
    });
    rows.push(...page);
    const last = page[page.length - 1];
    if (last === undefined || page.length < THREAD_LOG_ALL_EVENTS_PAGE_SIZE) {
      return { rows, hasMore: false };
    }
    cursor = String(last.seq);
  }
}

function resolveThreadTimelineTextFormat(
  opts: ThreadLogCommandOptions,
): ThreadTimelineTextFormat {
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
