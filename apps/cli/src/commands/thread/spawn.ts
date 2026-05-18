import { Command } from "commander";
import type { Thread } from "@bb/domain";
import type { BaseBranchSpec, EnvironmentArgs } from "@bb/server-contract";
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
  PERMISSION_MODE_HELP,
  parseServiceTier,
  statusText,
} from "./helpers.js";

interface ThreadSpawnCommandOptions {
  prompt: string;
  json?: boolean;
  project?: string;
  environment?: string;
  newEnvironment?: string;
  baseBranch?: string;
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
  baseBranch?: string;
}): EnvironmentArgs {
  const environmentValue = args.environmentValue?.trim();
  const newEnvironmentKind = args.newEnvironmentKind?.trim();
  const trimmedBaseBranch = args.baseBranch?.trim();
  const baseBranch: BaseBranchSpec = trimmedBaseBranch
    ? { kind: "named", name: trimmedBaseBranch }
    : { kind: "default" };

  if (environmentValue && newEnvironmentKind) {
    throw new Error("Cannot combine --environment with --new-environment.");
  }
  if (newEnvironmentKind) {
    if (newEnvironmentKind === "worktree") {
      return {
        type: "host",
        hostId: requireHostId(args.hostId),
        workspace: { type: "managed-worktree", baseBranch },
      };
    }
    throw new Error(
      `Unknown environment kind '${newEnvironmentKind}'. Supported: worktree.`,
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
      "Create a new managed environment of the given kind (worktree)",
    )
    .option(
      "--base-branch <branch>",
      "Base branch for new managed environments (worktree). Defaults to the source's default branch.",
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
      "Reasoning level: low, medium, high, xhigh, max (provider-dependent)",
    )
    .option("--title <title>", "Thread title")
    .option("--service-tier <tier>", "Service tier: fast or default")
    .option("--permission-mode <mode>", PERMISSION_MODE_HELP)
    .option("--host <id>", "Host ID (defaults to local host)")
    .option(
      "--no-context-parent-thread",
      "Do not default parent thread context to BB_THREAD_ID",
    )
    .action(
      action(async (opts: ThreadSpawnCommandOptions) => {
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
          baseBranch: opts.baseBranch,
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
      }),
    );
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
