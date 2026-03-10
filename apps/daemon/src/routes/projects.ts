import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, resolve, sep } from "node:path";
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import {
  createProjectSchema,
  updateProjectSchema,
  type Project,
  type ProjectFileSuggestion,
  type ThreadWorkStatus,
  type UploadedPromptAttachment,
} from "@beanbag/agent-core";
import { z } from "zod";
import type { EventRepository, ProjectRepository, ThreadRepository } from "@beanbag/db";
import { searchProjectFiles } from "../project-file-search.js";
import {
  invalidRequestError,
  projectNotFoundError,
  unsupportedOperationError,
} from "../domain-errors.js";
import { sendApiError, sendRouteError } from "./error-response.js";

const projectFileQuerySchema = z.object({
  query: z.string().default(""),
  limit: z
    .string()
    .optional()
    .transform((value) => {
      if (!value) return undefined;
      const parsed = Number.parseInt(value, 10);
      return Number.isFinite(parsed) ? parsed : undefined;
    }),
});

const projectAttachmentQuerySchema = z.object({
  path: z.string().min(1),
});

type SearchProjectFilesFn = (
  rootPath: string,
  query: string,
  limit?: number,
) => Promise<ProjectFileSuggestion[]>;

type StorePromptAttachmentFn = (args: {
  projectId: string;
  file: File;
}) => Promise<UploadedPromptAttachment>;

const ATTACHMENTS_ROOT_PATH = resolve(homedir(), ".beanbag", "attachments");
const MAX_PROMPT_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_PROMPT_IMAGE_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const IMAGE_EXTENSION_PATTERN = /\.(png|jpe?g|webp|gif|bmp|svg)$/i;

function sanitizeFileName(rawName: string): string {
  const base = basename(rawName).trim();
  if (base.length === 0) return "attachment.bin";
  const cleaned = base.replaceAll(/[^a-zA-Z0-9._-]/g, "_");
  if (cleaned.length === 0) return "attachment.bin";
  return cleaned.slice(0, 120);
}

function sanitizePathSegment(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (trimmed.length === 0) return "unknown";
  const cleaned = trimmed.replaceAll(/[^a-zA-Z0-9._-]/g, "_");
  if (cleaned.length === 0) return "unknown";
  return cleaned.slice(0, 120);
}

function isImageAttachment(fileName: string, mimeType: string | undefined): boolean {
  if (mimeType?.toLowerCase().startsWith("image/")) return true;
  return IMAGE_EXTENSION_PATTERN.test(fileName);
}

function resolvePromptAttachmentPath(
  projectId: string,
  fileName: string,
): string {
  const attachmentsDir = resolve(ATTACHMENTS_ROOT_PATH, sanitizePathSegment(projectId));
  mkdirSync(attachmentsDir, { recursive: true });

  const extension = extname(fileName);
  const nameWithoutExtension = fileName.slice(0, fileName.length - extension.length);
  const timestamp = Date.now();
  const randomSuffix = Math.random().toString(36).slice(2, 10);
  const savedName = `${nameWithoutExtension}-${timestamp}-${randomSuffix}${extension}`;
  const destinationPath = resolve(attachmentsDir, savedName);

  const attachmentsPrefix = `${attachmentsDir}${sep}`;
  if (!destinationPath.startsWith(attachmentsPrefix)) {
    throw invalidRequestError("Attachment path resolved outside project scope");
  }
  return destinationPath;
}

function resolveProjectAttachmentDirectory(projectId: string): string {
  return resolve(ATTACHMENTS_ROOT_PATH, sanitizePathSegment(projectId));
}

function isPathWithinDirectory(path: string, directory: string): boolean {
  const normalizedDirectory = resolve(directory);
  const normalizedPath = resolve(path);
  return (
    normalizedPath === normalizedDirectory ||
    normalizedPath.startsWith(`${normalizedDirectory}${sep}`)
  );
}

function inferImageContentType(path: string): string {
  const extension = extname(path).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".gif") return "image/gif";
  if (extension === ".webp") return "image/webp";
  if (extension === ".bmp") return "image/bmp";
  if (extension === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}

async function storePromptAttachment(args: {
  projectId: string;
  file: File;
}): Promise<UploadedPromptAttachment> {
  const safeName = sanitizeFileName(args.file.name);
  const mimeType = args.file.type.trim().length > 0 ? args.file.type : undefined;
  const sizeBytes = args.file.size;

  if (sizeBytes <= 0) {
    throw invalidRequestError("Attachment cannot be empty");
  }
  if (sizeBytes > MAX_PROMPT_ATTACHMENT_BYTES) {
    throw invalidRequestError(
      `Attachment exceeds ${Math.floor(MAX_PROMPT_ATTACHMENT_BYTES / (1024 * 1024))}MB limit`,
    );
  }

  const isImage = isImageAttachment(safeName, mimeType);
  if (isImage && sizeBytes > MAX_PROMPT_IMAGE_ATTACHMENT_BYTES) {
    throw invalidRequestError(
      `Image attachment exceeds ${Math.floor(MAX_PROMPT_IMAGE_ATTACHMENT_BYTES / (1024 * 1024))}MB limit`,
    );
  }

  const destinationPath = resolvePromptAttachmentPath(args.projectId, safeName);
  const bytes = Buffer.from(await args.file.arrayBuffer());
  writeFileSync(destinationPath, bytes);

  return {
    type: isImage ? "localImage" : "localFile",
    path: destinationPath,
    name: safeName,
    ...(mimeType ? { mimeType } : {}),
    sizeBytes,
  };
}

