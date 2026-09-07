import { Command } from "commander";
import type { CommitActionResponse } from "@bb/server-contract";
import type {
  EnvironmentDiffArgs,
  EnvironmentDiffFileArgs,
  EnvironmentDiffPatchArgs,
  EnvironmentUpdateArgs,
} from "@bb/sdk";
import {
  environmentStatusSchema,
  environmentStatusValues,
  type EnvironmentStatus,
} from "@bb/domain";
import { action } from "../action.js";
import { createCliBbSdk } from "../client.js";
import { resolveMachineHostId, resolveMachineTargetOption } from "./machine.js";
import {
  outputJson,
  prependErrorContext,
  printEnvironmentGitOperationResult,
} from "./helpers.js";

interface EnvironmentCommitCommandOptions {
  json?: boolean;
}

interface EnvironmentListCommandOptions {
  host?: string;
  instanceKey?: string;
  json?: boolean;
  limit?: string;
  offset?: string;
  project?: string;
  provider?: string;
  status?: string;
}

interface EnvironmentProvidersCommandOptions {
  json?: boolean;
  project?: string;
  machine?: string;
  host?: string;
}

interface EnvironmentShowCommandOptions {
  json?: boolean;
}

interface EnvironmentStatusCommandOptions {
  json?: boolean;
  mergeBaseBranch?: string;
}

interface EnvironmentBranchesCommandOptions {
  json?: boolean;
  limit?: string;
  query?: string;
}

interface EnvironmentPathsCommandOptions {
  directories?: boolean;
  files?: boolean;
  json?: boolean;
  limit?: string;
  query?: string;
}

interface EnvironmentDiffCommandOptions {
  json?: boolean;
  mergeBaseBranch?: string;
  sha?: string;
  target: string;
}

interface EnvironmentDiffFileCommandOptions {
  json?: boolean;
  mergeBaseRef?: string;
  path: string;
  sha?: string;
  side: string;
  target: string;
}

interface EnvironmentDiffPatchCommandOptions extends EnvironmentDiffCommandOptions {
  path: string[];
}

interface EnvironmentUpdateCommandOptions {
  clearMergeBaseBranch?: boolean;
  clearName?: boolean;
  json?: boolean;
  mergeBaseBranch?: string;
  name?: string;
}

interface EnvironmentPullRequestCommandOptions {
  json?: boolean;
  method?: "merge" | "squash" | "rebase";
}

interface BuildEnvironmentUpdateArgsInput {
  id: string;
  opts: EnvironmentUpdateCommandOptions;
}

function parseEnvironmentStatus(value: string): EnvironmentStatus {
  const parsed = environmentStatusSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `--status must be one of ${environmentStatusValues.join(", ")}.`,
    );
  }
  return parsed.data;
}

function validateLimit(limit: string | undefined): void {
  if (limit !== undefined && !/^\d+$/u.test(limit)) {
    throw new Error("--limit must contain only digits.");
  }
}

function parseNonNegativeIntegerOption(
  value: string | undefined,
  optionName: "--limit" | "--offset",
): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/u.test(value)) {
    throw new Error(`${optionName} must be a non-negative integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${optionName} must be a non-negative integer.`);
  }
  return parsed;
}

function booleanQueryValue(value: boolean): "true" | "false" {
  return value ? "true" : "false";
}

function parseDiffFileSide(value: string): "old" | "new" {
  switch (value) {
    case "old":
      return "old";
    case "new":
      return "new";
    default:
      throw new Error("--side must be old or new.");
  }
}

