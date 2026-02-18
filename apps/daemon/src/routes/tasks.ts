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

const eventsQuerySchema = z.object({
  afterSeq: z.string().optional(),
});

const dependencyDeleteQuerySchema = z.object({
  type: taskDependencyTypeSchema,
});

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}

function toTaskChatMessage(input: PromptInput[]): string {
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
  return parts.join(" ").trim() || "(no text)";
}

const TASK_ASSIGNMENT_SYSTEM_MESSAGE =
  "[bb system] You have been assigned this task, please work on it as instructed";

function buildTaskAssignmentStartupInput(): PromptInput[] {
  return [{ type: "text", text: TASK_ASSIGNMENT_SYSTEM_MESSAGE }];
}

function resolveAgentRoleForTask(task: Task) {
  return getAgentRoleDefinition(task.assignee ?? "") ?? getDefaultAgentRole();
}

function buildPrimaryThreadTitle(task: Task): string {
  return `Primary Thread for Task ${task.id}`;
}

export function createTaskRoutes(
  projectRepo: ProjectRepository,
  taskRepo: TaskRepository,
  threadManager?: Pick<ThreadManager, "spawn" | "tell" | "list">,
  wsManager?: Pick<WSManager, "broadcast">,
) {
  const broadcastTaskChange = (taskId: string) => {
    wsManager?.broadcast("task", taskId);
  };

  const ensurePrimaryThread = async (
    task: Task,
    opts?: { forceNew?: boolean; initialInput?: PromptInput[] },
  ): Promise<{ threadId: string; createdThread: boolean }> => {
    if (!threadManager) {
      throw new Error("Task chat is unavailable");
    }
    if (!task.assignee) {
      throw new Error("Task must be assigned to an agent role before chatting");
    }

    if (!opts?.forceNew) {
      const primaryThread = threadManager
        .list({
          projectId: task.projectId,
          taskId: task.id,
          taskRole: "primary",
          includeArchived: true,
        })
        .filter((thread) => thread.archivedAt === undefined)
        .sort((a, b) => a.createdAt - b.createdAt)
        .at(-1);

      if (primaryThread) {
        return { threadId: primaryThread.id, createdThread: false };
      }
    }

    const input = opts?.initialInput ?? buildTaskAssignmentStartupInput();
    const agentRole = resolveAgentRoleForTask(task);
    const thread = await threadManager.spawn({
      projectId: task.projectId,
      title: buildPrimaryThreadTitle(task),
      ...(input ? { input } : {}),
      agentRoleId: agentRole.id,
      developerInstructions: agentRole.instructions,
      taskId: task.id,
      taskRole: "primary",
    });
    taskRepo.appendEvent(task.id, "task.chat.thread_created", {
      threadId: thread.id,
      taskRole: "primary",
    });
    return { threadId: thread.id, createdThread: true };
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
        if (threadManager && task.assignee) {
          try {
            await ensurePrimaryThread(task);
          } catch {
            // Assignment succeeds even if kickoff provisioning fails.
          }
        }
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
        const taskId = c.req.param("id");
        const previous = taskRepo.getById(taskId);
        const updated = taskRepo.update(taskId, c.req.valid("json"));
        if (!updated) {
          return c.json({ error: "Task not found" }, 404);
        }
        if (threadManager && updated.assignee) {
          const assigneeChanged = updated.assignee !== previous?.assignee;
          if (assigneeChanged) {
            try {
              await ensurePrimaryThread(updated, {
                forceNew: Boolean(previous?.assignee),
              });
            } catch {
              // Updating task assignee succeeds even if kickoff provisioning fails.
            }
          }
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
        if (threadManager && result.task.assignee) {
          try {
            await ensurePrimaryThread(result.task);
          } catch {
            // Assignment succeeds even if kickoff provisioning fails.
          }
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
        const { threadId, createdThread } = await ensurePrimaryThread(task, {
          initialInput: input,
        });
        if (!createdThread) {
          await threadManager.tell(threadId, { input }, undefined, {
            initiator: "user",
          });
        }

        taskRepo.appendEvent(task.id, "task.chat.message", {
          message: toTaskChatMessage(input),
          fromThreadId: null,
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
