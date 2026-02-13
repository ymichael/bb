import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import {
  createTaskSchema,
  updateTaskSchema,
  assignTaskSchema,
  createTaskDependencySchema,
  taskStatusSchema,
  taskDependencyTypeSchema,
} from "@beanbag/core";
import { z } from "zod";
import type { ProjectRepository, TaskRepository } from "@beanbag/db";

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

export function createTaskRoutes(
  projectRepo: ProjectRepository,
  taskRepo: TaskRepository,
) {
  return new Hono()
    .post("/", zValidator("json", createTaskSchema), async (c) => {
      try {
        const body = c.req.valid("json");
        const project = projectRepo.getById(body.projectId);
        if (!project) {
          return c.json({ error: "Project not found" }, 404);
        }
        const task = taskRepo.create(body);
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
        return c.json(result.task);
      } catch (err) {
        return c.json({ error: toErrorMessage(err) }, 400);
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
