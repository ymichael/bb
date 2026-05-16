import { Command } from "commander";
import type {
  ThreadLatestTerminalSummary,
  ThreadTimelinePendingTodos,
} from "@bb/domain";
import type {
  ProjectResponse,
  ThreadListResponse,
  ThreadResponse,
} from "@bb/server-contract";
import { action } from "../action.js";
import { resolveContextSnapshot } from "../context-env.js";
import { type Client, createClient, unwrap } from "../client.js";
import { outputJson } from "./helpers.js";
import {
  type ThreadEnvironmentInfo,
  fetchEnvironmentInfo,
  printEnvironmentInfo,
} from "./environment-helpers.js";
import {
  fetchThreadPendingTodos,
  printPendingTodos,
} from "./thread/pending-todos.js";
import { latestTerminalSummaryText } from "./thread/helpers.js";

interface StatusPayload {
  project: { id: string; name: string } | null;
  thread: {
    id: string;
    type: string;
    status: string;
    latestTerminalSummary: ThreadLatestTerminalSummary | null;
    title: string | null;
    parentThreadId: string | null;
    environment: ThreadEnvironmentInfo | null;
  } | null;
  managedThreads: Array<{
    id: string;
    status: string;
    latestTerminalSummary: ThreadLatestTerminalSummary | null;
    title: string | null;
  }> | null;
  pendingTodos: ThreadTimelinePendingTodos | null;
}

interface StatusCommandOptions {
  json?: boolean;
}

async function fetchSilent<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

function fetchProject(args: {
  client: Client;
  projectId: string;
}): Promise<ProjectResponse | null> {
  return fetchSilent(() =>
    unwrap<ProjectResponse>(
      args.client.api.v1.projects[":id"].$get({
        param: { id: args.projectId },
      }),
    ),
  );
}

function fetchThread(args: {
  client: Client;
  threadId: string;
}): Promise<ThreadResponse | null> {
  return fetchSilent(() =>
    unwrap<ThreadResponse>(
      args.client.api.v1.threads[":id"].$get({
        param: { id: args.threadId },
      }),
    ),
  );
}

function fetchManagedThreads(args: {
  client: Client;
  projectId: string;
  parentThreadId: string;
}): Promise<ThreadListResponse | null> {
  return fetchSilent(() =>
    unwrap<ThreadListResponse>(
      args.client.api.v1.threads.$get({
        query: {
          projectId: args.projectId,
          parentThreadId: args.parentThreadId,
        },
      }),
    ),
  );
}

export function registerStatusCommand(
  program: Command,
  getUrl: () => string,
): void {
  program
    .command("status")
    .description("Show current context")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: StatusCommandOptions) => {
        const context = resolveContextSnapshot();

        const payload: StatusPayload = {
          project: null,
          thread: null,
          managedThreads: null,
          pendingTodos: null,
        };

        let serverAvailable = false;

        // Try to fetch enriched data from the server
        if (context.projectId || context.threadId) {
          const client = createClient(getUrl());

          const [projectResult, threadResult] = await Promise.all([
            context.projectId
              ? fetchProject({ client, projectId: context.projectId })
              : Promise.resolve(null),
            context.threadId
              ? fetchThread({ client, threadId: context.threadId })
              : Promise.resolve(null),
          ]);

          if (projectResult) {
            payload.project = {
              id: projectResult.id,
              name: projectResult.name,
            };
            serverAvailable = true;
          }

          if (threadResult) {
            let environmentInfo: ThreadEnvironmentInfo | null = null;
            if (threadResult.environmentId) {
              environmentInfo = await fetchEnvironmentInfo({
                client,
                environmentId: threadResult.environmentId,
              });
            }

            payload.pendingTodos = await fetchThreadPendingTodos({
              client,
              threadId: threadResult.id,
            });

            payload.thread = {
              id: threadResult.id,
              type: threadResult.type,
              status: threadResult.status,
              latestTerminalSummary: threadResult.latestTerminalSummary,
              title: threadResult.title ?? null,
              parentThreadId: threadResult.parentThreadId ?? null,
              environment: environmentInfo,
            };
            serverAvailable = true;

            // If the thread is a manager, fetch managed (child) threads
            if (threadResult.type === "manager") {
              const managed = await fetchManagedThreads({
                client,
                projectId: threadResult.projectId,
                parentThreadId: threadResult.id,
              });
              if (managed) {
                payload.managedThreads = managed.map((t) => ({
                  id: t.id,
                  status: t.status,
                  latestTerminalSummary: t.latestTerminalSummary,
                  title: t.title ?? null,
                }));
              }
            }
          }
        }

        // JSON output
        if (outputJson(opts, payload)) return;

        // Human-readable output
        if (serverAvailable && payload.project) {
          console.log(
            `Project: ${payload.project.name} (${payload.project.id})`,
          );
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
          const latestTerminal = latestTerminalSummaryText(
            payload.thread.latestTerminalSummary,
          );
          if (latestTerminal) {
            console.log(`  Latest turn: ${latestTerminal}`);
          }
          if (payload.thread.title) {
            console.log(`  Title: ${payload.thread.title}`);
          }
          if (payload.thread.parentThreadId) {
            console.log(`  Parent: ${payload.thread.parentThreadId}`);
          }
          if (payload.thread.environment) {
            printEnvironmentInfo(payload.thread.environment);
          }

          if (payload.managedThreads && payload.managedThreads.length > 0) {
            console.log("");
            console.log(`Managed threads: ${payload.managedThreads.length}`);
            for (const mt of payload.managedThreads) {
              const title = mt.title ? `"${mt.title}"` : "";
              const latest = latestTerminalSummaryText(
                mt.latestTerminalSummary,
              );
              const latestText = latest ? `  latest: ${latest}` : "";
              console.log(`  ${mt.id}  ${mt.status}${latestText}  ${title}`);
            }
          }

          printPendingTodos(payload.pendingTodos);
        } else if (context.threadId) {
          console.log(`Thread: ${context.threadId}`);
        } else {
          console.log("Thread: (not set)");
        }

        if (!context.projectId && !context.threadId) {
          console.log("");
          console.log("Tip: run bb guide for help getting started.");
        }
      }),
    );
}
