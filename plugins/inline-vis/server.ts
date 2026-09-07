import path from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const MAX_HTML_BYTES = 5 * 1024 * 1024;

const HTML_EXTENSIONS = new Set([".html", ".htm"]);

interface PrepareHtmlPreviewResult {
  file: string;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`"${field}" must be a non-empty string`);
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireWorkspaceHtmlFile(value: unknown): string {
  const file = requireNonEmptyString(value, "file");
  if (path.isAbsolute(file)) {
    throw new Error(`"file" must be workspace-relative, not absolute: ${file}`);
  }
  if (/^[a-zA-Z]:[\\/]/.test(file) || file.startsWith("\\\\")) {
    throw new Error(`"file" must be workspace-relative, not absolute: ${file}`);
  }
  const slashNormalized = file.replace(/\\/g, "/");
  if (slashNormalized.split("/").includes("..")) {
    throw new Error(`"file" must not contain traversal segments: ${file}`);
  }
  const normalized = path.posix.normalize(slashNormalized);
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized === "." ||
    normalized.startsWith("/")
  ) {
    throw new Error(`"file" must not escape the workspace: ${file}`);
  }
  const ext = path.posix.extname(normalized).toLowerCase();
  if (!HTML_EXTENSIONS.has(ext)) {
    throw new Error(
      `"file" must end with .html or .htm, got ${JSON.stringify(file)}`,
    );
  }
  return normalized;
}

export function resolveContainedHtmlPath(
  rootPath: string,
  relativeFile: string,
): string {
  const root = path.resolve(rootPath);
  const absolute = path.resolve(root, relativeFile);
  const relative = path.relative(root, absolute);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`"file" must not escape the workspace: ${relativeFile}`);
  }
  return absolute;
}

function httpStatus(error: unknown): number | null {
  if (!isRecord(error)) {
    return null;
  }
  const status = error.status;
  return typeof status === "number" ? status : null;
}

export const inlineVisRpcContract = defineRpcContract({
  prepareHtmlPreview: {
    input: z
      .object({
        threadId: z.string().trim().min(1),
        file: z.string().transform((value) => requireWorkspaceHtmlFile(value)),
      })
      .strict(),
    output: z.object({ file: z.string() }).strict(),
  },
});

export default async function plugin(bb: BbPluginApi) {
  bb.rpc.register(inlineVisRpcContract, {
    async prepareHtmlPreview({
      threadId,
      file,
    }): Promise<PrepareHtmlPreviewResult> {
      const thread = await bb.sdk.threads.get({
        threadId,
        include: "environment",
      });

      if (!("environment" in thread)) {
        throw new Error(
          "Thread environment was not returned — inline-vis needs a live environment.",
        );
      }

      const environment = thread.environment;
      const rootPath =
        typeof environment?.path === "string" ? environment.path : null;
      if (!rootPath) {
        throw new Error(
          "This thread has no workspace path — inline-vis needs a live environment.",
        );
      }
      const hostId =
        typeof environment?.hostId === "string" ? environment.hostId : null;
      if (!hostId) {
        throw new Error(
          "This thread's environment has no hostId — cannot read workspace files.",
        );
      }

      const absolutePath = resolveContainedHtmlPath(rootPath, file);

      let result;
      try {
        result = await bb.sdk.files.read({
          path: absolutePath,
          rootPath,
          hostId,
        });
      } catch (error) {
        if (httpStatus(error) === 404) {
          throw new Error(`HTML file not found: ${file}`);
        }
        throw error;
      }

      if (result.contentEncoding !== "utf8") {
        throw new Error(
          `HTML file is not valid UTF-8 text (encoding=${result.contentEncoding}).`,
        );
      }
      const sizeBytes = result.sizeBytes;
      if (sizeBytes > MAX_HTML_BYTES) {
        throw new Error(
          `HTML file is too large (${sizeBytes} bytes; max ${MAX_HTML_BYTES}).`,
        );
      }

      return { file };
    },
  });
}