function buildEnvironmentDiffArgs(
  id: string,
  opts: EnvironmentDiffCommandOptions,
): EnvironmentDiffArgs {
  switch (opts.target) {
    case "uncommitted":
      if (opts.mergeBaseBranch !== undefined || opts.sha !== undefined) {
        throw new Error(
          "--target uncommitted cannot be combined with --merge-base-branch or --sha.",
        );
      }
      return { environmentId: id, target: "uncommitted" };
    case "branch_committed":
    case "all":
      if (!opts.mergeBaseBranch) {
        throw new Error(
          `--merge-base-branch is required when --target ${opts.target} is used.`,
        );
      }
      if (opts.sha !== undefined) {
        throw new Error(
          `--target ${opts.target} cannot be combined with --sha.`,
        );
      }
      return {
        environmentId: id,
        target: opts.target,
        mergeBaseBranch: opts.mergeBaseBranch,
      };
    case "commit":
      if (!opts.sha) {
        throw new Error("--sha is required when --target commit is used.");
      }
      if (opts.mergeBaseBranch !== undefined) {
        throw new Error(
          "--target commit cannot be combined with --merge-base-branch.",
        );
      }
      return { environmentId: id, target: "commit", sha: opts.sha };
    default:
      throw new Error(
        "--target must be uncommitted, branch_committed, all, or commit.",
      );
  }
}

function buildEnvironmentDiffFileArgs(
  id: string,
  opts: EnvironmentDiffFileCommandOptions,
): EnvironmentDiffFileArgs {
  const side = parseDiffFileSide(opts.side);
  const common = {
    environmentId: id,
    path: opts.path,
    side,
  };
  switch (opts.target) {
    case "uncommitted":
      if (opts.mergeBaseRef !== undefined || opts.sha !== undefined) {
        throw new Error(
          "--target uncommitted cannot be combined with --merge-base-ref or --sha.",
        );
      }
      return { ...common, target: "uncommitted" };
    case "branch_committed":
      if (!opts.mergeBaseRef) {
        throw new Error(
          `--merge-base-ref is required when --target ${opts.target} is used.`,
        );
      }
      if (opts.sha !== undefined) {
        throw new Error(
          `--target ${opts.target} cannot be combined with --sha.`,
        );
      }
      return {
        ...common,
        target: opts.target,
        mergeBaseRef: opts.mergeBaseRef,
      };
    case "all":
      if (!opts.mergeBaseRef) {
        throw new Error(
          `--merge-base-ref is required when --target ${opts.target} is used.`,
        );
      }
      if (opts.sha !== undefined) {
        throw new Error(
          `--target ${opts.target} cannot be combined with --sha.`,
        );
      }
      return {
        ...common,
        target: "all",
        mergeBaseRef: opts.mergeBaseRef,
      };
    case "commit":
      if (!opts.sha) {
        throw new Error("--sha is required when --target commit is used.");
      }
      if (opts.mergeBaseRef !== undefined) {
        throw new Error(
          "--target commit cannot be combined with --merge-base-ref.",
        );
      }
      return { ...common, target: "commit", sha: opts.sha };
    default:
      throw new Error(
        "--target must be uncommitted, branch_committed, all, or commit.",
      );
  }
}

function buildEnvironmentDiffPatchArgs(
  id: string,
  opts: EnvironmentDiffPatchCommandOptions,
): EnvironmentDiffPatchArgs {
  if (opts.path.length === 0) {
    throw new Error("Provide at least one --path.");
  }
  const diffArgs = buildEnvironmentDiffArgs(id, opts);
  switch (diffArgs.target) {
    case "uncommitted":
      return {
        environmentId: id,
        paths: opts.path,
        target: { type: "uncommitted" },
      };
    case "branch_committed":
    case "all":
      return {
        environmentId: id,
        paths: opts.path,
        target: {
          type: diffArgs.target,
          mergeBaseBranch: diffArgs.mergeBaseBranch,
        },
      };
    case "commit":
      return {
        environmentId: id,
        paths: opts.path,
        target: { type: "commit", sha: diffArgs.sha },
      };
  }
}

