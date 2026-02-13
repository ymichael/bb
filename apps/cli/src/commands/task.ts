import { Command } from "commander";
import type { Task, TaskEvent, TaskStatus, TaskCloseReason, TaskDependencyType } from "@beanbag/core";
import { createClient, unwrap } from "../client.js";

function statusIcon(status: TaskStatus): string {
  switch (status) {
    case "open":
      return "\u25CB";
    case "in_progress":
      return "\u25D4";
    case "blocked":
      return "\u25D1";
    case "closed":
      return "\u25CF";
    default:
      return "?";
  }
}

function printTask(task: Task): void {
  console.log("");
  console.log(`  ID:          ${task.id}`);
  console.log(`  Project:     ${task.projectId}`);
  console.log(`  Title:       ${task.title}`);
  console.log(`  Status:      ${statusIcon(task.status)} ${task.status}`);
  if (task.assignee) console.log(`  Assignee:    ${task.assignee}`);
  if (task.closeReason) console.log(`  CloseReason: ${task.closeReason}`);
  if (task.resultSummary) console.log(`  Summary:     ${task.resultSummary}`);
  console.log(`  Created:     ${new Date(task.createdAt).toLocaleString()}`);
  console.log(`  Updated:     ${new Date(task.updatedAt).toLocaleString()}`);
  if (task.closedAt) console.log(`  Closed:      ${new Date(task.closedAt).toLocaleString()}`);
  console.log("");
}

function printTaskTable(tasks: Task[]): void {
  const idWidth = Math.max(4, ...tasks.map((t) => t.id.length));
  const statusWidth = 12;
  const projectWidth = Math.max(7, ...tasks.map((t) => t.projectId.length));
  const titleWidth = Math.max(5, ...tasks.map((t) => t.title.length));

  const header = [
    "ID".padEnd(idWidth),
    "Project".padEnd(projectWidth),
    "Status".padEnd(statusWidth),
    "Title".padEnd(titleWidth),
  ].join("  ");

  console.log("");
  console.log(header);
  console.log("-".repeat(header.length));
  for (const task of tasks) {
    const row = [
      task.id.padEnd(idWidth),
      task.projectId.padEnd(projectWidth),
      `${statusIcon(task.status)} ${task.status}`.padEnd(statusWidth + 2),
      task.title.padEnd(titleWidth),
    ].join("  ");
    console.log(row);
  }
  console.log("");
}

