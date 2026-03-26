import { Command } from "commander";
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
  message?: string;
  stagedOnly?: boolean;
  json?: boolean;
  thread: string;
}

interface EnvironmentSquashMergeCommandOptions {
  commitIfNeeded?: boolean;
  stagedOnly?: boolean;
  commitMessage?: string;
  squashMessage?: string;
  mergeBaseBranch?: string;
  json?: boolean;
  thread: string;
}

interface EnvironmentPromoteCommandOptions {
  json?: boolean;
  thread: string;
}

interface EnvironmentDemoteCommandOptions {
  json?: boolean;
  thread: string;
}

export function registerEnvironmentCommands(
  program: Command,
  getUrl: () => string,
): void {
  const environment = program
    .command("environment")
    .description("Inspect and operate on first-class environments");

  environment
    .command("commit <id>")
    .description("Commit changes in an environment")
    .requiredOption("--thread <threadId>", "Thread to act on")
    .option("--message <message>", "Commit message hint")
    .option("--staged-only", "Commit only currently staged changes")
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
              threadId: opts.thread,
              options: {
                includeUnstaged: opts.stagedOnly ? false : true,
                ...(opts.message ? { message: opts.message } : {}),
              },
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
    .requiredOption("--thread <threadId>", "Thread to act on")
    .option("--commit-if-needed", "Allow a prep commit before squash merge")
    .option("--staged-only", "Use only staged changes for the prep commit")
    .option("--commit-message <message>", "Prep commit message hint")
    .option("--squash-message <message>", "Squash commit message hint")
    .option("--merge-base-branch <branch>", "Merge-base branch hint")
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
            threadId: opts.thread,
            options: {
              commitIfNeeded: opts.commitIfNeeded === true,
              includeUnstaged: opts.stagedOnly ? false : true,
              ...(opts.commitMessage ? { commitMessage: opts.commitMessage } : {}),
              ...(opts.squashMessage ? { squashMessage: opts.squashMessage } : {}),
              ...(opts.mergeBaseBranch ? { mergeBaseBranch: opts.mergeBaseBranch } : {}),
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
    .requiredOption("--thread <threadId>", "Thread to act on")
    .option("--json", "Print machine-readable JSON output")
    .action(action(async (id: string, opts: EnvironmentPromoteCommandOptions) => {
      const client = createClient(getUrl());
      let result: { ok: true; action: "promote"; message: string };
      try {
        result = await unwrap<{ ok: true; action: "promote"; message: string }>(
          client.api.v1.environments[":id"].actions.$post({
            param: { id },
            json: { action: "promote", threadId: opts.thread },
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
    .requiredOption("--thread <threadId>", "Thread to act on")
    .option("--json", "Print machine-readable JSON output")
    .action(action(async (id: string, opts: EnvironmentDemoteCommandOptions) => {
      const client = createClient(getUrl());
      const result = await unwrap<{ ok: true; action: "demote"; message: string }>(
        client.api.v1.environments[":id"].actions.$post({
          param: { id },
          json: { action: "demote", threadId: opts.thread },
        }),
      );
      if (outputJson(opts, result)) return;
      console.log(result.message);
    }));
}
