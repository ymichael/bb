import {
  countProjectSources,
  createProject,
  getProjectExecutionDefaults,
  createProjectSource,
  deleteProjectSource,
  getDefaultProjectSource,
  getProjectSourceByHost,
  getProjectSourceForProject,
  listPublicProjects,
  listProjectSourcesByProjectIds,
  listThreads,
  updateProject,
  updateProjectSource,
} from "@bb/db";
import {
  createManagerThreadRequestSchema,
  createProjectRequestSchema,
  createProjectSourceRequestSchema,
  projectAttachmentContentQuerySchema,
  projectDefaultExecutionOptionsQuerySchema,
  projectFilesQuerySchema,
  typedRoutes,
  updateProjectRequestSchema,
  updateProjectSourceRequestSchema,
  type ProjectResponse,
  type PublicApiSchema,
} from "@bb/server-contract";
import { hostDaemonCommandResultSchemaByType } from "@bb/host-daemon-contract";
import type { Hono } from "hono";
import { renderTemplate } from "@bb/templates";
import type { AppDeps } from "../types.js";
import { COMMAND_TIMEOUT_MS } from "../constants.js";
import { ApiError } from "../errors.js";
import { readAttachment, storeAttachment } from "../services/projects/attachments.js";
import {
  requireNonDestroyedHostWithStatus,
  requireProject,
  requirePublicProject,
} from "../services/lib/entity-lookup.js";
import { ensureProjectSourceEnvironment, createThreadFromRequest } from "../services/threads/thread-create.js";
import { queueCommandAndWait } from "../services/hosts/command-wait.js";
import { parseOptionalInteger } from "../services/lib/validation.js";
import {
  advanceProjectDeletion,
  requestProjectDeletion,
} from "../services/projects/project-deletion.js";