function printTaskEvent(event: TaskEvent): void {
  const time = new Date(event.createdAt).toLocaleTimeString();
  const data = JSON.stringify(event.data);
  console.log(`[${time}] [${event.type}] ${data}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function registerTaskCommands(program: Command, getUrl: () => string): void {
  const task = program.command("task").description("Manage tasks");

  task
    .command("create")
    .description("Create a task")
    .requiredOption("--project <id>", "Project ID")
    .requiredOption("--title <title>", "Task title")
    .option("--description <description>", "Task description")
    .option("--parent <taskId>", "Parent task ID")
    .action(
      async (opts: {
        project: string;
        title: string;
        description?: string;
        parent?: string;
      }) => {
        const client = createClient(getUrl());
        try {
          const created = await unwrap<Task>(
            client.api.v1.tasks.$post({
              json: {
                projectId: opts.project,
                title: opts.title,
                description: opts.description,
                parentId: opts.parent,
              },
            }),
          );
          console.log(`Task created: ${created.id}`);
          printTask(created);
        } catch (err: unknown) {
          console.error(`Error: ${(err as Error).message}`);
          process.exit(1);
        }
      },
    );

  task
    .command("list")
    .description("List tasks")
    .requiredOption("--project <id>", "Project ID")
    .option("--status <status>", "Task status")
    .option("--parent <taskId>", "Parent task ID")
    .action(
      async (opts: { project: string; status?: TaskStatus; parent?: string }) => {
        const client = createClient(getUrl());
        try {
          const tasks = await unwrap<Task[]>(
            client.api.v1.tasks.$get({
              query: {
                projectId: opts.project,
                status: opts.status,
                parentId: opts.parent,
              },
            }),
          );
          if (tasks.length === 0) {
            console.log("No tasks found");
            return;
          }
          printTaskTable(tasks);
        } catch (err: unknown) {
          console.error(`Error: ${(err as Error).message}`);
          process.exit(1);
        }
      },
    );

  task
    .command("ready")
    .description("List assignable ready tasks")
    .requiredOption("--project <id>", "Project ID")
    .action(async (opts: { project: string }) => {
      const client = createClient(getUrl());
      try {
        const tasks = await unwrap<Task[]>(
          client.api.v1.tasks.ready.$get({
            query: { projectId: opts.project },
          }),
        );
        if (tasks.length === 0) {
          console.log("No ready tasks found");
          return;
        }
        printTaskTable(tasks);
      } catch (err: unknown) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  task
    .command("show <id>")
    .description("Show task details")
    .action(async (id: string) => {
      const client = createClient(getUrl());
      try {
        const task = await unwrap<Task>(
          client.api.v1.tasks[":id"].$get({ param: { id } }),
        );
        printTask(task);
      } catch (err: unknown) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  task
    .command("update <id>")
    .description("Update task fields")
    .option("--title <title>", "New title")
    .option("--description <description>", "New description")
    .option("--status <status>", "open|in_progress|blocked|closed")
    .option("--summary <summary>", "Result summary")
    .option("--assignee <assignee>", "Assignee")
    .option("--close-reason <reason>", "completed|failed|canceled")
    .action(
      async (
        id: string,
        opts: {
          title?: string;
          description?: string;
          status?: TaskStatus;
          summary?: string;
          assignee?: string;
          closeReason?: TaskCloseReason;
        },
      ) => {
        const client = createClient(getUrl());
        try {
          const updated = await unwrap<Task>(
            client.api.v1.tasks[":id"].$patch({
              param: { id },
              json: {
                title: opts.title,
                description: opts.description,
                status: opts.status,
                resultSummary: opts.summary,
                assignee: opts.assignee,
                closeReason: opts.closeReason,
              },
            }),
          );
          console.log(`Task updated: ${updated.id}`);
          printTask(updated);
        } catch (err: unknown) {
          console.error(`Error: ${(err as Error).message}`);
          process.exit(1);
        }
      },
    );

  task
    .command("assign <id>")
    .description("Assign a task to an actor/thread identity")
    .requiredOption("--assignee <assignee>", "Assignee ID")
    .action(async (id: string, opts: { assignee: string }) => {
      const client = createClient(getUrl());
      try {
        const assigned = await unwrap<Task>(
          client.api.v1.tasks[":id"].assign.$post({
            param: { id },
            json: { assignee: opts.assignee },
          }),
        );
        console.log(`Task assigned: ${assigned.id}`);
        printTask(assigned);
      } catch (err: unknown) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  task
    .command("close <id>")
    .description("Close a task with a reason")
    .requiredOption("--reason <reason>", "completed|failed|canceled")
    .option("--summary <summary>", "Result summary")
    .action(async (id: string, opts: { reason: TaskCloseReason; summary?: string }) => {
      const client = createClient(getUrl());
      try {
        const closed = await unwrap<Task>(
          client.api.v1.tasks[":id"].$patch({
            param: { id },
            json: {
              status: "closed",
              closeReason: opts.reason,
              resultSummary: opts.summary,
            },
          }),
        );
        console.log(`Task closed: ${closed.id}`);
        printTask(closed);
      } catch (err: unknown) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  const dep = task.command("dep").description("Manage task dependencies");

  dep
    .command("add <taskId> <dependsOnTaskId>")
    .description("Add a task dependency")
    .requiredOption("--type <type>", "blocks|parent-child|related")
    .action(
      async (
        taskId: string,
        dependsOnTaskId: string,
        opts: { type: TaskDependencyType },
      ) => {
        const client = createClient(getUrl());
        try {
          await unwrap(
            client.api.v1.tasks[":id"].dependencies.$post({
              param: { id: taskId },
              json: { dependsOnTaskId, type: opts.type },
            }),
          );
          console.log(`Dependency added: ${taskId} -(${opts.type})-> ${dependsOnTaskId}`);
        } catch (err: unknown) {
          console.error(`Error: ${(err as Error).message}`);
          process.exit(1);
        }
      },
    );

  dep
    .command("remove <taskId> <dependsOnTaskId>")
    .description("Remove a task dependency")
    .requiredOption("--type <type>", "blocks|parent-child|related")
    .action(
      async (
        taskId: string,
        dependsOnTaskId: string,
        opts: { type: TaskDependencyType },
      ) => {
        const client = createClient(getUrl());
        try {
          await unwrap(
            client.api.v1.tasks[":id"].dependencies[":dependsOnTaskId"].$delete({
              param: { id: taskId, dependsOnTaskId },
              query: { type: opts.type },
            }),
          );
          console.log(`Dependency removed: ${taskId} -(${opts.type})-> ${dependsOnTaskId}`);
        } catch (err: unknown) {
          console.error(`Error: ${(err as Error).message}`);
          process.exit(1);
        }
      },
    );

  task
    .command("events <id>")
    .description("Show task event log")
    .option("-f, --follow", "Follow new events")
    .action(async (id: string, opts: { follow?: boolean }) => {
      const client = createClient(getUrl());
      try {
        let lastSeq = -1;
        const events = await unwrap<TaskEvent[]>(
          client.api.v1.tasks[":id"].events.$get({
            param: { id },
            query: {},
          }),
        );
        for (const event of events) {
          printTaskEvent(event);
          if (event.seq > lastSeq) lastSeq = event.seq;
        }

        if (!opts.follow) return;

        console.log("--- following (Ctrl+C to stop) ---");
        process.on("SIGINT", () => {
          console.log("\n--- stopped following ---");
          process.exit(0);
        });

        while (true) {
          await sleep(500);
          try {
            const newEvents = await unwrap<TaskEvent[]>(
              client.api.v1.tasks[":id"].events.$get({
                param: { id },
                query: { afterSeq: String(lastSeq) },
              }),
            );
            for (const event of newEvents) {
              printTaskEvent(event);
              if (event.seq > lastSeq) lastSeq = event.seq;
            }
          } catch {
            await sleep(1500);
          }
        }
      } catch (err: unknown) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
