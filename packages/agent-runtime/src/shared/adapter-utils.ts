/**
 * Shared adapter utilities.
 *
 * Functions and constants duplicated across the claude-code, pi, and codex
 * adapters are extracted here so each adapter imports from one place.
 */

import { z } from "zod";
import type {
  ModelReasoningEffort,
  PromptInput,
  ThreadEventItem,
  ThreadEventUserContent,
} from "@bb/domain";
import {
  contentWrapperSchema,
  textBlockSchema,
} from "./tool-arg-schemas.js";
import {
  getStringProperty,
  isRecord,
} from "./provider-visibility-helpers.js";

// ---------------------------------------------------------------------------
// Reasoning effort constants
// ---------------------------------------------------------------------------

export const LOW_REASONING_EFFORT: ModelReasoningEffort = {
  reasoningEffort: "low",
  description: "Low reasoning effort",
};
export const MEDIUM_REASONING_EFFORT: ModelReasoningEffort = {
  reasoningEffort: "medium",
  description: "Medium reasoning effort",
};
export const HIGH_REASONING_EFFORT: ModelReasoningEffort = {
  reasoningEffort: "high",
  description: "High reasoning effort",
};
export const XHIGH_REASONING_EFFORT: ModelReasoningEffort = {
  reasoningEffort: "xhigh",
  description: "Extra high reasoning effort",
};

// ---------------------------------------------------------------------------
// User message ack helpers
// ---------------------------------------------------------------------------

function toThreadEventUserContent(input: PromptInput[]): ThreadEventUserContent[] {
  return input.map((item) => {
    switch (item.type) {
      case "text":
        return { type: "text", text: item.text };
      case "image":
        return { type: "image", url: item.url };
      case "localImage":
        return { type: "localImage", path: item.path };
      case "localFile":
        return { type: "localFile", path: item.path };
      default: {
        const exhaustive: never = item;
        throw new Error(`Unsupported prompt input type: ${String(exhaustive)}`);
      }
    }
  });
}

export function buildUserMessageAckItem(
  input: PromptInput[],
  itemId: string,
  clientRequestSequence: number | undefined,
): Extract<ThreadEventItem, { type: "userMessage" }> | null {
  if (input.length === 0) {
    return null;
  }
  return {
    type: "userMessage",
    id: itemId,
    content: toThreadEventUserContent(input),
    ...(clientRequestSequence !== undefined ? { clientRequestSequence } : {}),
  };
}

const shellEnvironmentVariableKeySchema = z.string().regex(
  /^[A-Z_][A-Z0-9_]*$/i,
);

// ---------------------------------------------------------------------------
// Diff helpers
// ---------------------------------------------------------------------------

/**
 * Builds a minimal unified-diff string from old/new text pairs.
 * Exported so each adapter can call it with its own arg names.
 */
export function buildEditDiff(
  filePath: string,
  oldString: string | undefined,
  newString: string | undefined,
): string | undefined {
  const normalizedPath = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (oldString === undefined && newString !== undefined) {
    const newLines = newString.split("\n").map((line) => `+${line}`);
    return [
      "--- /dev/null",
      `+++ b/${normalizedPath}`,
      ...newLines,
    ].join("\n") + "\n";
  }

  if (oldString !== undefined && newString === undefined) {
    const oldLines = oldString.split("\n").map((line) => `-${line}`);
    return [
      `--- a/${normalizedPath}`,
      "+++ /dev/null",
      ...oldLines,
    ].join("\n") + "\n";
  }

  if (oldString !== undefined && newString !== undefined) {
    const oldLines = oldString.split("\n").map((line) => `-${line}`);
    const newLines = newString.split("\n").map((line) => `+${line}`);
    return [
      `--- a/${normalizedPath}`,
      `+++ b/${normalizedPath}`,
      ...oldLines,
      ...newLines,
    ].join("\n") + "\n";
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Shared item helpers
// ---------------------------------------------------------------------------

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

export function buildShellEnvironmentPolicyConfig(
  envVars?: Record<string, string>,
): Record<string, string> | undefined {
  if (!envVars) {
    return undefined;
  }

  const config: Record<string, string> = {};
  for (const [key, value] of Object.entries(envVars)) {
    if (!shellEnvironmentVariableKeySchema.safeParse(key).success) {
      continue;
    }
    config[`shell_environment_policy.set.${key}`] = value;
  }

  return Object.keys(config).length > 0 ? config : undefined;
}

// ---------------------------------------------------------------------------
// Numeric helpers
// ---------------------------------------------------------------------------

export function toNonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

/**
 * Extracts text from tool result content.
 * Handles strings, arrays of text blocks, and `{ content: [...] }` wrappers.
 */
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
    if (!isRecord(block) || getStringProperty(block, "type") !== "tool_reference") {
      return null;
    }

    const toolName = getStringProperty(block, "tool_name");
    if (!toolName) {
      return null;
    }
    toolNames.push(toolName);
  }

  return toolNames.length > 0
    ? `Matched tools: ${toolNames.join(", ")}`
    : null;
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
