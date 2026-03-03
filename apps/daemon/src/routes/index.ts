import { Hono } from "hono";
import type { ThreadOrchestrator } from "@beanbag/agent-core";
import type {
  EventRepository,
  ProjectRepository,
  ThreadRepository,
} from "@beanbag/db";
import { createProjectRoutes } from "./projects.js";
import { createThreadRoutes } from "./threads.js";
import { createSystemRoutes } from "./system.js";
import type { WSManager } from "../ws.js";

export interface ApiRouteDeps {
  projectRepo: ProjectRepository;
  threadRepo: ThreadRepository;
  eventRepo: EventRepository;
  threadManager: ThreadOrchestrator;
  wsManager: WSManager;
  startTime: number;
  requestShutdown?: (reason: string) => void;
  requestRestart?: (reason: string) => void;
  shouldRestart?: () => boolean;
}

export function createApiRoutes(deps: ApiRouteDeps) {
  return new Hono()
    .route(
      "/projects",
      createProjectRoutes(deps.projectRepo, undefined, undefined, {
        threadRepo: deps.threadRepo,
        eventRepo: deps.eventRepo,
      }),
    )
    .route("/threads", createThreadRoutes(deps.threadManager))
    .route(
      "/system",
      createSystemRoutes(deps.threadManager, deps.startTime, {
        requestShutdown: deps.requestShutdown,
        requestRestart: deps.requestRestart,
        shouldRestart: deps.shouldRestart,
      }),
    );
}
