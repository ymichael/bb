import type {
  UIMessage,
  UIUserMessage,
  UIAssistantTextMessage,
  UIAssistantReasoningMessage,
  UIToolCallMessage,
  UIToolExploringMessage,
  UIFileEditMessage,
  UIWebSearchMessage,
  UIOperationMessage,
  UIErrorMessage,
} from "@bb/domain";

export type TimelineFormat = "json" | "minimal" | "verbose";

export interface FormatTimelineOptions {
  format: TimelineFormat;
  /** Whether to use ANSI colors. Default: auto-detect from stdout.isTTY. */
  color?: boolean;
}

// Simple ANSI helpers (no external dependency)
function dim(text: string, color: boolean): string {
  return color ? `\x1b[2m${text}\x1b[22m` : text;
}
function cyan(text: string, color: boolean): string {
  return color ? `\x1b[36m${text}\x1b[39m` : text;
}
function green(text: string, color: boolean): string {
  return color ? `\x1b[32m${text}\x1b[39m` : text;
}
function yellow(text: string, color: boolean): string {
  return color ? `\x1b[33m${text}\x1b[39m` : text;
}
function red(text: string, color: boolean): string {
  return color ? `\x1b[31m${text}\x1b[39m` : text;
}

function separator(label: string, color: boolean): string {
  const pad = Math.max(0, 60 - label.length - 4);
  return dim(`── ${label} ${"─".repeat(pad)}`, color);
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 3)}...`;
}

function statusBadge(status: string, color: boolean): string {
  switch (status) {
    case "completed":
      return green("✓", color);
    case "error":
      return red("✗", color);
    case "pending":
    case "streaming":
      return yellow("⋯", color);
    case "interrupted":
      return yellow("⊘", color);
    default:
      return status;
  }
}

function formatUser(msg: UIUserMessage, _verbose: boolean, color: boolean): string {
  const lines: string[] = [];
  lines.push(separator("User", color));
  lines.push(msg.text);
  if (msg.attachments) {
    const parts: string[] = [];
    if (msg.attachments.localImages > 0) parts.push(`${msg.attachments.localImages} image(s)`);
    if (msg.attachments.localFiles > 0) parts.push(`${msg.attachments.localFiles} file(s)`);
    if (parts.length > 0) lines.push(dim(`  [${parts.join(", ")}]`, color));
  }
  return lines.join("\n");
}

function formatAssistantText(msg: UIAssistantTextMessage, _verbose: boolean, color: boolean): string {
  const lines: string[] = [];
  lines.push(separator("Assistant", color));
  lines.push(msg.text);
  return lines.join("\n");
}

function formatReasoning(msg: UIAssistantReasoningMessage, verbose: boolean, color: boolean): string {
  if (!verbose) return "";
  const lines: string[] = [];
  lines.push(separator("Reasoning", color));
  lines.push(dim(msg.text, color));
  return lines.join("\n");
}

function formatToolCall(msg: UIToolCallMessage, verbose: boolean, color: boolean): string {
  const lines: string[] = [];
  const badge = statusBadge(msg.status, color);
  const name = msg.toolName ?? "exec_command";
  const cmd = msg.command ?? "";
  lines.push(separator(`Tool Call: ${name}`, color));
  lines.push(`  ${badge} ${cyan(cmd || name, color)}`);
  if (msg.durationMs !== undefined) {
    lines.push(dim(`  ${msg.duration ?? `${msg.durationMs}ms`}`, color));
  }
  if (msg.output) {
    const maxOut = verbose ? 10000 : 200;
    const output = truncate(msg.output.trim(), maxOut);
    if (output) {
      lines.push(dim(`  ${output.split("\n").join("\n  ")}`, color));
    }
  }
  if (msg.exitCode !== undefined && msg.exitCode !== 0) {
    lines.push(red(`  exit code ${msg.exitCode}`, color));
  }
  return lines.join("\n");
}

function formatExploring(msg: UIToolExploringMessage, verbose: boolean, color: boolean): string {
  const lines: string[] = [];
  const badge = statusBadge(msg.status, color);
  lines.push(separator(`Exploring (${msg.calls.length} call${msg.calls.length === 1 ? "" : "s"})`, color));
  for (const call of msg.calls) {
    const cmd = call.command ?? call.callId;
    lines.push(`  ${badge} ${dim(cmd, color)}`);
    if (verbose && call.output) {
      const output = truncate(call.output.trim(), 500);
      if (output) {
        lines.push(dim(`    ${output.split("\n").join("\n    ")}`, color));
      }
    }
  }
  return lines.join("\n");
}

function formatFileEdit(msg: UIFileEditMessage, verbose: boolean, color: boolean): string {
  const lines: string[] = [];
  const badge = statusBadge(msg.status, color);
  lines.push(separator("File Edit", color));
  for (const change of msg.changes) {
    const kindLabel = change.kind ? ` (${change.kind})` : "";
    lines.push(`  ${badge} ${cyan(change.path, color)}${dim(kindLabel, color)}`);
    if (verbose && change.diff) {
      const diff = truncate(change.diff.trim(), 2000);
      lines.push(dim(`  ${diff.split("\n").join("\n  ")}`, color));
    }
  }
  if (msg.stdout && verbose) {
    lines.push(dim(`  ${truncate(msg.stdout.trim(), 500)}`, color));
  }
  return lines.join("\n");
}

function formatWebSearch(msg: UIWebSearchMessage, _verbose: boolean, color: boolean): string {
  const lines: string[] = [];
  const badge = statusBadge(msg.status, color);
  lines.push(separator("Web Search", color));
  const query = msg.query ?? msg.action ?? "";
  lines.push(`  ${badge} ${cyan(query, color)}`);
  return lines.join("\n");
}

function formatOperation(msg: UIOperationMessage, _verbose: boolean, color: boolean): string {
  const lines: string[] = [];
  lines.push(separator(`Operation: ${msg.title}`, color));
  if (msg.detail) lines.push(dim(`  ${msg.detail}`, color));
  if (msg.status) lines.push(`  ${statusBadge(msg.status, color)}`);
  return lines.join("\n");
}

function formatError(msg: UIErrorMessage, _verbose: boolean, color: boolean): string {
  const lines: string[] = [];
  lines.push(separator("Error", color));
  lines.push(red(`  ${msg.message}`, color));
  return lines.join("\n");
}

function formatMessage(msg: UIMessage, verbose: boolean, color: boolean): string {
  switch (msg.kind) {
    case "user":
      return formatUser(msg, verbose, color);
    case "assistant-text":
      return formatAssistantText(msg, verbose, color);
    case "assistant-reasoning":
      return formatReasoning(msg, verbose, color);
    case "tool-call":
      return formatToolCall(msg, verbose, color);
    case "tool-exploring":
      return formatExploring(msg, verbose, color);
    case "file-edit":
      return formatFileEdit(msg, verbose, color);
    case "web-search":
      return formatWebSearch(msg, verbose, color);
    case "operation":
      return formatOperation(msg, verbose, color);
    case "error":
      return formatError(msg, verbose, color);
    case "debug/raw-event":
      // Skip debug events in timeline view
      return "";
    default:
      return "";
  }
}

/**
 * Format an array of UIMessages as human-readable terminal text.
 *
 * - `minimal`: Compact view — exploring collapsed, tool output truncated, reasoning hidden
 * - `verbose`: Full view — all output shown, reasoning included, diffs expanded
 */
export function formatTimelineAsText(
  messages: UIMessage[],
  options?: { verbose?: boolean; color?: boolean },
): string {
  const verbose = options?.verbose ?? false;
  const color = options?.color ?? false;

  const blocks: string[] = [];
  for (const msg of messages) {
    const formatted = formatMessage(msg, verbose, color);
    if (formatted) {
      blocks.push(formatted);
    }
  }
  return blocks.join("\n\n");
}
