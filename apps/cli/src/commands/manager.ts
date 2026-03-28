import { Command } from "commander";
import { type Thread } from "@bb/domain";
import { action } from "../action.js";
import { createClient, unwrap } from "../client.js";
import { requireThreadId } from "../context-env.js";
import { renderBorderlessTable } from "../table.js";
import {
  confirmDestructiveAction,
  outputJson,
  parseReasoningLevel,
  printContextLabel,
  requireProjectIdWithLabel,
} from "./helpers.js";

interface ManagerHireCommandOptions {
  json?: boolean;
  project?: string;
  name?: string;
  provider: string;
  model: string;
  reasoningLevel: string;
}

interface ManagerListCommandOptions {
  json?: boolean;
  project?: string;
}

interface ManagerStatusCommandOptions {
  json?: boolean;
}

interface ManagerDeleteCommandOptions {
  yes?: boolean;
  json?: boolean;
}

export function registerManagerCommands(program: Command, getUrl: () => string): void {
  const manager = program.command("manager").description("Manage project managers");

  manager
    .command("hire [projectId]")
    .description("Hire a new manager for a project")
    .option("--project <id>", "Project ID (defaults to BB_PROJECT_ID)")
    .option("--name <name>", "Manager name")
    .requiredOption("--provider <id>", "Provider ID for the manager (e.g. claude-code, codex)")
    .requiredOption("--model <model>", "Model ID for the manager")
    .requiredOption("--reasoning-level <level>", "Reasoning level (low, medium, high, xhigh)")
    .option("--json", "Print machine-readable JSON output")
    .action(action(async (
      projectIdArg: string | undefined,
      opts: ManagerHireCommandOptions,
    ) => {
      const client = createClient(getUrl());
      const resolvedProject = requireProjectIdWithLabel(projectIdArg ?? opts.project);
      const projectId = resolvedProject.id;
      printContextLabel(resolvedProject, "Project", "BB_PROJECT_ID", opts);
      const reasoningLevel = parseReasoningLevel(opts.reasoningLevel);
      if (!reasoningLevel) {
        throw new Error("Manager reasoning level is required");
      }
      const thread = await unwrap<Thread>(
        client.api.v1.projects[":id"].managers.$post({
          param: { id: projectId },
          json: {
            ...(opts.name ? { name: opts.name } : {}),
            providerId: opts.provider,
            model: opts.model,
            reasoningLevel,
          },
        }),
      );
      if (outputJson(opts, thread)) return;
      console.log(`Manager hired: ${thread.id}`);
      printManagerThread(thread);
    }));

  manager
    .command("list [projectId]")
    .description("List managers for a project")
    .option("--project <id>", "Project ID (defaults to BB_PROJECT_ID)")
    .option("--json", "Print machine-readable JSON output")
    .action(action(async (
      projectIdArg: string | undefined,
      opts: ManagerListCommandOptions,
    ) => {
      const client = createClient(getUrl());
      const resolvedProject = requireProjectIdWithLabel(projectIdArg ?? opts.project);
      const projectId = resolvedProject.id;
      printContextLabel(resolvedProject, "Project", "BB_PROJECT_ID", opts);
      const managers = await unwrap<Thread[]>(
        client.api.v1.threads.$get({
          query: { projectId, type: "manager" },
        }),
      );
      if (outputJson(opts, managers)) return;
      if (managers.length === 0) {
        console.log("No managers hired");
        return;
      }
      printManagerTable(managers);
    }));

  manager
    .command("status <id>")
    .description("Show manager status and managed threads")
    .option("--json", "Print machine-readable JSON output")
    .action(action(async (id: string, opts: ManagerStatusCommandOptions) => {
      const client = createClient(getUrl());
      const managerThreadId = requireThreadId(id);
      const managerThread = await getManagerThreadById(client, managerThreadId);
      const managedThreads = await listManagedThreads(client, managerThreadId);
      if (outputJson(opts, { manager: managerThread, managedThreads })) return;
      printManagerThread(managerThread);
      printManagedThreadTable(managedThreads);
    }));

  manager
    .command("delete <id>")
    .description("Delete a manager permanently")
    .option("--yes", "Skip the confirmation prompt")
    .option("--json", "Print machine-readable JSON output")
    .action(action(async (id: string, opts: ManagerDeleteCommandOptions) => {
      const client = createClient(getUrl());
      const managerThreadId = requireThreadId(id);
      const managerThread = await getManagerThreadById(client, managerThreadId);
      if (!opts.yes) {
        const confirmed = await confirmDestructiveAction(
          `Delete manager "${managerThread.title ?? managerThread.id}" permanently? This cannot be undone.`,
        );
        if (!confirmed) {
          console.log(`Manager ${managerThreadId} deletion cancelled`);
          return;
        }
      }
      await unwrap<{ ok: boolean }>(
        client.api.v1.threads[":id"].$delete({
          param: { id: managerThreadId },
        }),
      );
      if (outputJson(opts, { ok: true, managerId: managerThreadId })) return;
      console.log(`Manager ${managerThreadId} deleted`);
    }));
}

