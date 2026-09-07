import { Command } from "commander";
import {
  threadStatusSchema,
  threadStatusValues,
  type ThreadStatus,
} from "@bb/domain";
import {
  threadCountGroupBySchema,
  THREAD_COUNT_ROOT_PARENT,
  type ThreadCountGroupBy,
} from "@bb/server-contract";
import type { ThreadCountResult } from "@bb/sdk";
import { action } from "../../action.js";
import { createCliBbSdk } from "../../client.js";
import { renderBorderlessTable } from "../../table.js";
import { joinValues, outputJson } from "../helpers.js";

interface ThreadCountCommandOptions {
  by?: string;
  host?: string;
  json?: boolean;
  parent?: string;
  project?: string;
  provider?: string;
  status?: string;
}

const GROUP_COLUMN_HEADS: Record<ThreadCountGroupBy, string> = {
  host: "Machine",
  provider: "Provider",
  project: "Project",
};

export function registerCountCommand(
  parent: Command,
  getUrl: () => string,
): void {
  parent
    .command("count")
    .description(
      "Count threads without listing them; excludes archived and hidden threads",
    )
    .option(
      "--status <status>",
      `Count threads in this status: ${joinValues(threadStatusValues)}`,
    )
    .option("--host <id>", "Count threads whose environment is on this machine")
    .option("--provider <id>", "Count threads running on this provider")
    .option("--project <id>", "Count threads in this project")
    .option(
      "--parent <id|none>",
      `Count children of this thread, or '${THREAD_COUNT_ROOT_PARENT}' for threads with no parent`,
    )
    .option("--by <dimension>", "Group the count by host, provider, or project")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: ThreadCountCommandOptions) => {
        const groupBy = parseGroupBy(opts.by);
        const result = await createCliBbSdk(getUrl()).threads.count({
          ...(opts.status ? { status: parseStatus(opts.status) } : {}),
          ...(opts.host ? { hostId: opts.host } : {}),
          ...(opts.provider ? { providerId: opts.provider } : {}),
          ...(opts.project ? { projectId: opts.project } : {}),
          ...(opts.parent ? { parentThreadId: opts.parent } : {}),
          ...(groupBy ? { groupBy } : {}),
        });
        if (outputJson(opts, result)) return;
        printThreadCount(result, groupBy);
      }),
    );
}

/**
 * An ungrouped count is one number, so it prints as one number: the common
 * `bb thread count --status active` call stays pipeable without --json.
 */
function printThreadCount(
  result: ThreadCountResult,
  groupBy: ThreadCountGroupBy | undefined,
): void {
  if (result.groups === undefined || groupBy === undefined) {
    console.log(String(result.total));
    return;
  }
  if (result.groups.length === 0) {
    console.log("No threads found");
    return;
  }
  printGroupTable(result, groupBy);
}

function printGroupTable(
  result: ThreadCountResult,
  groupBy: ThreadCountGroupBy,
): void {
  // Biggest group first: the reason to group is to find where the threads are.
  const groups = [...(result.groups ?? [])].sort(
    (left, right) =>
      right.count - left.count || compareGroupKeys(left.key, right.key),
  );
  const rows = groups.map((group) => [group.key ?? "-", String(group.count)]);
  const head = [GROUP_COLUMN_HEADS[groupBy], "Count"];
  const table = renderBorderlessTable(
    {
      head,
      colWidths: [
        columnWidth(rows, 0, head[0].length),
        columnWidth(rows, 1, head[1].length),
      ],
    },
    rows,
  );

  console.log("");
  console.log(table);
  console.log("");
  console.log(`Total: ${result.total}`);
}

/** Threads without a host/provider/project sort last under a "-" key. */
function compareGroupKeys(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left.localeCompare(right);
}

function columnWidth(
  rows: string[][],
  index: number,
  headWidth: number,
): number {
  return Math.max(headWidth, ...rows.map((row) => row[index].length));
}

function parseStatus(value: string): ThreadStatus {
  const parsed = threadStatusSchema.safeParse(value.trim());
  if (parsed.success) return parsed.data;
  throw new Error(
    `Invalid --status value '${value}'. Expected ${joinValues(threadStatusValues)}.`,
  );
}

function parseGroupBy(
  value: string | undefined,
): ThreadCountGroupBy | undefined {
  if (value === undefined) return undefined;
  const parsed = threadCountGroupBySchema.safeParse(value.trim());
  if (parsed.success) return parsed.data;
  throw new Error(
    `Invalid --by value '${value}'. Expected 'host', 'provider', or 'project'.`,
  );
}
