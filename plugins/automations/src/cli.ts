import { extname, isAbsolute, resolve } from "node:path";
import type {
  BbPluginApi,
  PluginCliContext,
  PluginCliResult,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { AutomationService } from "./service.js";
import type {
  AgentEnvironment,
  AgentExecutionUpdate,
  AutomationReadProblem,
  AutomationReadResult,
  AutomationResponse,
  AutomationRunResponse,
  AutomationScriptInterpreter,
  CreateAutomationInput,
  PermissionMode,
  ReasoningLevel,
  ResolvedCreateAutomationInput,
  ServiceTier,
  UpdateAutomationInput,
} from "./rpc-types.js";
import {
  providerRoutingForEnvironment,
  resolvePermissionMode,
} from "./provider-permissions.js";
import {
  AUTOMATION_SCRIPT_TIMEOUT_DEFAULT_MS,
  automationScriptInterpreterSchema,
} from "./rpc-types.js";

const DURATION_PATTERN =
  /^(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/iu;
const hostListSchema = z.array(
  z
    .object({
      id: z.string().optional(),
      status: z.string().optional(),
      connected: z.boolean().optional(),
    })
    .passthrough(),
);

interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg.startsWith("--")) {
      const [rawName, inlineValue] = arg.slice(2).split(/=(.*)/s, 2);
      if (!rawName) throw new Error(`Invalid flag ${arg}`);
      if (inlineValue !== undefined) {
        flags.set(rawName, inlineValue);
        continue;
      }
      const next = rest[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(rawName, next);
        index += 1;
      } else {
        flags.set(rawName, true);
      }
    } else {
      positionals.push(arg);
    }
  }
  return { command, positionals, flags };
}

function flag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  if (value === undefined || value === true) return undefined;
  return value;
}

function boolFlag(args: ParsedArgs, name: string): boolean {
  return args.flags.has(name);
}

function requireFlag(args: ParsedArgs, name: string): string {
  const value = flag(args, name);
  if (!value) throw new Error(`Missing required option --${name} <value>.`);
  return value;
}

function optionalJson(args: ParsedArgs, value: unknown): string | null {
  return boolFlag(args, "json") ? `${JSON.stringify(value, null, 2)}\n` : null;
}

function parseRunAt(value: string): number {
  const runAt = Date.parse(value);
  if (!Number.isFinite(runAt)) {
    throw new Error("--at must be a valid date/time, preferably ISO 8601.");
  }
  if (runAt <= Date.now()) throw new Error("--at must be in the future.");
  return runAt;
}

function parseRunIn(value: string): number {
  const match = DURATION_PATTERN.exec(value.trim());
  if (!match)
    throw new Error("--in must be a duration like 30s, 5m, 2h, or 1d.");
  const amount = Number.parseInt(match[1] ?? "", 10);
  if (amount <= 0) throw new Error("--in must be greater than zero.");
  const unit = (match[2] ?? "").toLowerCase();
  const multiplier = unit.startsWith("s")
    ? 1_000
    : unit.startsWith("m")
      ? 60_000
      : unit.startsWith("h")
        ? 60 * 60_000
        : 24 * 60 * 60_000;
  return Date.now() + amount * multiplier;
}

function buildTrigger(args: ParsedArgs): CreateAutomationInput["trigger"] {
  const cron = flag(args, "cron");
  const at = flag(args, "at");
  const runIn = flag(args, "in");
  const triggerFlags = [
    cron !== undefined,
    at !== undefined,
    runIn !== undefined,
  ].filter(Boolean).length;
  if (triggerFlags !== 1) {
    throw new Error(
      "Provide exactly one schedule flag: --cron, --at, or --in.",
    );
  }
  if (cron !== undefined) {
    const timezone = flag(args, "timezone");
    if (!timezone) throw new Error("--cron requires --timezone.");
    return { triggerType: "schedule", cron, timezone };
  }
  if (flag(args, "timezone") !== undefined) {
    throw new Error("--timezone is only used with --cron.");
  }
  if (at !== undefined) return { triggerType: "once", runAt: parseRunAt(at) };
  if (runIn !== undefined)
    return { triggerType: "once", runAt: parseRunIn(runIn) };
  throw new Error("Provide exactly one schedule flag: --cron, --at, or --in.");
}

