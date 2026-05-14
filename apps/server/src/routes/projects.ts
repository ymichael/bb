import {
  countProjectSources,
  createProject,
  getProjectExecutionDefaults,
  createProjectSource,
  deleteProjectSource,
  getDefaultProjectSource,
  getProjectSourceByHost,
  getProjectSourceForProject,
  listProjectSources,
  listPublicProjects,
  listProjectSourcesByProjectIds,
  listThreads,
  listThreadsWithPendingInteractionStateForProjects,
  updateProject,
  updateProjectSource,
} from "@bb/db";
import { FILE_LIST_LIMIT_MAX } from "@bb/host-daemon-contract";
import {
  createManagerThreadRequestSchema,
  createProjectRequestSchema,
  createProjectSourceRequestSchema,
  projectAttachmentContentQuerySchema,
  projectBranchesQuerySchema,
  projectDefaultExecutionOptionsQuerySchema,
  projectFilesQuerySchema,
  projectListIncludeOptionSchema,
  projectListQuerySchema,
  promptHistoryQuerySchema,
  typedRoutes,
  updateProjectRequestSchema,
  updateProjectSourceRequestSchema,
  type ProjectListIncludeOption,
  type ProjectListQuery,
  type ProjectResponse,
  type ProjectWithThreadsResponse,
  type PublicApiSchema,
} from "@bb/server-contract";
import type { Hono } from "hono";
import { renderTemplate } from "@bb/templates";
import type { AppDeps } from "../types.js";
import { COMMAND_TIMEOUT_MS } from "../constants.js";
import { ApiError } from "../errors.js";
import {
  readAttachment,
  storeAttachment,
} from "../services/projects/attachments.js";
import {
  requireNonDestroyedHostWithStatus,
  requireProject,
  requirePublicProject,
  requireReadyEnvironment,
} from "../services/lib/entity-lookup.js";
import { PROMPT_HISTORY_ENTRY_LIMIT } from "@bb/domain";
import { createThreadFromRequest } from "../services/threads/thread-create.js";
import {
  toThreadListEntryResponses,
  toThreadResponseFromThread,
} from "../services/threads/thread-runtime-display.js";
import { queueCommandAndWait } from "../services/hosts/command-wait.js";
import { parseOptionalInteger } from "../services/lib/validation.js";
import {
  advanceProjectDeletion,
  requestProjectDeletion,
} from "../services/projects/project-deletion.js";
import { fetchGithubBranches } from "../services/github/branches.js";
import { listProjectPromptHistory } from "../services/prompt-history.js";

function buildProjectResponses(
  deps: AppDeps,
  projectId?: string,
): ProjectResponse[] {
  const projects = projectId
    ? [requirePublicProject(deps.db, projectId)]
    : listPublicProjects(deps.db);
  if (projects.length === 0) {
    return [];
  }
  const sourcesByProjectId = new Map<string, ProjectResponse["sources"]>();
  for (const source of listProjectSourcesByProjectIds(
    deps.db,
    projects.map((project) => project.id),
  )) {
    const projectSources = sourcesByProjectId.get(source.projectId);
    if (projectSources) {
      projectSources.push(source);
      continue;
    }
    sourcesByProjectId.set(source.projectId, [source]);
  }

  return projects.map((project) => ({
    ...project,
    sources: sourcesByProjectId.get(project.id) ?? [],
  }));
}

function parseProjectListIncludes(
  query: ProjectListQuery,
): Set<ProjectListIncludeOption> {
  const includes = new Set<ProjectListIncludeOption>();
  if (!query.include) {
    return includes;
  }
  for (const value of query.include.split(",")) {
    includes.add(projectListIncludeOptionSchema.parse(value));
  }
  return includes;
}

function buildProjectsWithThreadsResponse(
  deps: AppDeps,
): ProjectWithThreadsResponse[] {
  const projects = buildProjectResponses(deps);
  const projectIds = projects.map((project) => project.id);
  const threadRows = listThreadsWithPendingInteractionStateForProjects(
    deps.db,
    {
      archived: false,
      projectIds,
    },
  );
  const threadResponses = toThreadListEntryResponses(deps, {
    threads: threadRows,
  });
  const threadsByProjectId = new Map<
    string,
    ProjectWithThreadsResponse["threads"]
  >();
  for (const thread of threadResponses) {
    const projectThreads = threadsByProjectId.get(thread.projectId);
    if (projectThreads) {
      projectThreads.push(thread);
      continue;
    }
    threadsByProjectId.set(thread.projectId, [thread]);
  }

  return projects.map((project) => ({
    ...project,
    threads: threadsByProjectId.get(project.id) ?? [],
  }));
}

