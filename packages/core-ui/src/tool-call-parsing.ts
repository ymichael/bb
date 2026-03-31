import type { ViewToolCallSummary, ViewToolParsedIntent } from "@bb/domain";
import { getFirstStringField } from "./format-helpers.js";
import { toRecord } from "./unknown-helpers.js";

const SHELL_WRAPPER_NAMES = new Set(["sh", "bash", "zsh"]);
const DELEGATION_TOOL_NAMES = new Set(["Agent", "Task", "spawnAgent", "resumeAgent"]);

type ToolArguments = Record<string, unknown>;
type ToolIntentKind = ViewToolParsedIntent["type"];

type ToolCommandFormatter = (toolName: string, args: ToolArguments) => string;

type ToolOutputFormatter = (output: string) => string;

interface TodoWriteTodo {
  content?: string;
  status?: string;
  activeForm?: string;
}

interface ShellReadPattern {
  name: string;
  pattern: RegExp;
  captureIndex: number;
}

interface ShellReadMatch {
  name: string;
  path: string;
}

interface ToolDescriptor {
  argKeys: readonly string[];
  secondaryArgKeys?: readonly string[];
  formatCommand?: ToolCommandFormatter;
  formatOutput?: ToolOutputFormatter;
  intentKind?: ToolIntentKind;
}

const SHELL_SEGMENT_BREAK_TOKENS = new Set(["&&", "||", "|", ";"]);
const SEARCH_TOOL_NAMES = new Set(["rg", "grep"]);
const SEARCH_OPTIONS_WITH_VALUES = new Set(["-g", "--glob"]);

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

export function baseToolName(toolName: string): string {
  const segments = toolName.split(":");
  return segments[segments.length - 1] ?? toolName;
}

const TOOL_TABLE: Record<string, ToolDescriptor> = {
  Read: { argKeys: ["file_path", "file", "path"], intentKind: "read" },
  read: { argKeys: ["file_path", "file", "path"], intentKind: "read" },
  Glob: { argKeys: ["pattern", "path"], intentKind: "list_files" },
  glob: { argKeys: ["pattern", "path"], intentKind: "list_files" },
  Grep: { argKeys: ["pattern", "query"], secondaryArgKeys: ["path"], intentKind: "search" },
  grep: { argKeys: ["pattern", "query"], secondaryArgKeys: ["path"], intentKind: "search" },
  Bash: { argKeys: ["command"] },
  bash: { argKeys: ["command"] },
  Edit: { argKeys: ["file_path", "path"] },
  edit: { argKeys: ["file_path", "path"] },
  Write: { argKeys: ["file_path", "path"] },
  write: { argKeys: ["file_path", "path"] },
  ToolSearch: {
    argKeys: ["query"],
    formatCommand: formatToolSearchCommand,
  },
  TodoWrite: {
    argKeys: [],
    formatCommand: formatTodoWriteCommand,
    formatOutput: formatTodoWriteOutput,
  },
  Agent: {
    argKeys: ["description", "prompt"],
    formatCommand: formatAgentCommand,
    formatOutput: formatAgentOutput,
  },
  Task: {
    argKeys: ["description", "prompt"],
    formatCommand: formatAgentCommand,
    formatOutput: formatAgentOutput,
  },
  spawnAgent: {
    argKeys: ["prompt"],
    formatCommand: formatCollabAgentCommand,
  },
  sendInput: {
    argKeys: ["prompt"],
    formatCommand: formatCollabAgentCommand,
  },
  resumeAgent: { argKeys: [], formatCommand: formatCollabAgentCommand },
  wait: { argKeys: [], formatCommand: formatCollabAgentCommand },
  closeAgent: { argKeys: [], formatCommand: formatCollabAgentCommand },
};

function getToolDescriptor(toolName: string): ToolDescriptor | undefined {
  return TOOL_TABLE[baseToolName(toolName)];
}

