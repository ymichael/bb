import { Command } from "commander";
import type { Thread } from "@beanbag/agent-core";
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

export function registerDaemonCommands(program: Command, getUrl: () => string): void {
  const daemon = program.command("daemon").description("Manage daemon lifecycle");

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
