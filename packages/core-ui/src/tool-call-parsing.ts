import type { ViewToolParsedIntent } from "@bb/domain";
import { getFirstStringField } from "./format-helpers.js";
import { toRecord } from "./unknown-helpers.js";

const SHELL_WRAPPER_NAMES = new Set(["sh", "bash", "zsh"]);
const DELEGATION_TOOL_NAMES = new Set([
  "Agent",
  "Task",
  "spawnAgent",
  "resumeAgent",
]);

type ToolArguments = Record<string, unknown>;
type ToolIntentKind = ViewToolParsedIntent["type"];

type ToolCommandFormatter = (toolName: string, args: ToolArguments) => string;

type ToolOutputFormatter = (output: string) => string;

interface TodoWriteTodo {
  content?: string;
  status?: string;
  activeForm?: string;
}

interface ToolDescriptor {
  argKeys: readonly string[];
  secondaryArgKeys?: readonly string[];
  formatCommand?: ToolCommandFormatter;
  formatOutput?: ToolOutputFormatter;
  intentKind?: ToolIntentKind;
}

const SHELL_SEGMENT_BREAK_TOKENS = new Set(["&&", "||", "|", ";"]);

function unwrapQuotedShellArg(value: string): string {
  if (value.length < 2) return value;
  const quote = value[0];
  if ((quote !== "'" && quote !== '"') || value[value.length - 1] !== quote) {
    return value;
  }
  const inner = value.slice(1, -1);
  if (quote === "'") return inner;

  // POSIX double-quote: backslash escapes $, `, ", \, and newline. Any other
  // backslash is preserved literally. Unescaping here restores the inner
  // command to a form the tokenizer can parse without tripping over
  // shell-wrapper-only escapes.
  let result = "";
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch === "\\" && i + 1 < inner.length) {
      const next = inner[i + 1]!;
      if (
        next === "$" ||
        next === "`" ||
        next === '"' ||
        next === "\\" ||
        next === "\n"
      ) {
        result += next;
        i += 1;
        continue;
      }
    }
    result += ch;
  }
  return result;
}

function isKnownShellWrapper(value: string): boolean {
  const shellName = value.split("/").pop() ?? value;
  // Shell wrapper names are open_external runtime values; unknown shells intentionally
  // preserve the original command payload for display.
  return SHELL_WRAPPER_NAMES.has(shellName);
}

