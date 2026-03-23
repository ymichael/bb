import type { UIToolCallSummary, UIToolParsedIntent } from "@bb/domain";
import { getFirstStringField } from "./format-helpers.js";

const SHELL_WRAPPER_NAMES = new Set(["sh", "bash", "zsh"]);

function unwrapQuotedShellArg(value: string): string {
  if (value.length < 2) return value;
  const quote = value[0];
  if ((quote !== "'" && quote !== '"') || value[value.length - 1] !== quote) {
    return value;
  }
  return value.slice(1, -1);
}

function isKnownShellWrapper(value: string): boolean {
  const shellName = value.split("/").pop() ?? value;
  // Shell wrapper names are open_external runtime values; unknown shells intentionally
  // preserve the original command payload for display.
  return SHELL_WRAPPER_NAMES.has(shellName);
}

export function extractShellCommandFromString(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;

  const match = /^(\S+)\s+(-lc|-c)\s+([\s\S]+)$/.exec(trimmed);
  if (!match) return trimmed;

  const shellProgram = match[1];
  const commandArg = match[3];
  if (!shellProgram || !commandArg || !isKnownShellWrapper(shellProgram)) {
    return trimmed;
  }

  return unwrapQuotedShellArg(commandArg.trim());
}

// ── Tool descriptor table ──────────────────────────────────────────────
// Each entry defines how to parse intent and format display for a known tool.
// To add a new tool, add one row — both toolNameToParsedIntents and
// formatToolCallCommand will pick it up automatically.

interface ToolDescriptor {
  /** The exploring-intent type, or null if this tool is not an exploring action. */
  intentType: UIToolParsedIntent["type"] | null;
  /** Arg keys to extract as the primary value (tried in order). */
  argKeys: readonly string[];
  /** Optional secondary arg keys (e.g. path for Grep). */
  secondaryArgKeys?: readonly string[];
}

const TOOL_TABLE: Record<string, ToolDescriptor> = {
  Read:  { intentType: "read",       argKeys: ["file_path", "file", "path"] },
  read:  { intentType: "read",       argKeys: ["file_path", "file", "path"] },
  Glob:  { intentType: "list_files", argKeys: ["pattern", "path"] },
  glob:  { intentType: "list_files", argKeys: ["pattern", "path"] },
  ls:    { intentType: "list_files", argKeys: ["pattern", "path"] },
  find:  { intentType: "list_files", argKeys: ["pattern", "path"] },
  Grep:  { intentType: "search",     argKeys: ["pattern", "query"], secondaryArgKeys: ["path"] },
  grep:  { intentType: "search",     argKeys: ["pattern", "query"], secondaryArgKeys: ["path"] },
  Bash:  { intentType: null,         argKeys: ["command"] },
  bash:  { intentType: null,         argKeys: ["command"] },
  Edit:  { intentType: null,         argKeys: ["file_path", "path"] },
  edit:  { intentType: null,         argKeys: ["file_path", "path"] },
  Write: { intentType: null,         argKeys: ["file_path", "path"] },
  write: { intentType: null,         argKeys: ["file_path", "path"] },
};

// Maps well-known tool names to exploring intents for grouping
export function toolNameToParsedIntents(
  toolName: string,
  args: Record<string, unknown> | null,
): UIToolParsedIntent[] {
  const desc = TOOL_TABLE[toolName];
  if (!desc?.intentType) return [];

  const primary = getFirstStringField(args, desc.argKeys) ?? "";
  const secondary = desc.secondaryArgKeys
    ? getFirstStringField(args, desc.secondaryArgKeys) ?? ""
    : "";

  switch (desc.intentType) {
    case "read":
      return [{ type: "read", cmd: `${toolName} ${primary}`.trim(), name: toolName, path: primary || null }];
    case "list_files":
      return [{ type: "list_files", cmd: `${toolName} ${primary}`.trim(), path: primary || null }];
    case "search":
      return [{ type: "search", cmd: `${toolName} '${primary}'${secondary ? ` in ${secondary}` : ""}`.trim(), query: primary || null, path: secondary || null }];
    default:
      return [];
  }
}

export function formatToolCallCommand(toolName: string, args: Record<string, unknown> | null): string {
  if (!args) return toolName;

  const desc = TOOL_TABLE[toolName];
  if (!desc) return formatUnknownToolCommand(toolName, args);

  const primary = getFirstStringField(args, desc.argKeys) ?? "";

  // Bash is special: display the command itself, not "Bash <command>"
  if (toolName === "Bash" || toolName === "bash") {
    return primary || toolName;
  }

  // Grep is special: include query + path
  if (desc.secondaryArgKeys) {
    const secondary = getFirstStringField(args, desc.secondaryArgKeys);
    return `${toolName} '${primary}'${secondary ? ` in ${secondary}` : ""}`;
  }

  return `${toolName} ${primary}`.trim();
}

function formatUnknownToolCommand(toolName: string, args: Record<string, unknown>): string {
  const entries = Object.entries(args).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return toolName;
  const compact = entries.map(([k, v]) => {
    const vs = typeof v === "string" ? v : JSON.stringify(v);
    const display = vs.length > 40 ? `${vs.slice(0, 37)}...` : vs;
    return `${k}: ${display}`;
  }).join(", ");
  return `${toolName} { ${compact} }`;
}

export function isExploringIntent(intent: UIToolParsedIntent): boolean {
  return (
    intent.type === "read" ||
    intent.type === "list_files" ||
    intent.type === "search"
  );
}

export function isExploringCall(call: Pick<UIToolCallSummary, "parsedCmd">): boolean {
  if (call.parsedCmd.length === 0) return false;
  return call.parsedCmd.every((intent) => isExploringIntent(intent));
}
