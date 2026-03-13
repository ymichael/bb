type CommandOptionSpec = {
  positionalCount: number;
  optionsWithValues: Set<string>;
  flagOptions: Set<string>;
};

const THREAD_COMMAND_OPTION_SPECS: Record<
  string,
  CommandOptionSpec
> = {
  wait: {
    positionalCount: 1,
    optionsWithValues: new Set(["--status", "--event", "--timeout", "--poll-interval"]),
    flagOptions: new Set(),
  },
  sessions: {
    positionalCount: 1,
    optionsWithValues: new Set(),
    flagOptions: new Set(["--json"]),
  },
  status: {
    positionalCount: 1,
    optionsWithValues: new Set(["--recent-events", "--event-mode"]),
    flagOptions: new Set(["--include-low-signal", "--json"]),
  },
  show: {
    positionalCount: 1,
    optionsWithValues: new Set(),
    flagOptions: new Set(["--json"]),
  },
  archive: {
    positionalCount: 1,
    optionsWithValues: new Set(),
    flagOptions: new Set(["--force"]),
  },
  unarchive: {
    positionalCount: 1,
    optionsWithValues: new Set(),
    flagOptions: new Set(),
  },
  delete: {
    positionalCount: 1,
    optionsWithValues: new Set(),
    flagOptions: new Set(["--yes"]),
  },
  tell: {
    positionalCount: 2,
    optionsWithValues: new Set(),
    flagOptions: new Set(["--json"]),
  },
  steer: {
    positionalCount: 2,
    optionsWithValues: new Set(),
    flagOptions: new Set(),
  },
  commit: {
    positionalCount: 1,
    optionsWithValues: new Set(["--message"]),
    flagOptions: new Set(["--staged-only"]),
  },
  "squash-merge": {
    positionalCount: 1,
    optionsWithValues: new Set([
      "--commit-message",
      "--squash-message",
      "--merge-base-branch",
    ]),
    flagOptions: new Set(["--commit-if-needed", "--staged-only"]),
  },
  stop: {
    positionalCount: 1,
    optionsWithValues: new Set(),
    flagOptions: new Set(),
  },
  promote: {
    positionalCount: 1,
    optionsWithValues: new Set(),
    flagOptions: new Set(),
  },
  demote: {
    positionalCount: 1,
    optionsWithValues: new Set(["--project"]),
    flagOptions: new Set(),
  },
  log: {
    positionalCount: 1,
    optionsWithValues: new Set(),
    flagOptions: new Set(["--json"]),
  },
  output: {
    positionalCount: 1,
    optionsWithValues: new Set(),
    flagOptions: new Set(["--json"]),
  },
};

const MANAGER_COMMAND_OPTION_SPECS: Record<string, CommandOptionSpec> = {
  hire: {
    positionalCount: 1,
    optionsWithValues: new Set(),
    flagOptions: new Set(["--json"]),
  },
  show: {
    positionalCount: 1,
    optionsWithValues: new Set(),
    flagOptions: new Set(["--json"]),
  },
  status: {
    positionalCount: 1,
    optionsWithValues: new Set(),
    flagOptions: new Set(["--json"]),
  },
  threads: {
    positionalCount: 1,
    optionsWithValues: new Set(),
    flagOptions: new Set(["--json"]),
  },
  send: {
    positionalCount: 2,
    optionsWithValues: new Set(),
    flagOptions: new Set(["--json"]),
  },
  log: {
    positionalCount: 1,
    optionsWithValues: new Set(),
    flagOptions: new Set(["--json"]),
  },
  delete: {
    positionalCount: 1,
    optionsWithValues: new Set(),
    flagOptions: new Set(["--yes"]),
  },
};

function normalizeSubcommandArgs(
  args: string[],
  groupName: string,
  specs: Record<string, CommandOptionSpec>,
): string[] {
  if (args.length < 2) {
    return args;
  }

  const [group, subcommand, ...rest] = args;
  if (group !== groupName) {
    return args;
  }
  if (rest.includes("--")) {
    return args;
  }

  const spec = specs[subcommand];
  if (!spec) {
    return args;
  }

  const optionTokens: string[] = [];
  const positionalTokens: string[] = [];
  const trailingTokens: string[] = [];
  let sawDashPrefixedPositional = false;

  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (spec.flagOptions.has(value)) {
      optionTokens.push(value);
      continue;
    }
    if (spec.optionsWithValues.has(value)) {
      optionTokens.push(value);
      index += 1;
      if (index < rest.length) {
        optionTokens.push(rest[index]);
      }
      continue;
    }
    if (positionalTokens.length < spec.positionalCount) {
      positionalTokens.push(value);
      if (value.startsWith("-")) {
        sawDashPrefixedPositional = true;
      }
      continue;
    }
    trailingTokens.push(value);
  }

  if (!sawDashPrefixedPositional) {
    return args;
  }

  const normalized: string[] = [group, subcommand, ...optionTokens, "--", ...positionalTokens];
  if (trailingTokens.length > 0) {
    normalized.push(...trailingTokens);
  }
  return normalized;
}

export function normalizeCliArgv(argv: string[]): string[] {
  const [nodePath, scriptPath, ...args] = argv;
  if (args.length === 0) {
    return argv;
  }
  const threadNormalized = normalizeSubcommandArgs(
    args,
    "thread",
    THREAD_COMMAND_OPTION_SPECS,
  );
  const normalizedArgs = normalizeSubcommandArgs(
    threadNormalized,
    "manager",
    MANAGER_COMMAND_OPTION_SPECS,
  );
  return [nodePath, scriptPath, ...normalizedArgs];
}
