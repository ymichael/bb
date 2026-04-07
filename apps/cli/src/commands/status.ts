import { Command } from "commander";
import type { Environment, Host, Thread } from "@bb/domain";
import type { ProjectResponse } from "@bb/server-contract";
import {
  type EnvironmentDisplayInfo,
  formatEnvironmentDisplay,
} from "@bb/core-ui";
import { action } from "../action.js";
import { resolveContextSnapshot } from "../context-env.js";
import { type Client, createClient, unwrap } from "../client.js";
import { fetchLocalHostId } from "../daemon.js";
import { outputJson } from "./helpers.js";

interface ThreadEnvironmentInfo {
  display: EnvironmentDisplayInfo;
  hostId: string;
  hostName: string | null;
  isLocalHost: boolean;
}

interface StatusPayload {
  project: { id: string; name: string } | null;
  thread: {
    id: string;
    type: string;
    status: string;
    title: string | null;
    parentThreadId: string | null;
    environment: ThreadEnvironmentInfo | null;
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
}): Promise<Thread | null> {
  return fetchSilent(() =>
    unwrap<Thread>(
      args.client.api.v1.threads[":id"].$get({
        param: { id: args.threadId },
      }),
    ),
  );
}

function fetchHost(args: {
  client: Client;
  hostId: string;
}): Promise<Host | null> {
  return fetchSilent(() =>
    unwrap<Host>(
      args.client.api.v1.hosts[":id"].$get({
        param: { id: args.hostId },
      }),
    ),
  );
}

async function fetchEnvironmentInfo(args: {
  client: Client;
  environmentId: string;
}): Promise<ThreadEnvironmentInfo | null> {
  return fetchSilent(async () => {
    const [env, localHostId] = await Promise.all([
      unwrap<Environment>(
        args.client.api.v1.environments[":id"].$get({
          param: { id: args.environmentId },
        }),
      ),
      fetchLocalHostId(),
    ]);
    const host = await fetchHost({
      client: args.client,
      hostId: env.hostId,
    });
    const isLocal = env.hostId === localHostId;
    return {
      display: formatEnvironmentDisplay({
        environment: env,
        isLocalHost: isLocal,
        hostName: host?.name,
        hostType: host?.type,
      }),
      hostId: env.hostId,
      hostName: host?.name ?? null,
      isLocalHost: isLocal,
    };
  });
}

function fetchManagedThreads(args: {
  client: Client;
  projectId: string;
  parentThreadId: string;
}): Promise<Thread[] | null> {
  return fetchSilent(() =>
    unwrap<Thread[]>(
      args.client.api.v1.threads.$get({
        query: { projectId: args.projectId, parentThreadId: args.parentThreadId },
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

          payload.thread = {
            id: threadResult.id,
            type: threadResult.type,
            status: threadResult.status,
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
          const env = payload.thread.environment;
          const hostLabel = env.hostName ?? env.hostId;
          const hostSuffix = env.isLocalHost ? " (localhost)" : "";
          console.log(`  Host: ${hostLabel}${hostSuffix} (${env.hostId})`);

          console.log(`  Environment: ${env.display.modeLabel} (${env.display.id})`);
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
