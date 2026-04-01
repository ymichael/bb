import { Command } from "commander";
import type { Environment } from "@bb/domain";
import type {
  CommitActionResponse,
  SquashMergeActionResponse,
} from "@bb/server-contract";
import { action } from "../action.js";
import { createClient, unwrap } from "../client.js";
import {
  outputJson,
  prependErrorContext,
  printEnvironmentGitOperationResult,
} from "./helpers.js";

interface EnvironmentCommitCommandOptions {
  json?: boolean;
}

interface EnvironmentUpdateCommandOptions {
  clearMergeBaseBranch?: boolean;
  json?: boolean;
  mergeBaseBranch?: string;
}

interface EnvironmentSquashMergeCommandOptions {
  mergeBaseBranch: string;
  json?: boolean;
}

interface EnvironmentPromoteCommandOptions {
  json?: boolean;
}

interface EnvironmentDemoteCommandOptions {
  json?: boolean;
}

export function registerEnvironmentCommands(
  program: Command,
  getUrl: () => string,
): void {
  const environment = program
    .command("environment")
    .description("Inspect and operate on first-class environments");

  environment
    .command("update <id>")
    .description("Update environment metadata")
    .option("--merge-base-branch <branch>", "Set the merge-base branch override")
    .option("--clear-merge-base-branch", "Clear the merge-base branch override")
    .option("--json", "Print machine-readable JSON output")
    .action(action(async (id: string, opts: EnvironmentUpdateCommandOptions) => {
      const client = createClient(getUrl());
      if (opts.mergeBaseBranch && opts.clearMergeBaseBranch) {
        throw new Error(
          "Cannot combine --merge-base-branch with --clear-merge-base-branch.",
        );
      }
      if (!opts.mergeBaseBranch && !opts.clearMergeBaseBranch) {
        throw new Error(
          "No changes requested. Provide --merge-base-branch or --clear-merge-base-branch.",
        );
      }

      const environment = await unwrap<Environment>(
        client.api.v1.environments[":id"].$patch({
          param: { id },
          json: {
            mergeBaseBranch: opts.clearMergeBaseBranch
              ? null
              : opts.mergeBaseBranch ?? null,
          },
        }),
      );

      if (outputJson(opts, environment)) return;
      console.log(`Environment ${environment.id} updated`);
      console.log(
        environment.mergeBaseBranch
          ? `Merge base branch: ${environment.mergeBaseBranch}`
          : "Merge base branch cleared",
      );
    }));

  environment
    .command("commit <id>")
    .description("Commit changes in an environment")
    .option("--json", "Print machine-readable JSON output")
    .action(action(async (id: string, opts: EnvironmentCommitCommandOptions) => {
      const client = createClient(getUrl());
      let result: CommitActionResponse;
      try {
        result = await unwrap<CommitActionResponse>(
          client.api.v1.environments[":id"].actions.$post({
            param: { id },
            json: {
              action: "commit",
            },
          }),
        );
      } catch (err: unknown) {
        throw prependErrorContext(`Failed to commit in environment ${id}`, err);
      }
      if (outputJson(opts, result)) return;
      printEnvironmentGitOperationResult(result);
    }));

  environment
    .command("squash-merge <id>")
    .description("Squash-merge changes in an environment")
    .requiredOption("--merge-base-branch <branch>", "Merge-base branch")
    .option("--json", "Print machine-readable JSON output")
    .action(action(async (
      id: string,
      opts: EnvironmentSquashMergeCommandOptions,
    ) => {
      const client = createClient(getUrl());
      const result = await unwrap<SquashMergeActionResponse>(
        client.api.v1.environments[":id"].actions.$post({
          param: { id },
          json: {
            action: "squash_merge",
            options: {
              mergeBaseBranch: opts.mergeBaseBranch,
            },
          },
        }),
      );
      if (outputJson(opts, result)) return;
      printEnvironmentGitOperationResult(result);
    }));

  environment
    .command("promote <id>")
    .description("Promote an environment into the primary checkout")
    .option("--json", "Print machine-readable JSON output")
    .action(action(async (id: string, opts: EnvironmentPromoteCommandOptions) => {
      const client = createClient(getUrl());
      let result: { ok: true; action: "promote"; message: string };
      try {
        result = await unwrap<{ ok: true; action: "promote"; message: string }>(
          client.api.v1.environments[":id"].actions.$post({
            param: { id },
            json: { action: "promote" },
          }),
        );
      } catch (err: unknown) {
        throw prependErrorContext(`Failed to promote environment ${id}`, err);
      }
      if (outputJson(opts, result)) return;
      console.log(result.message);
    }));

  environment
    .command("demote <id>")
    .description("Demote an environment from the primary checkout")
    .option("--json", "Print machine-readable JSON output")
    .action(action(async (id: string, opts: EnvironmentDemoteCommandOptions) => {
      const client = createClient(getUrl());
      const result = await unwrap<{ ok: true; action: "demote"; message: string }>(
        client.api.v1.environments[":id"].actions.$post({
          param: { id },
          json: { action: "demote" },
        }),
      );
      if (outputJson(opts, result)) return;
      console.log(result.message);
    }));
}
