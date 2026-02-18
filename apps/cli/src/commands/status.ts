import { Command } from "commander";
import type { Task } from "@beanbag/core";
import { resolveContextSnapshot } from "../context-env.js";
import { createClient, unwrap } from "../client.js";
import { formatTaskDescription } from "../task-format.js";

export function registerStatusCommand(
  program: Command,
  getUrl: () => string,
): void {
  program
    .command("status")
    .description("Show current context")
    .action(async () => {
      const context = resolveContextSnapshot();
      if (context.projectId) {
        console.log(`Project: ${context.projectId}`);
      } else {
        console.log("Project: <unset>");
      }
      if (context.taskId) {
        console.log(`Task: ${context.taskId}`);
      } else {
        console.log("Task: <unset>");
      }
      if (context.threadId) {
        console.log(`Thread: ${context.threadId}`);
      } else {
        console.log("Thread: <unset>");
      }
      if (context.taskId) {
        const client = createClient(getUrl());
        try {
          const task = await unwrap<Task>(
            client.api.v1.tasks[":id"].$get({ param: { id: context.taskId } }),
          );
          console.log(`Task Title: ${task.title}`);
          console.log(`Task Description: ${formatTaskDescription(task.description)}`);
        } catch {
          console.log("Task Title: <unavailable>");
          console.log("Task Description: <unavailable>");
        }
      }
    });
}
