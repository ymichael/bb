import { Command } from "commander";
import type { Host } from "@bb/domain";
import {
  UPDATE_STATE_PRESENTATION,
  type UpdateState,
} from "@bb/domain/update-state";
import type { HostProviderCliStatusResponse } from "@bb/server-contract";
import { action } from "../action.js";
import { createCliBbSdk } from "../client.js";
import { renderBorderlessTable } from "../table.js";
import { outputJson } from "./helpers.js";
import { resolveMachineId } from "./machine.js";

type ProviderCliKey = string;
type ProviderCliStatus = HostProviderCliStatusResponse[string];
type ProviderCliStatusResponse = HostProviderCliStatusResponse;

interface UpdatesCommandOptions {
  json?: boolean;
  machine?: string;
}

interface ProviderUpdateTarget {
  host: Host;
  provider: ProviderCliKey;
  status: ProviderCliStatus;
}

interface MachineUpdatesEntry {
  host: Host;
  providerStatus: ProviderCliStatusResponse | null;
  statusError: string | null;
}

function providerState(status: ProviderCliStatus): UpdateState {
  if (!status.installed) return "not-installed";
  if (status.needsUpdate || status.versionUnsupported) {
    return status.installAction === null
      ? "update-manually"
      : "update-available";
  }
  return "up-to-date";
}

function providerStateLabel(status: ProviderCliStatus): string {
  return UPDATE_STATE_PRESENTATION[providerState(status)].label;
}

function providerVersionLabel(status: ProviderCliStatus): string {
  const current = status.currentVersion ?? "unknown";
  const latest = status.latestVersion;
  if (latest !== null && latest !== status.currentVersion) {
    return `${current} -> ${latest}`;
  }
  return current;
}

function isActionableProviderStatus(status: ProviderCliStatus): boolean {
  return (
    status.installAction !== null &&
    (!status.installed || status.needsUpdate || status.versionUnsupported)
  );
}

