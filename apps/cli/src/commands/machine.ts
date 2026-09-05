import { Command } from "commander";
import type { Host } from "@bb/domain";
import { action } from "../action.js";
import { createCliBbSdk } from "../client.js";
import { renderBorderlessTable } from "../table.js";
import { outputJson } from "./helpers.js";
import { confirmDestructiveAction } from "./helpers.js";

interface MachineListCommandOptions {
  json?: boolean;
  project?: string;
}

interface MachineMutationCommandOptions extends MachineListCommandOptions {
  yes?: boolean;
}

interface MachineProviderInstallOptions extends MachineListCommandOptions {
  action?: "install" | "update";
}

function parseProviderCliKey(value: string): string {
  const providerId = value.trim();
  if (providerId.length === 0)
    throw new Error("provider ID must not be empty.");
  return providerId;
}

function describeMachines(hosts: readonly Host[]): string {
  if (hosts.length === 0) return "none";
  return hosts.map((host) => `${host.name} (${host.id})`).join(", ");
}

export function resolveMachineId(
  hosts: readonly Host[],
  target: string,
): string {
  const trimmedTarget = target.trim();
  const idMatch = hosts.find((host) => host.id === trimmedTarget);
  if (idMatch) return idMatch.id;

  const nameMatches = hosts.filter((host) => host.name === trimmedTarget);
  if (nameMatches.length === 1) return nameMatches[0].id;
  if (nameMatches.length > 1) {
    throw new Error(
      `Machine name '${trimmedTarget}' is ambiguous. Matches: ${describeMachines(nameMatches)}.`,
    );
  }
  throw new Error(
    `Machine '${trimmedTarget}' was not found. Available machines: ${describeMachines(hosts)}.`,
  );
}

export function resolveMachineTargetOption(args: {
  machine?: string;
  host?: string;
}): string | undefined {
  if (args.machine && args.host) {
    throw new Error("Cannot combine --machine with --host.");
  }
  return args.machine ?? args.host;
}

type MachineEnvironmentRouting =
  | { environmentId: string; hostId?: never }
  | { environmentId?: never; hostId: string }
  | { environmentId?: never; hostId?: never };

export async function resolveMachineEnvironmentRouting(
  args: { environment?: string; host?: string; machine?: string },
  serverUrl: string,
): Promise<MachineEnvironmentRouting> {
  const machineTarget = resolveMachineTargetOption(args);
  if (machineTarget !== undefined && args.environment !== undefined) {
    throw new Error(
      "Cannot combine --machine or --host with --environment; the environment already selects its machine.",
    );
  }
  if (args.environment !== undefined) {
    return { environmentId: args.environment };
  }
  if (machineTarget !== undefined) {
    return {
      hostId: await resolveMachineHostId({ serverUrl, target: machineTarget }),
    };
  }
  return {};
}

export function formatMachineLastSeen(
  timestamp: number | null,
  now = Date.now(),
): string {
  if (timestamp === null) return "never";
  const elapsedMs = Math.max(0, now - timestamp);
  const minuteMs = 60 * 1000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;
  if (elapsedMs < minuteMs) return "just now";
  if (elapsedMs < hourMs) return `${Math.floor(elapsedMs / minuteMs)}m ago`;
  if (elapsedMs < dayMs) return `${Math.floor(elapsedMs / hourMs)}h ago`;
  return `${Math.floor(elapsedMs / dayMs)}d ago`;
}

export async function resolveMachineHostId(args: {
  requireConnected?: boolean;
  serverUrl: string;
  target: string;
}): Promise<string> {
  const hosts = await createCliBbSdk(args.serverUrl).hosts.list();
  const hostId = resolveMachineId(hosts, args.target);
  if (
    args.requireConnected &&
    hosts.find((host) => host.id === hostId)?.status !== "connected"
  ) {
    throw new Error(`Machine '${args.target.trim()}' is disconnected.`);
  }
  return hostId;
}

