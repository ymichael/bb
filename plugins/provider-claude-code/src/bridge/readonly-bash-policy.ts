import { z } from "zod";

const READONLY_GIT_TOP_LEVEL_OPTIONS = new Set([
  "--no-optional-locks",
  "--no-pager",
]);
const READONLY_GIT_STATUS_OPTIONS = new Set([
  "--ahead-behind",
  "--branch",
  "--ignored",
  "--long",
  "--no-ahead-behind",
  "--porcelain",
  "--porcelain=v1",
  "--porcelain=v2",
  "--short",
  "-b",
  "-s",
  "-u",
  "-uno",
]);
const READONLY_GIT_DIFF_OPTIONS = new Set([
  "--",
  "--cached",
  "--check",
  "--color",
  "--compact-summary",
  "--find-copies",
  "--find-renames",
  "--histogram",
  "--ignore-all-space",
  "--ignore-blank-lines",
  "--ignore-space-at-eol",
  "--ignore-space-change",
  "--minimal",
  "--name-only",
  "--name-status",
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--numstat",
  "--patch",
  "--patience",
  "--shortstat",
  "--stat",
  "--summary",
  "--word-diff",
  "-M",
  "-U0",
  "-U1",
  "-U2",
  "-U3",
  "-w",
]);
const READONLY_GIT_SHOW_OPTIONS = new Set([
  "--",
  "--color",
  "--decorate",
  "--format=full",
  "--format=fuller",
  "--format=medium",
  "--format=oneline",
  "--name-only",
  "--name-status",
  "--no-color",
  "--no-ext-diff",
  "--no-patch",
  "--no-textconv",
  "--numstat",
  "--oneline",
  "--patch",
  "--shortstat",
  "--stat",
  "--summary",
  "-1",
]);
const READONLY_GIT_MERGE_BASE_OPTIONS = new Set([
  "--all",
  "--fork-point",
  "--independent",
  "--is-ancestor",
  "--octopus",
]);
const READONLY_GIT_LOG_OPTIONS = new Set([
  "--",
  "--all",
  "--color",
  "--decorate",
  "--format=full",
  "--format=fuller",
  "--format=medium",
  "--format=oneline",
  "--graph",
  "--max-count=1",
  "--name-only",
  "--name-status",
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--oneline",
  "--shortstat",
  "--stat",
  "-1",
]);
const READONLY_GIT_BRANCH_FLAG_OPTIONS = new Set([
  "--all",
  "--current",
  "--no-color",
  "--remotes",
  "--show-current",
  "-a",
  "-r",
]);
const READONLY_GIT_BRANCH_QUERY_OPTIONS = new Set([
  "--contains",
  "--merged",
  "--no-contains",
  "--no-merged",
]);
const READONLY_GIT_LS_FILES_OPTIONS = new Set([
  "--",
  "--cached",
  "--deleted",
  "--modified",
  "--others",
  "--stage",
  "--unmerged",
  "--with-tree",
  "-d",
  "-m",
  "-o",
  "-s",
  "-u",
]);
const READONLY_GIT_REV_PARSE_OPTIONS = new Set([
  "--abbrev-ref",
  "--absolute-git-dir",
  "--git-common-dir",
  "--git-dir",
  "--is-inside-work-tree",
  "--show-prefix",
  "--show-toplevel",
  "--short",
  "--verify",
]);
const READONLY_GIT_GREP_OPTIONS = new Set([
  "--",
  "--break",
  "--cached",
  "--count",
  "--files-with-matches",
  "--heading",
  "--ignore-case",
  "--line-number",
  "--name-only",
  "--no-color",
  "--untracked",
  "-I",
  "-c",
  "-i",
  "-l",
  "-n",
]);
const READONLY_GIT_BLAME_OPTIONS = new Set([
  "--",
  "--abbrev",
  "--date",
  "--line-porcelain",
  "--porcelain",
  "--root",
  "-L",
  "-w",
]);
const SIMPLE_SHELL_WORD_PATTERN = /^[A-Za-z0-9_./:@%+=,-]+$/u;
const RANGE_COUNT_OPTION_PATTERN = /^-[1-9][0-9]*$/u;
const UNIFIED_DIFF_OPTION_PATTERN = /^-U[0-9]+$/u;
const MAX_COUNT_OPTION_PATTERN = /^--max-count=[1-9][0-9]*$/u;
const UNTRACKED_FILES_OPTION_PATTERN = /^--untracked-files=(all|normal|no)$/u;
const FORMAT_OPTION_PATTERN = /^--format=[A-Za-z0-9_./:@%+=,-]+$/u;
const ABBREV_OPTION_PATTERN = /^--abbrev=[0-9]+$/u;
const DATE_OPTION_PATTERN = /^--date=[A-Za-z0-9_./:@%+=,-]+$/u;
const BLAME_LINE_RANGE_PATTERN = /^-L[0-9]+(,[0-9]+)?$/u;
const READONLY_GIT_DIFF_SAFETY_OPTIONS = [
  "--no-ext-diff",
  "--no-textconv",
] as const;
const READONLY_GIT_DIFF_SAFETY_SUBCOMMANDS = new Set(["diff", "show", "log"]);

