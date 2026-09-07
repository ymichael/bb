import type { BbPluginApi, PluginCliResult } from "@get-bb/plugin-sdk";
import { setTimeout as wait } from "node:timers/promises";
import {
  accountAddInputSchema,
  accountIdInputSchema,
  accountPriorityInputSchema,
  accountReorderInputSchema,
  accountPoolConfigSetInputSchema,
  bypassInputSchema,
  codexLoginPollInputSchema,
  loginCompleteInputSchema,
  tokenRotateInputSchema,
  routingSetInputSchema,
  type AccountPoolConfig,
  type AccountPoolConfigController,
  type AccountPoolConfigSetInput,
  type AccountSummary,
  type FamilyQuota,
  type LimitWindow,
  type ModelFamily,
  type PoolStatus,
} from "./contracts.js";
import type { PoolOperations } from "./operations.js";
import type { ClaudeOAuthLogin } from "./oauth-login.js";
import type { CodexDeviceLogin } from "./codex-device-login.js";

interface ParsedFlags {
  booleans: Set<string>;
  values: Map<string, string>;
}

const HELP = [
  "Usage:",
  "  bb pool account add --provider claude --import [--label <text>] [--priority <n>]",
  "  bb pool account add --provider codex --import [--label <text>] [--priority <n>]",
  "  bb pool account add --provider claude --login",
  "  bb pool account add --provider codex --login",
  "  bb pool account login-poll --session <id>",
  "  printf '%s\\n' \"$CLAUDE_AUTH_CODE\" | bb pool account login-complete --session <id> --code-stdin",
  "  bb pool account add --provider claude --api-key-stdin [--label <text>] [--priority <n>]",
  "  bb pool account add --provider claude --api-key <key> [--label <text>] [--priority <n>]  Unsafe: exposes the key in process arguments.",
  "  bb pool account list [--json]",
  "  bb pool account remove <id>",
  "  bb pool account enable <id>",
  "  bb pool account disable <id>",
  "  bb pool account priority <id> <n>",
  "  bb pool account reorder <claude|codex> <id>...",
  "  bb pool status [--json]",
  "  bb pool routing <claude|codex> [--off]",
  "  bb pool config",
  "  bb pool config set <anthropicUpstreamBaseUrl|codexUpstreamBaseUrl|switchThreshold> <value>",
  "  bb pool token rotate --machine <id-or-name>",
  "  bb pool bypass <thread-id> [--off]",
  "",
  "Accounts run sequentially by priority, then order added. The current fallback stays active until unavailable.",
  "Reorder includes every account for the provider and changes the next failover sequence; existing conversations stay pinned.",
].join("\n");

function parseFlags(
  argv: readonly string[],
  allowedBooleans: readonly string[],
  allowedValues: readonly string[],
): ParsedFlags {
  const booleans = new Set<string>();
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined || !arg.startsWith("--")) {
      throw new Error(`Unexpected argument ${JSON.stringify(arg)}.`);
    }
    const name = arg.slice(2);
    if (booleans.has(name) || values.has(name)) {
      throw new Error(`Duplicate flag --${name}.`);
    }
    if (allowedBooleans.includes(name)) {
      booleans.add(name);
      continue;
    }
    if (!allowedValues.includes(name))
      throw new Error(`Unknown flag --${name}.`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`--${name} requires a value.`);
    }
    values.set(name, value);
    index += 1;
  }
  return { booleans, values };
}

function formatReset(value: number | null): string {
  return value === null ? "-" : new Date(value).toISOString();
}

function formatUtilization(value: number | null): string {
  return value === null ? "-" : `${Math.round(value * 100)}%`;
}

const MODEL_FAMILIES: ModelFamily[] = [
  "fable",
  "sonnet",
  "opus",
  "haiku",
  "other",
];

function familyLabel(family: ModelFamily): string {
  return family[0]?.toUpperCase() + family.slice(1);
}

function formatWindowLabel(window: LimitWindow): string {
  if (window.windowMinutes === null) return window.slot;
  if (window.windowMinutes % 1_440 === 0)
    return `${window.windowMinutes / 1_440}d`;
  if (window.windowMinutes % 60 === 0) return `${window.windowMinutes / 60}h`;
  return `${window.windowMinutes}m`;
}

