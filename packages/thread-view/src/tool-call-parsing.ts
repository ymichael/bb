import type { EventProjectionToolParsedIntent } from "./event-projection-types.js";

const SHELL_WRAPPER_NAMES = new Set(["sh", "bash", "zsh"]);

const SHELL_SEGMENT_BREAK_TOKENS = new Set(["&&", "||", "|", ";", "\n"]);

function unwrapQuotedShellArg(value: string): string {
  if (value.length < 2) return value;
  const quote = value[0];
  if ((quote !== "'" && quote !== '"') || value[value.length - 1] !== quote) {
    return value;
  }
  const inner = value.slice(1, -1);
  if (quote === "'") return inner;

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

const DOUBLE_QUOTE_ESCAPABLE = new Set(["$", "`", '"', "\\", "\n"]);

interface ShellToken {
  readonly value: string;
  readonly quoted: boolean;
}

function tokenizeShellWords(command: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let current = "";
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

    if (character === "\n") {
      flushCurrent();
      tokens.push({ value: "\n", quoted: false });
      continue;
    }

    if (/\s/u.test(character)) {
      flushCurrent();
      continue;
    }

    if (character === "|" || character === "&" || character === ";") {
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

const ENV_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/u;

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
  | { kind: "intent"; intent: EventProjectionToolParsedIntent }
  | { kind: "none" };

interface RedirectScan {
  isWrite: boolean;
  consumedExtra: number;
}

function baseExecutableName(token: string): string {
  const slash = token.lastIndexOf("/");
  return slash >= 0 ? token.slice(slash + 1) : token;
}

function isSedInPlaceFlag(token: string): boolean {
  if (token === "--in-place") return true;
  if (token.startsWith("--in-place=")) return true;
  return /^-i(?:$|[^-])/u.test(token);
}

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

function scanRedirectAt(
  tokens: readonly ShellToken[],
  index: number,
): RedirectScan | null {
  const token = tokens[index];
  if (token === undefined) return null;
  if (token.quoted) return null;

  const value = token.value;
  const nextValue = tokens[index + 1]?.value;

  if (/^(?:\d+|&)?<<-?$/u.test(value)) {
    return { isWrite: true, consumedExtra: 1 };
  }

  if (/^(?:\d+|&)?<<<$/u.test(value)) {
    return { isWrite: false, consumedExtra: 1 };
  }

  if (value === "<(" || value === ">(") {
    let extra = 0;
    for (let j = index + 1; j < tokens.length; j += 1) {
      extra += 1;
      if (tokens[j]!.value.endsWith(")")) break;
    }
    return { isWrite: false, consumedExtra: extra };
  }

  if (/^(?:\d+|&)?<>$/u.test(value)) {
    return { isWrite: true, consumedExtra: 1 };
  }

  if (/^(?:\d+|&)?<$/u.test(value)) {
    return { isWrite: false, consumedExtra: 1 };
  }

  if (/^(?:\d+|&)?>\|$/u.test(value)) {
    if (nextValue === "/dev/null") return { isWrite: false, consumedExtra: 1 };
    return { isWrite: true, consumedExtra: 1 };
  }

  if (/^(\d*|&)>>?&$/u.test(value)) {
    if (nextValue === undefined) return { isWrite: false, consumedExtra: 0 };
    return { isWrite: false, consumedExtra: 1 };
  }

  const opMatch = /^(\d+|&)?>>?$/u.exec(value);
  if (opMatch) {
    const prefix = opMatch[1] ?? "";
    if (nextValue === undefined) return { isWrite: false, consumedExtra: 0 };

    if (/^[2-9]/u.test(prefix)) return { isWrite: false, consumedExtra: 1 };

    if (nextValue === "/dev/null") return { isWrite: false, consumedExtra: 1 };

    return { isWrite: true, consumedExtra: 1 };
  }

  return null;
}

function getCommandTokenIndex(tokens: readonly ShellToken[]): number {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
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

  if (commandName === "tee") return { kind: "write" };
  if (
    commandName === "sed" &&
    argTokens.some((t) => !t.quoted && isSedInPlaceFlag(t.value))
  ) {
    return { kind: "write" };
  }
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
      if (!argTokens.some((t) => !t.quoted && t.value === "-n")) {
        return { kind: "none" };
      }
      const positionals = collectPositionals(argTokens, NO_FLAGS_WITH_VALUE);
      const path = positionals[1];
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

export function parseShellCommandIntents(
  command: string | undefined,
): EventProjectionToolParsedIntent[] {
  if (!command) return [];

  const segments = splitShellCommandSegments(command);
  const classifications = segments.map((segment) =>
    classifyShellSegment(segment, command),
  );

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
  const entries = Object.entries(args).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return toolName;
  const compact = entries
    .map(([k, v]) => {
      const vs = typeof v === "string" ? v.trim() : JSON.stringify(v);
      const display = vs.length > 40 ? `${vs.slice(0, 37)}...` : vs;
      return `${k}: ${display}`;
    })
    .join(", ");
  return `${toolName} { ${compact} }`;
}
