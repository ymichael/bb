import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { PluginEnvironmentProviderProgress } from "@get-bb/plugin-sdk/environment-provider";
import { reportHostProgress } from "bb-environment-provider-host/progress";
import { z } from "zod";
import {
  worktreeBaseBranchSchema,
  worktreeHostContract,
  worktreeHostSignals,
} from "./contract.js";
import { GIT_WORKTREE_ENVIRONMENT_PROVIDER_ID } from "./provider-id.js";

const SETUP_TIMEOUT_MS = 15 * 60 * 1000;
const TEARDOWN_TIMEOUT_MS = 15 * 60 * 1000;

export const worktreeInputsSchema = z
  .object({
    branch: worktreeBaseBranchSchema.default({ kind: "default" }),
  })
  .default({ branch: { kind: "default" } });
export type WorktreeInputs = z.infer<typeof worktreeInputsSchema>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default async function worktreePlugin(bb: BbPluginApi): Promise<void> {
  const host = bb.hosts.experimental_client({
    contract: worktreeHostContract,
    experimental_signals: worktreeHostSignals,
  });
  const reports = new Map<string, PluginEnvironmentProviderProgress>();

  host.experimental_onSignal("progress", (event) => {
    const report = reports.get(event.payload.operationId);
    if (report !== undefined) reportHostProgress(report, event.payload);
  });

  bb.experimental_environments.register({
    id: GIT_WORKTREE_ENVIRONMENT_PROVIDER_ID,
    displayName: "Worktree",
    icon: "FolderGit",
    requires: { gitCheckout: true },
    inputs: worktreeInputsSchema,
    policy: { pathKeys: "per-attempt" },
    async create(context) {
      const hostId = context.host.id;
      const operationId = `create#${context.pathKey}#${context.attempt}`;
      reports.set(operationId, context.report);
      try {
        const result = await host.call(
          "create",
          {
            operationId,
            sourcePath: context.projectCheckout.path,
            pathKey: context.pathKey,
            branchName: context.rebuild
              ? (context.previous?.environment.branchName ??
                context.suggestedBranchName)
              : context.suggestedBranchName,
            baseBranch: context.inputs.branch,
            branchMode: context.rebuild ? "reuse-existing" : "reset",
            setupTimeoutMs: SETUP_TIMEOUT_MS,
          },
          { hostId, signal: context.signal, timeoutMs: SETUP_TIMEOUT_MS },
        );
        if (result.status === "failed") {
          return {
            status: "failed",
            failure: "terminal",
            message: result.message,
          };
        }
        return {
          status: "created",
          path: result.path,
          ownsPath: true,
          ...(result.baseBranch === null
            ? {}
            : { mergeBaseBranch: result.baseBranch }),
        };
      } catch (error) {
        if (context.signal.aborted) throw error;
        return {
          status: "failed",
          failure: "transient",
          message: errorMessage(error),
        };
      } finally {
        reports.delete(operationId);
      }
    },
    async remove(context) {
      if (context.hostId === null) {
        return { status: "failed", message: "The worktree machine is unknown" };
      }
      const operationId = `remove#${context.pathKey}#${context.attempt}`;
      reports.set(operationId, context.report);
      try {
        const result = await host.call(
          "remove",
          {
            operationId,
            pathKey: context.pathKey,
            path: context.path,
            teardownTimeoutMs: TEARDOWN_TIMEOUT_MS,
          },
          {
            hostId: context.hostId,
            signal: context.signal,
            timeoutMs: TEARDOWN_TIMEOUT_MS,
          },
        );
        return result;
      } catch (error) {
        if (context.signal.aborted) throw error;
        return { status: "failed", message: errorMessage(error) };
      } finally {
        reports.delete(operationId);
      }
    },
  });
}
