import { Command } from "commander";
import {
  assertNever,
  type Task,
  type TaskEvent,
  type TaskStatus,
  type TaskCloseReason,
  type TaskDependencyType,
} from "@beanbag/core";
import { createClient, unwrap } from "../client.js";
import {
  requireProjectId,
  requireTaskId,
  resolveTaskId,
} from "../context-env.js";
import { formatTaskDescription } from "../task-format.js";

type TaskStatusEventMode = "summary" | "raw";

function parseRecentEventsCount(rawCount: string): number {
  const parsed = Number.parseInt(rawCount, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("Recent events count must be a positive integer.");
  }
  return parsed;
}

function parseTaskStatusEventMode(rawMode: string | undefined): TaskStatusEventMode {
  const normalized = (rawMode ?? "summary").trim().toLowerCase();
  if (normalized === "summary" || normalized === "raw") {
    return normalized;
  }
  throw new Error(`Invalid event mode '${rawMode}'. Expected 'summary' or 'raw'.`);
}

export function statusText(status: TaskStatus): string {
  switch (status) {
    case "open":
      return "open";
    case "in_progress":
      return "in_progress";
    case "blocked":
      return "blocked";
    case "closed":
      return "closed";
    default:
      return assertNever(status);
  }
}

function printTask(task: Task): void {
  console.log("");
  console.log(`  ID:          ${task.id}`);
  console.log(`  Project:     ${task.projectId}`);
  console.log(`  Title:       ${task.title}`);
  console.log(`  Description: ${formatTaskDescription(task.description)}`);
  console.log(`  Status:      ${statusText(task.status)}`);
  if (task.assignee) console.log(`  Assignee:    ${task.assignee}`);
  if (task.closeReason) console.log(`  CloseReason: ${task.closeReason}`);
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
      statusText(task.status).padEnd(statusWidth),
      task.title.padEnd(titleWidth),
    ].join("  ");
    console.log(row);
  }
  console.log("");
}

function printTaskEvent(event: TaskEvent): void {
  const time = new Date(event.createdAt).toLocaleTimeString();
  const data = JSON.stringify(event.data);
  console.log(`time=${time} type=${event.type} data=${data}`);
}