export function isStructuredReadToolName(toolName: string): boolean {
  return getToolDescriptor(toolName)?.intentKind === "read";
}

export function isStructuredSearchToolName(toolName: string): boolean {
  return getToolDescriptor(toolName)?.intentKind === "search";
}

export function isStructuredListToolName(toolName: string): boolean {
  return getToolDescriptor(toolName)?.intentKind === "list_files";
}

export function isDelegationToolName(toolName: string): boolean {
  return DELEGATION_TOOL_NAMES.has(baseToolName(toolName));
}

function truncateForDisplay(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function asTodoWriteTodos(value: unknown): TodoWriteTodo[] {
  if (!Array.isArray(value)) return [];

  const todos: TodoWriteTodo[] = [];
  for (const entry of value) {
    const record = toRecord(entry);
    if (!record) continue;
    todos.push({
      content: asString(record.content),
      status: asString(record.status),
      activeForm: asString(record.activeForm),
    });
  }
  return todos;
}

function summarizeTodoCounts(todos: TodoWriteTodo[]): string {
  let pending = 0;
  let inProgress = 0;
  let completed = 0;

  for (const todo of todos) {
    switch (todo.status) {
      case "in_progress":
        inProgress += 1;
        break;
      case "completed":
        completed += 1;
        break;
      default:
        pending += 1;
        break;
    }
  }

  const parts: string[] = [];
  if (inProgress > 0) parts.push(`${inProgress} in progress`);
  if (pending > 0) parts.push(`${pending} pending`);
  if (completed > 0) parts.push(`${completed} completed`);
  return parts.join(", ");
}

function formatTodoWriteCommand(_toolName: string, args: ToolArguments): string {
  const todos = asTodoWriteTodos(args.todos);
  if (todos.length === 0) return "TodoWrite";

  const activeTodo = todos.find((todo) => todo.status === "in_progress");
  const headline = activeTodo?.activeForm ?? activeTodo?.content ?? todos[0]?.content;
  const countSummary = summarizeTodoCounts(todos);
  const summaryParts = [`${todos.length} todo${todos.length === 1 ? "" : "s"}`];

  if (countSummary.length > 0) {
    summaryParts.push(countSummary);
  }

  const header = `TodoWrite ${summaryParts.join(" - ")}`;
  if (!headline) return header;
  return `${header}: ${truncateForDisplay(headline, 80)}`;
}

function formatTodoWriteOutput(output: string): string {
  if (output.startsWith("Todos have been modified successfully.")) {
    return "Todo list updated";
  }
  return output;
}

function formatToolSearchCommand(_toolName: string, args: ToolArguments): string {
  const query = getFirstStringField(args, ["query"]);
  if (!query) return "ToolSearch";
  return `ToolSearch ${query}`;
}

function formatAgentCommand(_toolName: string, args: ToolArguments): string {
  const description = getFirstStringField(args, ["description"]);
  const prompt = getFirstStringField(args, ["prompt"]);
  const subagentType = getFirstStringField(args, ["subagent_type"]);
  const label = description ?? prompt;
  if (!label && !subagentType) return "Agent";
  if (!subagentType) return `Agent ${truncateForDisplay(label ?? "", 90)}`.trim();
  if (!label) return `Agent [${subagentType}]`;
  return `Agent [${subagentType}] ${truncateForDisplay(label, 90)}`;
}

export function stripAgentOutputMetadata(output: string): string {
  const lines = output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => !line.startsWith("agentId:") && !line.startsWith("<usage>"));
  return lines.join("\n").trim();
}

function formatAgentOutput(output: string): string {
  return stripAgentOutputMetadata(output);
}

function countReceiverThreadIds(args: ToolArguments): number {
  const receiverThreadIds = args["receiverThreadIds"];
  return Array.isArray(receiverThreadIds) ? receiverThreadIds.length : 0;
}