function parsePermissionMode(
  value: string | undefined,
): PermissionMode | undefined {
  if (value === undefined) return undefined;
  if (value === "accept-edits" || value === "auto" || value === "full") {
    return value;
  }
  throw new Error(
    "Invalid --permission-mode. Expected accept-edits, auto, or full.",
  );
}

function parseReasoningLevel(value: string): ReasoningLevel {
  if (
    value === "none" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "ultracode" ||
    value === "max" ||
    value === "ultra"
  ) {
    return value;
  }
  throw new Error(
    "Invalid --reasoning. Expected none, low, medium, high, xhigh, ultracode, max, or ultra.",
  );
}

function parseServiceTier(value: string): ServiceTier | null {
  if (value === "default" || value === "fast") return value;
  if (value === "none") return null;
  throw new Error("Invalid --service-tier. Expected default, fast, or none.");
}

function validateAgentTargetOptions(args: ParsedArgs): void {
  const targetOptionNames = [
    "target-thread",
    "environment",
    "new-environment",
  ] as const;
  const providedTargetOptions = targetOptionNames.filter((name) =>
    args.flags.has(name),
  );
  for (const name of providedTargetOptions) {
    if (!flag(args, name)) {
      throw new Error(`Missing required option --${name} <value>.`);
    }
  }
  if (providedTargetOptions.length > 1) {
    throw new Error(
      "Cannot combine target options: --target-thread, --environment, and --new-environment.",
    );
  }
  if (args.flags.has("base-branch") && !args.flags.has("new-environment")) {
    throw new Error("--base-branch requires --new-environment worktree.");
  }
}

function parseScriptInterpreter(
  value: string | undefined,
): AutomationScriptInterpreter | undefined {
  if (value === undefined) return undefined;
  const parsed = automationScriptInterpreterSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new Error(
    "Invalid --interpreter. Expected bash, sh, node, or python3.",
  );
}

const INTERPRETER_BY_EXTENSION: Record<string, AutomationScriptInterpreter> = {
  ".sh": "bash",
  ".bash": "bash",
  ".js": "node",
  ".mjs": "node",
  ".py": "python3",
};

function inferInterpreterFromPath(
  filePath: string,
): AutomationScriptInterpreter | undefined {
  return INTERPRETER_BY_EXTENSION[extname(filePath).toLowerCase()];
}

function parseTimeoutMs(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      "--timeout must be a positive integer number of milliseconds.",
    );
  }
  return parsed;
}

function parseScriptEnv(
  value: string | undefined,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new Error("--env-json must be a JSON object of string values.");
  }
  const parsed = z.record(z.string(), z.string()).safeParse(decoded);
  if (!parsed.success) {
    throw new Error("--env-json must be a JSON object of string values.");
  }
  return parsed.data;
}

function looksLikePath(value: string): boolean {
  return value.includes("/") || value.startsWith(".") || value.startsWith("~");
}

async function resolveConnectedHostId(
  bb: Pick<BbPluginApi, "sdk">,
): Promise<string> {
  const hosts = hostListSchema.parse(await bb.sdk.hosts.list());
  const host =
    hosts.find((candidate) => candidate.connected === true) ??
    hosts.find((candidate) => candidate.status === "connected") ??
    hosts[0];
  if (!host?.id) throw new Error("No connected host is available.");
  return host.id;
}

async function buildAgentEnvironment(
  bb: Pick<BbPluginApi, "sdk">,
  args: ParsedArgs,
): Promise<AgentEnvironment> {
  const environment = flag(args, "environment")?.trim();
  const newEnvironment = flag(args, "new-environment")?.trim();
  const baseBranch = flag(args, "base-branch")?.trim();
  if (environment && newEnvironment) {
    throw new Error("Cannot combine --environment with --new-environment.");
  }
  if (newEnvironment) {
    if (newEnvironment !== "worktree") {
      throw new Error(
        `Unknown environment kind '${newEnvironment}'. Supported: worktree.`,
      );
    }
    return {
      type: "host",
      hostId: await resolveConnectedHostId(bb),
      workspace: {
        type: "managed-worktree",
        baseBranch: baseBranch
          ? { kind: "named", name: baseBranch }
          : { kind: "default" },
      },
    };
  }
  if (!environment) return { type: "project-default" };
  if (looksLikePath(environment)) {
    return {
      type: "host",
      hostId: await resolveConnectedHostId(bb),
      workspace: { type: "unmanaged", path: environment },
    };
  }
  return { type: "reuse", environmentId: environment };
}