const bashToolInputSchema = z.object({ command: z.string() }).passthrough();

interface ReadonlyBashCommand {
  needsNoOptionalGitLocks: boolean;
  tokens: readonly string[];
}

type ReadonlyGitDynamicOptionChecker = (token: string) => boolean;

function hasParentDirectoryTraversal(token: string): boolean {
  return token === ".." || token.startsWith("../") || token.includes("/../");
}

function isAbsolutePathToken(token: string): boolean {
  return token.startsWith("/") || /^[A-Za-z]:\//u.test(token);
}

function tokenizeSimpleReadonlyShellCommand(command: string): string[] | null {
  const tokens = command.trim().split(/\s+/u).filter(Boolean);
  if (tokens.length === 0) {
    return null;
  }
  for (const token of tokens) {
    if (
      !SIMPLE_SHELL_WORD_PATTERN.test(token) ||
      hasParentDirectoryTraversal(token)
    ) {
      return null;
    }
  }
  return tokens;
}

function isReadonlyGitArg(token: string): boolean {
  return (
    token === "--" || (!token.startsWith("-") && !isAbsolutePathToken(token))
  );
}

function isReadonlyGitPositionalValue(token: string): boolean {
  return !token.startsWith("-") && !isAbsolutePathToken(token);
}

function areReadonlyGitArgs(
  args: readonly string[],
  allowedOptions: ReadonlySet<string>,
  allowDynamicOption?: ReadonlyGitDynamicOptionChecker,
): boolean {
  for (const arg of args) {
    if (isReadonlyGitArg(arg)) {
      continue;
    }
    if (allowedOptions.has(arg)) {
      continue;
    }
    if (allowDynamicOption?.(arg)) {
      continue;
    }
    return false;
  }
  return true;
}

function areReadonlyGitBranchArgs(args: readonly string[]): boolean {
  let index = 0;
  let allowListPatterns = false;
  while (index < args.length) {
    const arg = args[index];
    if (!arg) {
      return false;
    }
    if (READONLY_GIT_BRANCH_FLAG_OPTIONS.has(arg)) {
      index += 1;
      continue;
    }
    if (arg === "--list") {
      allowListPatterns = true;
      index += 1;
      continue;
    }
    if (READONLY_GIT_BRANCH_QUERY_OPTIONS.has(arg)) {
      index += 1;
      const value = args[index];
      if (value && isReadonlyGitPositionalValue(value)) {
        index += 1;
      }
      continue;
    }
    if (allowListPatterns && isReadonlyGitPositionalValue(arg)) {
      index += 1;
      continue;
    }
    return false;
  }
  return true;
}

function consumeReadonlyGitTopLevelOptions(tokens: readonly string[]): number {
  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index];
    if (!token || !READONLY_GIT_TOP_LEVEL_OPTIONS.has(token)) {
      break;
    }
    index += 1;
  }
  return index;
}

