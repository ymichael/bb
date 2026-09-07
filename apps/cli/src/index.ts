#!/usr/bin/env node
import { Command } from "commander";
import { maybeReexecViaBbCli } from "./bb-cli-reexec.js";
import {
  CORE_COMMAND_GROUPS,
  type CommandGroupDeps,
  pluginProxyCandidate,
  selectCommandGroups,
} from "./command-groups.js";
import { resolveBbCliVersion } from "./version.js";
import type { CliRuntimeContext } from "./context-env.js";

maybeReexecViaBbCli();

const program = new Command();

program
  .name("bb")
  .description("BB CLI - manage your AI coding agents")
  .enablePositionalOptions()
  .version(resolveBbCliVersion());

const KNOWN_COMMAND_NAMES: ReadonlySet<string> = new Set([
  ...CORE_COMMAND_GROUPS.map((group) => group.name),
  "help",
]);

type ContextEnvModule = typeof import("./context-env.js");

function createCommandGroupDeps(
  contextEnv: ContextEnvModule,
): CommandGroupDeps {
  let cliRuntimeContext: CliRuntimeContext | undefined;
  const getCliRuntimeContext = (): CliRuntimeContext =>
    (cliRuntimeContext ??= contextEnv.createCliRuntimeContext());
  return {
    getUrl: () => contextEnv.resolveServerUrl(getCliRuntimeContext()),
    getContext: () => contextEnv.resolveContextSnapshot(getCliRuntimeContext()),
  };
}

async function tryPluginCommandProxy(
  candidate: string,
  getUrl: () => string,
): Promise<void> {
  const proxy = await import("./plugin-cli-proxy.js");
  const result = await proxy.fetchPluginCliContributions(getUrl());
  if (result.outcome === "unreachable") {
    console.error(
      proxy.describeUnreachableServer(
        getUrl(),
        result.cause,
        result.lastTimeoutMs,
        result.attempts,
      ),
    );
    process.exit(1);
  }
  if (result.outcome === "invalid") return;
  const match = proxy.findPluginCliCommand(result.contributions, candidate);
  if (match === undefined) {
    const disabled = await proxy.findDisabledPluginForCommand(
      getUrl(),
      candidate,
    );
    if (disabled !== null) {
      console.error(
        `bb ${candidate} is provided by the "${disabled.id}" plugin, which is disabled — ` +
          `run \`bb plugin enable ${disabled.id}\` or enable it in Plugins.`,
      );
      process.exit(1);
    }
    return;
  }
  const argv = process.argv.slice(3);
  const command = match.commands.find((entry) => entry.name === argv[0]);
  if (
    command !== undefined &&
    argv.slice(1).some((arg) => arg === "--help" || arg === "-h")
  ) {
    console.log(command.usage);
    process.exit(0);
  }
  process.exit(await proxy.runPluginCliCommand(getUrl(), match.pluginId, argv));
}

async function main(): Promise<void> {
  const firstArg = process.argv[2];
  const groups = selectCommandGroups(firstArg);
  if (groups.length === 0) {
    await program.parseAsync(process.argv);
    return;
  }

  const [contextEnv, ...registrars] = await Promise.all([
    import("./context-env.js"),
    ...groups.map((group) => group.load()),
  ]);
  const deps = createCommandGroupDeps(contextEnv);

  program.addHelpText("after", () => {
    const context = deps.getContext();
    const project = context.projectId ?? "<unset>";
    const thread = context.threadId ?? "<unset>";

    return `

Current context:
  BB_PROJECT_ID: ${project}
  BB_THREAD_ID: ${thread}
  BB_SERVER_URL: ${context.serverUrl}

Quick start:
  bb status
  bb project list
  bb thread show <id>
  bb thread spawn --project <id> --provider codex --prompt "..."
`;
  });

  for (const register of registrars) {
    register(program, deps);
  }

  const candidate = pluginProxyCandidate(firstArg, KNOWN_COMMAND_NAMES);
  if (candidate !== null) {
    await tryPluginCommandProxy(candidate, deps.getUrl);
  }
  await program.parseAsync(process.argv);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
