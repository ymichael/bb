import { Command } from "commander";
import type {
  CommitActionResponse,
  SquashMergeActionResponse,
} from "@bb/server-contract";
import { action } from "../action.js";
import { createClient, unwrap } from "../client.js";
import { resolveThreadId } from "../context-env.js";
import {
  outputJson,
  prependErrorContext,
  printEnvironmentGitOperationResult,
  requireThreadIdOrSelf,
} from "./helpers.js";

interface EnvironmentCommitCommandOptions {
  thread?: string;
  self?: boolean;
  message?: string;
  stagedOnly?: boolean;
  json?: boolean;
}

interface EnvironmentSquashMergeCommandOptions {
  thread?: string;
  self?: boolean;
  commitIfNeeded?: boolean;
  stagedOnly?: boolean;
  commitMessage?: string;
  squashMessage?: string;
  mergeBaseBranch?: string;
  json?: boolean;
}

interface EnvironmentPromoteCommandOptions {
  thread?: string;
  json?: boolean;
}

interface EnvironmentDemoteCommandOptions {
  thread?: string;
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
    .command("commit <id>")
    .description("Commit changes in an environment")
    .option("--thread <thread-id>", "Initiating thread ID")
    .option("--self", "Use BB_THREAD_ID as the initiating thread")
    .option("--message <message>", "Commit message hint")
    .option("--staged-only", "Commit only currently staged changes")
    .option("--json", "Print machine-readable JSON output")
    .action(action(async (id: string, opts: EnvironmentCommitCommandOptions) => {
      const client = createClient(getUrl());
      const initiatingThreadId = requireThreadIdOrSelf(opts.thread, opts);
      let result: CommitActionResponse;
      try {
        result = await unwrap<CommitActionResponse>(
          client.api.v1.environments[":id"].actions.$post({
            param: { id },
            json: {
              action: "commit",
              initiatingThreadId,
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
    .option("--thread <thread-id>", "Initiating thread ID")
    .option("--self", "Use BB_THREAD_ID as the initiating thread")
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
      const initiatingThreadId = requireThreadIdOrSelf(opts.thread, opts);
      const result = await unwrap<SquashMergeActionResponse>(
        client.api.v1.environments[":id"].actions.$post({
          param: { id },
          json: {
            action: "squash_merge",
            initiatingThreadId,
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
    .option("--thread <id>", "Thread ID attached to the environment (defaults to BB_THREAD_ID)")
    .option("--json", "Print machine-readable JSON output")
    .action(action(async (id: string, opts: EnvironmentPromoteCommandOptions) => {
      const client = createClient(getUrl());
      const threadId = opts.thread ?? resolveThreadId();
      if (!threadId) {
        throw new Error("A thread id is required. Pass --thread or set BB_THREAD_ID.");
      }
      let result: { ok: true; action: "promote"; message: string };
      try {
        result = await unwrap<{ ok: true; action: "promote"; message: string }>(
          client.api.v1.environments[":id"].actions.$post({
            param: { id },
            json: { action: "promote", initiatingThreadId: threadId },
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
    .option("--thread <id>", "Thread ID attached to the environment (defaults to BB_THREAD_ID)")
    .option("--json", "Print machine-readable JSON output")
    .action(action(async (id: string, opts: EnvironmentDemoteCommandOptions) => {
      const client = createClient(getUrl());
      const threadId = opts.thread ?? resolveThreadId();
      if (!threadId) {
        throw new Error("A thread id is required. Pass --thread or set BB_THREAD_ID.");
      }
      const result = await unwrap<{ ok: true; action: "demote"; message: string }>(
        client.api.v1.environments[":id"].actions.$post({
          param: { id },
          json: { action: "demote", initiatingThreadId: threadId },
        }),
      );
      if (outputJson(opts, result)) return;
      console.log(result.message);
    }));
}
