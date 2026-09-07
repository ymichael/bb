import { Command } from "commander";
import { PERSONAL_PROJECT_ID, type Thread } from "@bb/domain";
import { action } from "../../action.js";
import { createCliBbSdk } from "../../client.js";
import { resolveExplicitIdFlag } from "../../context-env.js";
import { renderBorderlessTable } from "../../table.js";
import { outputJson } from "../helpers.js";

interface ThreadListCommandOptions {
  environment?: string;
  project?: string;
  parentThread?: string;
  archived?: boolean;
  section?: string;
  unsectioned?: boolean;
  json?: boolean;
  includeHidden?: boolean;
}

export function registerListCommand(
  parent: Command,
  getUrl: () => string,
): void {
  parent
    .command("list")
    .description("List threads")
    .option("--project <id>", "Filter by project ID (defaults to all projects)")
    .option("--environment <id>", "Filter by environment ID")
    .option("--parent-thread <id>", "Filter by parent thread ID")
    .option("--section <id>", "Filter by thread section ID")
    .option("--unsectioned", "Show only threads outside sections")
    .option("--archived", "Show only archived threads")
    .option("--include-hidden", "Include hidden threads")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: ThreadListCommandOptions) => {
        const sdk = createCliBbSdk(getUrl());
        const projectId = resolveExplicitIdFlag({
          flagName: "--project flag",
          value: opts.project,
        });
        const parentThreadId = resolveExplicitIdFlag({
          flagName: "--parent-thread",
          value: opts.parentThread,
        });
        const environmentId = resolveExplicitIdFlag({
          flagName: "--environment",
          value: opts.environment,
        });
        if (opts.section && opts.unsectioned) {
          throw new Error("Cannot combine --section with --unsectioned.");
        }
        const sectionId = resolveExplicitIdFlag({
          flagName: "--section",
          value: opts.section,
        });
        const threads = await sdk.threads.list({
          ...(projectId ? { projectId } : {}),
          ...(environmentId ? { environmentId } : {}),
          ...(parentThreadId ? { parentThreadId } : {}),
          ...(opts.archived ? { archived: true } : {}),
          ...(sectionId ? { sectionId } : {}),
          ...(opts.unsectioned ? { unsectioned: true } : {}),
          ...(opts.includeHidden ? { includeHidden: true } : {}),
        });
        if (outputJson(opts, threads)) return;
        if (threads.length === 0) {
          console.log("No threads found");
          return;
        }
        const projects = await sdk.projects.list({ includePersonal: false });
        const projectNames = new Map(
          projects.map((project) => [project.id, project.name]),
        );
        printThreadTable(threads, projectNames);
      }),
    );
}

const MAX_TITLE_WIDTH = 60;

function printThreadTable(
  threads: Thread[],
  projectNames: ReadonlyMap<string, string>,
): void {
  const rows = threads.map((thread) => [
    thread.id,
    truncateCell(formatThreadListTitle(thread), MAX_TITLE_WIDTH),
    formatThreadListProject(thread, projectNames),
    formatThreadListStatus(thread),
  ]);
  const idWidth = Math.max(4, ...rows.map((row) => row[0].length));
  const titleWidth = Math.max(5, ...rows.map((row) => row[1].length));
  const projectWidth = Math.max(7, ...rows.map((row) => row[2].length));
  const statusWidth = Math.max(12, ...rows.map((row) => row[3].length));
  const table = renderBorderlessTable(
    {
      head: ["ID", "Title", "Project", "Status"],
      colWidths: [idWidth, titleWidth, projectWidth, statusWidth],
    },
    rows,
  );

  console.log("");
  console.log(table);
  console.log("");
}

function formatThreadListTitle(thread: Thread): string {
  const title = thread.title?.trim();
  if (title) return title;
  const fallback = thread.titleFallback?.trim();
  if (fallback) return fallback;
  return "-";
}

function formatThreadListProject(
  thread: Thread,
  projectNames: ReadonlyMap<string, string>,
): string {
  if (thread.projectId === PERSONAL_PROJECT_ID) return "-";
  return projectNames.get(thread.projectId) ?? thread.projectId;
}

function truncateCell(value: string, maxWidth: number): string {
  const singleLine = value.replace(/\s+/g, " ");
  if (singleLine.length <= maxWidth) return singleLine;
  return `${singleLine.slice(0, maxWidth - 1)}…`;
}

function formatThreadListStatus(thread: Thread): string {
  const flags: string[] = [];
  if (thread.archivedAt !== null) {
    flags.push("archived");
  }
  if (thread.pinnedAt !== null) {
    flags.push("pinned");
  }
  if (flags.length === 0) {
    return thread.status;
  }
  return `${thread.status} (${flags.join(", ")})`;
}