function formatLimitWindows(windows: readonly LimitWindow[]): string {
  if (windows.length === 0) return "-";
  return windows
    .map(
      (window) =>
        `${formatWindowLabel(window)}=${formatUtilization(window.utilization)} ${formatReset(window.resetAt)}`,
    )
    .join("; ");
}

function formatFamilyQuota(quota: FamilyQuota | null): string {
  if (quota === null) return "-";
  return [
    formatUtilization(quota.utilization),
    quota.status ?? "-",
    formatReset(quota.resetAt),
    quota.source,
  ].join(" ");
}

function formatAccounts(accounts: readonly AccountSummary[]): string {
  if (accounts.length === 0) return "No accounts configured.";
  const families = MODEL_FAMILIES.filter((family) =>
    accounts.some((account) => account.familyWeekly[family] !== null),
  );
  return [
    [
      "ID",
      "Label",
      "Provider",
      "Kind",
      "Enabled",
      "Priority",
      "5h",
      "5h reset",
      "7d",
      "7d reset",
      "Windows",
      ...families.map(familyLabel),
      "Status",
    ].join("\t"),
    ...accounts.map((account) =>
      [
        account.id,
        account.label,
        account.provider,
        account.kind,
        String(account.enabled),
        String(account.priority),
        formatUtilization(account.fiveHourUtilization),
        formatReset(account.fiveHourResetAt),
        formatUtilization(account.sevenDayUtilization),
        formatReset(account.sevenDayResetAt),
        formatLimitWindows(account.limitWindows),
        ...families.map((family) =>
          formatFamilyQuota(account.familyWeekly[family]),
        ),
        account.status,
      ].join("\t"),
    ),
  ].join("\n");
}

function formatStatus(status: PoolStatus): string {
  return [
    `Route: ${status.route}`,
    `Accepting: ${status.accepting}`,
    `Enabled accounts: ${status.enabledAccountCount}`,
    `In flight: ${status.inFlight}`,
    "",
    "Machine tokens:",
    ...(status.hosts.length === 0
      ? ["None minted."]
      : status.hosts.map(
          (host) =>
            `${host.hostName ?? host.hostId}\t${new Date(host.mintedAt).toISOString()}\t${host.lastUsedAt === null ? "never" : new Date(host.lastUsedAt).toISOString()}`,
        )),
    "",
    "Recently routed threads without a local Claude login:",
    ...(status.routedThreadsWithoutLocalLogin.length === 0
      ? ["None."]
      : status.routedThreadsWithoutLocalLogin.map(
          (thread) =>
            `${thread.threadId}\t${thread.hostName ?? thread.hostId}\t${thread.localClaudeStatus}`,
        )),
    "",
    formatAccounts(status.accounts),
  ].join("\n");
}

function formatConfig(config: AccountPoolConfig): string {
  return [
    `anthropicUpstreamBaseUrl: ${config.anthropicUpstreamBaseUrl}`,
    `codexUpstreamBaseUrl: ${config.codexUpstreamBaseUrl}`,
    `switchThreshold: ${config.switchThreshold}`,
  ].join("\n");
}

function parseConfigUpdate(
  key: string | undefined,
  value: string | undefined,
): AccountPoolConfigSetInput {
  if (value === undefined) throw new Error(HELP);
  if (key === "anthropicUpstreamBaseUrl") {
    return accountPoolConfigSetInputSchema.parse({
      anthropicUpstreamBaseUrl: value,
    });
  }
  if (key === "codexUpstreamBaseUrl") {
    return accountPoolConfigSetInputSchema.parse({
      codexUpstreamBaseUrl: value,
    });
  }
  if (key === "switchThreshold") {
    return accountPoolConfigSetInputSchema.parse({
      switchThreshold: Number(value),
    });
  }
  throw new Error(
    "Config key must be anthropicUpstreamBaseUrl, codexUpstreamBaseUrl, or switchThreshold.",
  );
}

