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
  updateProjectRequestSchema,
  updateProjectSourceRequestSchema,
  workspaceFileSchema,
  type ProjectResponse,
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
import { parseJsonBody, parseOptionalInteger, parseQueryValue } from "../services/validation.js";

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
  app.get("/projects", (context) => context.json(buildProjectResponses(deps)));

  app.post("/projects", async (context) => {
    const payload = await parseJsonBody(context, createProjectRequestSchema);
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

  app.get("/projects/:id", (context) =>
    context.json(buildProjectResponses(deps, context.req.param("id"))[0]),
  );

  app.patch("/projects/:id", async (context) => {
    requireProject(deps.db, context.req.param("id"));
    const payload = await parseJsonBody(context, updateProjectRequestSchema);
    const project = updateProject(deps.db, deps.hub, context.req.param("id"), payload);
    if (!project) {
      throw new ApiError(404, "project_not_found", "Project not found");
    }
    return context.json(buildProjectResponses(deps, project.id)[0]);
  });

  app.delete("/projects/:id", async (context) => {
    requireProject(deps.db, context.req.param("id"));
    await deleteProjectAttachments(deps.config.dataDir, context.req.param("id"));
    deleteProject(deps.db, deps.hub, context.req.param("id"));
    return context.json({ ok: true });
  });

  app.post("/projects/:id/sources", async (context) => {
    requireProject(deps.db, context.req.param("id"));
    const payload = await parseJsonBody(context, createProjectSourceRequestSchema);
    requireHostWithStatus(deps.db, payload.hostId);
    const source = createProjectSource(deps.db, deps.hub, {
      projectId: context.req.param("id"),
      hostId: payload.hostId,
      type: payload.type ?? "local_path",
      path: payload.path ?? null,
      repoUrl: payload.repoUrl ?? null,
    });
    return context.json(source, 201);
  });

  app.patch("/projects/:id/sources/:sourceId", async (context) => {
    requireProject(deps.db, context.req.param("id"));
    const payload = await parseJsonBody(context, updateProjectSourceRequestSchema);
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

  app.delete("/projects/:id/sources/:sourceId", (context) => {
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

  app.get("/projects/:id/files", async (context) => {
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
        ...(context.req.query("query") ? { query: context.req.query("query") } : {}),
      },
    });
    const result = hostDaemonCommandResultSchemaByType["workspace.list_files"].parse(rawResult);
    const limit = parseOptionalInteger(context.req.query("limit"), "limit");
    return context.json(
      result.files
        .slice(0, limit ?? result.files.length)
        .map((file) => workspaceFileSchema.parse(file)),
    );
  });

  app.post("/projects/:id/attachments", async (context) => {
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

  app.get("/projects/:id/attachments/content", async (context) => {
    requireProject(deps.db, context.req.param("id"));
    const path = parseQueryValue(context.req.query("path"), "path");
    const attachment = await readAttachment(deps.config.dataDir, context.req.param("id"), path);
    return new Response(new Uint8Array(attachment.content), {
      status: 200,
      headers: {
        "content-type": attachment.mimeType ?? "application/octet-stream",
      } as HeadersInit,
    });
  });

  app.post("/projects/:id/managers", async (context) => {
    requireProject(deps.db, context.req.param("id"));
    const payload = await parseJsonBody(context, createManagerThreadRequestSchema);
    const source = getDefaultProjectSource(deps.db, context.req.param("id"));
    if (!source) {
      throw new ApiError(409, "invalid_request", "Project has no default source");
    }
    const thread = await createThreadFromRequest(deps, {
      projectId: context.req.param("id"),
      providerId: payload.providerId ?? "claude-code",
      type: "manager",
      ...(payload.title ? { title: payload.title } : {}),
      ...(payload.model ? { model: payload.model } : {}),
      ...(payload.reasoningLevel ? { reasoningLevel: payload.reasoningLevel } : {}),
      environment: {
        type: "host",
        hostId: source.hostId,
        workspace: { type: "managed-worktree" },
      },
    });
    return context.json(thread, 201);
  });
}