function formatCollabAgentCommand(toolName: string, args: ToolArguments): string {
  const receiverCount = countReceiverThreadIds(args);
  const prompt = getFirstStringField(args, ["prompt"]);

  if (toolName === "wait") {
    return receiverCount > 0
      ? `wait for ${receiverCount} agent${receiverCount === 1 ? "" : "s"}`
      : "wait";
  }

  if (toolName === "resumeAgent") {
    return receiverCount > 0
      ? `resumeAgent ${receiverCount} agent${receiverCount === 1 ? "" : "s"}`
      : "resumeAgent";
  }

  if (toolName === "closeAgent") {
    return receiverCount > 0
      ? `closeAgent ${receiverCount} agent${receiverCount === 1 ? "" : "s"}`
      : "closeAgent";
  }

  const action = receiverCount > 0
    ? `${toolName} ${receiverCount} agent${receiverCount === 1 ? "" : "s"}`
    : toolName;
  if (!prompt) return action;
  return `${action}: ${truncateForDisplay(prompt, 90)}`;
}

const SHELL_READ_PATTERNS: readonly ShellReadPattern[] = [
  {
    name: "sed",
    pattern: /\bsed\s+-n\s+(?:"[^"]*"|'[^']*'|\S+)\s+([^\s|&;]+)/u,
    captureIndex: 1,
  },
  {
    name: "nl",
    pattern: /\bnl\s+-ba\s+([^\s|&;]+)/u,
    captureIndex: 1,
  },
  {
    name: "cat",
    pattern: /\bcat\s+([^\s|&;]+)/u,
    captureIndex: 1,
  },
  {
    name: "head",
    pattern: /\bhead(?:\s+-\d+)?\s+([^\s|&;]+)/u,
    captureIndex: 1,
  },
];

function extractShellReadMatch(command: string): ShellReadMatch | null {
  for (const entry of SHELL_READ_PATTERNS) {
    const match = entry.pattern.exec(command);
    const path = match?.[entry.captureIndex]?.trim();
    if (!path) continue;
    return {
      name: entry.name,
      path,
    };
  }
  return null;
}

function extractFindPath(command: string): string | null {
  const match = /\bfind\s+([^\s|&;]+)/u.exec(command);
  return match?.[1]?.trim() ?? null;
}

function extractLsPath(command: string): string | null {
  const match = /\bls\b(?:\s+-[^\s]+)*\s+([^\s|&;]+)/u.exec(command);
  return match?.[1]?.trim() ?? null;
}

function extractSearchQuery(command: string): string | null {
  const quoted = /\b(?:rg|grep)\b[\s\S]*?(?:"([^"]+)"|'([^']+)')/u.exec(command);
  if (quoted?.[1]) return quoted[1].trim();
  if (quoted?.[2]) return quoted[2].trim();

  const unquoted = /\b(?:rg|grep)\b(?:\s+-[^\s]+|\s+--[^\s]+)*\s+([^\s|&;]+)/u.exec(command);
  return unquoted?.[1]?.trim() ?? null;
}

function tokenizeShellWords(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (!character) continue;

    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }

    if (character === "\\") {
      if (quote === "'") {
        current += character;
        continue;
      }
      escaping = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = null;
        continue;
      }
      current += character;
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }

    if (/\s/u.test(character)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    if (character === "|" || character === "&" || character === ";") {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }

      const nextCharacter = command[index + 1];
      if (
        nextCharacter &&
        ((character === "|" && nextCharacter === "|") ||
          (character === "&" && nextCharacter === "&"))
      ) {
        tokens.push(`${character}${nextCharacter}`);
        index += 1;
        continue;
      }

      tokens.push(character);
      continue;
    }

    current += character;
  }

  if (escaping) {
    current += "\\";
  }
  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