async function collectMachineUpdates(
  sdk: ReturnType<typeof createCliBbSdk>,
  hosts: readonly Host[],
): Promise<MachineUpdatesEntry[]> {
  return Promise.all(
    hosts.map(async (host): Promise<MachineUpdatesEntry> => {
      if (host.status !== "connected") {
        return { host, providerStatus: null, statusError: null };
      }
      try {
        return {
          host,
          providerStatus: await sdk.hosts.providerCliStatus({
            hostId: host.id,
          }),
          statusError: null,
        };
      } catch (error) {
        return {
          host,
          providerStatus: null,
          statusError: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
}

function actionableTargets(
  entries: readonly MachineUpdatesEntry[],
): ProviderUpdateTarget[] {
  const targets: ProviderUpdateTarget[] = [];
  for (const entry of entries) {
    if (entry.providerStatus === null) continue;
    for (const [provider, status] of Object.entries(entry.providerStatus)) {
      if (isActionableProviderStatus(status)) {
        targets.push({ host: entry.host, provider, status });
      }
    }
  }
  return targets;
}

function printUpdatesTable(args: {
  appRow: readonly [string, string, string];
  entries: readonly MachineUpdatesEntry[];
}): void {
  const rows: string[][] = [[...args.appRow]];
  for (const entry of args.entries) {
    if (entry.host.status !== "connected") {
      rows.push([entry.host.name, "-", "offline"]);
      continue;
    }
    if (entry.providerStatus === null) {
      rows.push([entry.host.name, "-", entry.statusError ?? "status failed"]);
      continue;
    }
    for (const status of Object.values(entry.providerStatus)) {
      rows.push([
        `${entry.host.name} · ${status.displayName}`,
        providerVersionLabel(status),
        providerStateLabel(status),
      ]);
    }
  }
  const widths = [
    Math.max(6, ...rows.map((row) => row[0].length)),
    Math.max(7, ...rows.map((row) => row[1].length)),
    Math.max(5, ...rows.map((row) => row[2].length)),
  ];
  console.log("");
  console.log(
    renderBorderlessTable(
      {
        head: ["Target", "Version", "State"],
        colWidths: widths,
        trimTrailingWhitespace: true,
      },
      rows,
    ),
  );
  console.log("");
}

export function registerUpdatesCommands(
  program: Command,
  getUrl: () => string,
): void {
  const updates = program
    .command("updates")
    .description("Inspect and apply bb and provider CLI updates");

  updates
    .command("status", { isDefault: true })
    .description("Show bb and provider CLI update status across machines")
    .option("--machine <id-or-name>", "Limit to one machine")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: UpdatesCommandOptions) => {
        const sdk = createCliBbSdk(getUrl());
        const [version, hosts] = await Promise.all([
          sdk.system.version(),
          sdk.hosts.list(),
        ]);
        const selectedHosts =
          opts.machine === undefined
            ? hosts
            : hosts.filter(
                (host) => host.id === resolveMachineId(hosts, opts.machine!),
              );
        const entries = await collectMachineUpdates(sdk, selectedHosts);
        if (
          outputJson(opts, {
            app: version,
            machines: entries.map((entry) => ({
              host: entry.host,
              providerStatus: entry.providerStatus,
              statusError: entry.statusError,
            })),
          })
        ) {
          return;
        }

        const appState = version.isDevelopment
          ? "development mode"
          : version.updateAvailable
            ? `${UPDATE_STATE_PRESENTATION["update-available"].label} (run: ${version.upgradeCommand})`
            : UPDATE_STATE_PRESENTATION["up-to-date"].label;
        const appVersionLabel =
          version.latestVersion !== null &&
          version.latestVersion !== version.currentVersion
            ? `${version.currentVersion} -> ${version.latestVersion}`
            : version.currentVersion;
        printUpdatesTable({
          appRow: ["bb-app", appVersionLabel, appState],
          entries,
        });
      }),
    );

  updates
    .command("apply")
    .description("Run every available provider CLI install/update")
    .option("--machine <id-or-name>", "Limit to one machine")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: UpdatesCommandOptions) => {
        const sdk = createCliBbSdk(getUrl());
        const hosts = await sdk.hosts.list();
        const selectedHosts =
          opts.machine === undefined
            ? hosts
            : hosts.filter(
                (host) => host.id === resolveMachineId(hosts, opts.machine!),
              );
        const entries = await collectMachineUpdates(sdk, selectedHosts);
        const targets = actionableTargets(entries);
        if (targets.length === 0) {
          if (outputJson(opts, { results: [] })) return;
          const hasManualUpdates = entries.some(
            (entry) =>
              entry.providerStatus !== null &&
              Object.values(entry.providerStatus).some(
                (status) =>
                  status.installed &&
                  status.needsUpdate &&
                  status.installAction === null,
              ),
          );
          console.log(
            hasManualUpdates
              ? "No updates bb can apply. Run bb updates status for manual updates."
              : "Everything is up to date.",
          );
          return;
        }

        const results: {
          hostId: string;
          hostName: string;
          provider: ProviderCliKey;
          success: boolean;
          message: string | null;
        }[] = [];
        for (const target of targets) {
          const actionKind = target.status.installAction?.kind ?? "install";
          if (!opts.json) {
            console.log(
              `${target.status.displayName} on ${target.host.name}: running ${actionKind}…`,
            );
          }
          try {
            const events = await sdk.hosts.installProviderCli({
              hostId: target.host.id,
              provider: target.provider,
              actionKind,
            });
            const completed = events.find(
              (event) => event.type === "completed",
            );
            const errorEvent = events.find((event) => event.type === "error");
            const success =
              completed?.type === "completed" && completed.success;
            results.push({
              hostId: target.host.id,
              hostName: target.host.name,
              provider: target.provider,
              success,
              message: errorEvent?.type === "error" ? errorEvent.message : null,
            });
            if (!opts.json) {
              console.log(
                success
                  ? `${target.status.displayName} on ${target.host.name}: done`
                  : `${target.status.displayName} on ${target.host.name}: failed${
                      errorEvent?.type === "error"
                        ? ` (${errorEvent.message})`
                        : ""
                    }`,
              );
            }
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            results.push({
              hostId: target.host.id,
              hostName: target.host.name,
              provider: target.provider,
              success: false,
              message,
            });
            if (!opts.json) {
              console.log(
                `${target.status.displayName} on ${target.host.name}: failed (${message})`,
              );
            }
          }
        }
        if (outputJson(opts, { results })) return;
        const failures = results.filter((result) => !result.success);
        if (failures.length > 0) {
          throw new Error(
            `${failures.length} update${failures.length === 1 ? "" : "s"} failed.`,
          );
        }
      }),
    );
}
