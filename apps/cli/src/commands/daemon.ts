import { Command } from "commander";
import type { SystemHealthReport, Thread } from "@beanbag/agent-core";
import { createClient, unwrap } from "../client.js";

interface ShutdownAcceptedResponse {
  ok: boolean;
  forced: boolean;
  blockingThreadsCount: number;
}

interface ShutdownBlockedResponse {
  code?: string;
  message?: string;
  blockingThreads?: Array<{
    id: string;
    projectId: string;
    status: Thread["status"];
  }>;
}

function formatBlockingThread(thread: {
  id: string;
  projectId: string;
  status: Thread["status"];
}): string {
  return `- ${thread.id} (${thread.status}, project ${thread.projectId})`;
}

function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = unitIndex === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

function formatUptime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  return `${hours}h ${minutes}m ${remainingSeconds}s`;
}

function printHealthReport(report: SystemHealthReport): void {
  console.log("Daemon Health");
  console.log(`Generated: ${new Date(report.generatedAt).toISOString()}`);
  console.log(`Uptime: ${formatUptime(report.uptime)}`);
  console.log(`Projects: ${report.projectCount}`);
  console.log(`Running threads: ${report.runningThreads}`);
  console.log(
    "Threads: " +
      `${report.threadCounts.total} total, ` +
      `${report.threadCounts.archived} archived, ` +
      `${report.threadCounts.active} active, ` +
      `${report.threadCounts.idle} idle, ` +
      `${report.threadCounts.error} error, ` +
      `${report.threadCounts.provisioned} provisioned, ` +
      `${report.threadCounts.provisioning} provisioning, ` +
      `${report.threadCounts.created} created, ` +
      `${report.threadCounts.provisioningFailed} provisioning_failed`,
  );
  console.log(`Managed storage: ${formatBytes(report.storage.totalBytes)}`);
  if (report.storage.disk) {
    console.log(
      `Disk: ${formatBytes(report.storage.disk.availableBytes)} free / ${formatBytes(report.storage.disk.totalBytes)} total at ${report.storage.disk.path}`,
    );
  }
  console.log("Storage buckets:");
  for (const bucket of report.storage.buckets) {
    console.log(`- ${bucket.label}: ${formatBytes(bucket.bytes)}`);
    for (const path of bucket.paths) {
      console.log(`  ${path}`);
    }
  }
}

export function registerDaemonCommands(program: Command, getUrl: () => string): void {
  const daemon = program.command("daemon").description("Manage daemon lifecycle");

  daemon
    .command("health")
    .description("Show daemon health and managed storage usage")
    .option("--json", "Print machine-readable JSON output")
    .action(async (opts: { json?: boolean }) => {
      const client = createClient(getUrl());
      try {
        const report = await unwrap<SystemHealthReport>(
          client.api.v1.system.health.$get(),
        );
        if (opts.json) {
          console.log(JSON.stringify(report, null, 2));
          return;
        }
        printHealthReport(report);
      } catch (err: unknown) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  daemon
    .command("restart")
    .description("Safely request daemon shutdown before restart")
    .option("--force", "Shutdown even when active/provisioning work exists")
    .action(async (opts: { force?: boolean }) => {
      const client = createClient(getUrl());
      try {
        const shutdownResponse = await client.api.v1.system.shutdown.$post({
          json: opts.force ? { force: true } : {},
        });

        if (shutdownResponse.status === 409) {
          const blocked = await shutdownResponse.json() as ShutdownBlockedResponse;
          const blockingThreads = blocked.blockingThreads ?? [];
          console.error(
            blocked.message ??
              "Daemon shutdown blocked by active thread work. Use --force to override.",
          );
          if (blockingThreads.length > 0) {
            console.error("Blocking threads:");
            for (const thread of blockingThreads) {
              console.error(formatBlockingThread(thread));
            }
          }
          process.exit(1);
          return;
        }

        const payload = await unwrap<ShutdownAcceptedResponse>(
          Promise.resolve(shutdownResponse),
        );
        console.log(
          payload.forced
            ? "Daemon shutdown requested (forced)."
            : "Daemon shutdown requested.",
        );
        console.log(
          "Restart daemon now (for example: `pnpm daemon` or your configured dev watcher).",
        );
      } catch (err: unknown) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
