import { Command } from "commander";
import { type Project, type Thread } from "@beanbag/agent-core";
import { createClient, unwrap } from "../client.js";
import { createInterface } from "node:readline/promises";
import { requireProjectId, requireThreadId } from "../context-env.js";

export function registerManagerCommands(program: Command, getUrl: () => string): void {
  const manager = program.command("manager").description("Manage project managers");

  manager
    .command("hire [projectId]")
    .description("Hire or reopen the primary manager for a project")
    .option("--project <id>", "Project ID (defaults to BB_PROJECT_ID)")
    .option("--json", "Print machine-readable JSON output")
    .action(async (
      projectIdArg: string | undefined,
      opts: { json?: boolean; project?: string },
    ) => {
      const client = createClient(getUrl());
      try {
        const projectId = requireProjectId(projectIdArg ?? opts.project);
        const thread = await unwrap<Thread>(
          client.api.v1.projects[":id"].manager.$post({
            param: { id: projectId },
          }),
        );
        if (opts.json) {
          console.log(JSON.stringify(thread, null, 2));
          return;
        }
        console.log(`Manager ready: ${thread.id}`);
        printManagerThread(thread);
      } catch (err: unknown) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  manager
    .command("show [projectId]")
    .description("Show the primary manager for a project")
    .option("--project <id>", "Project ID (defaults to BB_PROJECT_ID)")
    .option("--json", "Print machine-readable JSON output")
    .action(async (
      projectIdArg: string | undefined,
      opts: { json?: boolean; project?: string },
    ) => {
      const client = createClient(getUrl());
      try {
        const projectId = requireProjectId(projectIdArg ?? opts.project);
        const project = await getProjectById(client, projectId);
        if (!project.primaryManagerThreadId) {
          console.log("No manager hired");
          return;
        }
        const thread = await getThreadById(client, project.primaryManagerThreadId);
        if (opts.json) {
          console.log(JSON.stringify(thread, null, 2));
          return;
        }
        printManagerThread(thread);
      } catch (err: unknown) {
        console.error(`Error: ${(err as Error).message}`);
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
        if (opts.json) {
          console.log(JSON.stringify({ manager: managerThread, managedThreads }, null, 2));
          return;
        }
        printManagerThread(managerThread);
        printManagedThreadTable(managedThreads);
      } catch (err: unknown) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  manager
    .command("threads <id>")
    .description("List threads managed by a manager")
    .option("--json", "Print machine-readable JSON output")
    .action(async (id: string, opts: { json?: boolean }) => {
      const client = createClient(getUrl());
      try {
        const managerThreadId = requireThreadId(id);
        await getManagerThreadById(client, managerThreadId);
        const managedThreads = await listManagedThreads(client, managerThreadId);
        if (opts.json) {
          console.log(JSON.stringify(managedThreads, null, 2));
          return;
        }
        printManagedThreadTable(managedThreads);
      } catch (err: unknown) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  manager
    .command("send <id> <message>")
    .description("Send a message to a manager thread")
    .option("--json", "Print machine-readable JSON output")
    .action(async (id: string, message: string, opts: { json?: boolean }) => {
      const client = createClient(getUrl());
      try {
        const managerThreadId = requireThreadId(id);
        await getManagerThreadById(client, managerThreadId);
        const result = await unwrap<{ ok: boolean }>(
          client.api.v1.threads[":id"].tell.$post({
            param: { id: managerThreadId },
            json: {
              input: [{ type: "text", text: message }],
            },
          }),
        );
        if (opts.json) {
          console.log(JSON.stringify({ managerId: managerThreadId, ...result }, null, 2));
          return;
        }
        console.log(`Manager ${managerThreadId} updated`);
      } catch (err: unknown) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  manager
    .command("log <id>")
    .description("Show manager thread event log")
    .option("--json", "Print machine-readable JSON output")
    .action(async (id: string, opts: { json?: boolean }) => {
      const client = createClient(getUrl());
      try {
        const managerThreadId = requireThreadId(id);
        await getManagerThreadById(client, managerThreadId);
        const events = await unwrap<unknown[]>(
          client.api.v1.threads[":id"].events.$get({
            param: { id: managerThreadId },
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

  manager
    .command("delete <id>")
    .description("Delete a manager permanently")
    .option("--yes", "Skip the confirmation prompt")
    .action(async (id: string, opts: { yes?: boolean }) => {
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
          fetch(buildThreadUrl(getUrl(), managerThreadId), { method: "DELETE" }),
        );
        console.log(`Manager ${managerThreadId} deleted`);
      } catch (err: unknown) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}

async function confirmDestructiveAction(message: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "Refusing destructive action without an interactive terminal. Re-run with --yes to confirm.",
    );
  }
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await readline.question(`${message} [y/N] `);
    const normalized = answer.trim().toLowerCase();
    return normalized === "y" || normalized === "yes";
  } finally {
    readline.close();
  }
}

async function getProjectById(
  client: ReturnType<typeof createClient>,
  projectId: string,
): Promise<Project> {
  const projects = await unwrap<Project[]>(
    client.api.v1.projects.$get(),
  );
  const project = projects.find((candidate) => candidate.id === projectId);
  if (!project) {
    throw new Error(`Project ${projectId} not found`);
  }
  return project;
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

function buildThreadUrl(baseUrl: string, threadId: string): URL {
  return new URL(`/api/v1/threads/${encodeURIComponent(threadId)}`, baseUrl);
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

function printEvent(event: unknown): void {
  if (!event || typeof event !== "object") {
    console.log(String(event));
    return;
  }
  const record = event as {
    type?: unknown;
    data?: unknown;
    createdAt?: unknown;
  };
  const time =
    typeof record.createdAt === "number"
      ? new Date(record.createdAt).toLocaleTimeString()
      : "unknown";
  const type = typeof record.type === "string" ? record.type : "unknown";
  const data =
    typeof record.data === "string"
      ? record.data
      : JSON.stringify(record.data ?? null, null, 2);
  console.log(`time=${time} type=${type} data=${data}`);
}