export function registerTaskCommands(program: Command, getUrl: () => string): void {
  const task = program.command("task").description("Manage tasks");

  task
    .command("create")
    .description("Create a task")
    .option("--project <id>", "Project ID (defaults to BB_PROJECT_ID)")
    .requiredOption("--title <title>", "Task title")
    .option("--description <description>", "Task description")
    .option("--parent <taskId>", "Parent task ID")
    .option(
      "--no-context-parent",
      "Do not default parent to BB_TASK_ID when --parent is omitted",
    )
    .action(
      async (opts: {
        project?: string;
        title: string;
        description?: string;
        parent?: string;
        contextParent?: boolean;
      }) => {
        const client = createClient(getUrl());
        try {
          if (opts.parent && opts.contextParent === false) {
            throw new Error(
              "Cannot combine --parent with --no-context-parent.",
            );
          }

          const projectId = requireProjectId(opts.project);
          const parentId =
            opts.parent ??
            (opts.contextParent === false ? undefined : resolveTaskId());
          const created = await unwrap<Task>(
            client.api.v1.tasks.$post({
              json: {
                projectId,
                title: opts.title,
                description: opts.description,
                parentId,
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
    .option("--project <id>", "Project ID (defaults to BB_PROJECT_ID)")
    .option("--status <status>", "Task status")
    .option("--parent <taskId>", "Parent task ID")
    .action(
      async (opts: { project?: string; status?: TaskStatus; parent?: string }) => {
        const client = createClient(getUrl());
        try {
          const projectId = requireProjectId(opts.project);
          const tasks = await unwrap<Task[]>(
            client.api.v1.tasks.$get({
              query: {
                projectId,
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
    .command("status [id]")
    .description("Show task status (defaults to BB_TASK_ID)")
    .option("--recent-events <count>", "Include last N task events")
    .option(
      "--event-mode <mode>",
      "summary|raw event formatting for --recent-events",
      "summary",
    )
    .action(
      async (
        id: string | undefined,
        opts: { recentEvents?: string; eventMode?: string },
      ) => {
        const client = createClient(getUrl());
        try {
          const taskId = requireTaskId(id);
          const recentEvents =
            opts.recentEvents === undefined
              ? undefined
              : parseRecentEventsCount(opts.recentEvents);
          const eventMode = parseTaskStatusEventMode(opts.eventMode);
          const task = await unwrap<Task>(
            client.api.v1.tasks[":id"].$get({ param: { id: taskId } }),
          );
          const events =
            recentEvents === undefined
              ? []
              : await unwrap<TaskEvent[]>(
                  client.api.v1.tasks[":id"].events.$get({
                    param: { id: taskId },
                    query: {},
                  }),
                );
          printTaskStatus(task, events, { recentEvents, eventMode });
        } catch (err: unknown) {
          console.error(`Error: ${(err as Error).message}`);
          process.exit(1);
        }
      },
    );

  task
    .command("show [id]")
    .description("Show task details (defaults to BB_TASK_ID)")
    .action(async (id: string | undefined) => {
      const client = createClient(getUrl());
      try {
        const taskId = requireTaskId(id);
        const task = await unwrap<Task>(
          client.api.v1.tasks[":id"].$get({ param: { id: taskId } }),
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
    .option("--assignee <assignee>", "Assignee")
    .option("--close-reason <reason>", "completed|failed|canceled")
    .action(
      async (
        id: string,
        opts: {
          title?: string;
          description?: string;
          status?: TaskStatus;
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
    .action(async (id: string, opts: { reason: TaskCloseReason }) => {
      const client = createClient(getUrl());
      try {
        const closed = await unwrap<Task>(
          client.api.v1.tasks[":id"].$patch({
            param: { id },
            json: {
              status: "closed",
              closeReason: opts.reason,
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
          console.log(
            `Dependency added: task=${taskId} dependsOn=${dependsOnTaskId} type=${opts.type}`,
          );
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
          console.log(
            `Dependency removed: task=${taskId} dependsOn=${dependsOnTaskId} type=${opts.type}`,
          );
        } catch (err: unknown) {
          console.error(`Error: ${(err as Error).message}`);
          process.exit(1);
        }
      },
    );

  task
    .command("events [id]")
    .description("Show task event log (defaults to BB_TASK_ID)")
    .action(async (id: string | undefined) => {
      const client = createClient(getUrl());
      try {
        const taskId = requireTaskId(id);
        const events = await unwrap<TaskEvent[]>(
          client.api.v1.tasks[":id"].events.$get({
            param: { id: taskId },
            query: {},
          }),
        );
        for (const event of events) {
          printTaskEvent(event);
        }
      } catch (err: unknown) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}

function printTaskStatus(
  task: Task,
  events: TaskEvent[],
  opts?: { recentEvents?: number; eventMode: TaskStatusEventMode },
): void {
  console.log(`Task ${task.id}`);
  console.log(
    `Status ${statusText(task.status)}${task.assignee ? ` (assignee: ${task.assignee})` : ""}`,
  );
  console.log(`Project ${task.projectId}`);
  console.log(`Description ${formatTaskDescription(task.description)}`);
  console.log(`Updated ${new Date(task.updatedAt).toLocaleString()}`);

  const recentEventCount = opts?.recentEvents;
  if (recentEventCount === undefined) return;
  const eventMode = opts?.eventMode ?? "summary";

  const recentEvents = events.slice(-recentEventCount);

  console.log("");
  console.log("Recent events:");
  if (recentEvents.length === 0) return;

  if (eventMode === "raw") {
    for (const event of recentEvents) {
      printTaskEvent(event);
    }
    return;
  }

  for (const event of recentEvents) {
    const at = new Date(event.createdAt).toLocaleTimeString();
    console.log(`- ${at} ${event.type}`);
  }
}