function withProjectPathStatus(project: Project): Project {
  return {
    ...project,
    rootPathExists: existsSync(project.rootPath),
  };
}

export function createProjectRoutes(
  projectRepo: ProjectRepository,
  findProjectFiles: SearchProjectFilesFn = searchProjectFiles,
  savePromptAttachment: StorePromptAttachmentFn = storePromptAttachment,
  deps?: {
    threadRepo?: ThreadRepository;
    eventRepo?: EventRepository;
    getProjectWorkspaceStatus?: (projectId: string, rootPath: string) => ThreadWorkStatus;
    getProjectWorkspaceStatusAsync?: (
      projectId: string,
      rootPath: string,
    ) => Promise<ThreadWorkStatus>;
  },
) {
  return new Hono()
    .post("/", zValidator("json", createProjectSchema), async (c) => {
      try {
        const { name, rootPath } = c.req.valid("json");
        const project = projectRepo.create({ name, rootPath });
        return c.json(withProjectPathStatus(project), 201);
      } catch (err) {
        return sendRouteError(c, err);
      }
    })
    .patch("/:id", zValidator("json", updateProjectSchema), async (c) => {
      try {
        const projectId = c.req.param("id");
        const { name, rootPath, projectInstructions } = c.req.valid("json");
        const updated = projectRepo.update(projectId, {
          name,
          rootPath,
          projectInstructions,
        });
        if (!updated) {
          return sendRouteError(c, projectNotFoundError(projectId));
        }
        return c.json(withProjectPathStatus(updated));
      } catch (err) {
        return sendRouteError(c, err);
      }
    })
    .delete("/:id", async (c) => {
      try {
        const projectId = c.req.param("id");
        const project = projectRepo.getById(projectId);
        if (!project) {
          return sendRouteError(c, projectNotFoundError(projectId));
        }

        if (deps?.threadRepo && deps.eventRepo) {
          const projectThreads = deps.threadRepo.list({
            projectId,
            includeArchived: true,
          });
          for (const thread of projectThreads) {
            deps.eventRepo.deleteByThreadId(thread.id);
            deps.threadRepo.delete(thread.id);
          }
        }

        projectRepo.delete(projectId);
        return c.json({ ok: true });
      } catch (err) {
        return sendRouteError(c, err);
      }
    })
    .get("/", async (c) => {
      try {
        const projects = projectRepo.list();
        return c.json(projects.map((project) => withProjectPathStatus(project)));
      } catch (err) {
        return sendRouteError(c, err);
      }
    })
    .get("/:id/files", zValidator("query", projectFileQuerySchema), async (c) => {
      try {
        const projectId = c.req.param("id");
        const project = projectRepo.getById(projectId);
        if (!project) {
          return sendRouteError(c, projectNotFoundError(projectId));
        }

        const { query, limit } = c.req.valid("query");
        if (query.trim().length === 0) {
          return c.json([]);
        }
        const files = await findProjectFiles(project.rootPath, query, limit);
        return c.json(files);
      } catch (err) {
        return sendRouteError(c, err);
      }
    })
    .get("/:id/workspace-status", async (c) => {
      try {
        const projectId = c.req.param("id");
        const project = projectRepo.getById(projectId);
        if (!project) {
          return sendRouteError(c, projectNotFoundError(projectId));
        }
        const getProjectWorkspaceStatusAsync = deps?.getProjectWorkspaceStatusAsync;
        const getProjectWorkspaceStatus = deps?.getProjectWorkspaceStatus;
        if (!getProjectWorkspaceStatusAsync && !getProjectWorkspaceStatus) {
          throw unsupportedOperationError("Project workspace status is unavailable");
        }
        const status = getProjectWorkspaceStatusAsync
          ? await getProjectWorkspaceStatusAsync(project.id, project.rootPath)
          : getProjectWorkspaceStatus!(project.id, project.rootPath);
        return c.json(status);
      } catch (err) {
        return sendRouteError(c, err);
      }
    })
    .post("/:id/attachments", async (c) => {
      try {
        const projectId = c.req.param("id");
        const project = projectRepo.getById(projectId);
        if (!project) {
          return sendRouteError(c, projectNotFoundError(projectId));
        }

        const body = await c.req.parseBody();
        const file = body.file;
        if (!(file instanceof File)) {
          throw invalidRequestError("Expected multipart file field named 'file'");
        }

        const uploaded = await savePromptAttachment({
          projectId: project.id,
          file,
        });
        return c.json(uploaded, 201);
      } catch (err) {
        return sendRouteError(c, err);
      }
    })
    .get("/:id/attachments/content", zValidator("query", projectAttachmentQuerySchema), async (c) => {
      try {
        const projectId = c.req.param("id");
        const project = projectRepo.getById(projectId);
        if (!project) {
          return sendRouteError(c, projectNotFoundError(projectId));
        }

        const { path } = c.req.valid("query");
        const attachmentsDir = resolveProjectAttachmentDirectory(project.id);
        const requestedPath = resolve(path);
        if (!isPathWithinDirectory(requestedPath, attachmentsDir)) {
          throw invalidRequestError("Attachment path is outside project scope");
        }
        if (!existsSync(requestedPath)) {
          return sendApiError(c, {
            status: 404,
            code: "attachment_not_found",
            message: "Attachment not found",
          });
        }

        const bytes = readFileSync(requestedPath);
        c.header("Content-Type", inferImageContentType(requestedPath));
        c.header("Cache-Control", "private, max-age=60");
        return c.body(bytes);
      } catch (err) {
        return sendRouteError(c, err);
      }
    });
}
