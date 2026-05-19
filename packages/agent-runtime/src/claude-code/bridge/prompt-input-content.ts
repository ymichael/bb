import { readFile } from "node:fs/promises";
import path from "node:path";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

export type ClaudeMessageContent = SDKUserMessage["message"]["content"];
export type ClaudeContentBlockParam = Exclude<
  ClaudeMessageContent,
  string
>[number];

type SupportedImageMediaType =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp";

const promptInputItemSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string(),
  }),
  z.object({
    type: z.literal("image"),
    url: z.string(),
  }),
  z.object({
    type: z.literal("localImage"),
    path: z.string(),
  }),
  z.object({
    type: z.literal("localFile"),
    path: z.string(),
    name: z.string().optional(),
    sizeBytes: z.number().optional(),
    mimeType: z.string().optional(),
  }),
]);

type PromptInputItem = z.infer<typeof promptInputItemSchema>;

const IMAGE_MEDIA_TYPES_BY_EXT: Record<string, SupportedImageMediaType> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const TEXT_FILE_EXTENSIONS = new Set([
  ".bash",
  ".c",
  ".cc",
  ".cjs",
  ".clj",
  ".cpp",
  ".cs",
  ".css",
  ".csv",
  ".dart",
  ".env",
  ".ex",
  ".exs",
  ".fish",
  ".go",
  ".graphql",
  ".gql",
  ".h",
  ".hpp",
  ".hs",
  ".htm",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsonl",
  ".jsx",
  ".kt",
  ".less",
  ".lock",
  ".log",
  ".lua",
  ".markdown",
  ".md",
  ".mdx",
  ".mjs",
  ".php",
  ".pl",
  ".proto",
  ".ps1",
  ".py",
  ".r",
  ".rb",
  ".rs",
  ".sass",
  ".scala",
  ".scss",
  ".sh",
  ".sql",
  ".svelte",
  ".swift",
  ".text",
  ".toml",
  ".ts",
  ".tsv",
  ".tsx",
  ".txt",
  ".vue",
  ".xml",
  ".yaml",
  ".yml",
  ".zsh",
]);

function inferImageMediaType(
  filePath: string,
  declared: string | undefined,
): SupportedImageMediaType | null {
  if (
    declared === "image/png" ||
    declared === "image/jpeg" ||
    declared === "image/gif" ||
    declared === "image/webp"
  ) {
    return declared;
  }
  const ext = path.extname(filePath).toLowerCase();
  return IMAGE_MEDIA_TYPES_BY_EXT[ext] ?? null;
}

function isPdfAttachment(item: {
  mimeType?: string | undefined;
  path: string;
}): boolean {
  if (item.mimeType === "application/pdf") return true;
  return path.extname(item.path).toLowerCase() === ".pdf";
}

function isTextAttachment(item: {
  mimeType?: string | undefined;
  path: string;
}): boolean {
  const mime = item.mimeType;
  if (mime) {
    if (
      mime.startsWith("text/") ||
      mime === "application/json" ||
      mime === "application/xml" ||
      mime === "application/javascript" ||
      mime === "application/x-yaml" ||
      mime === "application/x-sh" ||
      mime === "application/x-typescript"
    ) {
      return true;
    }
  }
  const ext = path.extname(item.path).toLowerCase();
  return TEXT_FILE_EXTENSIONS.has(ext);
}

function attachmentDisplayName(item: {
  name?: string | undefined;
  path: string;
}): string {
  if (item.name && item.name.length > 0) return item.name;
  return path.basename(item.path);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parsePromptInputItems(input: unknown): PromptInputItem[] {
  if (!Array.isArray(input)) return [];
  const items: PromptInputItem[] = [];
  for (const raw of input) {
    const parsed = promptInputItemSchema.safeParse(raw);
    if (parsed.success) items.push(parsed.data);
  }
  return items;
}

function plainTextFromTextOnlyItems(
  items: ReadonlyArray<PromptInputItem>,
): string | undefined {
  const chunks: string[] = [];
  for (const item of items) {
    if (item.type === "text") chunks.push(item.text);
  }
  return chunks.length > 0 ? chunks.join("\n") : undefined;
}

async function blocksFromLocalImage(
  item: Extract<PromptInputItem, { type: "localImage" }>,
): Promise<ClaudeContentBlockParam> {
  const mediaType = inferImageMediaType(item.path, undefined);
  if (!mediaType) {
    return {
      type: "text",
      text: `[Attached image at ${item.path} could not be encoded — unsupported image extension]`,
    };
  }
  try {
    const bytes = await readFile(item.path);
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: mediaType,
        data: bytes.toString("base64"),
      },
    };
  } catch (error) {
    return {
      type: "text",
      text: `[Failed to read attached image at ${item.path}: ${describeError(error)}]`,
    };
  }
}

async function blocksFromLocalFile(
  item: Extract<PromptInputItem, { type: "localFile" }>,
): Promise<ClaudeContentBlockParam> {
  const displayName = attachmentDisplayName(item);
  try {
    if (isPdfAttachment(item)) {
      const bytes = await readFile(item.path);
      return {
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: bytes.toString("base64"),
        },
        title: displayName,
      };
    }
    if (isTextAttachment(item)) {
      const text = await readFile(item.path, "utf8");
      return {
        type: "document",
        source: {
          type: "text",
          media_type: "text/plain",
          data: text,
        },
        title: displayName,
      };
    }
    const detail = item.mimeType ? `, type ${item.mimeType}` : "";
    return {
      type: "text",
      text: `[Attached file: ${displayName} (path: ${item.path}${detail}). The file format is not supported as inline content — use the Read tool to view it.]`,
    };
  } catch (error) {
    return {
      type: "text",
      text: `[Failed to read attached file ${displayName} at ${item.path}: ${describeError(error)}]`,
    };
  }
}

/**
 * Convert the bridge's `params.input` array into a Claude `MessageParam`
 * `content` value (either a plain string for text-only turns, or an array of
 * `ContentBlockParam` when attachments are present).
 *
 * Returns `undefined` when the input would produce no model-visible content.
 */
export async function buildUserMessageContent(
  input: unknown,
): Promise<ClaudeMessageContent | undefined> {
  if (typeof input === "string") {
    return input.length > 0 ? input : undefined;
  }

  const items = parsePromptInputItems(input);
  if (items.length === 0) return undefined;

  const hasAttachment = items.some((item) => item.type !== "text");
  if (!hasAttachment) {
    return plainTextFromTextOnlyItems(items);
  }

  const blocks: ClaudeContentBlockParam[] = [];
  for (const item of items) {
    switch (item.type) {
      case "text":
        if (item.text.length > 0) {
          blocks.push({ type: "text", text: item.text });
        }
        break;
      case "image":
        blocks.push({
          type: "image",
          source: { type: "url", url: item.url },
        });
        break;
      case "localImage":
        blocks.push(await blocksFromLocalImage(item));
        break;
      case "localFile":
        blocks.push(await blocksFromLocalFile(item));
        break;
    }
  }

  if (blocks.length === 0) return undefined;
  return blocks;
}
