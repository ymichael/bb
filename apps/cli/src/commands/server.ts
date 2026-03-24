import { Command } from "commander";
import type {
  SystemShutdownAcceptedResponse,
  SystemShutdownBlockedResponse,
  SystemShutdownBlockingThread,
} from "@bb/server-contract";
import { createClient, unwrap } from "../client.js";
import { getErrorMessage, outputJson } from "./helpers.js";

function formatBlockingThread(thread: SystemShutdownBlockingThread): string {
  return `- ${thread.id} (${thread.status}, project ${thread.projectId})`;
}

export function registerServerCommands(program: Command, getUrl: () => string): void {
  const server = program.command("server").description("Manage server lifecycle");

  server
    .command("restart")
    .description("Safely request server shutdown before restart")
    .option("--force", "Shutdown even when active/provisioning work exists")
    .option("--json", "Print machine-readable JSON output")
    .action(async (opts: { force?: boolean; json?: boolean }) => {
      const client = createClient(getUrl());
      try {
        const shutdownResponse = await client.api.v1.system.shutdown.$post({
          json: opts.force ? { force: true } : {},
        });

        if (shutdownResponse.status === 409) {
          const blocked = await shutdownResponse.json() as SystemShutdownBlockedResponse;
          const blockingThreads = blocked.blockingThreads ?? [];
          console.error(
            blocked.message ??
              "Server shutdown blocked by active thread work. Use --force to override.",
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

        const payload = await unwrap<SystemShutdownAcceptedResponse>(
          Promise.resolve(shutdownResponse),
        );
        if (outputJson(opts, payload)) return;
        console.log(
          payload.forced
            ? "Server shutdown requested (forced)."
            : "Server shutdown requested.",
        );
        console.log(
          "Restart server now (for example: `pnpm server` or your configured dev watcher).",
        );
      } catch (err: unknown) {
        console.error(`Error: ${getErrorMessage(err)}`);
        process.exit(1);
      }
    });
}
