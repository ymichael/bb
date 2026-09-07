import { z } from "zod";
import type {
  ThreadEventItem,
  ThreadEventTokenUsageBreakdown,
} from "@bb/domain";
import { textBlockSchema } from "./tool-arg-schemas.js";
import { getStringProperty, isRecord } from "./provider-visibility-helpers.js";

const contentWrapperSchema = z
  .object({
    content: z.array(z.unknown()),
  })
  .passthrough();

const shellEnvironmentVariableKeySchema = z
  .string()
  .regex(/^[A-Z_][A-Z0-9_]*$/i);

type LineDiffOperation =
  | { type: "add"; line: string }
  | { type: "remove"; line: string };

const MAX_EXACT_LINE_DIFF_CELLS = 1_000_000;

function splitComparableLines(text: string): string[] {
  const normalized = text.replace(/\r\n?/gu, "\n");
  if (normalized.length === 0) {
    return [];
  }
  const lines = normalized.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function commonPrefixLength(
  oldLines: readonly string[],
  newLines: readonly string[],
): number {
  const limit = Math.min(oldLines.length, newLines.length);
  let index = 0;
  while (index < limit && oldLines[index] === newLines[index]) {
    index += 1;
  }
  return index;
}

function commonSuffixLength(args: {
  newLines: readonly string[];
  oldLines: readonly string[];
  prefixLength: number;
}): number {
  let oldIndex = args.oldLines.length - 1;
  let newIndex = args.newLines.length - 1;
  let length = 0;
  while (
    oldIndex >= args.prefixLength &&
    newIndex >= args.prefixLength &&
    args.oldLines[oldIndex] === args.newLines[newIndex]
  ) {
    length += 1;
    oldIndex -= 1;
    newIndex -= 1;
  }
  return length;
}

function buildReplacementLineDiff(
  oldLines: readonly string[],
  newLines: readonly string[],
): LineDiffOperation[] {
  return [
    ...oldLines.map((line) => ({ type: "remove" as const, line })),
    ...newLines.map((line) => ({ type: "add" as const, line })),
  ];
}

function buildExactLineDiff(
  oldLines: readonly string[],
  newLines: readonly string[],
): LineDiffOperation[] {
  if (oldLines.length === 0) {
    return newLines.map((line) => ({ type: "add" as const, line }));
  }
  if (newLines.length === 0) {
    return oldLines.map((line) => ({ type: "remove" as const, line }));
  }

  const columnCount = newLines.length + 1;
  const cellCount = (oldLines.length + 1) * columnCount;
  if (cellCount > MAX_EXACT_LINE_DIFF_CELLS) {
    return buildReplacementLineDiff(oldLines, newLines);
  }

  const lcs = new Uint32Array(cellCount);
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    const rowOffset = oldIndex * columnCount;
    const nextRowOffset = (oldIndex + 1) * columnCount;
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      lcs[rowOffset + newIndex] =
        oldLines[oldIndex] === newLines[newIndex]
          ? lcs[nextRowOffset + newIndex + 1] + 1
          : Math.max(
              lcs[nextRowOffset + newIndex],
              lcs[rowOffset + newIndex + 1],
            );
    }
  }

  const operations: LineDiffOperation[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLines.length && newIndex < newLines.length) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      oldIndex += 1;
      newIndex += 1;
      continue;
    }
    const removeScore = lcs[(oldIndex + 1) * columnCount + newIndex];
    const addScore = lcs[oldIndex * columnCount + newIndex + 1];
    if (removeScore >= addScore) {
      operations.push({ type: "remove", line: oldLines[oldIndex] ?? "" });
      oldIndex += 1;
    } else {
      operations.push({ type: "add", line: newLines[newIndex] ?? "" });
      newIndex += 1;
    }
  }
  while (oldIndex < oldLines.length) {
    operations.push({ type: "remove", line: oldLines[oldIndex] ?? "" });
    oldIndex += 1;
  }
  while (newIndex < newLines.length) {
    operations.push({ type: "add", line: newLines[newIndex] ?? "" });
    newIndex += 1;
  }
  return operations;
}

function buildChangedLineDiff(
  oldLines: readonly string[],
  newLines: readonly string[],
): LineDiffOperation[] {
  const prefixLength = commonPrefixLength(oldLines, newLines);
  const suffixLength = commonSuffixLength({
    oldLines,
    newLines,
    prefixLength,
  });
  const oldEnd = oldLines.length - suffixLength;
  const newEnd = newLines.length - suffixLength;
  return buildExactLineDiff(
    oldLines.slice(prefixLength, oldEnd),
    newLines.slice(prefixLength, newEnd),
  );
}

function formatLineDiff(args: {
  headers: readonly string[];
  operations: readonly LineDiffOperation[];
}): string {
  const body = args.operations.map((operation) =>
    operation.type === "add" ? `+${operation.line}` : `-${operation.line}`,
  );
  return [...args.headers, ...body].join("\n") + "\n";
}