interface RequireProjectSourceArgs {
  projectId: string;
  sourceId: string;
}

function requireProjectSource(
  deps: Pick<AppDeps, "db">,
  args: RequireProjectSourceArgs,
) {
  const source = getProjectSourceForProject(deps.db, args);
  if (!source) {
    throw new ApiError(404, "invalid_request", "Project source not found");
  }
  return source;
}

interface ResolvedHostPath {
  hostId: string;
  path: string;
}

/**
 * Resolve `(hostId, path)` from an existing project-bound environment.
 * Pure DB lookup — no provisioning, no daemon roundtrip. Use this when a
 * route narrows to a specific environment's workspace (e.g. a thread's
 * worktree) and needs to dispatch a `host.*` daemon command against the
 * environment's path.
 */
function resolveEnvironmentPath(
  deps: Pick<AppDeps, "db">,
  args: { projectId: string; environmentId: string },
): ResolvedHostPath {
  const environment = requireReadyEnvironment(deps.db, args.environmentId);
  if (environment.projectId !== args.projectId) {
    throw new ApiError(404, "environment_not_found", "Environment not found");
  }
  return { hostId: environment.hostId, path: environment.path };
}

/**
 * Resolve `(hostId, path)` from a project's local-path source. Pure DB
 * lookup — never creates an environment row, never queues a provision
 * command. Use for read-only listings issued before any thread environment
 * exists (e.g. file mentions and branch listing in the new-thread prompt
 * box).
 *
 * - When `hostId` is provided, returns the project's local-path source on
 *   that host (404 if the project has no local-path source for that host).
 * - When `hostId` is null, returns the project's default local-path source.
 */
function resolveProjectSourcePath(
  deps: Pick<AppDeps, "db">,
  args: { projectId: string; hostId: string | null },
): ResolvedHostPath {
  const source = args.hostId
    ? getProjectSourceByHost(deps.db, args.projectId, args.hostId)
    : getDefaultProjectSource(deps.db, args.projectId);
  if (!source || source.type !== "local_path") {
    throw new ApiError(
      args.hostId ? 404 : 409,
      "invalid_request",
      args.hostId
        ? "Project has no local-path source for host"
        : "Project has no default source",
    );
  }
  return { hostId: source.hostId, path: source.path };
}

