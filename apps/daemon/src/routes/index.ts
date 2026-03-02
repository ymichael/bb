import { Hono } from "hono";
import type { ProviderCommitMessageGenerator, ThreadOrchestrator } from "@beanbag/agent-core";
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
  projectCommitMessageGenerator?: ProviderCommitMessageGenerator;
  requestShutdown?: (reason: string) => void;
}

export function createApiRoutes(deps: ApiRouteDeps) {
  return new Hono()
    .route(
      "/projects",
      createProjectRoutes(deps.projectRepo, undefined, undefined, {
        threadRepo: deps.threadRepo,
        eventRepo: deps.eventRepo,
        commitMessageGenerator: deps.projectCommitMessageGenerator,
      }),
    )
    .route("/threads", createThreadRoutes(deps.threadManager))
    .route(
      "/system",
      createSystemRoutes(deps.threadManager, deps.startTime, {
        requestShutdown: deps.requestShutdown,
      }),
    );
}
