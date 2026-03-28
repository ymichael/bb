import { eq, inArray } from "drizzle-orm";
import {
  createProject,
  createProjectSource,
  deleteProject,
  deleteProjectSource,
  getDefaultProjectSource,
  listProjects,
  projectSources,
  updateProject,
  updateProjectSource,
} from "@bb/db";
import {
  createManagerThreadRequestSchema,
  createProjectRequestSchema,
  createProjectSourceRequestSchema,
  projectAttachmentContentQuerySchema,
  projectFilesQuerySchema,
  typedRoutes,
  updateProjectRequestSchema,
  updateProjectSourceRequestSchema,
  workspaceFileSchema,
  type ProjectResponse,
  type PublicApiSchema,
} from "@bb/server-contract";
import { hostDaemonCommandResultSchemaByType } from "@bb/host-daemon-contract";
import type { Hono } from "hono";
import type { AppDeps } from "../types.js";
import { COMMAND_TIMEOUT_MS } from "../constants.js";
import { ApiError } from "../errors.js";
import { deleteProjectAttachments, readAttachment, storeAttachment } from "../services/attachments.js";
import { requireHostWithStatus, requireProject } from "../services/entity-lookup.js";
import { ensureProjectSourceEnvironment, createThreadFromRequest } from "../services/thread-create.js";
import { queueCommandAndWait } from "../services/command-wait.js";
import { parseOptionalInteger } from "../services/validation.js";

function buildProjectResponses(deps: AppDeps, projectId?: string): ProjectResponse[] {
  const projects = projectId ? [requireProject(deps.db, projectId)] : listProjects(deps.db);
  if (projects.length === 0) {
    return [];
  }
  const sources = deps.db
    .select()
    .from(projectSources)
    .where(inArray(projectSources.projectId, projects.map((project) => project.id)))
    .all();

  return projects.map((project) => ({
    ...project,
    sources: sources.filter((source) => source.projectId === project.id),
  }));
}

function requireProjectSource(
  deps: Pick<AppDeps, "db">,
  args: {
    projectId: string;
    sourceId: string;
  },
) {
  const source = deps.db
    .select()
    .from(projectSources)
    .where(eq(projectSources.id, args.sourceId))
    .get();
  if (!source || source.projectId !== args.projectId) {
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
    requireHostWithStatus(deps.db, payload.hostId);
    const project = createProject(deps.db, deps.hub, {
      name: payload.name,
    });
    createProjectSource(deps.db, deps.hub, {
      projectId: project.id,
      hostId: payload.hostId,
      type: "local_path",
      path: payload.sourcePath,
      isDefault: true,
    });
    return context.json(buildProjectResponses(deps, project.id)[0], 201);
  });

  get("/projects/:id", (context) =>
    context.json(buildProjectResponses(deps, context.req.param("id"))[0]),
  );

  patch("/projects/:id", updateProjectRequestSchema, async (context, payload) => {
    requireProject(deps.db, context.req.param("id"));
    const project = updateProject(deps.db, deps.hub, context.req.param("id"), payload);
    if (!project) {
      throw new ApiError(404, "project_not_found", "Project not found");
    }
    return context.json(buildProjectResponses(deps, project.id)[0]);
  });

  del("/projects/:id", async (context) => {
    requireProject(deps.db, context.req.param("id"));
    await deleteProjectAttachments(deps.config.dataDir, context.req.param("id"));
    deleteProject(deps.db, deps.hub, context.req.param("id"));
    return context.json({ ok: true });
  });

  post("/projects/:id/sources", createProjectSourceRequestSchema, async (context, payload) => {
    requireProject(deps.db, context.req.param("id"));
    requireHostWithStatus(deps.db, payload.hostId);
    const source = createProjectSource(deps.db, deps.hub, {
      projectId: context.req.param("id"),
      hostId: payload.hostId,
      type: payload.type,
      path: payload.type === "local_path" ? payload.path : null,
      repoUrl: payload.type === "github_repo" ? payload.repoUrl : null,
    });
    return context.json(source, 201);
  });

  patch("/projects/:id/sources/:sourceId", updateProjectSourceRequestSchema, async (context, payload) => {
    requireProject(deps.db, context.req.param("id"));
    requireProjectSource(deps, {
      projectId: context.req.param("id"),
      sourceId: context.req.param("sourceId"),
    });
    const source = updateProjectSource(
      deps.db,
      deps.hub,
      context.req.param("sourceId"),
      payload,
    );
    if (!source) {
      throw new ApiError(404, "invalid_request", "Project source not found");
    }
    return context.json(source);
  });

  del("/projects/:id/sources/:sourceId", (context) => {
    requireProject(deps.db, context.req.param("id"));
    requireProjectSource(deps, {
      projectId: context.req.param("id"),
      sourceId: context.req.param("sourceId"),
    });
    const deleted = deleteProjectSource(deps.db, deps.hub, context.req.param("sourceId"));
    if (!deleted) {
      throw new ApiError(404, "invalid_request", "Project source not found");
    }
    return context.json({ ok: true });
  });

  get("/projects/:id/files", projectFilesQuerySchema, async (context, query) => {
    requireProject(deps.db, context.req.param("id"));
    const source = getDefaultProjectSource(deps.db, context.req.param("id"));
    if (!source || !source.path) {
      throw new ApiError(409, "invalid_request", "Project has no default source");
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
        environmentStatus: "ready",
        workspacePath: source.path,
        ...(query.query ? { query: query.query } : {}),
      },
    });
    const result = hostDaemonCommandResultSchemaByType["workspace.list_files"].parse(rawResult);
    const limit = parseOptionalInteger(query.limit, "limit");
    return context.json(
      result.files
        .slice(0, limit ?? result.files.length)
        .map((file) => workspaceFileSchema.parse(file)),
    );
  });

  post("/projects/:id/attachments", async (context) => {
    requireProject(deps.db, context.req.param("id"));
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
    requireProject(deps.db, context.req.param("id"));
    const attachment = await readAttachment(deps.config.dataDir, context.req.param("id"), query.path);
    return new Response(new Uint8Array(attachment.content), {
      status: 200,
      headers: {
        "content-type": attachment.mimeType ?? "application/octet-stream",
      } as HeadersInit,
    });
  });

  post("/projects/:id/managers", createManagerThreadRequestSchema, async (context, payload) => {
    requireProject(deps.db, context.req.param("id"));
    const source = getDefaultProjectSource(deps.db, context.req.param("id"));
    if (!source) {
      throw new ApiError(409, "invalid_request", "Project has no default source");
    }
    const thread = await createThreadFromRequest(deps, {
      projectId: context.req.param("id"),
      providerId: payload.providerId,
      type: "manager",
      ...(payload.title ? { title: payload.title } : {}),
      model: payload.model,
      reasoningLevel: payload.reasoningLevel,
      environment: {
        type: "host",
        hostId: source.hostId,
        workspace: { type: "managed-worktree" },
      },
    });
    return context.json(thread, 201);
  });
}
