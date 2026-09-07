import { Command } from "commander";
import {
  threadVisibilitySchema,
  type PromptInput,
  type Thread,
} from "@bb/domain";
import type { EnvironmentArgs } from "@bb/server-contract";
import { action } from "../../action.js";
import { createCliBbSdk } from "../../client.js";
import { resolveExplicitIdFlag } from "../../context-env.js";
import { outputJson, prependErrorContext } from "../helpers.js";
import {
  buildPromptInputs,
  collectOption,
  parsePermissionMode,
  PERMISSION_MODE_HELP,
} from "./helpers.js";
import {
  buildSpawnEnvironment,
  looksLikePath,
  resolveSpawnEnvironmentValue,
} from "./spawn.js";

interface ThreadForkCommandOptions {
  agentContextSeed?: string;
  baseBranch?: string;
  environment?: string;
  file?: string[];
  image?: string[];
  json?: boolean;
  newEnvironment?: string;
  permissionMode?: string;
  prompt?: string;
  sourceSeqEnd?: string;
  title?: string;
  visibility?: string;
}

function parseSourceSeqEnd(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error("--source-seq-end must be a non-negative integer.");
  }
  return parsed;
}

function buildForkInput(
  opts: ThreadForkCommandOptions,
): PromptInput[] | undefined {
  const files = opts.file ?? [];
  const images = opts.image ?? [];
  if (opts.prompt === undefined && files.length === 0 && images.length === 0) {
    return undefined;
  }
  if (opts.prompt !== undefined) {
    return buildPromptInputs({ message: opts.prompt, files, images });
  }
  return [
    ...files.map((path): PromptInput => ({ type: "localFile", path })),
    ...images.map((path): PromptInput => ({ type: "localImage", path })),
  ];
}

async function resolveForkSourceHostId(
  sdk: ReturnType<typeof createCliBbSdk>,
  sourceThreadId: string,
): Promise<string> {
  const sourceThread = await sdk.threads.get({ threadId: sourceThreadId });
  if (sourceThread.environmentId === null) {
    throw new Error("Source thread has no environment.");
  }
  const sourceEnvironment = await sdk.environments.get({
    environmentId: sourceThread.environmentId,
  });
  return sourceEnvironment.hostId;
}

function describeForkEnvironment(
  environment: EnvironmentArgs | undefined,
): string {
  if (environment === undefined) return "source environment";
  if (environment.type === "reuse") return environment.environmentId;
  if (environment.workspace.type === "managed-worktree") {
    return "new worktree";
  }
  if (environment.workspace.type === "personal") return "new personal";
  return environment.workspace.path ?? "host project source";
}

export function registerForkCommand(
  parent: Command,
  getUrl: () => string,
): void {
  parent
    .command("fork <source-thread-id>")
    .description("Fork a thread at its tip or a source event sequence")
    .option("--prompt <prompt>", "Optional first prompt; omit for an idle fork")
    .option("--title <title>", "Thread title")
    .option(
      "--source-seq-end <seq>",
      "Fork after the source turn containing this event sequence",
    )
    .option(
      "--environment <id-or-path>",
      "Existing environment ID or unmanaged workspace path",
    )
    .option(
      "--new-environment <kind>",
      "Create a fresh environment of the given kind (personal or worktree)",
    )
    .option(
      "--base-branch <branch>",
      "Exact Git ref; omit for bb's project default (use origin/<branch> for a remote ref)",
    )
    .option("--permission-mode <mode>", PERMISSION_MODE_HELP)
    .option("--visibility <visibility>", "Thread visibility: visible or hidden")
    .option(
      "--agent-context-seed <text>",
      "Persist agent-only context on the fork start",
    )
    .option(
      "--file <path>",
      "Pass a host-readable absolute or uploaded attachment file path (repeatable)",
      collectOption,
      [],
    )
    .option(
      "--image <path>",
      "Pass a host-readable absolute or uploaded attachment image path (repeatable)",
      collectOption,
      [],
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (sourceThreadIdValue: string, opts: ThreadForkCommandOptions) => {
          const sourceThreadId = resolveExplicitIdFlag({
            flagName: "source thread ID",
            value: sourceThreadIdValue,
          });
          if (!sourceThreadId) {
            throw new Error("Source thread ID is required.");
          }
          const input = buildForkInput(opts);
          const sourceSeqEnd = parseSourceSeqEnd(opts.sourceSeqEnd);
          const permissionMode = parsePermissionMode(opts.permissionMode);
          const visibility =
            opts.visibility === undefined
              ? undefined
              : threadVisibilitySchema.parse(opts.visibility);
          const environmentValue = resolveSpawnEnvironmentValue(
            opts.environment,
          );

          let thread: Thread;
          let environment: EnvironmentArgs | undefined;
          try {
            const sdk = createCliBbSdk(getUrl());
            const needsHostId =
              Boolean(opts.newEnvironment) ||
              (environmentValue !== undefined &&
                looksLikePath(environmentValue));
            const hostId = needsHostId
              ? await resolveForkSourceHostId(sdk, sourceThreadId)
              : null;
            environment =
              environmentValue === undefined &&
              opts.newEnvironment === undefined &&
              opts.baseBranch === undefined
                ? undefined
                : buildSpawnEnvironment({
                    defaultPersonalWorkspace: false,
                    environmentValue,
                    newEnvironmentKind: opts.newEnvironment,
                    hostId,
                    baseBranch: opts.baseBranch,
                  });
            thread = await sdk.threads.fork({
              sourceThreadId,
              origin: "cli",
              ...(environment === undefined ? {} : { environment }),
              ...(input === undefined ? {} : { input }),
              ...(sourceSeqEnd === undefined ? {} : { sourceSeqEnd }),
              ...(opts.title === undefined ? {} : { title: opts.title }),
              ...(permissionMode === undefined ? {} : { permissionMode }),
              ...(visibility === undefined ? {} : { visibility }),
              ...(opts.agentContextSeed === undefined
                ? {}
                : {
                    agentContextSeed: [
                      {
                        type: "text",
                        text: opts.agentContextSeed,
                        mentions: [],
                        visibility: "agent-only" as const,
                      },
                    ],
                  }),
            });
          } catch (error: unknown) {
            throw prependErrorContext(
              `Failed to fork thread ${sourceThreadId}`,
              error,
            );
          }

          if (outputJson(opts, thread)) return;
          console.log(`Thread forked: ${thread.id}`);
          console.log(`Source: ${sourceThreadId}`);
          console.log(`Status: ${thread.status}`);
          console.log(`Environment: ${describeForkEnvironment(environment)}`);
          if (thread.visibility === "hidden") {
            console.log("Visibility: hidden");
          }
        },
      ),
    );
}
