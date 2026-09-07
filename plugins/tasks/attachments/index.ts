import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Attachment, TasksStore } from "../db";

export const MAX_ATTACHMENT_SIZE_BYTES = 25 * 1024 * 1024;

const INLINE_RASTER_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
]);

const RASTER_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
};

const UPLOAD_PATH = "/attachments/upload";
const DOWNLOAD_PATH = "/attachments/download";
const DELETE_PATH = "/attachments/delete";
const MIME_PATTERN =
  /^(application|audio|font|image|message|model|multipart|text|video)\/[!#$&^_.+\-A-Za-z0-9]+$/;
const storeRoots = new WeakMap<TasksStore, string>();

export type AttachmentOwner =
  | { taskId: string; commentId?: never }
  | { taskId?: never; commentId: string };

type SaveAttachmentFromBytesOptions = AttachmentOwner & {
  fileName: string;
  mime?: string;
};

interface DatabaseListRow {
  name: string;
  file: string;
}

type PluginHttpContext = Parameters<
  Parameters<BbPluginApi["http"]["route"]>[2]
>[0];

class AttachmentRequestError extends Error {
  constructor(
    readonly status: 400 | 413,
    message: string,
  ) {
    super(message);
  }
}

export class AttachmentReferencedError extends Error {
  constructor(readonly attachment: Attachment) {
    super(
      `Attachment "${attachment.fileName}" is used in the task description. Remove it from the description before deleting the attachment.`,
    );
    this.name = "AttachmentReferencedError";
  }
}

class AttachmentCleanupError extends Error {
  constructor(
    readonly attachment: Attachment,
    readonly cleanupCause: unknown,
  ) {
    super(`Failed to remove attachment blob: ${attachment.fileName}`);
    this.name = "AttachmentCleanupError";
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function removeAttachmentDescriptionReferences(
  markdown: string,
  attachmentId: string,
): string {
  const url = escapeRegExp(buildAttachmentUrl(attachmentId));
  return markdown.replace(new RegExp(`!\\[[^\\]]*\\]\\(${url}\\)`, "g"), "");
}

function pluginDataDirectory(bb: BbPluginApi): string {
  const main = bb.storage
    .database()
    .prepare<[], DatabaseListRow>("PRAGMA database_list")
    .all()
    .find((database) => database.name === "main");
  if (!main?.file) {
    throw new Error("Tasks attachment storage requires a file-backed database");
  }
  return dirname(main.file);
}

function requireStoreRoot(store: TasksStore): string {
  const root = storeRoots.get(store);
  if (!root) {
    throw new Error(
      "Tasks attachment helpers require registerAttachments(bb, store) first",
    );
  }
  return root;
}

function pathInside(root: string, blobPath: string): string {
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(absoluteRoot, blobPath);
  if (
    absolutePath !== absoluteRoot &&
    !absolutePath.startsWith(`${absoluteRoot}${sep}`)
  ) {
    throw new Error("Attachment blob path escapes the plugin data directory");
  }
  return absolutePath;
}

export async function removeAttachmentBlobs(
  bb: BbPluginApi,
  store: TasksStore,
  attachments: readonly Pick<Attachment, "id" | "blobPath">[],
): Promise<void> {
  if (attachments.length === 0) return;
  const root = requireStoreRoot(store);
  const removals = await Promise.allSettled(
    attachments.map(async (attachment) => {
      const absolutePath = pathInside(root, attachment.blobPath);
      await rm(dirname(absolutePath), { recursive: true, force: true });
    }),
  );
  const failures = removals.flatMap((result, index) => {
    if (result.status === "fulfilled") return [];
    const attachment = attachments[index];
    const message =
      result.reason instanceof Error
        ? result.reason.message
        : String(result.reason);
    bb.log.warn(
      `failed to remove attachment blob ${attachment?.id ?? "unknown"}: ${message}`,
    );
    return [result.reason];
  });
  if (failures.length > 0) {
    throw new AggregateError(failures, "Failed to remove attachment blobs");
  }
}

function buildContentDisposition(
  disposition: "inline" | "attachment",
  fileName: string,
): string {
  const visibleName = fileName.replace(BIDI_CONTROL_PATTERN, "_");
  const asciiFallback = visibleName
    .replace(/[^\x20-\x7e]/g, "-")
    .replace(/["\\]/g, "_");
  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encodeExtValue(visibleName)}`;
}

function encodeExtValue(value: string): string {
  let encoded = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const char = String.fromCharCode(byte);
    encoded += /[A-Za-z0-9!#$&+\-.^_`|~]/.test(char)
      ? char
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return encoded;
}

const BIDI_CONTROL_PATTERN = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

function sanitizeFileName(fileName: string): string {
  const baseName = fileName
    .normalize("NFC")
    .replaceAll("\\", "/")
    .split("/")
    .at(-1)
    ?.trim();
  let sanitized = (baseName ?? "")
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "_")
    .replace(BIDI_CONTROL_PATTERN, "_")
    .replace(/^\.+/, "")
    .trim();
  while (Buffer.byteLength(sanitized, "utf8") > 180) {
    sanitized = sanitized.slice(0, -1);
  }
  if (!sanitized || sanitized === "." || sanitized === "..") {
    return "attachment";
  }
  return sanitized;
}

function normalizeMime(mime: string): string {
  const normalized = mime.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!MIME_PATTERN.test(normalized)) {
    throw new AttachmentRequestError(400, "mime must be a valid MIME type");
  }
  return normalized;
}

function isInlineRasterMime(mime: string): boolean {
  return INLINE_RASTER_MIMES.has(
    mime.split(";", 1)[0]?.trim().toLowerCase() ?? "",
  );
}

function bytesMatch(
  bytes: Uint8Array,
  offset: number,
  expected: readonly number[],
): boolean {
  return expected.every((value, index) => bytes[offset + index] === value);
}

function sniffRasterMime(bytes: Uint8Array): string | undefined {
  if (bytesMatch(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (bytesMatch(bytes, 0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (
    bytesMatch(bytes, 0, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    bytesMatch(bytes, 0, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  ) {
    return "image/gif";
  }
  if (
    bytesMatch(bytes, 0, [0x52, 0x49, 0x46, 0x46]) &&
    bytesMatch(bytes, 8, [0x57, 0x45, 0x42, 0x50])
  ) {
    return "image/webp";
  }
  if (
    bytesMatch(bytes, 4, [0x66, 0x74, 0x79, 0x70]) &&
    (bytesMatch(bytes, 8, [0x61, 0x76, 0x69, 0x66]) ||
      bytesMatch(bytes, 8, [0x61, 0x76, 0x69, 0x73]))
  ) {
    return "image/avif";
  }
  return undefined;
}

function inferMimeFromBytes(bytes: Uint8Array, fileName: string): string {
  const sniffed = sniffRasterMime(bytes.subarray(0, 12));
  if (sniffed) return sniffed;
  const extension = fileName.toLowerCase().match(/\.[^.]+$/u)?.[0];
  return (
    (extension && RASTER_MIME_BY_EXTENSION[extension]) ??
    "application/octet-stream"
  );
}

function normalizeOwner(
  taskId: string | null | undefined,
  commentId: string | null | undefined,
): AttachmentOwner {
  const normalizedTaskId = taskId?.trim() || undefined;
  const normalizedCommentId = commentId?.trim() || undefined;
  if (Boolean(normalizedTaskId) === Boolean(normalizedCommentId)) {
    throw new AttachmentRequestError(
      400,
      "exactly one of taskId or commentId is required",
    );
  }
  if (normalizedTaskId) return { taskId: normalizedTaskId };
  if (normalizedCommentId) return { commentId: normalizedCommentId };
  throw new Error("unreachable attachment owner state");
}

function attachmentParameters(context: PluginHttpContext): {
  owner: AttachmentOwner;
  fileName: string;
  mime: string;
} {
  const query = context.req.query();
  const owner = normalizeOwner(
    query.taskId ?? context.req.header("x-task-id"),
    query.commentId ?? context.req.header("x-comment-id"),
  );
  const requestedFileName =
    query.fileName ?? context.req.header("x-file-name") ?? "";
  if (!requestedFileName.trim()) {
    throw new AttachmentRequestError(400, "fileName is required");
  }
  const requestedMime =
    query.mime ??
    context.req.header("x-mime-type") ??
    context.req.header("content-type") ??
    "";
  return {
    owner,
    fileName: sanitizeFileName(requestedFileName),
    mime: normalizeMime(requestedMime),
  };
}

async function readRequestBody(request: Request): Promise<Uint8Array> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_ATTACHMENT_SIZE_BYTES
  ) {
    throw new AttachmentRequestError(413, "attachment exceeds the 25 MB limit");
  }
  if (!request.body) return new Uint8Array();

  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ATTACHMENT_SIZE_BYTES) {
        await reader.cancel();
        throw new AttachmentRequestError(
          413,
          "attachment exceeds the 25 MB limit",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function persistAttachment(
  store: TasksStore,
  owner: AttachmentOwner,
  fileName: string,
  mime: string,
  sizeBytes: number,
  writeBlob: (path: string) => Promise<void>,
): Promise<Attachment> {
  if (sizeBytes > MAX_ATTACHMENT_SIZE_BYTES) {
    throw new AttachmentRequestError(413, "attachment exceeds the 25 MB limit");
  }
  const safeFileName = sanitizeFileName(fileName);
  const safeMime = normalizeMime(mime);
  const attachment = store.createAttachment({
    ...owner,
    fileName: safeFileName,
    mime: safeMime,
    sizeBytes,
    blobPath: join("blobs", "pending", safeFileName),
    isImage: isInlineRasterMime(safeMime),
  });
  const blobPath = join("blobs", attachment.id, safeFileName);
  const absolutePath = pathInside(requireStoreRoot(store), blobPath);

  try {
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeBlob(absolutePath);
    return store.updateAttachment(attachment.id, {
      blobPath,
    });
  } catch (error) {
    store.deleteAttachment(attachment.id);
    await rm(dirname(absolutePath), { recursive: true, force: true });
    throw error;
  }
}

export function buildAttachmentUrl(attachmentId: string): string {
  return `/api/v1/plugins/tasks/http${DOWNLOAD_PATH}?attachmentId=${encodeURIComponent(attachmentId)}`;
}

export async function saveAttachmentFromBytes(
  store: TasksStore,
  bytes: Uint8Array,
  options: SaveAttachmentFromBytesOptions,
): Promise<Attachment> {
  return persistAttachment(
    store,
    normalizeOwner(options.taskId, options.commentId),
    options.fileName,
    options.mime ?? inferMimeFromBytes(bytes, options.fileName),
    bytes.byteLength,
    (destinationPath) => writeFile(destinationPath, bytes),
  );
}

export async function readAttachmentContent(
  store: TasksStore,
  attachmentId: string,
): Promise<{ attachment: Attachment; content: Buffer }> {
  const attachment = store.getAttachment(attachmentId);
  if (!attachment) throw new Error(`Attachment not found: ${attachmentId}`);
  const sourcePath = pathInside(requireStoreRoot(store), attachment.blobPath);
  return { attachment, content: await readFile(sourcePath) };
}

function errorResponse(context: PluginHttpContext, error: unknown): Response {
  if (error instanceof AttachmentRequestError) {
    return context.json({ error: error.message }, error.status);
  }
  if (error instanceof AttachmentReferencedError) {
    return context.json({ error: error.message }, 409);
  }
  if (error instanceof AttachmentCleanupError) {
    return context.json({ error: error.message }, 500);
  }
  throw error;
}

export async function deleteAttachmentById(
  bb: BbPluginApi,
  store: TasksStore,
  attachmentId: string,
  options: {
    removeBlobs?: typeof removeAttachmentBlobs;
    removeDescriptionReferences?: boolean;
  } = {},
): Promise<Attachment | null> {
  const attachment = store.getAttachment(attachmentId);
  if (!attachment) return null;

  const taskId =
    attachment.taskId ??
    (attachment.commentId
      ? store.getComment(attachment.commentId)?.taskId
      : undefined);
  const ownerTask = taskId ? store.getTask(taskId) : undefined;
  let nextDescription: string | undefined;
  if (ownerTask?.description.includes(buildAttachmentUrl(attachment.id))) {
    if (!options.removeDescriptionReferences) {
      throw new AttachmentReferencedError(attachment);
    }
    nextDescription = removeAttachmentDescriptionReferences(
      ownerTask.description,
      attachment.id,
    );
    if (nextDescription === ownerTask.description) {
      throw new AttachmentReferencedError(attachment);
    }
  }

  try {
    await (options.removeBlobs ?? removeAttachmentBlobs)(bb, store, [
      attachment,
    ]);
  } catch (error) {
    throw new AttachmentCleanupError(attachment, error);
  }
  if (ownerTask && nextDescription !== undefined) {
    store.updateTask(ownerTask.id, { description: nextDescription });
  }
  if (!store.deleteAttachment(attachment.id)) return null;
  publishAttachmentChanged(bb, store, attachment);
  return attachment;
}

export function publishAttachmentChanged(
  bb: BbPluginApi,
  store: TasksStore,
  attachment: Attachment,
): void {
  const taskId =
    attachment.taskId ??
    (attachment.commentId
      ? store.getComment(attachment.commentId)?.taskId
      : undefined);
  const task = taskId ? store.getTask(taskId) : undefined;
  if (!task) {
    bb.log.warn(`failed to publish attachment change ${attachment.id}`);
    return;
  }
  bb.realtime.publish("tasks:changed", {
    taskId: task.id,
    projectId: task.projectId,
  });
}

export function registerAttachments(
  bb: BbPluginApi,
  store: TasksStore,
  options: {
    removeBlobs?: typeof removeAttachmentBlobs;
  } = {},
): void {
  const root = pluginDataDirectory(bb);
  storeRoots.set(store, root);

  bb.http.route(
    "POST",
    UPLOAD_PATH,
    async (context) => {
      try {
        const parameters = attachmentParameters(context);
        const body = await readRequestBody(context.req.raw);
        const attachment = await persistAttachment(
          store,
          parameters.owner,
          parameters.fileName,
          parameters.mime,
          body.byteLength,
          (destinationPath) => writeFile(destinationPath, body),
        );
        publishAttachmentChanged(bb, store, attachment);
        return context.json(
          {
            attachmentId: attachment.id,
            url: buildAttachmentUrl(attachment.id),
          },
          201,
        );
      } catch (error) {
        return errorResponse(context, error);
      }
    },
    { auth: "token" },
  );

  bb.http.route("GET", DOWNLOAD_PATH, async (context) => {
    const attachmentId = context.req.query("attachmentId")?.trim();
    const attachment = attachmentId
      ? store.getAttachment(attachmentId)
      : undefined;
    if (!attachment)
      return context.json({ error: "attachment not found" }, 404);

    const absolutePath = pathInside(root, attachment.blobPath);
    try {
      await stat(absolutePath);
    } catch {
      return context.json({ error: "attachment not found" }, 404);
    }
    const disposition = isInlineRasterMime(attachment.mime)
      ? "inline"
      : "attachment";
    return new Response(new Uint8Array(await readFile(absolutePath)), {
      headers: {
        "Content-Type": attachment.mime,
        "Content-Length": String(attachment.sizeBytes),
        "Content-Disposition": buildContentDisposition(
          disposition,
          attachment.fileName,
        ),
        "X-Content-Type-Options": "nosniff",
      },
    });
  });

  bb.http.route("DELETE", DELETE_PATH, async (context) => {
    const attachmentId = context.req.query("attachmentId")?.trim();
    try {
      const attachment = attachmentId
        ? await deleteAttachmentById(bb, store, attachmentId, {
            removeBlobs: options.removeBlobs,
            removeDescriptionReferences:
              context.req.query("removeDescriptionReferences") === "true",
          })
        : null;
      if (!attachment)
        return context.json({ error: "attachment not found" }, 404);
      return context.json({ deleted: true });
    } catch (error) {
      return errorResponse(context, error);
    }
  });
}
