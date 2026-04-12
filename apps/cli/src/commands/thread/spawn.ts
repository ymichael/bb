import { Command } from "commander";
import type { Thread } from "@bb/domain";
import type { EnvironmentArgs } from "@bb/server-contract";
import { action } from "../../action.js";
import { createClient, unwrap } from "../../client.js";
import {
  requireProjectId,
  resolveEnvironmentId,
  resolveThreadId,
} from "../../context-env.js";
import { fetchLocalHostId } from "../../daemon.js";
import {
  outputJson,
  parseReasoningLevel,
  prependErrorContext,
} from "../helpers.js";
import {
  parsePermissionMode,
  parseServiceTier,
  statusText,
} from "./helpers.js";

interface ThreadSpawnCommandOptions {
  prompt: string;
  json?: boolean;
  project?: string;
  environment?: string;
  newEnvironment?: string;
  parentThread?: string;
  provider?: string;
  model?: string;
  reasoningLevel?: string;
  title?: string;
  serviceTier?: string;
  host?: string;
  permissionMode?: string;
  contextParentThread?: boolean;
}

export function looksLikePath(value: string): boolean {
  return value.includes("/") || value.startsWith(".") || value.startsWith("~");
}

export function requireHostId(hostId: string | null): string {
  if (!hostId) {
    throw new Error("Cannot reach local host daemon. Is it running?");
  }
  return hostId;
}

export function buildSpawnEnvironment(args: {
  environmentValue?: string;
  newEnvironmentKind?: string;
  hostId: string | null;
  explicitHost?: boolean;
}): EnvironmentArgs {
  const environmentValue = args.environmentValue?.trim();
  const newEnvironmentKind = args.newEnvironmentKind?.trim();

  if (environmentValue && newEnvironmentKind) {
    throw new Error("Cannot combine --environment with --new-environment.");
  }
  if (newEnvironmentKind) {
    if (newEnvironmentKind.startsWith("sandbox/")) {
      const sandboxType = newEnvironmentKind.slice("sandbox/".length);
      if (!sandboxType) {
        throw new Error("Missing sandbox type after 'sandbox/'. Example: sandbox/e2b.");
      }
      if (args.explicitHost) {
        throw new Error("Cannot combine --host with sandbox environments. Sandbox environments provision their own hosts.");
      }
      return { type: "sandbox-host", sandboxType };
    }
    if (newEnvironmentKind === "worktree") {
      return {
        type: "host",
        hostId: requireHostId(args.hostId),
        workspace: { type: "managed-worktree" },
      };
    }
    throw new Error(
      `Unknown environment kind '${newEnvironmentKind}'. Supported: worktree, sandbox/<type>.`,
    );
  }
  if (!environmentValue) {
    return {
      type: "host",
      hostId: requireHostId(args.hostId),
      workspace: { type: "unmanaged", path: null },
    };
  }
  if (looksLikePath(environmentValue)) {
    return {
      type: "host",
      hostId: requireHostId(args.hostId),
      workspace: { type: "unmanaged", path: environmentValue },
    };
  }
  return {
    type: "reuse",
    environmentId: environmentValue,
  };
}

export function registerSpawnCommand(
  parent: Command,
  getUrl: () => string,
): void {
  parent
    .command("spawn")
    .description(
      "Spawn a new thread for a project; omitted provider and execution flags inherit remembered project defaults",
    )
    .requiredOption("--prompt <prompt>", "Initial prompt for the thread")
    .option("--json", "Print machine-readable JSON output")
    .option("--project <id>", "Project ID (defaults to BB_PROJECT_ID)")
    .option(
      "--environment <id-or-path>",
      "Existing environment UUID or unmanaged workspace path",
    )
    .option(
      "--new-environment <kind>",
      "Create a new managed environment of the given kind (worktree, sandbox/e2b)",
    )
    .option(
      "--parent-thread <id>",
      "Parent thread ID for worker thread links (defaults to BB_THREAD_ID)",
    )
    .option(
      "--provider <id>",
      "Provider ID for the thread. Omit to use the project's remembered provider choice for standard threads",
    )
    .option(
      "--model <model>",
      "Model ID for the thread. Omit to use the project's remembered default for the resolved provider",
    )
    .option(
      "--reasoning-level <level>",
      "Reasoning level: low, medium, high, xhigh",
    )
    .option("--title <title>", "Thread title")
    .option("--service-tier <tier>", "Service tier: fast or flex")
    .option("--permission-mode <mode>", "Permission mode: readonly, workspace-write, or full")
    .option("--host <id>", "Host ID (defaults to local host)")
    .option(
      "--no-context-parent-thread",
      "Do not default parent thread context to BB_THREAD_ID",
    )
    .action(action(async (opts: ThreadSpawnCommandOptions) => {
      const client = createClient(getUrl());
      if (opts.parentThread && opts.contextParentThread === false) {
        throw new Error(
          "Cannot combine --parent-thread with --no-context-parent-thread.",
        );
      }

      const projectId = requireProjectId(opts.project);
      const environmentValue = resolveEnvironmentId(opts.environment);
      let hostId: string | null = opts.host ?? null;
      if (!hostId) {
        hostId = await fetchLocalHostId();
      }
      const environment = buildSpawnEnvironment({
        environmentValue,
        newEnvironmentKind: opts.newEnvironment,
        hostId,
        explicitHost: !!opts.host,
      });
      const reasoningLevel = parseReasoningLevel(opts.reasoningLevel);
      const serviceTier = parseServiceTier(opts.serviceTier);
      const permissionMode = parsePermissionMode(opts.permissionMode);
      const parentThreadId =
        opts.parentThread ??
        (opts.contextParentThread === false ? undefined : resolveThreadId());

      let thread: Thread;
      try {
        thread = await unwrap<Thread>(
          client.api.v1.threads.$post({
            json: {
              origin: "cli",
              projectId,
              ...(opts.provider ? { providerId: opts.provider } : {}),
              ...(opts.model ? { model: opts.model } : {}),
              input: [{ type: "text", text: opts.prompt }],
              ...(reasoningLevel ? { reasoningLevel } : {}),
              ...(opts.title ? { title: opts.title } : {}),
              ...(serviceTier ? { serviceTier } : {}),
              ...(permissionMode ? { permissionMode } : {}),
              environment,
              ...(parentThreadId ? { parentThreadId } : {}),
            },
          }),
        );
      } catch (err: unknown) {
        throw prependErrorContext("Failed to create thread", err);
      }

      if (outputJson(opts, thread)) return;
      console.log(`Thread spawned: ${thread.id}`);
      if (
        thread.parentThreadId &&
        thread.parentThreadId === resolveThreadId()
      ) {
        console.log("You will be notified when this thread is done.");
      }
      printThread(thread);
    }));
}

function printThread(thread: Thread): void {
  console.log("");
  console.log(`  ID:       ${thread.id}`);
  console.log(`  Project:  ${thread.projectId}`);
  console.log(`  Status:   ${statusText(thread.status)}`);
  if (thread.archivedAt !== null) {
    console.log(`  Archived: ${new Date(thread.archivedAt).toLocaleString()}`);
  }
  console.log(`  Created:  ${new Date(thread.createdAt).toLocaleString()}`);
  console.log(`  Updated:  ${new Date(thread.updatedAt).toLocaleString()}`);
  console.log("");
}