function findShellSegmentTokens(
  command: string,
  matcher: (token: string) => boolean,
): string[] {
  const tokens = tokenizeShellWords(command);
  const segments: string[][] = [];
  let currentSegment: string[] = [];

  for (const token of tokens) {
    if (SHELL_SEGMENT_BREAK_TOKENS.has(token)) {
      if (currentSegment.length > 0) {
        segments.push(currentSegment);
        currentSegment = [];
      }
      continue;
    }
    currentSegment.push(token);
  }

  if (currentSegment.length > 0) {
    segments.push(currentSegment);
  }

  return (
    segments.find((segment) => segment.some((token) => matcher(token))) ?? []
  );
}

function isShellRedirectionToken(token: string): boolean {
  return /^(?:\d*>|>>|<|>\|?|2>&1)/u.test(token);
}

function extractSearchPath(command: string): string | null {
  const segment = findShellSegmentTokens(
    command,
    (token) => SEARCH_TOOL_NAMES.has(token),
  );
  if (segment.length === 0) {
    return null;
  }

  const toolIndex = segment.findIndex((token) => SEARCH_TOOL_NAMES.has(token));
  if (toolIndex < 0) {
    return null;
  }

  let querySeen = false;
  let lastPathCandidate: string | null = null;
  for (let index = toolIndex + 1; index < segment.length; index += 1) {
    const token = segment[index];
    if (!token) continue;

    if (!querySeen) {
      if (token.startsWith("-")) {
        if (SEARCH_OPTIONS_WITH_VALUES.has(token)) {
          index += 1;
        }
        continue;
      }
      querySeen = true;
      continue;
    }

    if (token.startsWith("-")) {
      if (SEARCH_OPTIONS_WITH_VALUES.has(token)) {
        index += 1;
      }
      continue;
    }
    if (isShellRedirectionToken(token)) {
      continue;
    }

    lastPathCandidate = token;
  }

  return lastPathCandidate;
}

export function parseShellCommandIntents(command: string | undefined): ViewToolParsedIntent[] {
  if (!command) return [];

  // Check search/list commands first — they may be piped through head/tail
  // which would otherwise be misclassified as reads.

  if (/\brg\b/u.test(command)) {
    return [
      {
        type: "search",
        cmd: command,
        query: extractSearchQuery(command),
        path: extractSearchPath(command),
      },
    ];
  }

  if (/\bgrep\b/u.test(command)) {
    return [
      {
        type: "search",
        cmd: command,
        query: extractSearchQuery(command),
        path: extractSearchPath(command),
      },
    ];
  }

  const findPath = extractFindPath(command);
  if (findPath) {
    return [
      {
        type: "list_files",
        cmd: command,
        path: findPath,
      },
    ];
  }

  const lsPath = extractLsPath(command);
  if (lsPath) {
    return [
      {
        type: "list_files",
        cmd: command,
        path: lsPath,
      },
    ];
  }

  const readMatch = extractShellReadMatch(command);
  if (readMatch) {
    return [
      {
        type: "read",
        cmd: command,
        name: readMatch.name,
        path: readMatch.path,
      },
    ];
  }

  return [];
}

export function formatToolCallCommand(toolName: string, args: Record<string, unknown> | null): string {
  if (!args) return toolName;

  const desc = TOOL_TABLE[toolName];
  if (!desc) return formatUnknownToolCommand(toolName, args);

  if (desc.formatCommand) {
    return desc.formatCommand(toolName, args);
  }

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

export function formatToolCallOutput(
  toolName: string,
  output: string,
): string {
  const desc = TOOL_TABLE[toolName];
  if (!desc?.formatOutput) {
    return output;
  }
  return desc.formatOutput(output);
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

export function isExploringIntent(intent: ViewToolParsedIntent): boolean {
  return (
    intent.type === "read" ||
    intent.type === "list_files" ||
    intent.type === "search"
  );
}

export function isExploringCall(call: Pick<ViewToolCallSummary, "parsedCmd">): boolean {
  if (call.parsedCmd.length === 0) return false;
  return call.parsedCmd.every((intent) => isExploringIntent(intent));
}
