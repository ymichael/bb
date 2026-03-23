/**
 * Shared adapter utilities.
 *
 * Functions and constants duplicated across the claude-code, pi, and codex
 * adapters are extracted here so each adapter imports from one place.
 */

import { renderTemplate } from "@bb/templates";
import type { ModelReasoningEffort, ThreadEventItem } from "@bb/domain";
import {
  bashArgsSchema,
  contentWrapperSchema,
  fileEditArgsSchema,
  textBlockSchema,
  webSearchArgsSchema,
} from "./tool-arg-schemas.js";

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
// Base instructions
// ---------------------------------------------------------------------------

const DEFAULT_BASE_INSTRUCTIONS = renderTemplate("agentBaseInstructions", {});

/**
 * Resolves base instructions with optional developer instructions appended.
 * If `developerInstructions` already starts with the default base instructions,
 * it is returned as-is to avoid duplication.
 */
export function resolveBaseInstructions(developerInstructions?: string): string {
  const trimmed = developerInstructions?.trim();
  if (!trimmed) return DEFAULT_BASE_INSTRUCTIONS;
  if (trimmed === DEFAULT_BASE_INSTRUCTIONS || trimmed.startsWith(`${DEFAULT_BASE_INSTRUCTIONS}\n`)) {
    return trimmed;
  }
  return `${DEFAULT_BASE_INSTRUCTIONS}\n\n${trimmed}`;
}

// ---------------------------------------------------------------------------
// Tool category sets
// ---------------------------------------------------------------------------

export const BASH_TOOLS = new Set(["Bash", "bash"]);
export const FILE_EDIT_TOOLS = new Set(["Edit", "Write", "edit", "write"]);
export const WEB_SEARCH_TOOLS = new Set(["WebSearch", "WebFetch"]);

// ---------------------------------------------------------------------------
// Numeric helpers
// ---------------------------------------------------------------------------

export function toNonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

// ---------------------------------------------------------------------------
// Tool call / result → ThreadEventItem translation
// ---------------------------------------------------------------------------

/**
 * Translates a tool call (name + args) into a `ThreadEventItem`.
 * Recognises bash, file-edit, and web-search tools and produces the
 * corresponding specialised item types.
 */
export function translateToolCallToItem(
  callId: string,
  toolName: string,
  args: unknown,
): ThreadEventItem {
  if (BASH_TOOLS.has(toolName)) {
    const parsed = bashArgsSchema.safeParse(args);
    return {
      type: "commandExecution",
      id: callId,
      command: parsed.success ? String(parsed.data.command ?? "") : "",
      cwd: parsed.success && typeof parsed.data.cwd === "string" ? parsed.data.cwd : "",
      status: "pending",
    };
  }

  if (FILE_EDIT_TOOLS.has(toolName)) {
    const parsed = fileEditArgsSchema.safeParse(args);
    const filePath = parsed.success
      ? (parsed.data.file_path ?? parsed.data.path ?? "")
      : "";
    return {
      type: "fileChange",
      id: callId,
      changes: [{ path: filePath, kind: "update" as const }],
      status: "pending",
    };
  }

  if (WEB_SEARCH_TOOLS.has(toolName)) {
    const parsed = webSearchArgsSchema.safeParse(args);
    return {
      type: "webSearch",
      id: callId,
      query: parsed.success ? String(parsed.data.query ?? parsed.data.url ?? "") : "",
    };
  }

  return {
    type: "toolCall",
    id: callId,
    tool: toolName,
    arguments: args,
    status: "pending",
  };
}

/**
 * Translates a tool result into a `ThreadEventItem`.
 *
 * When `isError` is true the returned item uses `"failed"` status and (for
 * bash tools) exit code 1.  When omitted or false the item uses `"completed"`.
 */
export function translateToolResultToItem(
  callId: string,
  toolName: string | undefined,
  content: unknown,
  isError?: boolean,
): ThreadEventItem {
  const outputText = extractResultText(content);
  const status = isError ? "failed" as const : "completed" as const;

  if (toolName && BASH_TOOLS.has(toolName)) {
    return {
      type: "commandExecution",
      id: callId,
      command: "",
      cwd: "",
      aggregatedOutput: outputText,
      exitCode: isError ? 1 : 0,
      status,
    };
  }

  if (toolName && FILE_EDIT_TOOLS.has(toolName)) {
    return {
      type: "fileChange",
      id: callId,
      changes: [],
      status,
    };
  }

  if (toolName && WEB_SEARCH_TOOLS.has(toolName)) {
    return {
      type: "webSearch",
      id: callId,
      query: "",
    };
  }

  return {
    type: "toolCall",
    id: callId,
    tool: toolName ?? "unknown",
    status,
    result: outputText,
  };
}

/**
 * Extracts text from tool result content.
 * Handles strings, arrays of text blocks, and `{ content: [...] }` wrappers.
 */
export function extractResultText(content: unknown): string {
  if (typeof content === "string") return content;

  if (content && typeof content === "object" && !Array.isArray(content)) {
    const wrapper = contentWrapperSchema.safeParse(content);
    if (wrapper.success) {
      return extractResultText(wrapper.data.content);
    }
    return JSON.stringify(content);
  }

  if (!Array.isArray(content)) return JSON.stringify(content ?? "");

  const chunks: string[] = [];
  for (const block of content) {
    const parsed = textBlockSchema.safeParse(block);
    if (parsed.success) {
      chunks.push(parsed.data.text);
    }
  }
  return chunks.join("\n");
}
