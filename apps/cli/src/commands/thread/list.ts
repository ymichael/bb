import { Command } from "commander";
import type { Thread } from "@bb/domain";
import { action } from "../../action.js";
import { createClient, unwrap } from "../../client.js";
import { resolveThreadId } from "../../context-env.js";
import { renderBorderlessTable } from "../../table.js";
import {
  outputJson,
  printContextLabel,
  type ResolvedId,
} from "../helpers.js";
import { statusText } from "./helpers.js";

interface ThreadListCommandOptions {
  project?: string;
  parentThread?: string;
  archived?: boolean;
  json?: boolean;
}

export function registerListCommand(
  parent: Command,
  getUrl: () => string,
): void {
  parent
    .command("list")
    .description("List threads")
    .option("--project <id>", "Filter by project ID (defaults to BB_PROJECT_ID)")
    .option("--parent-thread <id>", "Filter by managing parent thread ID")
    .option("--archived", "Show only archived threads")
    .option("--json", "Print machine-readable JSON output")
    .action(action(async (opts: ThreadListCommandOptions) => {
      const client = createClient(getUrl());
      const resolvedProject = resolveProjectContext(opts.project);
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
            ...(opts.archived ? { archived: "true" } : {}),
          },
        }),
      );
      if (outputJson(opts, threads)) return;
      if (threads.length === 0) {
        console.log("No threads found");
        return;
      }
      printThreadTable(threads);
    }));
}

function resolveProjectContext(
  projectId: string | undefined,
): ResolvedId | undefined {
  if (projectId) {
    return { id: projectId, source: "arg" };
  }
  const envProjectId = process.env.BB_PROJECT_ID?.trim();
  if (envProjectId) {
    return { id: envProjectId, source: "env" };
  }
  return undefined;
}

function printThreadTable(threads: Thread[]): void {
  const rows = threads.map((thread) => [
    thread.id,
    thread.projectId,
    thread.archivedAt !== null
      ? `${statusText(thread.status)} (archived)`
      : statusText(thread.status),
  ]);
  const idWidth = Math.max(4, ...rows.map((row) => row[0].length));
  const projectWidth = Math.max(7, ...rows.map((row) => row[1].length));
  const statusWidth = Math.max(12, ...rows.map((row) => row[2].length));
  const table = renderBorderlessTable(
    {
      head: ["ID", "Project", "Status"],
      colWidths: [idWidth, projectWidth, statusWidth],
    },
    rows,
  );

  console.log("");
  console.log(table);
  console.log("");
}