const scriptFileHostListSchema = z.array(
  z.object({ id: z.string().min(1), name: z.string().min(1) }).passthrough(),
);
const threadEnvironmentHostSchema = z
  .object({
    environment: z
      .object({ hostId: z.string().min(1) })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

async function resolveScriptFileHostId(
  bb: Pick<BbPluginApi, "sdk">,
  ctx: Pick<PluginCliContext, "threadId">,
  override: string | undefined,
): Promise<string | undefined> {
  if (override !== undefined) {
    const query = override.trim();
    if (query.length === 0) throw new Error("--host requires a name or id.");
    const hosts = scriptFileHostListSchema.parse(await bb.sdk.hosts.list());
    const idMatch = hosts.find((host) => host.id === query);
    if (idMatch) return idMatch.id;
    const nameMatches = hosts.filter(
      (host) => host.name.toLocaleLowerCase() === query.toLocaleLowerCase(),
    );
    if (nameMatches.length === 1) return nameMatches[0]!.id;
    if (nameMatches.length > 1) {
      throw new Error(
        `Host name "${query}" is ambiguous; pass one of these ids: ${nameMatches
          .map((host) => host.id)
          .join(", ")}`,
      );
    }
    throw new Error(
      `Unknown host "${query}"; run \`bb machine list\` to list hosts.`,
    );
  }
  if (ctx.threadId === undefined) return undefined;
  const thread = threadEnvironmentHostSchema.parse(
    await bb.sdk.threads.get({
      threadId: ctx.threadId,
      include: "environment",
    }),
  );
  if (!thread.environment) {
    throw new Error(
      `Thread ${ctx.threadId} has no environment, so the --script-file host cannot be resolved; pass --host <name-or-id>.`,
    );
  }
  return thread.environment.hostId;
}

type ScriptFileSource = {
  path: string;
  hostId: string | undefined;
  content: string;
};

async function loadScriptFileSource(
  bb: Pick<BbPluginApi, "sdk">,
  args: ParsedArgs,
  ctx: Pick<PluginCliContext, "cwd" | "threadId">,
): Promise<ScriptFileSource | undefined> {
  const scriptFile = flag(args, "script-file");
  const hostOverride = flag(args, "host");
  if (scriptFile === undefined) {
    if (hostOverride !== undefined) {
      throw new Error("--host requires --script-file.");
    }
    return undefined;
  }
  let path: string;
  if (isAbsolute(scriptFile)) {
    path = scriptFile;
  } else {
    if (ctx.cwd === undefined || !isAbsolute(ctx.cwd)) {
      throw new Error(
        "Relative --script-file paths need the invoking CLI cwd; pass an absolute path.",
      );
    }
    path = resolve(ctx.cwd, scriptFile);
  }
  const hostId = await resolveScriptFileHostId(bb, ctx, hostOverride);
  const file = await bb.sdk.files.read({
    ...(hostId !== undefined ? { hostId } : {}),
    path,
  });
  if (file.contentEncoding !== "utf8") {
    throw new Error(`--script-file is not UTF-8 text: ${path}`);
  }
  return { path, hostId, content: file.content };
}

type BuiltExecution = {
  execution: ResolvedCreateAutomationInput["execution"];
  scriptSource?: ScriptFileSource;
};

async function buildExecution(
  bb: Pick<BbPluginApi, "sdk">,
  args: ParsedArgs,
  ctx: Pick<PluginCliContext, "cwd" | "threadId">,
): Promise<BuiltExecution> {
  const prompt = flag(args, "prompt");
  const script = flag(args, "script");
  const scriptFile = flag(args, "script-file");
  const hasAgent = prompt !== undefined;
  const hasScript = script !== undefined || scriptFile !== undefined;
  if (hasAgent && hasScript) {
    throw new Error(
      "Provide either agent flags (--prompt) or script flags (--script/--script-file), not both.",
    );
  }
  if (
    hasAgent &&
    (args.flags.has("interpreter") ||
      args.flags.has("timeout") ||
      args.flags.has("env-json"))
  ) {
    throw new Error(
      "Agent automations do not accept --interpreter, --timeout, or --env-json.",
    );
  }
  if (!hasAgent && !hasScript) {
    throw new Error(
      "Provide an execution mode: agent (--prompt --provider --model) or script (--script-file <path> or --script <inline>).",
    );
  }
  if (hasAgent) {
    const provider = flag(args, "provider");
    const model = flag(args, "model");
    if (!provider || !model) {
      throw new Error(
        "Agent automations require --provider and --model alongside --prompt.",
      );
    }
    validateAgentTargetOptions(args);
    const environment = await buildAgentEnvironment(bb, args);
    const reasoning = flag(args, "reasoning");
    const serviceTier = flag(args, "service-tier");
    const parsedServiceTier =
      serviceTier === undefined ? undefined : parseServiceTier(serviceTier);
    return {
      execution: {
        mode: "agent",
        prompt,
        providerId: provider,
        model,
        reasoningLevel:
          reasoning === undefined ? "medium" : parseReasoningLevel(reasoning),
        ...(parsedServiceTier === null || parsedServiceTier === undefined
          ? {}
          : { serviceTier: parsedServiceTier }),
        permissionMode: await resolvePermissionMode(
          bb,
          provider,
          parsePermissionMode(flag(args, "permission-mode")),
          providerRoutingForEnvironment(environment),
        ),
        environment,
        ...(flag(args, "target-thread")
          ? { targetThreadId: flag(args, "target-thread") }
          : {}),
      },
    };
  }
  if (
    args.flags.has("provider") ||
    args.flags.has("model") ||
    args.flags.has("reasoning") ||
    args.flags.has("service-tier") ||
    args.flags.has("permission-mode") ||
    args.flags.has("target-thread") ||
    args.flags.has("environment") ||
    args.flags.has("new-environment") ||
    args.flags.has("base-branch")
  ) {
    throw new Error("Script automations do not accept agent execution flags.");
  }
  if (script !== undefined && scriptFile !== undefined) {
    throw new Error("Provide exactly one of --script or --script-file.");
  }
  const explicitInterpreter = parseScriptInterpreter(flag(args, "interpreter"));
  const timeoutMs = parseTimeoutMs(flag(args, "timeout"));
  const env = parseScriptEnv(flag(args, "env-json"));
  const scriptSource = await loadScriptFileSource(bb, args, ctx);
  const content = scriptSource ? scriptSource.content : script;
  if (!content) throw new Error("Missing script content.");
  const interpreter =
    explicitInterpreter ??
    (scriptSource ? inferInterpreterFromPath(scriptSource.path) : undefined);
  return {
    execution: {
      mode: "script",
      script: content,
      ...(scriptSource ? { scriptFile: scriptSource.path } : {}),
      ...(interpreter ? { interpreter } : {}),
      timeoutMs: timeoutMs ?? AUTOMATION_SCRIPT_TIMEOUT_DEFAULT_MS,
      ...(env ? { env } : {}),
    },
    ...(scriptSource ? { scriptSource } : {}),
  };
}

const COMPLETE_EXECUTION_FLAG_NAMES = [
  "script",
  "script-file",
  "interpreter",
  "timeout",
  "env-json",
] as const;

async function buildAgentExecutionUpdate(
  bb: Pick<BbPluginApi, "sdk">,
  args: ParsedArgs,
): Promise<AgentExecutionUpdate | undefined> {
  const agentOptionNames = [
    "prompt",
    "provider",
    "model",
    "reasoning",
    "service-tier",
    "permission-mode",
    "target-thread",
    "environment",
    "new-environment",
    "base-branch",
  ] as const;
  if (!agentOptionNames.some((name) => args.flags.has(name))) return undefined;

  validateAgentTargetOptions(args);
  const update: AgentExecutionUpdate = {};
  if (args.flags.has("prompt")) update.prompt = requireFlag(args, "prompt");
  if (args.flags.has("provider")) {
    update.providerId = requireFlag(args, "provider");
  }
  if (args.flags.has("model")) update.model = requireFlag(args, "model");
  if (args.flags.has("reasoning")) {
    update.reasoningLevel = parseReasoningLevel(requireFlag(args, "reasoning"));
  }
  if (args.flags.has("service-tier")) {
    update.serviceTier = parseServiceTier(requireFlag(args, "service-tier"));
  }
  if (args.flags.has("permission-mode")) {
    update.permissionMode = parsePermissionMode(
      requireFlag(args, "permission-mode"),
    );
  }
  if (args.flags.has("target-thread")) {
    update.target = {
      type: "target-thread",
      threadId: requireFlag(args, "target-thread"),
    };
  } else if (
    args.flags.has("environment") ||
    args.flags.has("new-environment")
  ) {
    update.target = {
      type: "environment",
      environment: await buildAgentEnvironment(bb, args),
    };
  }
  return update;
}

async function buildUpdateRequest(
  bb: Pick<BbPluginApi, "sdk">,
  args: ParsedArgs,
  ctx: Pick<PluginCliContext, "cwd" | "threadId">,
): Promise<{
  request: UpdateAutomationInput;
  scriptSource?: ScriptFileSource;
}> {
  const projectId = requireFlag(args, "project");
  const automationId = args.positionals[0];
  if (!automationId) throw new Error("Missing automationId.");
  const request: UpdateAutomationInput = { projectId, automationId };
  const name = flag(args, "name");
  if (name !== undefined) request.name = name;
  if (
    flag(args, "cron") !== undefined ||
    flag(args, "timezone") !== undefined ||
    flag(args, "at") !== undefined ||
    flag(args, "in") !== undefined
  ) {
    request.trigger = buildTrigger(args);
  }
  let scriptSource: ScriptFileSource | undefined;
  const replacesAgentExecution =
    args.flags.has("prompt") &&
    args.flags.has("provider") &&
    args.flags.has("model");
  if (
    replacesAgentExecution ||
    COMPLETE_EXECUTION_FLAG_NAMES.some((name) => args.flags.has(name))
  ) {
    const built = await buildExecution(bb, args, ctx);
    request.execution = built.execution;
    scriptSource = built.scriptSource;
  } else {
    const agentUpdate = await buildAgentExecutionUpdate(bb, args);
    if (agentUpdate !== undefined) {
      request.agent = agentUpdate;
    }
  }
  if (
    request.name === undefined &&
    request.trigger === undefined &&
    request.execution === undefined &&
    request.agent === undefined
  ) {
    throw new Error(
      "No changes requested. Provide --name, schedule flags, a complete agent/script execution, or partial agent update flags.",
    );
  }
  return { request, ...(scriptSource ? { scriptSource } : {}) };
}

function formatTimestamp(value: number | null): string {
  return value === null ? "-" : new Date(value).toLocaleString();
}

function formatAutomationTrigger(automation: AutomationResponse): string {
  if (automation.trigger.triggerType === "once") {
    return `once at ${formatTimestamp(automation.trigger.runAt)}`;
  }
  return `${automation.trigger.cron} (${automation.trigger.timezone})`;
}

type PrintableAutomation =
  | AutomationResponse
  | Extract<AutomationReadProblem, { problem: "missing-agent-prompt" }>;

function printAutomation(
  automation: PrintableAutomation,
  status?: string,
): string {
  const lines = [
    "",
    `  ID:        ${automation.id}`,
    `  Name:      ${automation.name}`,
    ...(status === undefined ? [] : [`  Status:    ${status}`]),
    `  Enabled:   ${automation.enabled ? "yes" : "no"}`,
    `  Mode:      ${automation.execution.mode}`,
    `  Schedule:  ${formatAutomationTrigger(automation)}`,
    `  Next run:  ${formatTimestamp(automation.nextRunAt)}`,
    `  Last run:  ${formatTimestamp(automation.lastRunAt)}`,
    `  Runs:      ${automation.runCount}`,
    `  Origin:    ${automation.origin}`,
  ];
  if (
    automation.execution.mode === "script" &&
    automation.execution.storedScriptPath !== undefined
  ) {
    lines.push(`  Script:    ${automation.execution.storedScriptPath}`);
  }
  if (automation.execution.mode === "agent") {
    lines.push(
      `  Provider:  ${automation.execution.providerId}`,
      `  Model:     ${automation.execution.model}`,
      `  Reasoning: ${automation.execution.reasoningLevel}`,
      `  Tier:      ${automation.execution.serviceTier ?? "-"}`,
      `  Permission: ${automation.execution.permissionMode}`,
    );
  }
  if (automation.lastError) lines.push(`  Error:     ${automation.lastError}`);
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/u.test(value)
    ? value
    : `'${value.replaceAll("'", "'\\''")}'`;
}

function refreshScriptFileCommand(
  automation: AutomationResponse,
  source: ScriptFileSource,
): string {
  if (automation.execution.mode !== "script") return "";
  const argv = [
    "bb",
    "automation",
    "update",
    automation.id,
    "--project",
    automation.projectId,
    "--script-file",
    source.path,
  ];
  if (source.hostId !== undefined) argv.push("--host", source.hostId);
  if (automation.execution.interpreter !== undefined) {
    argv.push("--interpreter", automation.execution.interpreter);
  }
  argv.push("--timeout", String(automation.execution.timeoutMs));
  if (automation.execution.env !== undefined) {
    argv.push("--env-json", JSON.stringify(automation.execution.env));
  }
  return argv.map(shellQuote).join(" ");
}

function printScriptFileSnapshotNote(
  automation: AutomationResponse,
  source: ScriptFileSource | undefined,
): string {
  if (
    source === undefined ||
    automation.execution.mode !== "script" ||
    automation.execution.storedScriptPath === undefined
  ) {
    return "";
  }
  return [
    `Copied ${source.path}${source.hostId !== undefined ? ` (host ${source.hostId})` : ""}`,
    `    to ${automation.execution.storedScriptPath}`,
    "The automation runs this stored copy, a snapshot of the source file.",
    "Edits to the source file do not apply until you run:",
    `  ${refreshScriptFileCommand(automation, source)}`,
    "",
  ].join("\n");
}

function table(head: string[], rows: string[][]): string {
  const widths = head.map((label, index) =>
    Math.max(label.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const format = (row: string[]) =>
    row
      .map((cell, index) => cell.padEnd(widths[index] ?? 0))
      .join("  ")
      .trimEnd();
  return ["", format(head), ...rows.map(format), ""].join("\n") + "\n";
}

function printAutomationProblem(automation: AutomationReadProblem): string {
  if (automation.problem === "missing-agent-prompt") {
    return printAutomation(automation, "Prompt required");
  }
  return (
    [
      "",
      `  ID:        ${automation.id}`,
      `  Name:      ${automation.name}`,
      "  Status:    Invalid data",
      "",
    ].join("\n") + "\n"
  );
}

function printAutomationTable(automations: AutomationReadResult[]): string {
  return table(
    ["ID", "Name", "Status", "On", "Schedule", "Next run", "Runs", "Origin"],
    automations.map((automation) =>
      "problem" in automation
        ? automation.problem === "missing-agent-prompt"
          ? [
              automation.id,
              automation.name,
              "Prompt required",
              automation.enabled ? "yes" : "no",
              formatAutomationTrigger(automation),
              formatTimestamp(automation.nextRunAt),
              String(automation.runCount),
              automation.origin,
            ]
          : [
              automation.id,
              automation.name,
              "Invalid data",
              "-",
              "-",
              "-",
              "-",
              "-",
            ]
        : [
            automation.id,
            automation.name,
            "-",
            automation.enabled ? "yes" : "no",
            formatAutomationTrigger(automation),
            formatTimestamp(automation.nextRunAt),
            String(automation.runCount),
            automation.origin,
          ],
    ),
  );
}

function printRunTable(runs: AutomationRunResponse[]): string {
  return table(
    ["ID", "Status", "Started", "Thread/Exit", "Detail"],
    runs.map((run) => [
      run.id,
      run.status,
      formatTimestamp(run.startedAt),
      run.threadId ?? (run.exitCode === null ? "-" : `exit ${run.exitCode}`),
      run.skipReason ?? run.error ?? "-",
    ]),
  );
}

function helpText(): string {
  return `Automation commands

bb automation list --project <id>
bb automation create --project <id> --name <name> (--cron <expr> --timezone <tz> | --at <datetime> | --in <duration>) (--prompt <text> --provider <id> --model <model> [--reasoning <level>] [--service-tier default|fast] | --script <inline> | --script-file <path> [--host <name-or-id>])
bb automation show <automationId> --project <id>
bb automation update <automationId> --project <id> [--name <name>] [schedule flags] [complete agent/script execution flags | --provider <id> --model <model> --reasoning <level> --service-tier default|fast|none]
bb automation pause <automationId> --project <id>
bb automation resume <automationId> --project <id>
bb automation run <automationId> --project <id> [--idempotency-key <key>]
bb automation runs <automationId> --project <id> [--limit <count>] [--output <runId>]
bb automation delete <automationId> --project <id> --yes
`;
}

export function registerAutomationCli(args: {
  bb: Pick<BbPluginApi, "cli" | "sdk">;
  service: AutomationService;
}): void {
  const { bb, service } = args;
  bb.cli.register({
    name: "automation",
    summary: "Inspect and manage automations (scheduled agent/script runs)",
    commands: [
      {
        name: "list",
        summary: "List automations for a project",
        usage: "bb automation list --project <id> [--json]",
      },
      {
        name: "create",
        summary: "Create an automation",
        usage:
          "bb automation create --project <id> --name <name> [schedule flags] [mode flags]",
      },
      {
        name: "show",
        summary: "Show automation details",
        usage: "bb automation show <automationId> --project <id> [--json]",
      },
      {
        name: "update",
        summary: "Update automation configuration",
        usage: "bb automation update <automationId> --project <id> [flags]",
      },
      {
        name: "pause",
        summary: "Pause an automation",
        usage: "bb automation pause <automationId> --project <id> [--json]",
      },
      {
        name: "resume",
        summary: "Resume an automation",
        usage: "bb automation resume <automationId> --project <id> [--json]",
      },
      {
        name: "run",
        summary: "Run an automation now",
        usage:
          "bb automation run <automationId> --project <id> [--idempotency-key <key>] [--json]",
      },
      {
        name: "runs",
        summary: "List automation runs",
        usage:
          "bb automation runs <automationId> --project <id> [--limit <count>] [--output <runId>] [--json]",
      },
      {
        name: "delete",
        summary: "Delete an automation",
        usage:
          "bb automation delete <automationId> --project <id> --yes [--json]",
      },
    ],
    async run(argv: string[], ctx: PluginCliContext): Promise<PluginCliResult> {
      try {
        const parsed = parseArgs(argv);
        const command = parsed.command;
        if (command === "help" || command === "--help" || command === "-h") {
          return { exitCode: 0, stdout: helpText() };
        }
        if (command === "list") {
          const result = service.list({
            projectId: requireFlag(parsed, "project"),
          });
          const json = optionalJson(parsed, result);
          return {
            exitCode: 0,
            stdout:
              json ??
              (result.length === 0
                ? "No automations found\n"
                : printAutomationTable(result)),
          };
        }
        if (command === "create") {
          const projectId = requireFlag(parsed, "project");
          const { execution, scriptSource } = await buildExecution(
            bb,
            parsed,
            ctx,
          );
          const request: ResolvedCreateAutomationInput = {
            projectId,
            name: requireFlag(parsed, "name"),
            enabled: !boolFlag(parsed, "disabled"),
            trigger: buildTrigger(parsed),
            execution,
            origin: ctx.threadId ? "agent" : "human",
            ...(ctx.threadId ? { createdByThreadId: ctx.threadId } : {}),
          };
          const created = await service.create(request);
          const json = optionalJson(parsed, created);
          return {
            exitCode: 0,
            stdout:
              json ??
              `Automation created: ${created.id}\n${printAutomation(created)}${printScriptFileSnapshotNote(created, scriptSource)}`,
          };
        }
        if (command === "show") {
          const automationId = parsed.positionals[0];
          if (!automationId) throw new Error("Missing automationId.");
          const found = await service.get({
            projectId: requireFlag(parsed, "project"),
            automationId,
          });
          const json = optionalJson(parsed, found);
          return {
            exitCode: 0,
            stdout:
              json ??
              ("problem" in found
                ? printAutomationProblem(found)
                : printAutomation(found)),
          };
        }
        if (command === "update") {
          const { request, scriptSource } = await buildUpdateRequest(
            bb,
            parsed,
            ctx,
          );
          const updated = await service.update(request);
          const json = optionalJson(parsed, updated);
          return {
            exitCode: 0,
            stdout:
              json ??
              `Automation ${updated.id} updated\n${printAutomation(updated)}${printScriptFileSnapshotNote(updated, scriptSource)}`,
          };
        }
        if (command === "pause" || command === "resume") {
          const automationId = parsed.positionals[0];
          if (!automationId) throw new Error("Missing automationId.");
          const input = {
            projectId: requireFlag(parsed, "project"),
            automationId,
          };
          const updated =
            command === "pause" ? service.pause(input) : service.resume(input);
          const json = optionalJson(parsed, updated);
          return {
            exitCode: 0,
            stdout:
              json ??
              `Automation ${updated.id} ${command === "pause" ? "paused" : "resumed"}\n`,
          };
        }
        if (command === "run") {
          const automationId = parsed.positionals[0];
          if (!automationId) throw new Error("Missing automationId.");
          const result = await service.run({
            projectId: requireFlag(parsed, "project"),
            automationId,
            ...(flag(parsed, "idempotency-key")
              ? { idempotencyKey: flag(parsed, "idempotency-key") }
              : {}),
          });
          const json = optionalJson(parsed, result);
          const threadLine = result.run.threadId
            ? `Thread: ${result.run.threadId}\n`
            : "";
          return {
            exitCode: 0,
            stdout: json ?? `Run started: ${result.run.id}\n${threadLine}`,
          };
        }
        if (command === "runs") {
          const automationId = parsed.positionals[0];
          if (!automationId) throw new Error("Missing automationId.");
          const limitText = flag(parsed, "limit");
          const limit =
            limitText === undefined
              ? undefined
              : Number.parseInt(limitText, 10);
          if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
            throw new Error("--limit must be a positive integer.");
          }
          const result = service.runs({
            projectId: requireFlag(parsed, "project"),
            automationId,
            limit: limit ?? 50,
          });
          const outputRunId = flag(parsed, "output");
          if (outputRunId) {
            const run = result.runs.find(
              (candidate) => candidate.id === outputRunId,
            );
            if (!run)
              throw new Error(
                `Run ${outputRunId} not found in returned runs. Increase --limit if it is older.`,
              );
            const json = optionalJson(parsed, run);
            return { exitCode: 0, stdout: json ?? `${run.output ?? ""}\n` };
          }
          const json = optionalJson(parsed, result);
          return {
            exitCode: 0,
            stdout:
              json ??
              (result.runs.length === 0
                ? "No runs found\n"
                : printRunTable(result.runs)),
          };
        }
        if (command === "delete") {
          const automationId = parsed.positionals[0];
          if (!automationId) throw new Error("Missing automationId.");
          if (!boolFlag(parsed, "yes")) {
            throw new Error(
              "Deletion requires --yes when run through the plugin CLI.",
            );
          }
          await service.delete({
            projectId: requireFlag(parsed, "project"),
            automationId,
          });
          const value = { ok: true, id: automationId };
          const json = optionalJson(parsed, value);
          return {
            exitCode: 0,
            stdout: json ?? `Automation ${automationId} deleted\n`,
          };
        }
        throw new Error(
          `Unknown automation command '${command}'.\n\n${helpText()}`,
        );
      } catch (error) {
        return {
          exitCode: 1,
          stderr: `${error instanceof Error ? error.message : String(error)}\n`,
        };
      }
    },
  });
}
