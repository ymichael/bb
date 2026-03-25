import { Command } from "commander";
import type { Environment, Thread } from "@bb/domain";
import type { ProjectResponse } from "@bb/server-contract";
import {
  type EnvironmentDisplayInfo,
  formatEnvironmentDisplay,
} from "@bb/core-ui";
import { action } from "../action.js";
import { resolveContextSnapshot } from "../context-env.js";
import { createClient, unwrap } from "../client.js";
import { fetchLocalHostId } from "../daemon.js";
import { outputJson } from "./helpers.js";

interface StatusPayload {
  project: { id: string; name: string } | null;
  thread: {
    id: string;
    type: string;
    status: string;
    title: string | null;
    parentThreadId: string | null;
    environment: EnvironmentDisplayInfo | null;
  } | null;
  managedThreads: Array<{
    id: string;
    status: string;
    title: string | null;
  }> | null;
}

interface StatusCommandOptions {
  json?: boolean;
}

export function registerStatusCommand(
  program: Command,
  getUrl: () => string,
): void {
  program
    .command("status")
    .description("Show current context")
    .option("--json", "Print machine-readable JSON output")
    .action(action(async (opts: StatusCommandOptions) => {
      const context = resolveContextSnapshot();

      const payload: StatusPayload = {
        project: null,
        thread: null,
        managedThreads: null,
      };

      let serverAvailable = false;

      // Try to fetch enriched data from the server
      if (context.projectId || context.threadId) {
        try {
          const client = createClient(getUrl());

          if (context.projectId) {
            try {
              const project = await unwrap<ProjectResponse>(
                client.api.v1.projects[":id"].$get({
                  param: { id: context.projectId },
                }),
              );
              payload.project = {
                id: project.id,
                name: project.name,
              };
              serverAvailable = true;
            } catch {
              // Project fetch failed; will fall back below
            }
          }

          if (context.threadId) {
            try {
              const thread = await unwrap<Thread>(
                client.api.v1.threads[":id"].$get({
                  param: { id: context.threadId },
                }),
              );

              let environmentDisplay: EnvironmentDisplayInfo | null = null;
              if (thread.environmentId) {
                try {
                  const env = await unwrap<Environment>(
                    client.api.v1.environments[":id"].$get({
                      param: { id: thread.environmentId },
                    }),
                  );
                  const localHostId = await fetchLocalHostId();
                  environmentDisplay = formatEnvironmentDisplay(env, env.hostId === localHostId);
                } catch {
                  // Environment fetch failed; leave as null
                }
              }

              payload.thread = {
                id: thread.id,
                type: thread.type,
                status: thread.status,
                title: thread.title ?? null,
                parentThreadId: thread.parentThreadId ?? null,
                environment: environmentDisplay,
              };
              serverAvailable = true;

              // If the thread is a manager, fetch managed (child) threads
              if (thread.type === "manager") {
                try {
                  const managed = await unwrap<Thread[]>(
                    client.api.v1.threads.$get({
                      query: { parentThreadId: thread.id },
                    }),
                  );
                  payload.managedThreads = managed.map((t) => ({
                    id: t.id,
                    status: t.status,
                    title: t.title ?? null,
                  }));
                } catch {
                  // Managed threads fetch failed; leave as null
                }
              }
            } catch {
              // Thread fetch failed; will fall back below
            }
          }
        } catch {
          // Server unreachable; fall back to env-var-only output
        }
      }

      // JSON output
      if (outputJson(opts, payload)) return;

      // Human-readable output
      if (serverAvailable && payload.project) {
        console.log(`Project: ${payload.project.name} (${payload.project.id})`);
      } else if (context.projectId) {
        console.log(`Project: ${context.projectId}`);
      } else {
        console.log("Project: (not set)");
      }

      console.log("");

      if (serverAvailable && payload.thread) {
        console.log(`Thread: ${payload.thread.id}`);
        console.log(`  Type: ${payload.thread.type}`);
        console.log(`  Status: ${payload.thread.status}`);
        if (payload.thread.title) {
          console.log(`  Title: ${payload.thread.title}`);
        }
        if (payload.thread.parentThreadId) {
          console.log(`  Parent: ${payload.thread.parentThreadId}`);
        }
        if (payload.thread.environment) {
          console.log(`  Environment: ${payload.thread.environment.label} (${payload.thread.environment.id})`);
        }

        if (payload.managedThreads && payload.managedThreads.length > 0) {
          console.log("");
          console.log(`Managed threads: ${payload.managedThreads.length}`);
          for (const mt of payload.managedThreads) {
            const title = mt.title ? `"${mt.title}"` : "";
            console.log(`  ${mt.id}  ${mt.status}  ${title}`);
          }
        }
      } else if (context.threadId) {
        console.log(`Thread: ${context.threadId}`);
      } else {
        console.log("Thread: (not set)");
      }

      if (!context.projectId && !context.threadId) {
        console.log("");
        console.log("Tip: run bb guide for help getting started.");
      }
    }));
}
