import { Hono } from "hono";
import type { ProjectRepository, TaskRepository } from "@beanbag/db";
import type { ThreadManager } from "../thread-manager.js";
import { createProjectRoutes } from "./projects.js";
import { createThreadRoutes } from "./threads.js";
import { createSystemRoutes } from "./system.js";
import { createTaskRoutes } from "./tasks.js";
import { createRoleRoutes } from "./roles.js";
import type { WSManager } from "../ws.js";

export interface ApiRouteDeps {
  projectRepo: ProjectRepository;
  taskRepo: TaskRepository;
  threadManager: ThreadManager;
  wsManager: WSManager;
  startTime: number;
}

export function createApiRoutes(deps: ApiRouteDeps) {
  return new Hono()
    .route("/projects", createProjectRoutes(deps.projectRepo))
    .route(
      "/tasks",
      createTaskRoutes(
        deps.projectRepo,
        deps.taskRepo,
        deps.threadManager,
        deps.wsManager,
      ),
    )
    .route("/roles", createRoleRoutes())
    .route("/threads", createThreadRoutes(deps.threadManager))
    .route("/system", createSystemRoutes(deps.threadManager, deps.startTime));
}