function isReadonlyGitCommand(tokens: readonly string[]): boolean {
  if (tokens[0] !== "git") {
    return false;
  }
  const subcommandIndex = consumeReadonlyGitTopLevelOptions(tokens);
  const subcommand = tokens[subcommandIndex];
  if (!subcommand) {
    return false;
  }
  const args = tokens.slice(subcommandIndex + 1);

  switch (subcommand) {
    case "status":
      return areReadonlyGitArgs(args, READONLY_GIT_STATUS_OPTIONS, (arg) =>
        UNTRACKED_FILES_OPTION_PATTERN.test(arg),
      );
    case "diff":
      return areReadonlyGitArgs(args, READONLY_GIT_DIFF_OPTIONS, (arg) =>
        UNIFIED_DIFF_OPTION_PATTERN.test(arg),
      );
    case "show":
      return areReadonlyGitArgs(
        args,
        READONLY_GIT_SHOW_OPTIONS,
        (arg) =>
          RANGE_COUNT_OPTION_PATTERN.test(arg) ||
          FORMAT_OPTION_PATTERN.test(arg),
      );
    case "merge-base":
      return areReadonlyGitArgs(args, READONLY_GIT_MERGE_BASE_OPTIONS);
    case "log":
      return areReadonlyGitArgs(
        args,
        READONLY_GIT_LOG_OPTIONS,
        (arg) =>
          RANGE_COUNT_OPTION_PATTERN.test(arg) ||
          MAX_COUNT_OPTION_PATTERN.test(arg) ||
          FORMAT_OPTION_PATTERN.test(arg),
      );
    case "branch":
      return areReadonlyGitBranchArgs(args);
    case "ls-files":
      return areReadonlyGitArgs(args, READONLY_GIT_LS_FILES_OPTIONS);
    case "rev-parse":
      return areReadonlyGitArgs(args, READONLY_GIT_REV_PARSE_OPTIONS, (arg) =>
        ABBREV_OPTION_PATTERN.test(arg),
      );
    case "grep":
      return areReadonlyGitArgs(args, READONLY_GIT_GREP_OPTIONS);
    case "blame":
      return areReadonlyGitArgs(
        args,
        READONLY_GIT_BLAME_OPTIONS,
        (arg) =>
          ABBREV_OPTION_PATTERN.test(arg) ||
          DATE_OPTION_PATTERN.test(arg) ||
          BLAME_LINE_RANGE_PATTERN.test(arg),
      );
    default:
      return false;
  }
}

function parseReadonlyBashCommand(command: string): ReadonlyBashCommand | null {
  const tokens = tokenizeSimpleReadonlyShellCommand(command);
  if (!tokens) {
    return null;
  }
  if (
    tokens[0] === "pwd" &&
    (tokens.length === 1 ||
      (tokens.length === 2 && (tokens[1] === "-L" || tokens[1] === "-P")))
  ) {
    return {
      needsNoOptionalGitLocks: false,
      tokens,
    };
  }
  if (!isReadonlyGitCommand(tokens)) {
    return null;
  }
  return {
    needsNoOptionalGitLocks: !tokens.includes("--no-optional-locks"),
    tokens,
  };
}

export function buildReadonlyBashUpdatedInput(
  input: unknown,
): Record<string, unknown> | null {
  const parsed = bashToolInputSchema.safeParse(input);
  if (!parsed.success) {
    return null;
  }

  const readonlyCommand = parseReadonlyBashCommand(parsed.data.command);
  if (!readonlyCommand) {
    return null;
  }
  return {
    ...parsed.data,
    command: buildReadonlyBashCommand(readonlyCommand),
  };
}

function buildReadonlyBashCommand(
  readonlyCommand: ReadonlyBashCommand,
): string {
  const tokens = readonlyCommand.needsNoOptionalGitLocks
    ? withNoOptionalGitLocks(readonlyCommand.tokens)
    : [...readonlyCommand.tokens];
  return withGitDiffSafetyOptions(tokens).join(" ");
}

function withNoOptionalGitLocks(tokens: readonly string[]): string[] {
  return [tokens[0], "--no-optional-locks", ...tokens.slice(1)];
}

function withGitDiffSafetyOptions(tokens: readonly string[]): string[] {
  if (tokens[0] !== "git") {
    return [...tokens];
  }
  const subcommandIndex = consumeReadonlyGitTopLevelOptions(tokens);
  const subcommand = tokens[subcommandIndex];
  if (!subcommand || !READONLY_GIT_DIFF_SAFETY_SUBCOMMANDS.has(subcommand)) {
    return [...tokens];
  }
  const args = tokens.slice(subcommandIndex + 1);
  const pathspecSeparatorIndex = args.indexOf("--");
  const optionArgs =
    pathspecSeparatorIndex === -1
      ? args
      : args.slice(0, pathspecSeparatorIndex);
  const missingOptions = READONLY_GIT_DIFF_SAFETY_OPTIONS.filter(
    (option) => !optionArgs.includes(option),
  );
  if (missingOptions.length === 0) {
    return [...tokens];
  }
  return [
    ...tokens.slice(0, subcommandIndex + 1),
    ...missingOptions,
    ...tokens.slice(subcommandIndex + 1),
  ];
}