export function buildEditDiff(
  filePath: string,
  oldString: string | undefined,
  newString: string | undefined,
): string | undefined {
  const normalizedPath = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (oldString === undefined && newString !== undefined) {
    return formatLineDiff({
      headers: ["--- /dev/null", `+++ b/${normalizedPath}`],
      operations: splitComparableLines(newString).map((line) => ({
        type: "add",
        line,
      })),
    });
  }

  if (oldString !== undefined && newString === undefined) {
    return formatLineDiff({
      headers: [`--- a/${normalizedPath}`, "+++ /dev/null"],
      operations: splitComparableLines(oldString).map((line) => ({
        type: "remove",
        line,
      })),
    });
  }

  if (oldString !== undefined && newString !== undefined) {
    const oldLines = splitComparableLines(oldString);
    const newLines = splitComparableLines(newString);
    const operations = buildChangedLineDiff(oldLines, newLines);
    if (operations.length === 0) {
      return undefined;
    }
    return formatLineDiff({
      headers: [`--- a/${normalizedPath}`, `+++ b/${normalizedPath}`],
      operations,
    });
  }
  return undefined;
}

export function toOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function toOptionalRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export function withParentToolCallId<TItem extends ThreadEventItem>(
  item: TItem,
  parentToolCallId?: string,
): TItem {
  if (!parentToolCallId) {
    return item;
  }
  return {
    ...item,
    parentToolCallId,
  };
}

export function buildShellEnvOverrides(
  envVars?: Record<string, string>,
): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const [key, value] of Object.entries(envVars ?? {})) {
    if (!shellEnvironmentVariableKeySchema.safeParse(key).success) {
      continue;
    }
    overrides[key] = value;
  }
  return overrides;
}

export function toNonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

export function normalizeProviderCommandOutput(args: {
  emptyPlaceholders: readonly string[];
  text: string;
}): string | undefined {
  const trimmedText = args.text.trim();
  if (
    args.emptyPlaceholders.some((placeholder) => placeholder === trimmedText)
  ) {
    return undefined;
  }
  return args.text.length > 0 ? args.text : undefined;
}

export function extractResultText(content: unknown): string {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (typeof content === "number" || typeof content === "boolean") {
    return JSON.stringify(content);
  }

  if (content && typeof content === "object" && !Array.isArray(content)) {
    const wrapper = contentWrapperSchema.safeParse(content);
    if (wrapper.success) {
      return extractResultText(wrapper.data.content);
    }
    return JSON.stringify(content);
  }

  if (!Array.isArray(content)) return "";

  const toolReferenceSummary = describeToolReferenceBlocks(content);
  if (toolReferenceSummary) {
    return toolReferenceSummary;
  }

  const chunks: string[] = [];
  for (const block of content) {
    const parsed = textBlockSchema.safeParse(block);
    if (parsed.success) {
      chunks.push(parsed.data.text);
      continue;
    }
    const fallback = describeResultContentBlock(block);
    if (fallback) {
      chunks.push(fallback);
    }
  }
  return chunks.join("\n");
}

function describeToolReferenceBlocks(blocks: unknown[]): string | null {
  const toolNames: string[] = [];
  for (const block of blocks) {
    if (
      !isRecord(block) ||
      getStringProperty(block, "type") !== "tool_reference"
    ) {
      return null;
    }

    const toolName = getStringProperty(block, "tool_name");
    if (!toolName) {
      return null;
    }
    toolNames.push(toolName);
  }

  return toolNames.length > 0 ? `Matched tools: ${toolNames.join(", ")}` : null;
}

function describeResultContentBlock(block: unknown): string | null {
  if (!isRecord(block)) {
    return null;
  }

  const type = getStringProperty(block, "type");
  if (!type) {
    return null;
  }

  const path = getStringProperty(block, "path");
  const toolName = getStringProperty(block, "tool_name");
  const url =
    getStringProperty(block, "url") ?? getStringProperty(block, "imageUrl");
  if (path) {
    return `[${type}: ${path}]`;
  }
  if (toolName) {
    return `[${type}: ${toolName}]`;
  }
  if (url) {
    return `[${type}: ${url}]`;
  }
  return `[${type}]`;
}

export const ZERO_TOKEN_USAGE: ThreadEventTokenUsageBreakdown = {
  totalTokens: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
};

export function addTokenUsage(
  total: ThreadEventTokenUsageBreakdown,
  last: ThreadEventTokenUsageBreakdown,
): ThreadEventTokenUsageBreakdown {
  return {
    totalTokens: total.totalTokens + last.totalTokens,
    inputTokens: total.inputTokens + last.inputTokens,
    cachedInputTokens: total.cachedInputTokens + last.cachedInputTokens,
    outputTokens: total.outputTokens + last.outputTokens,
    reasoningOutputTokens:
      total.reasoningOutputTokens + last.reasoningOutputTokens,
  };
}
