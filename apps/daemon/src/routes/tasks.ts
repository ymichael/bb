import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import {
  createTaskSchema,
  updateTaskSchema,
  assignTaskSchema,
  taskChatSchema,
  createTaskDependencySchema,
  taskStatusSchema,
  taskDependencyTypeSchema,
  type Task,
  type TaskEvent,
  type PromptInput,
} from "@beanbag/core";
import { z } from "zod";
import type { ProjectRepository, TaskRepository } from "@beanbag/db";
import type { WSManager } from "../ws.js";
import type { ThreadManager } from "../thread-manager.js";
import {
  getAgentRoleDefinition,
  getDefaultAgentRole,
} from "../agent-roles.js";

const listTasksQuerySchema = z.object({
  projectId: z.string().optional(),
  status: taskStatusSchema.optional(),
  parentId: z.string().optional(),
});

const readyTasksQuerySchema = z.object({
  projectId: z.string(),
});

const eventsQuerySchema = z.object({
  afterSeq: z.string().optional(),
});

const dependencyDeleteQuerySchema = z.object({
  type: taskDependencyTypeSchema,
});

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}

function summarizePromptInput(input: PromptInput[]): string {
  const parts: string[] = [];
  for (const chunk of input) {
    if (chunk.type === "text") {
      const trimmed = chunk.text.trim();
      if (trimmed.length > 0) {
        parts.push(trimmed);
      }
      continue;
    }
    if (chunk.type === "image" || chunk.type === "localImage") {
      parts.push("[image]");
    }
  }
  const summary = parts.join(" ").trim();
  if (!summary) return "(no text)";
  return summary.length > 240 ? `${summary.slice(0, 237)}...` : summary;
}

function getThreadIdFromTaskEvent(event: TaskEvent): string | undefined {
  const threadId = event.data?.threadId;
  return typeof threadId === "string" && threadId.length > 0
    ? threadId
    : undefined;
}

function resolveBoundTaskThreadId(taskEvents: TaskEvent[]): string | undefined {
  for (let i = taskEvents.length - 1; i >= 0; i -= 1) {
    const threadId = getThreadIdFromTaskEvent(taskEvents[i]);
    if (threadId) return threadId;
  }
  return undefined;
}

function buildTaskRolePreamble(task: Task): string {
  const role = getAgentRoleDefinition(task.assignee ?? "") ?? getDefaultAgentRole();
  const description =
    task.description && task.description.trim().length > 0
      ? task.description.trim()
      : "(none)";

  return [
    `You are now assigned to Beanbag task ${task.id}.`,
    `Role: ${role.id} (${role.name})`,
    "",
    "Role instructions:",
    role.instructions,
    "",
    "Task context:",
    `- projectId: ${task.projectId}`,
    `- taskId: ${task.id}`,
    `- title: ${task.title}`,
    `- status: ${task.status}`,
    `- description: ${description}`,
    "",
    "Collaborate directly in this thread with the user who owns the task.",
  ].join("\n");
}

