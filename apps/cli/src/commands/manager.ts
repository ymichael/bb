import { Command } from "commander";
import { type Thread } from "@bb/core";
import { createClient, unwrap } from "../client.js";
import { requireProjectId, requireThreadId } from "../context-env.js";
import {
  confirmDestructiveAction,
  getErrorMessage,
  outputJson,
  resolveProjectIdWithLabel,
  printContextLabel,
} from "./helpers.js";

export function registerManagerCommands(program: Command, getUrl: () => string): void {
  const manager = program.command("manager").description("Manage project managers");

  manager
    .command("hire [projectId]")
    .description("Hire a new manager for a project")
    .option("--project <id>", "Project ID (defaults to BB_PROJECT_ID)")
    .option("--title <title>", "Manager name")
    .option("--provider <id>", "Provider ID for the manager (e.g. claude-code, codex)")
    .option("--model <model>", "Model ID for the manager")
    .option("--reasoning-level <level>", "Reasoning level (low, medium, high, xhigh)")
    .option("--json", "Print machine-readable JSON output")
    .action(async (
      projectIdArg: string | undefined,
      opts: { json?: boolean; project?: string; title?: string; provider?: string; model?: string; reasoningLevel?: string },
    ) => {
      const client = createClient(getUrl());
      try {
        const resolvedProject = resolveProjectIdWithLabel(projectIdArg ?? opts.project);
        const projectId = resolvedProject.id;
        printContextLabel(resolvedProject, "Project", "BB_PROJECT_ID", opts);
        const thread = await unwrap<Thread>(
          client.api.v1.projects[":id"].manager.$post({
            param: { id: projectId },
            json: {
              ...(opts.title ? { title: opts.title } : {}),
              ...(opts.provider ? { providerId: opts.provider } : {}),
              ...(opts.model ? { model: opts.model } : {}),
              ...(opts.reasoningLevel ? { reasoningLevel: opts.reasoningLevel as "low" | "medium" | "high" | "xhigh" } : {}),
            },
          }),
        );
        if (outputJson(opts, thread)) return;
        console.log(`Manager hired: ${thread.id}`);
        printManagerThread(thread);
      } catch (err: unknown) {
        console.error(`Error: ${getErrorMessage(err)}`);
        process.exit(1);
      }
    });

  manager
    .command("list [projectId]")
    .description("List managers for a project")
    .option("--project <id>", "Project ID (defaults to BB_PROJECT_ID)")
    .option("--json", "Print machine-readable JSON output")
    .action(async (
      projectIdArg: string | undefined,
      opts: { json?: boolean; project?: string },
    ) => {
      const client = createClient(getUrl());
      try {
        const resolvedProject = resolveProjectIdWithLabel(projectIdArg ?? opts.project);
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
      } catch (err: unknown) {
        console.error(`Error: ${getErrorMessage(err)}`);
        process.exit(1);
      }
    });

  manager
    .command("status <id>")
    .description("Show manager status and managed threads")
    .option("--json", "Print machine-readable JSON output")
    .action(async (id: string, opts: { json?: boolean }) => {
      const client = createClient(getUrl());
      try {
        const managerThreadId = requireThreadId(id);
        const managerThread = await getManagerThreadById(client, managerThreadId);
        const managedThreads = await listManagedThreads(client, managerThreadId);
        if (outputJson(opts, { manager: managerThread, managedThreads })) return;
        printManagerThread(managerThread);
        printManagedThreadTable(managedThreads);
      } catch (err: unknown) {
        console.error(`Error: ${getErrorMessage(err)}`);
        process.exit(1);
      }
    });

  manager
    .command("delete <id>")
    .description("Delete a manager permanently")
    .option("--yes", "Skip the confirmation prompt")
    .option("--json", "Print machine-readable JSON output")
    .action(async (id: string, opts: { yes?: boolean; json?: boolean }) => {
      const client = createClient(getUrl());
      try {
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
      } catch (err: unknown) {
        console.error(`Error: ${getErrorMessage(err)}`);
        process.exit(1);
      }
    });
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
  const idWidth = Math.max(4, ...managers.map((m) => m.id.length));
  const statusWidth = Math.max(6, ...managers.map((m) => m.status.length));
  const titleWidth = Math.max(
    5,
    ...managers.map((m) => (m.title ?? "<untitled>").length),
  );

  const header = [
    "ID".padEnd(idWidth),
    "Status".padEnd(statusWidth),
    "Title".padEnd(titleWidth),
  ].join("  ");

  console.log("");
  console.log(header);
  console.log("-".repeat(header.length));
  for (const m of managers) {
    console.log(
      [
        m.id.padEnd(idWidth),
        m.status.padEnd(statusWidth),
        (m.title ?? "<untitled>").padEnd(titleWidth),
      ].join("  "),
    );
  }
  console.log("");
}

function printManagedThreadTable(threads: Thread[]): void {
  console.log("Managed threads:");
  if (threads.length === 0) {
    console.log("  None");
    return;
  }
  console.log("");
  const idWidth = Math.max(4, ...threads.map((thread) => thread.id.length));
  const statusWidth = Math.max(6, ...threads.map((thread) => thread.status.length));
  const titleWidth = Math.max(
    5,
    ...threads.map((thread) => (thread.title ?? thread.titleFallback ?? "<untitled>").length),
  );
  const header = [
    "ID".padEnd(idWidth),
    "Status".padEnd(statusWidth),
    "Title".padEnd(titleWidth),
  ].join("  ");
  console.log(header);
  console.log("-".repeat(header.length));
  for (const thread of threads) {
    console.log(
      [
        thread.id.padEnd(idWidth),
        thread.status.padEnd(statusWidth),
        (thread.title ?? thread.titleFallback ?? "<untitled>").padEnd(titleWidth),
      ].join("  "),
    );
  }
  console.log("");
}

