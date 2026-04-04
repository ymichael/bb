import { eq, inArray } from "drizzle-orm";
import {
  createProject,
  createProjectSource,
  deleteProject,
  deleteProjectSource,
  getDefaultProjectSource,
  listEnvironments,
  listProjects,
  listThreads,
  projectSources,
  toProjectSource,
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
  type ProjectResponse,
  type PublicApiSchema,
} from "@bb/server-contract";
import { hostDaemonCommandResultSchemaByType } from "@bb/host-daemon-contract";
import type { Hono } from "hono";
import { renderTemplate } from "@bb/templates";
import type { AppDeps } from "../types.js";
import { COMMAND_TIMEOUT_MS } from "../constants.js";
import { ApiError } from "../errors.js";
import { deleteProjectAttachments, readAttachment, storeAttachment } from "../services/attachments.js";
import { queueEnvironmentDestroyCommand } from "../services/environment-cleanup.js";
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
    sources: sources
      .filter((source) => source.projectId === project.id)
      .map(toProjectSource),
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
    const { source } = payload;
    if (source.type === "local_path") {
      requireHostWithStatus(deps.db, source.hostId);
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

  patch("/projects/:id", updateProjectRequestSchema, async (context, payload) => {
    const project = updateProject(deps.db, deps.hub, context.req.param("id"), payload);
    if (!project) {
      throw new ApiError(404, "project_not_found", "Project not found");
    }
    return context.json(buildProjectResponses(deps, project.id)[0]);
  });

  del("/projects/:id", async (context) => {
    const id = context.req.param("id");
    requireProject(deps.db, id);

    // Queue host-daemon destroy commands for managed environments before the
    // cascade delete removes the environment rows.
    const environments = listEnvironments(deps.db, id);
    for (const env of environments) {
      if (env.managed && env.path && env.status !== "destroying" && env.status !== "destroyed") {
        queueEnvironmentDestroyCommand(deps, {
          hostId: env.hostId,
          id: env.id,
          path: env.path,
          workspaceProvisionType: env.workspaceProvisionType,
        });
      }
    }

    // DB delete first (cascades to environments, threads, events, sources),
    // then filesystem cleanup — avoids losing attachments if the delete throws.
    deleteProject(deps.db, deps.hub, id);
    await deleteProjectAttachments(deps.config.dataDir, id);
    return context.json({ ok: true });
  });

  post("/projects/:id/sources", createProjectSourceRequestSchema, async (context, payload) => {
    requireProject(deps.db, context.req.param("id"));
    if (payload.type === "local_path") {
      requireHostWithStatus(deps.db, payload.hostId);
    }
    const source = createProjectSource(deps.db, deps.hub, {
      projectId: context.req.param("id"),
      ...payload,
    });
    return context.json(source, 201);
  });

  patch("/projects/:id/sources/:sourceId", updateProjectSourceRequestSchema, async (context, payload) => {
    requireProject(deps.db, context.req.param("id"));
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
    requireProject(deps.db, projectId);
    requireProjectSource(deps, {
      projectId,
      sourceId: context.req.param("sourceId"),
    });
    const sourceCount = deps.db
      .select()
      .from(projectSources)
      .where(eq(projectSources.projectId, projectId))
      .all().length;
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
    requireProject(deps.db, context.req.param("id"));
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
    const projectId = context.req.param("id");
    requireProject(deps.db, projectId);
    const source = getDefaultProjectSource(deps.db, projectId);
    if (!source) {
      throw new ApiError(409, "invalid_request", "Project has no default source");
    }
    if (source.type !== "local_path") {
      throw new ApiError(409, "invalid_request", "Default source has no local path");
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
      projectId,
      providerId: payload.providerId,
      type: "manager",
      title,
      input: [{ type: "text", text: welcomeMessage }],
      model: payload.model,
      reasoningLevel: payload.reasoningLevel,
      environment: {
        type: "host",
        hostId: source.hostId,
        workspace: { type: "unmanaged", path: source.path },
      },
    });
    return context.json(thread, 201);
  });
}
