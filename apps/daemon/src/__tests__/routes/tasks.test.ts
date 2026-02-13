import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { Project, Task, TaskDependency, TaskEvent } from "@beanbag/core";
import type { ProjectRepository, TaskRepository } from "@beanbag/db";
import { createTaskRoutes } from "../../routes/tasks.js";

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "proj-1",
    name: "Project One",
    rootPath: "/repo",
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    projectId: "proj-1",
    title: "Implement task API",
    status: "open",
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function mockProjectRepo(): ProjectRepository {
  return {
    create: vi.fn(),
    getById: vi.fn(),
    list: vi.fn(),
    delete: vi.fn(),
  } as unknown as ProjectRepository;
}

function mockTaskRepo(): TaskRepository {
  return {
    create: vi.fn(),
    getById: vi.fn(),
    list: vi.fn(),
    getReady: vi.fn(),
    update: vi.fn(),
    assign: vi.fn(),
    addDependency: vi.fn(),
    removeDependency: vi.fn(),
    listDependencies: vi.fn(),
    listEvents: vi.fn(),
  } as unknown as TaskRepository;
}

describe("Task routes", () => {
  let projectRepo: ReturnType<typeof mockProjectRepo>;
  let taskRepo: ReturnType<typeof mockTaskRepo>;
  let app: Hono;

  beforeEach(() => {
    projectRepo = mockProjectRepo();
    taskRepo = mockTaskRepo();
    const routes = createTaskRoutes(projectRepo as any, taskRepo as any);
    app = new Hono().route("/tasks", routes);
  });

  describe("POST /tasks", () => {
    it("creates a task and returns 201", async () => {
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeProject(),
      );
      (taskRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(makeTask());

      const res = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: "proj-1",
          title: "Implement task API",
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBe("task-1");
      expect(taskRepo.create).toHaveBeenCalledWith({
        projectId: "proj-1",
        title: "Implement task API",
      });
    });

    it("returns 404 when project does not exist", async () => {
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        undefined,
      );

      const res = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: "missing",
          title: "Implement task API",
        }),
      });

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Project not found" });
    });
  });

  describe("GET /tasks", () => {
    it("lists tasks", async () => {
      (taskRepo.list as ReturnType<typeof vi.fn>).mockReturnValue([
        makeTask(),
        makeTask({ id: "task-2", title: "Second task" }),
      ]);

      const res = await app.request("/tasks?projectId=proj-1&status=open");

      expect(res.status).toBe(200);
      expect(taskRepo.list).toHaveBeenCalledWith({
        projectId: "proj-1",
        status: "open",
      });
      const body = await res.json();
      expect(body).toHaveLength(2);
    });
  });

  describe("POST /tasks/:id/assign", () => {
    it("assigns an unassigned task", async () => {
      (taskRepo.assign as ReturnType<typeof vi.fn>).mockReturnValue({
        task: makeTask({ assignee: "builder-1", status: "in_progress" }),
      });

      const res = await app.request("/tasks/task-1/assign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignee: "builder-1" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.assignee).toBe("builder-1");
      expect(body.status).toBe("in_progress");
    });

    it("returns 409 when already assigned", async () => {
      (taskRepo.assign as ReturnType<typeof vi.fn>).mockReturnValue({
        alreadyAssignedTo: "builder-2",
      });

      const res = await app.request("/tasks/task-1/assign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignee: "builder-1" }),
      });

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: "Task already assigned to builder-2",
      });
    });
  });

  describe("Dependencies", () => {
    it("adds a dependency", async () => {
      const dependency: TaskDependency = {
        taskId: "task-1",
        dependsOnTaskId: "task-parent",
        type: "parent-child",
        createdAt: 1000,
      };
      (taskRepo.addDependency as ReturnType<typeof vi.fn>).mockReturnValue(
        dependency,
      );

      const res = await app.request("/tasks/task-1/dependencies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dependsOnTaskId: "task-parent",
          type: "parent-child",
        }),
      });

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual(dependency);
    });

    it("lists dependencies for a task", async () => {
      (taskRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(makeTask());
      (taskRepo.listDependencies as ReturnType<typeof vi.fn>).mockReturnValue([
        {
          taskId: "task-1",
          dependsOnTaskId: "task-parent",
          type: "parent-child",
          createdAt: 1000,
        } satisfies TaskDependency,
      ]);

      const res = await app.request("/tasks/task-1/dependencies");

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveLength(1);
      expect(body[0].type).toBe("parent-child");
    });
  });

  describe("GET /tasks/:id/events", () => {
    it("returns task events", async () => {
      (taskRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(makeTask());
      (taskRepo.listEvents as ReturnType<typeof vi.fn>).mockReturnValue([
        {
          id: "evt-1",
          taskId: "task-1",
          seq: 1,
          type: "task.created",
          data: { title: "Implement task API" },
          createdAt: 1000,
        } satisfies TaskEvent,
      ]);

      const res = await app.request("/tasks/task-1/events?afterSeq=0");

      expect(res.status).toBe(200);
      expect(taskRepo.listEvents).toHaveBeenCalledWith("task-1", 0);
      const body = await res.json();
      expect(body[0].type).toBe("task.created");
    });
  });
});