function json(value: object): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function registerPoolCli(
  bb: Pick<BbPluginApi, "cli">,
  operations: PoolOperations,
  login: ClaudeOAuthLogin,
  codexLogin: CodexDeviceLogin,
  config: AccountPoolConfigController,
): void {
  bb.cli.register({
    name: "pool",
    summary:
      "Manage Claude and Codex accounts and inspect the Account Pooler hub",
    commands: [
      {
        name: "account-add",
        summary:
          "Sign in to Claude or Codex, import credentials, or add an Anthropic API key",
        usage:
          "bb pool account add --provider <claude|codex> --login\nbb pool account add --provider <claude|codex> --import [--label <text>] [--priority <n>]\nbb pool account add --provider claude --api-key-stdin [--label <text>] [--priority <n>]\nUnsafe compatibility form: bb pool account add --provider claude --api-key <key> [--label <text>] [--priority <n>]",
      },
      {
        name: "account-login-poll",
        summary: "Wait for a Codex device-code login to complete",
        usage: "bb pool account login-poll --session <id>",
      },
      {
        name: "account-login-complete",
        summary: "Complete a Claude browser login with its manual code",
        usage:
          "printf '%s\\n' \"$CLAUDE_AUTH_CODE\" | bb pool account login-complete --session <id> --code-stdin",
      },
      {
        name: "account-list",
        summary: "List pool accounts and observed quota",
        usage: "bb pool account list [--json]",
      },
      {
        name: "account-remove",
        summary: "Remove an account and its secret token file",
        usage: "bb pool account remove <id>",
      },
      {
        name: "account-enable",
        summary: "Enable an account",
        usage: "bb pool account enable <id>",
      },
      {
        name: "account-disable",
        summary: "Disable an account",
        usage: "bb pool account disable <id>",
      },
      {
        name: "account-priority",
        summary: "Set an account's position in the failover priority order",
        usage: "bb pool account priority <id> <n>",
      },
      {
        name: "account-reorder",
        summary: "Set the complete failover order for one provider",
        usage: "bb pool account reorder <claude|codex> <id>...",
      },
      {
        name: "status",
        summary: "Show hub, machine token, routing, and account status",
        usage: "bb pool status [--json]",
      },
      {
        name: "routing",
        summary: "Enable or disable pooled routing for one provider",
        usage: "bb pool routing <claude|codex> [--off]",
      },
      {
        name: "config",
        summary: "Show Account Pooler routing configuration",
        usage: "bb pool config",
      },
      {
        name: "config-set",
        summary: "Update one Account Pooler routing configuration value",
        usage:
          "bb pool config set <anthropicUpstreamBaseUrl|codexUpstreamBaseUrl|switchThreshold> <value>",
      },
      {
        name: "token-rotate",
        summary: "Rotate one machine's Account Pooler bearer token",
        usage: "bb pool token rotate --machine <id-or-name>",
      },
      {
        name: "bypass",
        summary: "Bypass Account Pooler routing for one thread",
        usage: "bb pool bypass <thread-id> [--off]",
      },
    ],
    async run(argv, ctx): Promise<PluginCliResult> {
      try {
        if (argv.includes("--help") || argv.includes("-h")) {
          return { exitCode: 0, stdout: `${HELP}\n` };
        }
        if (argv[0] === "account" && argv[1] === "priority") {
          if (argv.length !== 4 || argv[3]?.trim() === "")
            throw new Error(HELP);
          const input = accountPriorityInputSchema.parse({
            accountId: argv[2],
            priority: Number(argv[3]),
          });
          const account = await operations.setPriority(
            input.accountId,
            input.priority,
          );
          if (account === null) throw new Error("Account not found.");
          return {
            exitCode: 0,
            stdout: `Set ${account.label} priority to ${account.priority}.\n`,
          };
        }
        if (argv[0] === "account" && argv[1] === "reorder") {
          const input = accountReorderInputSchema.parse({
            provider: argv[2],
            accountIds: argv.slice(3),
          });
          await operations.reorder(input.provider, input.accountIds);
          return {
            exitCode: 0,
            stdout: `Updated ${input.provider} account order.\n`,
          };
        }
        if (argv[0] === "account" && argv[1] === "add") {
          const flags = parseFlags(
            argv.slice(2),
            ["import", "api-key-stdin", "login"],
            ["provider", "api-key", "label", "priority"],
          );
          const imported = flags.booleans.has("import");
          const apiKeyStdin = flags.booleans.has("api-key-stdin");
          const loginRequested = flags.booleans.has("login");
          const apiKey = flags.values.get("api-key");
          const sourceCount =
            Number(imported) +
            Number(apiKeyStdin) +
            Number(loginRequested) +
            Number(apiKey !== undefined);
          if (sourceCount !== 1)
            throw new Error(
              "Choose exactly one of --login, --import, --api-key-stdin, or --api-key <key>.",
            );
          if (loginRequested) {
            const provider = flags.values.get("provider");
            if (provider !== "claude" && provider !== "codex") {
              throw new Error(
                "--login requires --provider claude or --provider codex.",
              );
            }
            if (flags.values.has("label") || flags.values.has("priority")) {
              throw new Error("--login does not accept --label or --priority.");
            }
            if (provider === "codex") {
              const started = await codexLogin.start();
              return {
                exitCode: 0,
                stdout: `${[
                  "Open this URL to sign in to Codex:",
                  started.verificationUri,
                  "",
                  `Enter this code: ${started.userCode}`,
                  `Session ID: ${started.sessionId}`,
                  "",
                  "After authorizing, wait for the account to be added with:",
                  `bb pool account login-poll --session ${started.sessionId}`,
                ].join("\n")}\n`,
              };
            }
            const started = login.start();
            return {
              exitCode: 0,
              stdout: `${[
                "Open this URL to sign in to Claude:",
                started.authorizeUrl,
                "",
                `Session ID: ${started.sessionId}`,
                "",
                "After signing in, pipe the code shown on the final page into:",
                `printf '%s\\n' \"$CLAUDE_AUTH_CODE\" | bb pool account login-complete --session ${started.sessionId} --code-stdin`,
              ].join("\n")}\n`,
            };
          }
          if (apiKeyStdin) {
            throw new Error(
              "--api-key-stdin must be invoked through the bb CLI so it can read stdin safely.",
            );
          }
          if (!imported && flags.values.get("provider") !== "claude") {
            throw new Error("Anthropic API keys require --provider claude.");
          }
          const priorityText = flags.values.get("priority") ?? "100";
          const input = accountAddInputSchema.parse({
            provider: flags.values.get("provider"),
            source: imported ? { kind: "import" } : { kind: "api-key", apiKey },
            label: flags.values.get("label") ?? null,
            priority: Number(priorityText),
          });
          const account = await operations.add(input);
          return {
            exitCode: 0,
            stdout: `Added ${account.label} (${account.id}).\n`,
          };
        }
        if (argv[0] === "account" && argv[1] === "login-poll") {
          const flags = parseFlags(argv.slice(2), [], ["session"]);
          const input = codexLoginPollInputSchema.parse({
            sessionId: flags.values.get("session"),
          });
          const signal = ctx.signal;
          const cancel = () => codexLogin.cancel(input);
          signal?.addEventListener("abort", cancel, { once: true });
          try {
            if (signal?.aborted) {
              cancel();
              throw signal.reason ?? new Error("Codex login was cancelled.");
            }
            while (true) {
              await wait(
                codexLogin.nextPollDelayMs(input.sessionId),
                undefined,
                { signal },
              );
              const result = await codexLogin.poll(input);
              if (signal?.aborted) {
                throw signal.reason ?? new Error("Codex login was cancelled.");
              }
              if (result.status === "complete") {
                return {
                  exitCode: 0,
                  stdout: `Added ${result.account.label} (${result.account.id}).\n`,
                };
              }
              if (result.status === "error") {
                throw new Error(result.message);
              }
            }
          } catch (error) {
            if (signal?.aborted) codexLogin.cancel(input);
            throw error;
          } finally {
            signal?.removeEventListener("abort", cancel);
          }
        }
        if (argv[0] === "account" && argv[1] === "login-complete") {
          const flags = parseFlags(
            argv.slice(2),
            ["code-stdin"],
            ["session", "code"],
          );
          if (flags.booleans.has("code-stdin")) {
            throw new Error(
              "--code-stdin requires the current bb CLI so it can read stdin safely.",
            );
          }
          const input = loginCompleteInputSchema.parse({
            sessionId: flags.values.get("session"),
            pasted: flags.values.get("code"),
          });
          const account = await login.complete(input);
          return {
            exitCode: 0,
            stdout: `Added ${account.label} (${account.id}).\n`,
          };
        }
        if (argv[0] === "account" && argv[1] === "list") {
          const flags = parseFlags(argv.slice(2), ["json"], []);
          const accounts = await operations.list();
          return {
            exitCode: 0,
            stdout: flags.booleans.has("json")
              ? json({ accounts })
              : `${formatAccounts(accounts)}\n`,
          };
        }
        if (
          argv[0] === "account" &&
          ["remove", "enable", "disable"].includes(argv[1] ?? "")
        ) {
          if (argv.length !== 3) throw new Error(HELP);
          const { id } = accountIdInputSchema.parse({ id: argv[2] });
          if (argv[1] === "remove") {
            const removed = await operations.remove(id);
            if (!removed) throw new Error(`Account ${id} does not exist.`);
            return { exitCode: 0, stdout: `Removed ${id}.\n` };
          }
          const account =
            argv[1] === "enable"
              ? await operations.enable(id)
              : await operations.disable(id);
          if (account === null)
            throw new Error(`Account ${id} does not exist.`);
          return {
            exitCode: 0,
            stdout: `${argv[1] === "enable" ? "Enabled" : "Disabled"} ${id}.\n`,
          };
        }
        if (argv[0] === "status") {
          const flags = parseFlags(argv.slice(1), ["json"], []);
          const status = await operations.status();
          return {
            exitCode: 0,
            stdout: flags.booleans.has("json")
              ? json(status)
              : `${formatStatus(status)}\n`,
          };
        }
        if (argv[0] === "routing") {
          const flags = parseFlags(argv.slice(2), ["off"], []);
          const input = routingSetInputSchema.parse({
            provider: argv[1],
            enabled: !flags.booleans.has("off"),
          });
          await operations.setRouting(input.provider, input.enabled);
          return {
            exitCode: 0,
            stdout: `${input.enabled ? "Enabled" : "Disabled"} ${input.provider} Account Pooler routing.\n`,
          };
        }
        if (argv[0] === "config" && argv.length === 1) {
          return { exitCode: 0, stdout: `${formatConfig(config.get())}\n` };
        }
        if (argv[0] === "config" && argv[1] === "set") {
          if (argv.length !== 4) throw new Error(HELP);
          const next = await config.set(parseConfigUpdate(argv[2], argv[3]));
          return { exitCode: 0, stdout: `${formatConfig(next)}\n` };
        }
        if (argv[0] === "token" && argv[1] === "rotate") {
          const flags = parseFlags(argv.slice(2), [], ["machine"]);
          const { machine } = tokenRotateInputSchema.parse({
            machine: flags.values.get("machine"),
          });
          const token = await operations.rotateToken(machine);
          return {
            exitCode: 0,
            stdout: `Rotated the Account Pooler token for ${token.hostName ?? token.hostId}.\n`,
          };
        }
        if (argv[0] === "bypass") {
          const threadId = argv[1];
          if (threadId === undefined) throw new Error(HELP);
          const flags = parseFlags(argv.slice(2), ["off"], []);
          const input = bypassInputSchema.parse({
            threadId,
            bypassed: !flags.booleans.has("off"),
          });
          const result = await operations.setBypass(
            input.threadId,
            input.bypassed,
          );
          return {
            exitCode: 0,
            stdout: `${result.bypassed ? "Enabled" : "Disabled"} Account Pooler bypass for ${result.threadId}.\n`,
          };
        }
        throw new Error(HELP);
      } catch (error) {
        return {
          exitCode: 1,
          stderr: `${error instanceof Error ? error.message : String(error)}\n`,
        };
      }
    },
  });
}