export function registerMachineCommands(
  program: Command,
  getUrl: () => string,
): void {
  const machine = program
    .command("machine")
    .description("Inspect execution machines");

  machine
    .command("providers")
    .description("List installed machine providers")
    .option("--project <id>", "Evaluate availability for a project")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: MachineListCommandOptions) => {
        const providers = await createCliBbSdk(getUrl()).hosts.listProviders({
          ...(opts.project === undefined ? {} : { projectId: opts.project }),
        });
        if (outputJson(opts, providers)) return;
        if (providers.length === 0) {
          console.log("No machine providers found");
          return;
        }
        console.log(
          providers
            .map(
              (provider) =>
                `${provider.id}  ${provider.displayName}  ${provider.availability?.status ?? "available"}`,
            )
            .join("\n"),
        );
      }),
    );

  machine
    .command("list")
    .description("List execution machines")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: MachineListCommandOptions) => {
        const hosts = await createCliBbSdk(getUrl()).hosts.list();
        if (outputJson(opts, hosts)) return;
        if (hosts.length === 0) {
          console.log("No machines found");
          return;
        }
        printMachineTable(hosts);
      }),
    );

  machine
    .command("show <id-or-name>")
    .description("Show execution machine details")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (target: string, opts: MachineListCommandOptions) => {
        const sdk = createCliBbSdk(getUrl());
        const hostId = resolveMachineId(await sdk.hosts.list(), target);
        const host = await sdk.hosts.get({ hostId });
        if (outputJson(opts, host)) return;
        console.log(JSON.stringify(host, null, 2));
      }),
    );

  machine
    .command("join-code")
    .description("Create a short-lived machine pairing code")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: MachineListCommandOptions) => {
        const result = await createCliBbSdk(getUrl()).hosts.createJoinCode();
        if (outputJson(opts, result)) return;
        console.log(result.joinCode);
      }),
    );

  machine
    .command("rename <id-or-name> <name>")
    .description("Rename an execution machine")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (
          target: string,
          name: string,
          opts: MachineListCommandOptions,
        ) => {
          const sdk = createCliBbSdk(getUrl());
          const hostId = resolveMachineId(await sdk.hosts.list(), target);
          const host = await sdk.hosts.update({ hostId, name });
          if (outputJson(opts, host)) return;
          console.log(`Machine ${host.id} renamed to ${host.name}`);
        },
      ),
    );

  machine
    .command("remove <id-or-name>")
    .description("Revoke and remove an execution machine")
    .option("--yes", "Skip the confirmation prompt")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (target: string, opts: MachineMutationCommandOptions) => {
        const sdk = createCliBbSdk(getUrl());
        const hostId = resolveMachineId(await sdk.hosts.list(), target);
        if (
          !opts.yes &&
          !(await confirmDestructiveAction(`Remove machine ${hostId}?`))
        )
          return;
        const result = await sdk.hosts.delete({ hostId });
        if (outputJson(opts, result)) return;
        console.log(`Machine ${hostId} removed`);
      }),
    );

  machine
    .command("retry-update <id-or-name>")
    .description("Retry a pending daemon protocol update now")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (target: string, opts: MachineListCommandOptions) => {
        const sdk = createCliBbSdk(getUrl());
        const hostId = resolveMachineId(await sdk.hosts.list(), target);
        const result = await sdk.hosts.retryUpdate({ hostId });
        if (outputJson(opts, result)) return;
        console.log(`Machine ${hostId} update retry requested`);
      }),
    );

  machine
    .command("suspend <id-or-name>")
    .description("Suspend a provider-managed execution machine")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (target: string, opts: MachineListCommandOptions) => {
        const sdk = createCliBbSdk(getUrl());
        const hostId = resolveMachineId(await sdk.hosts.list(), target);
        const result = await sdk.hosts.suspend({ hostId });
        if (outputJson(opts, result)) return;
        console.log(`Machine ${hostId} suspended`);
      }),
    );

  machine
    .command("resume <id-or-name>")
    .description("Resume a suspended provider-managed execution machine")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (target: string, opts: MachineListCommandOptions) => {
        const sdk = createCliBbSdk(getUrl());
        const hostId = resolveMachineId(await sdk.hosts.list(), target);
        const result = await sdk.hosts.resume({ hostId });
        if (outputJson(opts, result)) return;
        console.log(`Machine ${hostId} resumed`);
      }),
    );

  machine
    .command("retry-cleanup <id-or-name>")
    .description("Retry a failed provider teardown immediately")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (target: string, opts: MachineListCommandOptions) => {
        const sdk = createCliBbSdk(getUrl());
        const hostId = resolveMachineId(await sdk.hosts.list(), target);
        const result = await sdk.hosts.retryCleanup({ hostId });
        if (outputJson(opts, result)) return;
        console.log(`Machine ${hostId} cleanup retried`);
      }),
    );

  const providerCli = machine
    .command("provider-cli")
    .description("Inspect and install provider CLIs on a machine");
  providerCli
    .command("status <id-or-name>")
    .description("Show registered provider CLI installation/update status")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (target: string, opts: MachineListCommandOptions) => {
        const sdk = createCliBbSdk(getUrl());
        const hostId = resolveMachineId(await sdk.hosts.list(), target);
        const result = await sdk.hosts.providerCliStatus({ hostId });
        if (outputJson(opts, result)) return;
        console.log(JSON.stringify(result, null, 2));
      }),
    );
  providerCli
    .command("install <id-or-name> <provider>")
    .description("Install or update a registered provider CLI by provider ID")
    .option("--action <action>", "Action: install or update", "install")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (
          target: string,
          provider: string,
          opts: MachineProviderInstallOptions,
        ) => {
          if (opts.action !== "install" && opts.action !== "update") {
            throw new Error("--action must be install or update.");
          }
          const sdk = createCliBbSdk(getUrl());
          const hostId = resolveMachineId(await sdk.hosts.list(), target);
          const events = await sdk.hosts.installProviderCli({
            hostId,
            provider: parseProviderCliKey(provider),
            actionKind: opts.action,
          });
          if (outputJson(opts, events)) return;
          for (const event of events) console.log(JSON.stringify(event));
        },
      ),
    );
}

function printMachineTable(hosts: Host[]): void {
  const now = Date.now();
  const rows = hosts.map((host) => [
    host.name,
    host.id,
    host.status,
    host.machineProviderId ?? "user-enrolled",
    formatMachineLastSeen(host.lastSeenAt, now),
  ]);
  const widths = [
    Math.max(4, ...rows.map((row) => row[0].length)),
    Math.max(2, ...rows.map((row) => row[1].length)),
    Math.max(6, ...rows.map((row) => row[2].length)),
    Math.max(8, ...rows.map((row) => row[3].length)),
    Math.max(9, ...rows.map((row) => row[4].length)),
  ];
  console.log("");
  console.log(
    renderBorderlessTable(
      {
        head: ["Name", "ID", "Status", "Provider", "Last seen"],
        colWidths: widths,
        trimTrailingWhitespace: true,
      },
      rows,
    ),
  );
  console.log("");
}