export function extractShellCommandFromString(
  value: string,
): string | undefined {
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

// Timeline tool names that represent shell command execution. This is separate
// from SHELL_WRAPPER_NAMES, which are executables inside a command string.
const SHELL_TOOL_NAMES = new Set(["exec_command", "Bash", "bash"]);

export function isShellToolName(toolName: string): boolean {
  return SHELL_TOOL_NAMES.has(baseToolName(toolName));
}

const TOOL_TABLE: Record<string, ToolDescriptor> = {
  Read: { argKeys: ["file_path", "file", "path"], intentKind: "read" },
  read: { argKeys: ["file_path", "file", "path"], intentKind: "read" },
  Glob: { argKeys: ["pattern", "path"], intentKind: "list_files" },
  glob: { argKeys: ["pattern", "path"], intentKind: "list_files" },
  Grep: {
    argKeys: ["pattern", "query"],
    secondaryArgKeys: ["path"],
    intentKind: "search",
  },
  grep: {
    argKeys: ["pattern", "query"],
    secondaryArgKeys: ["path"],
    intentKind: "search",
  },
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
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
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

function formatTodoWriteCommand(
  _toolName: string,
  args: ToolArguments,
): string {
  const todos = asTodoWriteTodos(args.todos);
  if (todos.length === 0) return "TodoWrite";

  const activeTodo = todos.find((todo) => todo.status === "in_progress");
  const headline =
    activeTodo?.activeForm ?? activeTodo?.content ?? todos[0]?.content;
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

function formatToolSearchCommand(
  _toolName: string,
  args: ToolArguments,
): string {
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
  if (!subagentType)
    return `Agent ${truncateForDisplay(label ?? "", 90)}`.trim();
  if (!label) return `Agent [${subagentType}]`;
  return `Agent [${subagentType}] ${truncateForDisplay(label, 90)}`;
}

export function stripAgentOutputMetadata(output: string): string {
  const lines = output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(
      (line) => !line.startsWith("agentId:") && !line.startsWith("<usage>"),
    );
  return lines.join("\n").trim();
}

function formatAgentOutput(output: string): string {
  return stripAgentOutputMetadata(output);
}

function countReceiverThreadIds(args: ToolArguments): number {
  const receiverThreadIds = args["receiverThreadIds"];
  return Array.isArray(receiverThreadIds) ? receiverThreadIds.length : 0;
}

function formatCollabAgentCommand(
  toolName: string,
  args: ToolArguments,
): string {
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

  const action =
    receiverCount > 0
      ? `${toolName} ${receiverCount} agent${receiverCount === 1 ? "" : "s"}`
      : toolName;
  if (!prompt) return action;
  return `${action}: ${truncateForDisplay(prompt, 90)}`;
}

// Characters that a backslash may escape inside double quotes, per POSIX shell
// semantics. A backslash before any other character is preserved literally.
const DOUBLE_QUOTE_ESCAPABLE = new Set(["$", "`", '"', "\\", "\n"]);

/** A shell token carries its literal value and whether any portion of it
 * came from inside a quoted string. The `quoted` flag lets the redirect
 * classifier distinguish operator-shaped characters that originated as shell
 * operators from ones the user typed inside quotes. */
export interface ShellToken {
  readonly value: string;
  readonly quoted: boolean;
}

export function tokenizeShellWords(command: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let current = "";
  // Track quoted vs unquoted contributions to the current token separately.
  // A token is `quoted: true` only when *every* character originated inside
  // quotes — that way `"-n"` (fully quoted) is recognized as a literal, while
  // `--include='*.html'` (partially quoted) is still treated as a flag.
  let currentHasQuoted = false;
  let currentHasUnquoted = false;
  let quote: "'" | '"' | null = null;
  let escaping = false;

  const recordQuoted = (): void => {
    currentHasQuoted = true;
  };
  const recordUnquoted = (): void => {
    currentHasUnquoted = true;
  };

  const flushCurrent = (): void => {
    const fullyQuoted = currentHasQuoted && !currentHasUnquoted;
    const hasContent = current.length > 0;
    if (!hasContent && !fullyQuoted) {
      currentHasQuoted = false;
      currentHasUnquoted = false;
      return;
    }
    tokens.push({ value: current, quoted: fullyQuoted });
    current = "";
    currentHasQuoted = false;
    currentHasUnquoted = false;
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (!character) continue;

    if (escaping) {
      current += character;
      if (quote !== null) recordQuoted();
      else recordUnquoted();
      escaping = false;
      continue;
    }

    if (character === "\\") {
      if (quote === "'") {
        current += character;
        recordQuoted();
        continue;
      }
      if (quote === '"') {
        const next = command[index + 1];
        if (next === undefined || !DOUBLE_QUOTE_ESCAPABLE.has(next)) {
          current += character;
          recordQuoted();
          continue;
        }
      }
      escaping = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = null;
        // An empty quoted string (`""` / `''`) still produces a token.
        if (current.length === 0) recordQuoted();
        continue;
      }
      current += character;
      recordQuoted();
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }

    if (/\s/u.test(character)) {
      flushCurrent();
      continue;
    }

    if (character === "|" || character === "&" || character === ";") {
      // `&>` / `&>>` are stdout+stderr redirects, not a background `&` followed
      // by redirection. Build them as a compound operator.
      if (character === "&" && command[index + 1] === ">") {
        flushCurrent();
        if (command[index + 2] === ">") {
          tokens.push({ value: "&>>", quoted: false });
          index += 2;
        } else {
          tokens.push({ value: "&>", quoted: false });
          index += 1;
        }
        continue;
      }

      flushCurrent();

      const nextCharacter = command[index + 1];
      if (
        nextCharacter &&
        ((character === "|" && nextCharacter === "|") ||
          (character === "&" && nextCharacter === "&"))
      ) {
        tokens.push({ value: `${character}${nextCharacter}`, quoted: false });
        index += 1;
        continue;
      }

      tokens.push({ value: character, quoted: false });
      continue;
    }

    if (character === "<" || character === ">") {
      // The `<` and `>` family of operators. If the current buffer is exactly
      // a digit sequence or `&` and was built entirely outside quotes, treat
      // it as the file-descriptor prefix for this redirect (e.g. `2>`, `&>`);
      // otherwise flush current as a word.
      let prefix = "";
      const currentIsUnquoted = currentHasUnquoted && !currentHasQuoted;
      if (currentIsUnquoted && (current === "&" || /^\d+$/u.test(current))) {
        prefix = current;
        current = "";
        currentHasUnquoted = false;
      } else if (current.length > 0 || currentHasQuoted) {
        flushCurrent();
      }

      const next1 = command[index + 1];
      const next2 = command[index + 2];

      let op = character;
      let consumed = 1;

      if (character === ">") {
        if (next1 === ">") {
          op = ">>";
          consumed = 2;
        } else if (next1 === "|") {
          op = ">|";
          consumed = 2;
        } else if (next1 === "(") {
          op = ">(";
          consumed = 2;
        } else if (next1 === "&") {
          op = ">&";
          consumed = 2;
        }
      } else {
        if (next1 === "<" && next2 === "<") {
          op = "<<<";
          consumed = 3;
        } else if (next1 === "<" && next2 === "-") {
          op = "<<-";
          consumed = 3;
        } else if (next1 === "<") {
          op = "<<";
          consumed = 2;
        } else if (next1 === "(") {
          op = "<(";
          consumed = 2;
        } else if (next1 === ">") {
          op = "<>";
          consumed = 2;
        }
      }

      tokens.push({ value: `${prefix}${op}`, quoted: false });
      index += consumed - 1;
      continue;
    }

    current += character;
    recordUnquoted();
  }

  if (escaping) {
    current += "\\";
    recordUnquoted();
  }
  flushCurrent();

  return tokens;
}

// ---------------------------------------------------------------------------
// Shell command intent classification
//
// Every classifier (reads, searches, lists, writes) operates on the same
// tokenized + segment-split representation. This keeps quoting, flag handling,
// and redirection logic in one place instead of N independent regexes over
// the raw command string — which previously mis-extracted paths for commands
// like `cat -n foo`, `head -n 20 foo`, `find -L /path`, and was fooled by
// operator-looking characters inside quoted arguments.
// ---------------------------------------------------------------------------

const ENV_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/u;

/** Search flags that take a separate value. */
const SEARCH_FLAGS_WITH_VALUE: ReadonlySet<string> = new Set([
  "-g",
  "--glob",
  "-t",
  "--type",
  "-T",
  "--type-not",
  "-A",
  "--after-context",
  "-B",
  "--before-context",
  "-C",
  "--context",
  "-m",
  "--max-count",
]);

/** `find` flags whose value is the next token. Only the common ones —
 * unknown flags are treated as value-less, which is harmless for path extraction
 * since `find` puts the start path before the expression. */
const FIND_FLAGS_WITH_VALUE: ReadonlySet<string> = new Set([
  "-name",
  "-iname",
  "-path",
  "-ipath",
  "-type",
  "-maxdepth",
  "-mindepth",
  "-size",
  "-mtime",
  "-mmin",
  "-user",
  "-group",
  "-perm",
  "-regex",
  "-iregex",
]);

const HEAD_TAIL_FLAGS_WITH_VALUE: ReadonlySet<string> = new Set(["-n", "-c"]);
const NO_FLAGS_WITH_VALUE: ReadonlySet<string> = new Set();

type SegmentClassification =
  | { kind: "write" }
  | { kind: "intent"; intent: ViewToolParsedIntent }
  | { kind: "none" };

interface RedirectScan {
  /** True when the redirect targets a real file (content is being written). */
  isWrite: boolean;
  /** Extra tokens consumed past the redirect operator (e.g., the target). */
  consumedExtra: number;
}

function baseExecutableName(token: string): string {
  const slash = token.lastIndexOf("/");
  return slash >= 0 ? token.slice(slash + 1) : token;
}

/** Matches `-i`, `-i.bak`, `-iEXT`, `--in-place`, `--in-place=EXT`. */
function isSedInPlaceFlag(token: string): boolean {
  if (token === "--in-place") return true;
  if (token.startsWith("--in-place=")) return true;
  return /^-i(?:$|[^-])/u.test(token);
}

/** Splits a command string into per-segment token lists, using `&&`, `||`,
 * `|`, and `;` as segment boundaries. Quoted operator-shaped tokens are never
 * treated as segment breaks (a quoted `|` is just a literal pipe character). */
function splitShellCommandSegments(command: string): ShellToken[][] {
  const tokens = tokenizeShellWords(command);
  const segments: ShellToken[][] = [];
  let current: ShellToken[] = [];
  for (const token of tokens) {
    if (!token.quoted && SHELL_SEGMENT_BREAK_TOKENS.has(token.value)) {
      if (current.length > 0) {
        segments.push(current);
        current = [];
      }
      continue;
    }
    current.push(token);
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

/** Identifies a redirect at `tokens[index]` and reports whether it represents
 * a file write. Returns `null` when the token is not a redirect at all.
 *
 * Token shapes (produced by `tokenizeShellWords`): all redirect operators are
 * separate tokens, optionally prefixed by a digit-fd or `&`. Examples:
 * `>`, `>>`, `1>`, `2>`, `&>`, `&>>`, `>|`, `>&`, `>(`, `<`, `<<`, `<<-`,
 * `<<<`, `<(`, `<>`. Targets always follow as their own tokens. */
function scanRedirectAt(
  tokens: readonly ShellToken[],
  index: number,
): RedirectScan | null {
  const token = tokens[index];
  if (token === undefined) return null;
  // Quoted operator-shaped tokens (e.g. `grep ">" file`) are literal data, not
  // shell operators; never classify them as redirects.
  if (token.quoted) return null;

  const value = token.value;
  const nextValue = tokens[index + 1]?.value;

  // Heredoc body marker: `<<` / `<<-`. Always a write-shape (the command is
  // mutating something downstream of stdin). Next token is the delimiter.
  if (/^(?:\d+|&)?<<-?$/u.test(value)) {
    return { isWrite: true, consumedExtra: 1 };
  }

  // Here-string: `<<<`. Feeds inline content to stdin — not a write. Next
  // token is the inline string.
  if (/^(?:\d+|&)?<<<$/u.test(value)) {
    return { isWrite: false, consumedExtra: 1 };
  }

  // Process substitution: `<(` or `>(`. Spans tokens until one ending in `)`.
  if (value === "<(" || value === ">(") {
    let extra = 0;
    for (let j = index + 1; j < tokens.length; j += 1) {
      extra += 1;
      if (tokens[j]!.value.endsWith(")")) break;
    }
    return { isWrite: false, consumedExtra: extra };
  }

  // Read-write `<>file`: mutates the target.
  if (/^(?:\d+|&)?<>$/u.test(value)) {
    return { isWrite: true, consumedExtra: 1 };
  }

  // Input redirect `<file`: not a write, but skip the target so it doesn't
  // leak into the positional list.
  if (/^(?:\d+|&)?<$/u.test(value)) {
    return { isWrite: false, consumedExtra: 1 };
  }

  // Clobber `>|file`: forced write — except `>|/dev/null`, which is still a
  // discard (the clobber flag only matters for files that already exist).
  if (/^(?:\d+|&)?>\|$/u.test(value)) {
    if (nextValue === "/dev/null") return { isWrite: false, consumedExtra: 1 };
    return { isWrite: true, consumedExtra: 1 };
  }

  // FD-copy operator `>&` (next token is a digit fd or, rarely, a file).
  if (/^(\d*|&)>>?&$/u.test(value)) {
    if (nextValue === undefined) return { isWrite: false, consumedExtra: 0 };
    return { isWrite: false, consumedExtra: 1 };
  }

  // Output redirect operator: `>`, `>>`, `1>`, `2>`, `&>`, `&>>`, ...
  const opMatch = /^(\d+|&)?>>?$/u.exec(value);
  if (opMatch) {
    const prefix = opMatch[1] ?? "";
    if (nextValue === undefined) return { isWrite: false, consumedExtra: 0 };

    // Stderr / other-fd redirects (`2>file`, `3>file`) are diagnostic, not a
    // content write. Skip the target.
    if (/^[2-9]/u.test(prefix)) return { isWrite: false, consumedExtra: 1 };

    // `/dev/null` is a discard, not a real file.
    if (nextValue === "/dev/null") return { isWrite: false, consumedExtra: 1 };

    return { isWrite: true, consumedExtra: 1 };
  }

  return null;
}

function getCommandTokenIndex(tokens: readonly ShellToken[]): number {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    // A quoted token like `"FOO=bar"` is a literal word, not an env assignment.
    if (token === undefined || token.quoted) break;
    if (!ENV_ASSIGNMENT_PATTERN.test(token.value)) break;
    index += 1;
  }
  return index;
}

function segmentHasWriteShape(argTokens: readonly ShellToken[]): boolean {
  let i = 0;
  while (i < argTokens.length) {
    const redir = scanRedirectAt(argTokens, i);
    if (redir) {
      if (redir.isWrite) return true;
      i += 1 + redir.consumedExtra;
      continue;
    }
    i += 1;
  }
  return false;
}

/** Walks argument tokens, skipping flags (and their values, when known) and
 * any redirection operator + its consumed targets. Returns the literal values
 * of positional arguments (quoted-ness is no longer relevant once they reach
 * the dispatched classifier). */
function collectPositionals(
  argTokens: readonly ShellToken[],
  flagsWithValue: ReadonlySet<string>,
): string[] {
  const positionals: string[] = [];
  let i = 0;
  while (i < argTokens.length) {
    const token = argTokens[i]!;

    const redir = scanRedirectAt(argTokens, i);
    if (redir) {
      i += 1 + redir.consumedExtra;
      continue;
    }

    // Flags only count as flags when unquoted — `"-n"` as quoted arg is a
    // literal positional, not a flag.
    if (!token.quoted && token.value.startsWith("-") && token.value !== "-") {
      if (flagsWithValue.has(token.value)) {
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    positionals.push(token.value);
    i += 1;
  }
  return positionals;
}

function classifyShellSegment(
  tokens: readonly ShellToken[],
  fullCommand: string,
): SegmentClassification {
  const commandIndex = getCommandTokenIndex(tokens);
  const commandToken = tokens[commandIndex];
  if (commandToken === undefined) return { kind: "none" };

  const argTokens = tokens.slice(commandIndex + 1);
  const commandName = baseExecutableName(commandToken.value);

  // Write-shape: specific commands that mutate, regardless of redirects.
  if (commandName === "tee") return { kind: "write" };
  if (
    commandName === "sed" &&
    argTokens.some((t) => !t.quoted && isSedInPlaceFlag(t.value))
  ) {
    return { kind: "write" };
  }
  // Heredocs and file redirections within this segment.
  if (segmentHasWriteShape(argTokens)) return { kind: "write" };

  switch (commandName) {
    case "rg":
    case "grep": {
      const positionals = collectPositionals(
        argTokens,
        SEARCH_FLAGS_WITH_VALUE,
      );
      return {
        kind: "intent",
        intent: {
          type: "search",
          cmd: fullCommand,
          query: positionals[0] ?? null,
          path:
            positionals.length > 1
              ? positionals[positionals.length - 1]!
              : null,
        },
      };
    }
    case "find": {
      const positionals = collectPositionals(argTokens, FIND_FLAGS_WITH_VALUE);
      const path = positionals[0];
      if (!path) return { kind: "none" };
      return {
        kind: "intent",
        intent: { type: "list_files", cmd: fullCommand, path },
      };
    }
    case "ls": {
      const positionals = collectPositionals(argTokens, NO_FLAGS_WITH_VALUE);
      const path = positionals[0] ?? ".";
      return {
        kind: "intent",
        intent: { type: "list_files", cmd: fullCommand, path },
      };
    }
    case "cat":
    case "nl": {
      const positionals = collectPositionals(argTokens, NO_FLAGS_WITH_VALUE);
      const path = positionals[0];
      if (!path) return { kind: "none" };
      return {
        kind: "intent",
        intent: { type: "read", cmd: fullCommand, name: commandName, path },
      };
    }
    case "head":
    case "tail": {
      const positionals = collectPositionals(
        argTokens,
        HEAD_TAIL_FLAGS_WITH_VALUE,
      );
      const path = positionals[0];
      if (!path) return { kind: "none" };
      return {
        kind: "intent",
        intent: { type: "read", cmd: fullCommand, name: commandName, path },
      };
    }
    case "sed": {
      // Only classify `sed -n SCRIPT FILE` as a read. Other sed invocations are
      // too variable to pattern-match reliably.
      if (!argTokens.some((t) => !t.quoted && t.value === "-n")) {
        return { kind: "none" };
      }
      const positionals = collectPositionals(argTokens, NO_FLAGS_WITH_VALUE);
      const path = positionals[1]; // [script, file]
      if (!path) return { kind: "none" };
      return {
        kind: "intent",
        intent: { type: "read", cmd: fullCommand, name: "sed", path },
      };
    }
    default:
      return { kind: "none" };
  }
}

export function hasShellWriteShape(command: string): boolean {
  const segments = splitShellCommandSegments(command);
  return segments.some(
    (segment) => classifyShellSegment(segment, command).kind === "write",
  );
}

export function parseShellCommandIntents(
  command: string | undefined,
): ViewToolParsedIntent[] {
  if (!command) return [];

  const segments = splitShellCommandSegments(command);
  const classifications = segments.map((segment) =>
    classifyShellSegment(segment, command),
  );

  // Any segment that writes disqualifies the whole command from "exploring".
  if (classifications.some((c) => c.kind === "write")) return [];

  for (const classification of classifications) {
    if (classification.kind === "intent") return [classification.intent];
  }
  return [];
}

export function formatToolCallCommand(
  toolName: string,
  args: Record<string, unknown> | null,
): string {
  if (!args) return toolName;

  const desc = TOOL_TABLE[toolName];
  if (!desc) return formatUnknownToolCommand(toolName, args);

  if (desc.formatCommand) {
    return desc.formatCommand(toolName, args);
  }

  const primary = getFirstStringField(args, desc.argKeys) ?? "";

  // Shell tools are special: display the command itself, not "Bash <command>".
  if (isShellToolName(toolName)) {
    return primary || toolName;
  }

  // Grep is special: include query + path
  if (desc.secondaryArgKeys) {
    const secondary = getFirstStringField(args, desc.secondaryArgKeys);
    return `${toolName} '${primary}'${secondary ? ` in ${secondary}` : ""}`;
  }

  return `${toolName} ${primary}`.trim();
}

export function formatToolCallOutput(toolName: string, output: string): string {
  const desc = TOOL_TABLE[toolName];
  if (!desc?.formatOutput) {
    return output;
  }
  return desc.formatOutput(output);
}

function formatUnknownToolCommand(
  toolName: string,
  args: Record<string, unknown>,
): string {
  const entries = Object.entries(args).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return toolName;
  const compact = entries
    .map(([k, v]) => {
      const vs = typeof v === "string" ? v : JSON.stringify(v);
      const display = vs.length > 40 ? `${vs.slice(0, 37)}...` : vs;
      return `${k}: ${display}`;
    })
    .join(", ");
  return `${toolName} { ${compact} }`;
}

export function isExploringIntent(intent: ViewToolParsedIntent): boolean {
  return (
    intent.type === "read" ||
    intent.type === "list_files" ||
    intent.type === "search"
  );
}

export function isExploringCall(call: {
  parsedIntents: ViewToolParsedIntent[];
}): boolean {
  if (call.parsedIntents.length === 0) return false;
  return call.parsedIntents.every((intent) => isExploringIntent(intent));
}
