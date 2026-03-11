import { Hono } from "hono";
import type { ThreadOrchestrator, ThreadWorkStatus } from "@beanbag/agent-core";
import type {
  EventRepository,
  ProjectRepository,
  ThreadRepository,
} from "@beanbag/db";
import { createProjectRoutes } from "./projects.js";
import { createThreadRoutes } from "./threads.js";
import { createSystemRoutes } from "./system.js";
import type { WSManager } from "../ws.js";
import type { EnvironmentAgentSessionService } from "../environment-agent-session-service.js";
import type { SystemHealthReport } from "@beanbag/agent-core";

export interface ApiRouteDeps {
  projectRepo: ProjectRepository;
  threadRepo: ThreadRepository;
  eventRepo: EventRepository;
  threadManager: ThreadOrchestrator;
  environmentAgentSessionService?: EnvironmentAgentSessionService;
  wsManager: WSManager;
  startTime: number;
  requestShutdown?: (reason: string) => void;
  requestRestart?: (reason: string) => void;
  shouldRestart?: () => boolean;
  getHealthReport?: () => SystemHealthReport;
}

export function createApiRoutes(deps: ApiRouteDeps) {
  const workspaceStatusAccessor = deps.threadManager as ThreadOrchestrator & {
    deleteThread?: (threadId: string) => Promise<void>;
    getProjectWorkspaceStatusAsync?: (
      projectId: string,
      rootPath: string,
    ) => Promise<ThreadWorkStatus>;
  };
  return new Hono()
    .route(
      "/projects",
      createProjectRoutes(deps.projectRepo, undefined, undefined, {
        threadRepo: deps.threadRepo,
        eventRepo: deps.eventRepo,
        deleteThreadAsync: (threadId) =>
          workspaceStatusAccessor.deleteThread
            ? workspaceStatusAccessor.deleteThread(threadId)
            : Promise.reject(new Error("Thread deletion is unavailable")),
        getProjectWorkspaceStatusAsync: (projectId, rootPath) =>
          workspaceStatusAccessor.getProjectWorkspaceStatusAsync
            ? workspaceStatusAccessor.getProjectWorkspaceStatusAsync(projectId, rootPath)
            : Promise.reject(
                new Error("Project workspace status lookup is unavailable"),
              ),
      }),
    )
    .route(
      "/threads",
      createThreadRoutes(deps.threadManager, {
        environmentAgentSessionService: deps.environmentAgentSessionService,
      }),
    )
    .route(
      "/system",
      createSystemRoutes(deps.threadManager, deps.startTime, {
        requestShutdown: deps.requestShutdown,
        requestRestart: deps.requestRestart,
        shouldRestart: deps.shouldRestart,
        getHealthReport: deps.getHealthReport,
      }),
    );
}