function buildProjectResponses(deps: AppDeps, projectId?: string): ProjectResponse[] {
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

export function registerProjectRoutes(app: Hono, deps: AppDeps): void {
  const { get, post, patch, del } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });

  get("/projects", (context) => context.json(buildProjectResponses(deps)));

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

  get("/projects/:id/default-execution-options", projectDefaultExecutionOptionsQuerySchema, (context, query) => {
    const projectId = context.req.param("id");
    requirePublicProject(deps.db, projectId);
    return context.json(
      getProjectExecutionDefaults(deps.db, {
        projectId,
        threadType: query.threadType,
      }),
    );
  });

  patch("/projects/:id", updateProjectRequestSchema, async (context, payload) => {
    requirePublicProject(deps.db, context.req.param("id"));
    const project = updateProject(deps.db, deps.hub, context.req.param("id"), payload);
    if (!project) {
      throw new ApiError(404, "project_not_found", "Project not found");
    }
    return context.json(buildProjectResponses(deps, project.id)[0]);
  });

  del("/projects/:id", async (context) => {
    const id = context.req.param("id");
    requireProject(deps.db, id);
    requestProjectDeletion(deps, { projectId: id });
    await advanceProjectDeletion(deps, { projectId: id });
    return context.json({ ok: true });
  });

  post("/projects/:id/sources", createProjectSourceRequestSchema, async (context, payload) => {
    requirePublicProject(deps.db, context.req.param("id"));
    if (payload.type === "local_path") {
      requireNonDestroyedHostWithStatus(deps.db, payload.hostId);
    }
    const source = createProjectSource(deps.db, deps.hub, {
      projectId: context.req.param("id"),
      ...payload,
    });
    return context.json(source, 201);
  });

  patch("/projects/:id/sources/:sourceId", updateProjectSourceRequestSchema, async (context, payload) => {
    requirePublicProject(deps.db, context.req.param("id"));
    const existing = requireProjectSource(deps, {
      projectId: context.req.param("id"),
      sourceId: context.req.param("sourceId"),
    });
    if (payload.type !== existing.type) {
      throw new ApiError(400, "invalid_request", `Source type mismatch: source is ${existing.type} but request specifies ${payload.type}`);
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
  });

  del("/projects/:id/sources/:sourceId", (context) => {
    const projectId = context.req.param("id");
    requirePublicProject(deps.db, projectId);
    requireProjectSource(deps, {
      projectId,
      sourceId: context.req.param("sourceId"),
    });
    const sourceCount = countProjectSources(deps.db, { projectId });
    if (sourceCount <= 1) {
      throw new ApiError(409, "invalid_request", "Cannot delete the last source of a project");
    }
    const deleted = deleteProjectSource(deps.db, deps.hub, context.req.param("sourceId"));
    if (!deleted) {
      throw new ApiError(404, "invalid_request", "Project source not found");
    }
    return context.json({ ok: true });
  });

  get("/projects/:id/files", projectFilesQuerySchema, async (context, query) => {
    requirePublicProject(deps.db, context.req.param("id"));
    const source = getDefaultProjectSource(deps.db, context.req.param("id"));
    if (!source || source.type !== "local_path") {
      throw new ApiError(409, "invalid_request", "Project has no default source");
    }

    const limit = Math.min(parseOptionalInteger(query.limit, "limit") ?? 1000, 10000);
    if (limit <= 0) {
      throw new ApiError(400, "invalid_request", "limit must be a positive integer");
    }
    const environment = await ensureProjectSourceEnvironment(deps, {
      hostId: source.hostId,
      path: source.path,
      projectId: context.req.param("id"),
    });
    const rawResult = await queueCommandAndWait(deps, {
      hostId: source.hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "workspace.list_files",
        environmentId: environment.id,
        workspaceContext: {
          workspacePath: source.path,
          workspaceProvisionType: environment.workspaceProvisionType,
        },
        ...(query.query ? { query: query.query } : {}),
        limit,
      },
    });
    const result = hostDaemonCommandResultSchemaByType["workspace.list_files"].parse(rawResult);
    return context.json({ files: result.files, truncated: result.truncated });
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

  get("/projects/:id/attachments/content", projectAttachmentContentQuerySchema, async (context, query) => {
    requirePublicProject(deps.db, context.req.param("id"));
    const attachment = await readAttachment(deps.config.dataDir, context.req.param("id"), query.path);
    return new Response(new Uint8Array(attachment.content), {
      status: 200,
      headers: {
        "content-type": attachment.mimeType ?? "application/octet-stream",
      } as HeadersInit,
    });
  });

  post("/projects/:id/managers", createManagerThreadRequestSchema, async (context, payload) => {
    const projectId = context.req.param("id");
    requirePublicProject(deps.db, projectId);

    const { hostId } = payload.environment;
    requireNonDestroyedHostWithStatus(deps.db, hostId);
    const source = getProjectSourceByHost(deps.db, projectId, hostId);
    if (!source) {
      throw new ApiError(409, "invalid_request", "No project source found for the selected host");
    }
    if (source.type !== "local_path") {
      throw new ApiError(409, "invalid_request", "Project source for host has no local path");
    }

    let title: string;
    if (payload.name) {
      title = payload.name;
    } else {
      const existingManagers = listThreads(deps.db, { projectId, type: "manager" });
      title = existingManagers.length === 0 ? "Manager" : `Manager ${existingManagers.length + 1}`;
    }

    const welcomeMessage = renderTemplate("systemMessageManagerWelcome", {});

    const thread = await createThreadFromRequest(deps, {
      automationId: null,
      origin: payload.origin ?? null,
      projectId,
      providerId: payload.providerId,
      type: "manager",
      title,
      input: [{ type: "text", text: welcomeMessage }],
      ...(payload.model ? { model: payload.model } : {}),
      ...(payload.serviceTier ? { serviceTier: payload.serviceTier } : {}),
      ...(payload.reasoningLevel ? { reasoningLevel: payload.reasoningLevel } : {}),
      ...(payload.sandboxMode ? { sandboxMode: payload.sandboxMode } : {}),
      environment: {
        type: "host",
        hostId,
        workspace: { type: "unmanaged", path: source.path },
      },
    });
    return context.json(thread, 201);
  });
}