export function registerProjectRoutes(app: Hono, deps: AppDeps): void {
  const { get, post, patch, del } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });

  get("/projects", projectListQuerySchema, (context, query) => {
    const includes = parseProjectListIncludes(query);
    if (includes.has("threads")) {
      return context.json(buildProjectsWithThreadsResponse(deps));
    }
    return context.json(buildProjectResponses(deps));
  });

  post("/projects", createProjectRequestSchema, async (context, payload) => {
    const { source } = payload;
    if (source.type === "local_path") {
      requireNonDestroyedHostWithStatus(deps.db, source.hostId);
    }
    const { project } = createProject(deps.db, deps.hub, {
      name: payload.name,
      source,
    });
    return context.json(buildProjectResponses(deps, project.id)[0], 201);
  });

  get("/projects/:id", (context) =>
    context.json(buildProjectResponses(deps, context.req.param("id"))[0]),
  );

  get(
    "/projects/:id/default-execution-options",
    projectDefaultExecutionOptionsQuerySchema,
    (context, query) => {
      const projectId = context.req.param("id");
      requirePublicProject(deps.db, projectId);
      return context.json(
        getProjectExecutionDefaults(deps.db, {
          projectId,
          threadType: query.threadType,
        }),
      );
    },
  );

  get(
    "/projects/:id/prompt-history",
    promptHistoryQuerySchema,
    (context, query) => {
      const projectId = context.req.param("id");
      requirePublicProject(deps.db, projectId);
      const limit = Math.min(
        parseOptionalInteger(query.limit, "limit") ??
          PROMPT_HISTORY_ENTRY_LIMIT,
        PROMPT_HISTORY_ENTRY_LIMIT,
      );
      if (limit <= 0) {
        throw new ApiError(
          400,
          "invalid_request",
          "limit must be a positive integer",
        );
      }

      return context.json(
        listProjectPromptHistory(deps, {
          projectId,
          limit,
        }),
      );
    },
  );

  patch(
    "/projects/:id",
    updateProjectRequestSchema,
    async (context, payload) => {
      requirePublicProject(deps.db, context.req.param("id"));
      const project = updateProject(
        deps.db,
        deps.hub,
        context.req.param("id"),
        payload,
      );
      if (!project) {
        throw new ApiError(404, "project_not_found", "Project not found");
      }
      return context.json(buildProjectResponses(deps, project.id)[0]);
    },
  );

  del("/projects/:id", async (context) => {
    const id = context.req.param("id");
    requireProject(deps.db, id);
    requestProjectDeletion(deps, { projectId: id });
    await advanceProjectDeletion(deps, { projectId: id });
    return context.json({ ok: true });
  });

  post(
    "/projects/:id/sources",
    createProjectSourceRequestSchema,
    async (context, payload) => {
      requirePublicProject(deps.db, context.req.param("id"));
      if (payload.type === "local_path") {
        requireNonDestroyedHostWithStatus(deps.db, payload.hostId);
      }
      const source = createProjectSource(deps.db, deps.hub, {
        projectId: context.req.param("id"),
        ...payload,
      });
      return context.json(source, 201);
    },
  );

  patch(
    "/projects/:id/sources/:sourceId",
    updateProjectSourceRequestSchema,
    async (context, payload) => {
      requirePublicProject(deps.db, context.req.param("id"));
      const existing = requireProjectSource(deps, {
        projectId: context.req.param("id"),
        sourceId: context.req.param("sourceId"),
      });
      if (payload.type !== existing.type) {
        throw new ApiError(
          400,
          "invalid_request",
          `Source type mismatch: source is ${existing.type} but request specifies ${payload.type}`,
        );
      }
      const source = updateProjectSource(
        deps.db,
        deps.hub,
        context.req.param("sourceId"),
        payload.type === "local_path"
          ? {
              ...(payload.path ? { path: payload.path } : {}),
              ...(payload.isDefault ? { isDefault: payload.isDefault } : {}),
            }
          : {
              ...(payload.repoUrl ? { repoUrl: payload.repoUrl } : {}),
              ...(payload.isDefault ? { isDefault: payload.isDefault } : {}),
            },
      );
      if (!source) {
        throw new ApiError(404, "invalid_request", "Project source not found");
      }
      return context.json(source);
    },
  );

  del("/projects/:id/sources/:sourceId", (context) => {
    const projectId = context.req.param("id");
    requirePublicProject(deps.db, projectId);
    requireProjectSource(deps, {
      projectId,
      sourceId: context.req.param("sourceId"),
    });
    const sourceCount = countProjectSources(deps.db, { projectId });
    if (sourceCount <= 1) {
      throw new ApiError(
        409,
        "invalid_request",
        "Cannot delete the last source of a project",
      );
    }
    const deleted = deleteProjectSource(
      deps.db,
      deps.hub,
      context.req.param("sourceId"),
    );
    if (!deleted) {
      throw new ApiError(404, "invalid_request", "Project source not found");
    }
    return context.json({ ok: true });
  });

  get(
    "/projects/:id/files",
    projectFilesQuerySchema,
    async (context, query) => {
      const projectId = context.req.param("id");
      requirePublicProject(deps.db, projectId);

      const limit = Math.min(
        parseOptionalInteger(query.limit, "limit") ?? 1000,
        FILE_LIST_LIMIT_MAX,
      );
      if (limit <= 0) {
        throw new ApiError(
          400,
          "invalid_request",
          "limit must be a positive integer",
        );
      }

      // Both branches dispatch host.list_files against the resolved path —
      // env-scoped requests narrow to a specific environment's workspace
      // (e.g. a thread's worktree), pre-env requests fall back to the
      // project's default source.
      const target =
        query.environmentId !== null
          ? resolveEnvironmentPath(deps, {
              projectId,
              environmentId: query.environmentId,
            })
          : resolveProjectSourcePath(deps, { projectId, hostId: null });
      const result = await queueCommandAndWait(deps, {
        hostId: target.hostId,
        timeoutMs: COMMAND_TIMEOUT_MS,
        command: {
          type: "host.list_files",
          path: target.path,
          ...(query.query ? { query: query.query } : {}),
          limit,
        },
      });
      return context.json({ files: result.files, truncated: result.truncated });
    },
  );

  get(
    "/projects/:id/branches",
    projectBranchesQuerySchema,
    async (context, query) => {
      const projectId = context.req.param("id");
      requirePublicProject(deps.db, projectId);

      const source = resolveProjectSourcePath(deps, {
        projectId,
        hostId: query.hostId,
      });
      const result = await queueCommandAndWait(deps, {
        hostId: source.hostId,
        timeoutMs: COMMAND_TIMEOUT_MS,
        command: {
          type: "host.list_branches",
          path: source.path,
        },
      });
      return context.json({
        branches: result.branches,
        current: result.current,
        defaultBranch: result.defaultBranch,
      });
    },
  );

  get("/projects/:id/github-branches", async (context) => {
    const projectId = context.req.param("id");
    requirePublicProject(deps.db, projectId);

    if (!deps.config.githubPat) {
      throw new ApiError(
        501,
        "not_configured",
        "GitHub PAT is not configured",
      );
    }

    const githubSource = listProjectSources(deps.db, projectId).find(
      (source) => source.type === "github_repo",
    );
    if (!githubSource || githubSource.type !== "github_repo") {
      throw new ApiError(
        404,
        "invalid_request",
        "Project has no GitHub source",
      );
    }

    return context.json(
      await fetchGithubBranches(deps.config.githubPat, githubSource.repoUrl),
    );
  });

  post("/projects/:id/attachments", async (context) => {
    requirePublicProject(deps.db, context.req.param("id"));
    const formData = await context.req.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      throw new ApiError(400, "invalid_request", "Attachment file is required");
    }
    return context.json(
      await storeAttachment(deps.config.dataDir, context.req.param("id"), file),
      201,
    );
  });

  get(
    "/projects/:id/attachments/content",
    projectAttachmentContentQuerySchema,
    async (context, query) => {
      requirePublicProject(deps.db, context.req.param("id"));
      const attachment = await readAttachment(
        deps.config.dataDir,
        context.req.param("id"),
        query.path,
      );
      return new Response(new Uint8Array(attachment.content), {
        status: 200,
        headers: {
          "content-type": attachment.mimeType ?? "application/octet-stream",
        } as HeadersInit,
      });
    },
  );

  post(
    "/projects/:id/managers",
    createManagerThreadRequestSchema,
    async (context, payload) => {
      const projectId = context.req.param("id");
      requirePublicProject(deps.db, projectId);

      const { hostId } = payload.environment;
      requireNonDestroyedHostWithStatus(deps.db, hostId);
      const source = getProjectSourceByHost(deps.db, projectId, hostId);
      if (!source) {
        throw new ApiError(
          409,
          "invalid_request",
          "No project source found for the selected host",
        );
      }
      if (source.type !== "local_path") {
        throw new ApiError(
          409,
          "invalid_request",
          "Project source for host has no local path",
        );
      }

      let title: string;
      if (payload.name) {
        title = payload.name;
      } else {
        const existingManagers = listThreads(deps.db, {
          projectId,
          type: "manager",
        });
        title =
          existingManagers.length === 0
            ? "Manager"
            : `Manager ${existingManagers.length + 1}`;
      }

      const welcomeMessage = renderTemplate("systemMessageManagerWelcome", {});

      const thread = await createThreadFromRequest(deps, {
        automationId: null,
        origin: payload.origin,
        projectId,
        providerId: payload.providerId,
        type: "manager",
        title,
        input: [{ type: "text", text: welcomeMessage }],
        ...(payload.model ? { model: payload.model } : {}),
        ...(payload.serviceTier ? { serviceTier: payload.serviceTier } : {}),
        ...(payload.reasoningLevel
          ? { reasoningLevel: payload.reasoningLevel }
          : {}),
        ...(payload.permissionMode
          ? { permissionMode: payload.permissionMode }
          : {}),
        environment: {
          type: "host",
          hostId,
          workspace: { type: "unmanaged", path: source.path },
        },
      });
      return context.json(toThreadResponseFromThread(deps, { thread }), 201);
    },
  );
}
