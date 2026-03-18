import { Command } from "commander";
import type { Thread } from "@bb/core";
import { createClient, unwrap } from "../client.js";
import { requireProjectId } from "../context-env.js";
import {
  getErrorMessage,
  outputJson,
  printContextLabel,
  resolveProjectIdWithLabel,
} from "./helpers.js";

export function registerEnvironmentCommands(
  program: Command,
  getUrl: () => string,
): void {
  const environment = program
    .command("environment")
    .description("Inspect and operate on first-class environments");

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
