import { Hono } from "hono";
import type { ServerRuntimeMode, ThreadOrchestrator, ThreadWorkStatus } from "@bb/core";
import type {
  EnvironmentRepository,
  EventRepository,
  ProjectRepository,
  ThreadEnvironmentAttachmentRepository,
  ThreadRepository,
} from "@bb/db";
import { createEnvironmentRoutes } from "./environments.js";
import { createEnvironmentDaemonRoutes } from "./environment-daemon.js";
import { createProjectRoutes } from "./projects.js";
import { createThreadRoutes } from "./threads.js";
import { createSystemRoutes } from "./system.js";
import type { WSManager } from "../ws.js";
import type { EnvironmentAgentSessionService } from "../environment-agent-session-service.js";
import type { SystemHealthReport } from "@bb/core";

export interface ApiRouteDeps {
  projectRepo: ProjectRepository;
  environmentRepo?: EnvironmentRepository;
  threadEnvironmentAttachmentRepo?: ThreadEnvironmentAttachmentRepository;
  threadRepo: ThreadRepository;
  eventRepo: EventRepository;
  threadManager: ThreadOrchestrator;
  environmentAgentSessionService?: EnvironmentAgentSessionService;
  wsManager: WSManager;
  startTime: number;
  requestShutdown?: (reason: string) => void;
  requestRestart?: (reason: string) => void;
  shouldRestart?: () => boolean;
  getRuntimeMode?: () => ServerRuntimeMode;
  getHealthReport?: () => SystemHealthReport;
  runtimeEnv: NodeJS.ProcessEnv;
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
        threadManager: deps.threadManager,
        runtimeEnv: deps.runtimeEnv,
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
        environmentRepo: deps.environmentRepo,
        threadEnvironmentAttachmentRepo: deps.threadEnvironmentAttachmentRepo,
        runtimeEnv: deps.runtimeEnv,
      }),
    )
    .route("/environments", createEnvironmentRoutes(deps.environmentRepo, deps.threadManager))
    .route(
      "/environments",
      deps.environmentAgentSessionService && deps.environmentRepo
        ? createEnvironmentDaemonRoutes({
            environmentAgentSessionService: deps.environmentAgentSessionService,
            environmentRepo: deps.environmentRepo,
          })
        : new Hono(),
    )
    .route(
      "/system",
      createSystemRoutes(deps.threadManager, deps.startTime, {
        requestShutdown: deps.requestShutdown,
        requestRestart: deps.requestRestart,
        shouldRestart: deps.shouldRestart,
        getRuntimeMode: deps.getRuntimeMode,
        getHealthReport: deps.getHealthReport,
      }),
    );
}