async function getThreadById(
  client: ReturnType<typeof createClient>,
  threadId: string,
): Promise<Thread> {
  return unwrap<Thread>(
    client.api.v1.threads[":id"].$get({
      param: { id: threadId },
    }),
  );
}

async function getManagerThreadById(
  client: ReturnType<typeof createClient>,
  threadId: string,
): Promise<Thread> {
  const thread = await getThreadById(client, threadId);
  if (thread.type !== "manager") {
    throw new Error(`Thread ${threadId} is not a manager`);
  }
  return thread;
}

async function listManagedThreads(
  client: ReturnType<typeof createClient>,
  managerThreadId: string,
): Promise<Thread[]> {
  return unwrap<Thread[]>(
    client.api.v1.threads.$get({
      query: { parentThreadId: managerThreadId },
    }),
  );
}

function printManagerThread(thread: Thread): void {
  console.log("");
  console.log(`  ID:       ${thread.id}`);
  console.log(`  Title:    ${thread.title ?? "<untitled>"}`);
  console.log(`  Type:     ${thread.type}`);
  console.log(`  Status:   ${thread.status}`);
  console.log(`  Project:  ${thread.projectId}`);
  console.log(`  Created:  ${new Date(thread.createdAt).toLocaleString()}`);
  console.log(`  Updated:  ${new Date(thread.updatedAt).toLocaleString()}`);
  console.log("");
}

function printManagerTable(managers: Thread[]): void {
  const rows = managers.map((manager) => [
    manager.id,
    manager.status,
    manager.title ?? "<untitled>",
  ]);
  const idWidth = Math.max(4, ...rows.map((row) => row[0].length));
  const statusWidth = Math.max(6, ...rows.map((row) => row[1].length));
  const titleWidth = Math.max(5, ...rows.map((row) => row[2].length));
  const table = renderBorderlessTable(
    {
      head: ["ID", "Status", "Title"],
      colWidths: [idWidth, statusWidth, titleWidth],
    },
    rows,
  );

  console.log("");
  console.log(table);
  console.log("");
}

function printManagedThreadTable(threads: Thread[]): void {
  console.log("Managed threads:");
  if (threads.length === 0) {
    console.log("  None");
    return;
  }
  console.log("");
  const rows = threads.map((thread) => [
    thread.id,
    thread.status,
    thread.title ?? "<untitled>",
  ]);
  const idWidth = Math.max(4, ...rows.map((row) => row[0].length));
  const statusWidth = Math.max(6, ...rows.map((row) => row[1].length));
  const titleWidth = Math.max(5, ...rows.map((row) => row[2].length));
  const table = renderBorderlessTable(
    {
      head: ["ID", "Status", "Title"],
      colWidths: [idWidth, statusWidth, titleWidth],
    },
    rows,
  );
  console.log(table);
  console.log("");
}
