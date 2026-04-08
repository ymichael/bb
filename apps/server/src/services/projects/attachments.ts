// For now, we store attachments on the server's local file system.
// We might move this to something like R2 or S3 in the future.
// eslint-disable-next-line no-restricted-imports
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import type { UploadedPromptAttachment } from "@bb/server-contract";
import mimeTypes from "mime-types";
import { ApiError } from "../../errors.js";

const IMAGE_LIMIT_BYTES = 10 * 1024 * 1024;
const FILE_LIMIT_BYTES = 25 * 1024 * 1024;

function sanitizeFilename(name: string): string {
  const base = basename(name).replace(/[^a-zA-Z0-9._-]+/gu, "-");
  return base.length > 0 ? base : "attachment";
}

function buildStoredFilename(originalName: string): string {
  const sanitized = sanitizeFilename(originalName);
  const extension = extname(sanitized);
  const stem = extension.length > 0
    ? sanitized.slice(0, -extension.length)
    : sanitized;
  return `${stem}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${extension}`;
}

function projectAttachmentDir(dataDir: string, projectId: string): string {
  return join(dataDir, "attachments", projectId);
}

function resolveAttachmentPath(
  attachmentDir: string,
  relativePath: string,
): string {
  const normalizedRelativePath = normalize(relativePath.replaceAll("\\", "/"));
  const resolvedAttachmentDir = resolve(attachmentDir);
  const resolvedPath = resolve(resolvedAttachmentDir, normalizedRelativePath);
  const relativePathFromDir = relative(resolvedAttachmentDir, resolvedPath);

  if (
    relativePathFromDir === "" ||
    (!relativePathFromDir.startsWith("..") && !isAbsolute(relativePathFromDir))
  ) {
    return resolvedPath;
  }

  throw new ApiError(400, "invalid_request", "Attachment path escapes project directory");
}

export async function storeAttachment(
  dataDir: string,
  projectId: string,
  file: File,
): Promise<UploadedPromptAttachment> {
  const isImage = (file.type || "").startsWith("image/");
  const sizeLimit = isImage ? IMAGE_LIMIT_BYTES : FILE_LIMIT_BYTES;
  if (file.size > sizeLimit) {
    throw new ApiError(
      400,
      "invalid_request",
      `Attachment exceeds ${Math.floor(sizeLimit / (1024 * 1024))}MB limit`,
    );
  }

  const dir = projectAttachmentDir(dataDir, projectId);
  await mkdir(dir, { recursive: true });

  const storedName = buildStoredFilename(file.name);
  const outputPath = join(dir, storedName);
  const bytes = Buffer.from(await file.arrayBuffer());
  await writeFile(outputPath, bytes);

  return {
    type: isImage ? "localImage" : "localFile",
    path: storedName,
    name: file.name,
    mimeType: file.type || undefined,
    sizeBytes: file.size,
  };
}

export async function readAttachment(
  dataDir: string,
  projectId: string,
  relativePath: string,
): Promise<{ content: Buffer; mimeType?: string }> {
  const dir = projectAttachmentDir(dataDir, projectId);
  const resolved = resolveAttachmentPath(dir, relativePath);

  const fileStat = await stat(resolved).catch(() => null);
  if (!fileStat || !fileStat.isFile()) {
    throw new ApiError(404, "invalid_request", "Attachment not found");
  }

  return {
    content: await readFile(resolved),
    mimeType: mimeTypes.lookup(resolved) || undefined,
  };
}

export async function deleteProjectAttachments(
  dataDir: string,
  projectId: string,
): Promise<void> {
  await rm(projectAttachmentDir(dataDir, projectId), {
    force: true,
    recursive: true,
  });
}