export function createTaskRoutes(
  projectRepo: ProjectRepository,
  taskRepo: TaskRepository,
  threadManager?: Pick<ThreadManager, "spawn" | "tell" | "getById">,
  wsManager?: Pick<WSManager, "broadcast">,
) {
  const broadcastTaskChange = (taskId: string) => {
    wsManager?.broadcast("task", taskId);
  };

  return new Hono()
    .post("/", zValidator("json", createTaskSchema), async (c) => {
      try {
        const body = c.req.valid("json");
        const project = projectRepo.getById(body.projectId);
        if (!project) {
          return c.json({ error: "Project not found" }, 404);
        }
        const task = taskRepo.create(body);
        broadcastTaskChange(task.id);
        return c.json(task, 201);
      } catch (err) {
        const message = toErrorMessage(err);
        if (
          message.includes("not found") ||
          message.includes("same project") ||
          message.includes("cycle")
        ) {
          return c.json({ error: message }, 400);
        }
        return c.json({ error: message }, 500);
      }
    })
    .get("/", zValidator("query", listTasksQuerySchema), async (c) => {
      try {
        const filters = c.req.valid("query");
        const tasks = taskRepo.list(filters);
        return c.json(tasks);
      } catch (err) {
        return c.json({ error: toErrorMessage(err) }, 500);
      }
    })
    .get("/ready", zValidator("query", readyTasksQuerySchema), async (c) => {
      try {
        const { projectId } = c.req.valid("query");
        const project = projectRepo.getById(projectId);
        if (!project) {
          return c.json({ error: "Project not found" }, 404);
        }
        const tasks = taskRepo.getReady(projectId);
        return c.json(tasks);
      } catch (err) {
        return c.json({ error: toErrorMessage(err) }, 500);
      }
    })
    .get("/:id", async (c) => {
      try {
        const task = taskRepo.getById(c.req.param("id"));
        if (!task) {
          return c.json({ error: "Task not found" }, 404);
        }
        return c.json(task);
      } catch (err) {
        return c.json({ error: toErrorMessage(err) }, 500);
      }
    })
    .patch("/:id", zValidator("json", updateTaskSchema), async (c) => {
      try {
        const updated = taskRepo.update(c.req.param("id"), c.req.valid("json"));
        if (!updated) {
          return c.json({ error: "Task not found" }, 404);
        }
        broadcastTaskChange(updated.id);
        return c.json(updated);
      } catch (err) {
        return c.json({ error: toErrorMessage(err) }, 400);
      }
    })
    .post("/:id/assign", zValidator("json", assignTaskSchema), async (c) => {
      try {
        const result = taskRepo.assign(c.req.param("id"), c.req.valid("json").assignee);
        if (!result) {
          return c.json({ error: "Task not found" }, 404);
        }
        if (result.alreadyAssignedTo !== undefined) {
          return c.json(
            {
              error: `Task already assigned to ${result.alreadyAssignedTo || "another worker"}`,
            },
            409,
          );
        }
        if (!result.task) {
          return c.json({ error: "Task assignment did not return a task" }, 500);
        }
        broadcastTaskChange(result.task.id);
        return c.json(result.task);
      } catch (err) {
        return c.json({ error: toErrorMessage(err) }, 400);
      }
    })
    .post("/:id/chat", zValidator("json", taskChatSchema), async (c) => {
      try {
        if (!threadManager) {
          return c.json({ error: "Task chat is unavailable" }, 503);
        }

        const taskId = c.req.param("id");
        const task = taskRepo.getById(taskId);
        if (!task) {
          return c.json({ error: "Task not found" }, 404);
        }
        if (!task.assignee) {
          return c.json(
            { error: "Task must be assigned to an agent role before chatting" },
            409,
          );
        }

        const input = c.req.valid("json").input;
        const existingEvents = taskRepo.listEvents(taskId);
        let threadId = resolveBoundTaskThreadId(existingEvents);
        let createdThread = false;

        if (threadId) {
          const thread = threadManager.getById(threadId);
          if (!thread || thread.projectId !== task.projectId) {
            threadId = undefined;
          }
        }

        if (!threadId) {
          const firstTurnInput: PromptInput[] = [
            { type: "text", text: buildTaskRolePreamble(task) },
            ...input,
          ];
          const thread = await threadManager.spawn({
            projectId: task.projectId,
            title: `Task ${task.id.slice(0, 8)}: ${task.title}`,
            input: firstTurnInput,
          });
          threadId = thread.id;
          createdThread = true;
          taskRepo.appendEvent(task.id, "task.chat.thread_bound", {
            threadId,
            assignee: task.assignee,
          });
        } else {
          await threadManager.tell(threadId, { input });
        }

        taskRepo.appendEvent(task.id, "task.chat.message_sent", {
          threadId,
          assignee: task.assignee,
          preview: summarizePromptInput(input),
        });
        broadcastTaskChange(task.id);
        return c.json({ ok: true, threadId, createdThread });
      } catch (err) {
        return c.json({ error: toErrorMessage(err) }, 400);
      }
    })
    .post("/:id/archive", async (c) => {
      try {
        const task = taskRepo.archive(c.req.param("id"));
        if (!task) {
          return c.json({ error: "Task not found" }, 404);
        }
        broadcastTaskChange(task.id);
        return c.json({ ok: true });
      } catch (err) {
        return c.json({ error: toErrorMessage(err) }, 500);
      }
    })
    .get("/:id/dependencies", async (c) => {
      try {
        const task = taskRepo.getById(c.req.param("id"));
        if (!task) {
          return c.json({ error: "Task not found" }, 404);
        }
        const deps = taskRepo.listDependencies(c.req.param("id"));
        return c.json(deps);
      } catch (err) {
        return c.json({ error: toErrorMessage(err) }, 500);
      }
    })
    .post(
      "/:id/dependencies",
      zValidator("json", createTaskDependencySchema),
      async (c) => {
        try {
          const dependency = taskRepo.addDependency({
            taskId: c.req.param("id"),
            ...c.req.valid("json"),
          });
          if (!dependency) {
            return c.json({ error: "Task not found" }, 404);
          }
          broadcastTaskChange(dependency.taskId);
          return c.json(dependency, 201);
        } catch (err) {
          return c.json({ error: toErrorMessage(err) }, 400);
        }
      },
    )
    .delete(
      "/:id/dependencies/:dependsOnTaskId",
      zValidator("query", dependencyDeleteQuerySchema),
      async (c) => {
        try {
          const { type } = c.req.valid("query");
          const removed = taskRepo.removeDependency({
            taskId: c.req.param("id"),
            dependsOnTaskId: c.req.param("dependsOnTaskId"),
            type,
          });
          if (!removed) {
            return c.json({ error: "Dependency not found" }, 404);
          }
          broadcastTaskChange(c.req.param("id"));
          return c.json({ ok: true });
        } catch (err) {
          return c.json({ error: toErrorMessage(err) }, 400);
        }
      },
    )
    .get("/:id/events", zValidator("query", eventsQuerySchema), async (c) => {
      try {
        const task = taskRepo.getById(c.req.param("id"));
        if (!task) {
          return c.json({ error: "Task not found" }, 404);
        }
        const { afterSeq } = c.req.valid("query");
        const afterSeqNum = afterSeq ? Number.parseInt(afterSeq, 10) : undefined;
        const events = taskRepo.listEvents(c.req.param("id"), afterSeqNum);
        return c.json(events);
      } catch (err) {
        return c.json({ error: toErrorMessage(err) }, 500);
      }
    });
}
