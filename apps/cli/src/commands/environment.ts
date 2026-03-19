import { Command } from "commander";
import type {
  CommitEnvironmentOperationResponse,
  SquashMergeEnvironmentOperationResponse,
  Thread,
} from "@bb/core";
import { createClient, unwrap } from "../client.js";
import { requireProjectId, resolveThreadId } from "../context-env.js";
import {
  getErrorMessage,
  outputJson,
  printEnvironmentGitOperationResult,
  printContextLabel,
  resolveProjectIdWithLabel,
  resolveThreadIdOrSelf,
} from "./helpers.js";

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
    .action(async (
      id: string,
      opts: {
        thread?: string;
        self?: boolean;
        message?: string;
        stagedOnly?: boolean;
        json?: boolean;
      },
    ) => {
      const client = createClient(getUrl());
      try {
        const initiatingThreadId = resolveThreadIdOrSelf(opts.thread, opts);
        const result = await unwrap<CommitEnvironmentOperationResponse>(
          client.api.v1.environments[":id"].operations.$post({
            param: { id },
            json: {
              operation: "commit",
              initiatingThreadId,
              options: {
                includeUnstaged: opts.stagedOnly ? false : true,
                ...(opts.message ? { message: opts.message } : {}),
              },
            },
          }),
        );
        if (outputJson(opts, result)) return;
        printEnvironmentGitOperationResult(result);
      } catch (err: unknown) {
        console.error(`Error: ${getErrorMessage(err)}`);
        process.exit(1);
      }
    });

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
    .action(async (
      id: string,
      opts: {
        thread?: string;
        self?: boolean;
        commitIfNeeded?: boolean;
        stagedOnly?: boolean;
        commitMessage?: string;
        squashMessage?: string;
        mergeBaseBranch?: string;
        json?: boolean;
      },
    ) => {
      const client = createClient(getUrl());
      try {
        const initiatingThreadId = resolveThreadIdOrSelf(opts.thread, opts);
        const result = await unwrap<SquashMergeEnvironmentOperationResponse>(
          client.api.v1.environments[":id"].operations.$post({
            param: { id },
            json: {
              operation: "squash_merge",
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
      } catch (err: unknown) {
        console.error(`Error: ${getErrorMessage(err)}`);
        process.exit(1);
      }
    });

  environment
    .command("promote <id>")
    .description("Promote an environment into the primary checkout")
    .option("--json", "Print machine-readable JSON output")
    .action(async (id: string, opts: { json?: boolean }) => {
      const client = createClient(getUrl());
      try {
        const result = await unwrap<{ ok: true; promoted: boolean; message: string }>(
          client.api.v1.environments[":id"].operations.$post({
            param: { id },
            json: { operation: "promote_primary" },
          }),
        );
        if (outputJson(opts, result)) return;
        console.log(result.message);
      } catch (err: unknown) {
        console.error(`Error: ${getErrorMessage(err)}`);
        process.exit(1);
      }
    });

  environment
    .command("demote [id]")
    .description("Demote the currently promoted primary-checkout environment")
    .option("--project <id>", "Project ID (defaults to BB_PROJECT_ID when id is omitted)")
    .option("--json", "Print machine-readable JSON output")
    .action(async (id: string | undefined, opts: { project?: string; json?: boolean }) => {
      const client = createClient(getUrl());
      try {
        const environmentId = (() => {
          if (id) return Promise.resolve(id);
          const threadIdFromContext = resolveThreadId();
          if (threadIdFromContext) {
            return unwrap<Thread>(
              client.api.v1.threads[":id"].$get({ param: { id: threadIdFromContext } }),
            ).then((thread) => {
              if (!thread.environmentId) {
                throw new Error(`Thread ${thread.id} has no attached environment.`);
              }
              return thread.environmentId;
            });
          }
          const projectId = requireProjectId(opts.project);
          return unwrap<Thread[]>(
            client.api.v1.threads.$get({
              query: { projectId },
            }),
          ).then((threads) => {
            const active = threads.find((thread) => thread.primaryCheckout?.isActive);
            const activeEnvironmentId = active?.environmentId;
            if (!activeEnvironmentId) {
              throw new Error("Primary checkout is already demoted.");
            }
            return activeEnvironmentId;
          });
        })();

        const result = await unwrap<{ ok: true; demoted: boolean; message: string }>(
          client.api.v1.environments[":id"].operations.$post({
            param: { id: await environmentId },
            json: { operation: "demote_primary" },
          }),
        );
        if (outputJson(opts, result)) return;
        console.log(result.message);
      } catch (err: unknown) {
        console.error(`Error: ${getErrorMessage(err)}`);
        process.exit(1);
      }
    });

  environment
    .command("promote-status")
    .description("Show which environment is active in the primary checkout")
    .option("--project <id>", "Project ID (defaults to BB_PROJECT_ID)")
    .option("--json", "Print machine-readable JSON output")
    .action(async (opts: { project?: string; json?: boolean }) => {
      const client = createClient(getUrl());
      try {
        const resolvedProject = resolveProjectIdWithLabel(opts.project);
        printContextLabel(resolvedProject, "Project", "BB_PROJECT_ID", opts);
        const threads = await unwrap<Thread[]>(
          client.api.v1.threads.$get({
            query: { projectId: resolvedProject.id },
          }),
        );
        const active = threads.find((thread) => thread.primaryCheckout?.isActive);
        const environmentId = active?.environmentId ?? null;
        if (outputJson(opts, { environmentId, threadId: active?.id ?? null })) return;
        if (!environmentId) {
          console.log("Primary checkout: demoted");
          return;
        }
        console.log(`Primary checkout environment: ${environmentId}`);
        if (active?.id) {
          console.log(`Thread: ${active.id}`);
        }
        if (active?.title) {
          console.log(`Title: ${active.title}`);
        }
      } catch (err: unknown) {
        console.error(`Error: ${getErrorMessage(err)}`);
        process.exit(1);
      }
    });
}