function collectPath(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function buildEnvironmentUpdateArgs({
  id,
  opts,
}: BuildEnvironmentUpdateArgsInput): EnvironmentUpdateArgs {
  if (opts.clearMergeBaseBranch === true) {
    if (opts.clearName === true) {
      return { environmentId: id, mergeBaseBranch: null, name: null };
    }
    if (opts.name !== undefined) {
      return { environmentId: id, mergeBaseBranch: null, name: opts.name };
    }
    return { environmentId: id, mergeBaseBranch: null };
  }

  if (opts.mergeBaseBranch !== undefined) {
    const mergeBaseBranch = opts.mergeBaseBranch;
    if (opts.clearName === true) {
      return { environmentId: id, mergeBaseBranch, name: null };
    }
    if (opts.name !== undefined) {
      return { environmentId: id, mergeBaseBranch, name: opts.name };
    }
    return { environmentId: id, mergeBaseBranch };
  }

  if (opts.clearName === true) {
    return { environmentId: id, name: null };
  }

  if (opts.name !== undefined) {
    return { environmentId: id, name: opts.name };
  }

  throw new Error(
    "No changes requested. Provide --merge-base-branch, --clear-merge-base-branch, --name, or --clear-name.",
  );
}

export function registerEnvironmentCommands(
  program: Command,
  getUrl: () => string,
): void {
  const environment = program
    .command("environment")
    .description("Inspect and operate on first-class environments");

  environment
    .command("providers")
    .description("List registered environment providers")
    .option("--project <id>", "Show availability for this project")
    .option("--machine <id-or-name>", "Show availability on this machine")
    .option("--host <id-or-name>", "Alias for --machine")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: EnvironmentProvidersCommandOptions) => {
        const machineTarget = resolveMachineTargetOption(opts);
        if (machineTarget !== undefined && opts.project === undefined) {
          throw new Error("--machine or --host requires --project <id>.");
        }
        const hostId =
          machineTarget === undefined
            ? undefined
            : await resolveMachineHostId({
                serverUrl: getUrl(),
                target: machineTarget,
              });
        const providers = await createCliBbSdk(
          getUrl(),
        ).environments.listProviders({
          ...(opts.project === undefined ? {} : { projectId: opts.project }),
          ...(hostId === undefined ? {} : { hostId }),
        });
        if (outputJson(opts, providers)) return;
        if (providers.length === 0) {
          console.log("No environment providers available");
          return;
        }
        for (const provider of providers) {
          const requirements = Object.entries(provider.requires)
            .filter(([, required]) => required)
            .map(([name]) => name)
            .join(", ");
          const inputs =
            provider.inputs === null ? "" : "  takes --environment-inputs";
          const availability =
            provider.availability === null
              ? ""
              : provider.availability.status === "available"
                ? "  available"
                : `  ${provider.availability.status}: ${provider.availability.message}`;
          console.log(
            `${provider.id}  ${provider.displayName}  ${requirements || "-"}${inputs}${availability}`,
          );
        }
      }),
    );

  environment
    .command("list")
    .description("List environments, including destroyed ones when requested")
    .option("--project <id>", "Only environments in this project")
    .option(
      "--provider <id>",
      "Only environments produced by this environment provider",
    )
    .option("--host <id-or-name>", "Only environments on this machine")
    .option(
      "--instance-key <key>",
      "Only the environment its provider named with this instance key",
    )
    .option(
      "--status <status>",
      "Only environments in this status: provisioning, ready, error, destroyed",
    )
    .option("--limit <n>", "At most this many rows, oldest first")
    .option("--offset <n>", "Skip this many rows")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: EnvironmentListCommandOptions) => {
        const limit = parseNonNegativeIntegerOption(opts.limit, "--limit");
        const offset = parseNonNegativeIntegerOption(opts.offset, "--offset");
        const sdk = createCliBbSdk(getUrl());
        const hostId =
          opts.host === undefined
            ? undefined
            : await resolveMachineHostId({
                serverUrl: getUrl(),
                target: opts.host,
              });
        const rows = await sdk.environments.list({
          ...(opts.project ? { projectId: opts.project } : {}),
          ...(opts.provider ? { environmentProviderId: opts.provider } : {}),
          ...(opts.instanceKey ? { instanceKey: opts.instanceKey } : {}),
          ...(hostId === undefined ? {} : { hostId }),
          ...(opts.status === undefined
            ? {}
            : { status: parseEnvironmentStatus(opts.status) }),
          ...(limit === undefined ? {} : { limit }),
          ...(offset === undefined ? {} : { offset }),
        });
        if (outputJson(opts, rows)) return;
        for (const env of rows) {
          console.log(
            `${env.id}  ${env.status}  ${env.environmentProviderId ?? "-"}  ${env.path ?? "-"}`,
          );
        }
      }),
    );

  environment
    .command("delete <id>")
    .description(
      "Request provider cleanup; refused while threads are live or stopping",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (id: string, opts: { json?: boolean }) => {
        const sdk = createCliBbSdk(getUrl());
        const result = await sdk.environments.delete({ environmentId: id });
        if (outputJson(opts, result)) return;
        const environment = await sdk.environments.get({ environmentId: id });
        console.log(`Cleanup requested for environment ${id}.`);
        console.log(`Lifecycle: ${environment.lifecycle.phase}`);
      }),
    );

  environment
    .command("show <id>")
    .description("Show environment details")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (id: string, opts: EnvironmentShowCommandOptions) => {
        const sdk = createCliBbSdk(getUrl());
        const env = await sdk.environments.get({ environmentId: id });
        if (outputJson(opts, env)) return;
        console.log(`Environment: ${env.id}`);
        console.log(`  Project: ${env.projectId}`);
        console.log(`  Status: ${env.status}`);
        console.log(`  Lifecycle: ${env.lifecycle.phase}`);
        if (env.lifecycle.retireAt !== null)
          console.log(
            `  Retire at: ${new Date(env.lifecycle.retireAt).toISOString()}`,
          );
        if (env.lifecycle.teardown !== null) {
          console.log(
            `  Teardown: ${env.lifecycle.teardown.status} (attempt ${env.lifecycle.teardown.attempt})`,
          );
          if (env.lifecycle.teardown.message !== undefined)
            console.log(
              `  Teardown message: ${env.lifecycle.teardown.message}`,
            );
        }
        if (env.path) {
          console.log(`  Path: ${env.path}`);
        }
        if (env.name) {
          console.log(`  Name: ${env.name}`);
        }
        console.log(
          `  Provider: ${env.environmentProviderId ?? "none (attached directory)"}`,
        );
        if (env.branchName) {
          console.log(`  Branch: ${env.branchName}`);
        }
        if (env.defaultBranch) {
          console.log(`  Default branch: ${env.defaultBranch}`);
        }
        if (env.mergeBaseBranch) {
          console.log(`  Merge base: ${env.mergeBaseBranch}`);
        }
        console.log(`  Git repo: ${env.isGitRepo}`);
        console.log(`  Created: ${new Date(env.createdAt).toLocaleString()}`);
        console.log(`  Updated: ${new Date(env.updatedAt).toLocaleString()}`);
      }),
    );

  environment
    .command("status <id>")
    .description("Show an environment's workspace status")
    .option("--merge-base-branch <branch>", "Include merge-base status")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (id: string, opts: EnvironmentStatusCommandOptions) => {
        const result = await createCliBbSdk(getUrl()).environments.status({
          environmentId: id,
          ...(opts.mergeBaseBranch !== undefined
            ? { mergeBaseBranch: opts.mergeBaseBranch }
            : {}),
        });
        if (outputJson(opts, result)) return;
        if (result.outcome === "not_applicable") {
          console.log(`Status unavailable: ${result.message}`);
          return;
        }
        if (result.outcome === "unavailable") {
          console.log(`Status unavailable: ${result.failure.message}`);
          return;
        }
        const status = result.workspace;
        console.log(`State: ${status.workingTree.state}`);
        console.log(`Branch: ${status.branch.currentBranch ?? "(detached)"}`);
        console.log(`Default branch: ${status.branch.defaultBranch}`);
        console.log(`Changed files: ${status.workingTree.files.length}`);
        if (status.workingTree.lineStatsComplete) {
          console.log(`Insertions: +${status.workingTree.insertions}`);
          console.log(`Deletions: -${status.workingTree.deletions}`);
        } else {
          console.log("Line stats: unavailable for untracked files");
        }
        if (status.mergeBase) {
          console.log(`Merge base: ${status.mergeBase.mergeBaseBranch}`);
          console.log(`Ahead: ${status.mergeBase.aheadCount}`);
          console.log(`Behind: ${status.mergeBase.behindCount}`);
        }
      }),
    );

  environment
    .command("branches <id>")
    .description("List branches available in an environment")
    .option("--query <query>", "Branch-name filter")
    .option("--limit <count>", "Maximum local and remote branches")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (id: string, opts: EnvironmentBranchesCommandOptions) => {
        validateLimit(opts.limit);
        const result = await createCliBbSdk(getUrl()).environments.diffBranches(
          {
            environmentId: id,
            ...(opts.query !== undefined ? { query: opts.query } : {}),
            ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
          },
        );
        if (outputJson(opts, result)) return;
        console.log("Local branches:");
        for (const branch of result.branches) console.log(`  ${branch}`);
        if (result.branches.length === 0) console.log("  (none)");
        if (result.branchesTruncated) console.log("  (truncated)");
        console.log("Remote branches:");
        for (const branch of result.remoteBranches) console.log(`  ${branch}`);
        if (result.remoteBranches.length === 0) console.log("  (none)");
        if (result.remoteBranchesTruncated) console.log("  (truncated)");
      }),
    );

  environment
    .command("paths <id>")
    .description("Search an environment's files and directories")
    .option("--query <query>", "Fuzzy path query")
    .option("--limit <count>", "Maximum paths")
    .option("--files", "Include files")
    .option("--directories", "Include directories")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (id: string, opts: EnvironmentPathsCommandOptions) => {
        validateLimit(opts.limit);
        const includeFiles = opts.files === true || opts.directories !== true;
        const includeDirectories =
          opts.directories === true || opts.files !== true;
        const result = await createCliBbSdk(getUrl()).environments.paths({
          environmentId: id,
          includeFiles: booleanQueryValue(includeFiles),
          includeDirectories: booleanQueryValue(includeDirectories),
          ...(opts.query !== undefined ? { query: opts.query } : {}),
          ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
        });
        if (outputJson(opts, result)) return;
        for (const entry of result.paths) {
          console.log(`${entry.kind}\t${entry.path}`);
        }
        if (result.truncated) console.log("(results truncated)");
      }),
    );

  environment
    .command("diff <id>")
    .description("Show an environment's git diff")
    .requiredOption(
      "--target <target>",
      "Diff target: uncommitted, branch_committed, all, or commit",
    )
    .option("--merge-base-branch <branch>", "Branch-based target base")
    .option("--sha <sha>", "Commit target SHA")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (id: string, opts: EnvironmentDiffCommandOptions) => {
        const result = await createCliBbSdk(getUrl()).environments.diff(
          buildEnvironmentDiffArgs(id, opts),
        );
        if (outputJson(opts, result)) return;
        if (result.outcome === "not_applicable") {
          console.log(`Diff unavailable: ${result.message}`);
          return;
        }
        if (result.outcome === "unavailable") {
          console.log(`Diff unavailable: ${result.failure.message}`);
          return;
        }
        if (result.diff.files.trim().length > 0) {
          console.log(result.diff.files.trimEnd());
        }
        if (result.diff.shortstat.trim().length > 0) {
          console.log(result.diff.shortstat.trim());
        }
        if (result.diff.diff.length > 0) {
          console.log(result.diff.diff);
        }
        if (result.diff.truncated) console.log("(diff truncated)");
      }),
    );

  environment
    .command("diff-files <id>")
    .description("List changed files in an environment")
    .requiredOption(
      "--target <target>",
      "Diff target: uncommitted, branch_committed, all, or commit",
    )
    .option("--merge-base-branch <branch>", "Branch-based target base")
    .option("--sha <sha>", "Commit target SHA")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (id: string, opts: EnvironmentDiffCommandOptions) => {
        const result = await createCliBbSdk(getUrl()).environments.diffFiles(
          buildEnvironmentDiffArgs(id, opts),
        );
        if (outputJson(opts, result)) return;
        if (result.outcome === "not_applicable") {
          console.log(`Diff files unavailable: ${result.message}`);
          return;
        }
        if (result.outcome === "unavailable") {
          console.log(`Diff files unavailable: ${result.failure.message}`);
          return;
        }
        for (const file of result.files) {
          const path = file.previousPath
            ? `${file.previousPath} -> ${file.path}`
            : file.path;
          const stats = file.binary
            ? "binary"
            : `+${file.additions} -${file.deletions}`;
          console.log(
            `${file.changeKind}\t${stats}\t${file.origin}\t${file.loadMode}\t${path}`,
          );
        }
        if (result.shortstat.trim().length > 0) {
          console.log(result.shortstat.trim());
        }
        if (result.truncated) {
          console.log("(additional changed files omitted)");
        }
      }),
    );

  environment
    .command("diff-file <id>")
    .description("Read one side of a changed environment file")
    .requiredOption(
      "--target <target>",
      "Diff target: uncommitted, branch_committed, all, or commit",
    )
    .requiredOption("--path <path>", "Repository-relative file path")
    .requiredOption("--side <side>", "File side: old or new")
    .option("--merge-base-ref <sha>", "Resolved merge-base SHA")
    .option("--sha <sha>", "Commit target SHA")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (id: string, opts: EnvironmentDiffFileCommandOptions) => {
        const result = await createCliBbSdk(getUrl()).environments.diffFile(
          buildEnvironmentDiffFileArgs(id, opts),
        );
        if (outputJson(opts, result)) return;
        if (result.contentEncoding === "base64") {
          console.log(`Binary file: ${result.path}`);
          console.log(`Encoding: ${result.contentEncoding}`);
          console.log(`Size: ${result.sizeBytes} bytes`);
          if (result.mimeType) console.log(`MIME type: ${result.mimeType}`);
          console.log(result.content);
          return;
        }
        console.log(result.content);
      }),
    );

  environment
    .command("diff-patch <id>")
    .description("Fetch patches for selected changed files")
    .requiredOption(
      "--target <target>",
      "Diff target: uncommitted, branch_committed, all, or commit",
    )
    .option("--path <path>", "Changed file path (repeatable)", collectPath, [])
    .option("--merge-base-branch <branch>", "Branch-based target base")
    .option("--sha <sha>", "Commit target SHA")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (id: string, opts: EnvironmentDiffPatchCommandOptions) => {
        const result = await createCliBbSdk(getUrl()).environments.diffPatch(
          buildEnvironmentDiffPatchArgs(id, opts),
        );
        if (outputJson(opts, result)) return;
        if (result.outcome === "not_applicable") {
          console.log(`Diff patches unavailable: ${result.message}`);
          return;
        }
        if (result.outcome === "unavailable") {
          console.log(`Diff patches unavailable: ${result.failure.message}`);
          return;
        }
        for (const patch of result.patches) {
          console.log(`File: ${patch.path}`);
          console.log(patch.patch);
          if (patch.truncated) console.log("(patch truncated)");
        }
      }),
    );

  environment
    .command("update <id>")
    .description("Update environment metadata")
    .option(
      "--merge-base-branch <branch>",
      "Set the merge-base branch override",
    )
    .option("--clear-merge-base-branch", "Clear the merge-base branch override")
    .option("--name <name>", "Set the environment display name")
    .option("--clear-name", "Clear the environment display name")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (id: string, opts: EnvironmentUpdateCommandOptions) => {
        const hasMergeBaseBranch = opts.mergeBaseBranch !== undefined;
        const hasClearMergeBaseBranch = opts.clearMergeBaseBranch === true;
        const hasName = opts.name !== undefined;
        const hasClearName = opts.clearName === true;

        if (hasMergeBaseBranch && hasClearMergeBaseBranch) {
          throw new Error(
            "Cannot combine --merge-base-branch with --clear-merge-base-branch.",
          );
        }
        if (hasName && hasClearName) {
          throw new Error("Cannot combine --name with --clear-name.");
        }
        if (opts.name !== undefined && opts.name.trim().length === 0) {
          throw new Error("Environment name cannot be empty.");
        }
        if (
          !hasMergeBaseBranch &&
          !hasClearMergeBaseBranch &&
          !hasName &&
          !hasClearName
        ) {
          throw new Error(
            "No changes requested. Provide --merge-base-branch, --clear-merge-base-branch, --name, or --clear-name.",
          );
        }

        const sdk = createCliBbSdk(getUrl());
        const environment = await sdk.environments.update(
          buildEnvironmentUpdateArgs({ id, opts }),
        );

        if (outputJson(opts, environment)) return;
        console.log(`Environment ${environment.id} updated`);
        if (hasClearMergeBaseBranch || hasMergeBaseBranch) {
          console.log(
            environment.mergeBaseBranch
              ? `Merge base branch: ${environment.mergeBaseBranch}`
              : "Merge base branch cleared",
          );
        }
        if (hasClearName || hasName) {
          console.log(
            environment.name ? `Name: ${environment.name}` : "Name cleared",
          );
        }
      }),
    );

  environment
    .command("commit <id>")
    .description("Commit changes in an environment")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (id: string, opts: EnvironmentCommitCommandOptions) => {
        const sdk = createCliBbSdk(getUrl());
        let result: CommitActionResponse;
        try {
          result = await sdk.environments.commit({ environmentId: id });
        } catch (err: unknown) {
          throw prependErrorContext(
            `Failed to commit in environment ${id}`,
            err,
          );
        }
        if (outputJson(opts, result)) return;
        printEnvironmentGitOperationResult(result);
      }),
    );

  environment
    .command("archive-threads <id>")
    .description("Archive every active thread in an environment")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (id: string, opts: EnvironmentCommitCommandOptions) => {
        const result = await createCliBbSdk(
          getUrl(),
        ).environments.archiveThreads({
          environmentId: id,
        });
        if (outputJson(opts, result)) return;
        console.log(
          `Archived ${result.archivedThreadIds.length} thread(s) in environment ${id}`,
        );
      }),
    );

  const pullRequest = environment
    .command("pull-request")
    .description("Inspect and manage an environment's pull request");

  pullRequest
    .command("show <id>")
    .description("Show an environment's pull request")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (id: string, opts: EnvironmentPullRequestCommandOptions) => {
        const result = await createCliBbSdk(getUrl()).environments.pullRequest({
          environmentId: id,
        });
        if (outputJson(opts, result)) return;
        if (result.outcome === "unavailable") {
          console.log(`Pull request lookup unavailable: ${result.message}`);
          return;
        }
        if (result.outcome === "absent") {
          console.log("No pull request found");
          return;
        }
        const pr = result.pullRequest;
        console.log(`Pull request: #${pr.number} ${pr.state} - ${pr.title}`);
        console.log(`URL: ${pr.url}`);
        console.log(`Branch: ${pr.headRefName} -> ${pr.baseRefName}`);
        console.log(`Attention: ${pr.attention}`);
        console.log(
          `Checks: ${pr.checks.state} (${pr.checks.passedCount} passed, ` +
            `${pr.checks.failedCount} failed, ${pr.checks.pendingCount} pending, ` +
            `${pr.checks.totalCount} total)`,
        );
        console.log(
          `Review: ${pr.review.state} (${pr.review.reviewRequestCount} requested)`,
        );
        console.log(`Merge: ${pr.mergeability.state}`);
      }),
    );

  pullRequest
    .command("ready <id>")
    .description("Mark a pull request ready for review")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (id: string, opts: EnvironmentPullRequestCommandOptions) => {
        const result = await createCliBbSdk(
          getUrl(),
        ).environments.markPullRequestReady({ environmentId: id });
        if (outputJson(opts, result)) return;
        console.log(result.message);
      }),
    );

  pullRequest
    .command("draft <id>")
    .description("Convert a pull request to draft")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (id: string, opts: EnvironmentPullRequestCommandOptions) => {
        const result = await createCliBbSdk(
          getUrl(),
        ).environments.markPullRequestDraft({ environmentId: id });
        if (outputJson(opts, result)) return;
        console.log(result.message);
      }),
    );

  pullRequest
    .command("merge <id>")
    .description("Merge a pull request")
    .option(
      "--method <method>",
      "Merge method: merge, squash, or rebase",
      "merge",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (id: string, opts: EnvironmentPullRequestCommandOptions) => {
        if (
          opts.method !== "merge" &&
          opts.method !== "squash" &&
          opts.method !== "rebase"
        ) {
          throw new Error("--method must be merge, squash, or rebase.");
        }
        const result = await createCliBbSdk(
          getUrl(),
        ).environments.mergePullRequest({
          environmentId: id,
          method: opts.method,
        });
        if (outputJson(opts, result)) return;
        console.log(result.message);
      }),
    );
}
