import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { PluginEnvironmentProviderProgress } from "@get-bb/plugin-sdk/environment-provider";
import { reportHostProgress } from "bb-environment-provider-host/progress";
import { z } from "zod";
import {
  checkoutBranchSelectionSchema,
  checkoutHostContract,
  checkoutHostSignals,
  type CheckoutBranchSelection,
} from "./contract.js";
import { PROJECT_CHECKOUT_ENVIRONMENT_PROVIDER_ID } from "./provider-id.js";

const ATTACH_TIMEOUT_MS = 15 * 60 * 1000;
const LIVE_THREAD_STATUSES = new Set([
  "starting",
  "active",
  "idle",
  "stopping",
]);
const LIVE_THREAD_MESSAGE =
  "Cannot checkout branch while another thread is using this workspace";
const DETACHED_MESSAGE = "Checkout blocked while HEAD is detached";
const UNBORN_MESSAGE = "Checkout blocked before the first commit";
const CONFLICTS_MESSAGE = "Checkout blocked by unresolved conflicts";
const DIRTY_MESSAGE = "Checkout blocked by uncommitted changes";

export const checkoutInputsSchema = z.object({
  path: z.string().min(1).optional(),
  branch: checkoutBranchSelectionSchema.optional(),
});
export type CheckoutInputs = z.infer<typeof checkoutInputsSchema>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default async function checkoutPlugin(bb: BbPluginApi): Promise<void> {
  const host = bb.hosts.experimental_client({
    contract: checkoutHostContract,
    experimental_signals: checkoutHostSignals,
  });
  const reports = new Map<string, PluginEnvironmentProviderProgress>();

  host.experimental_onSignal("progress", (event) => {
    const report = reports.get(event.payload.operationId);
    if (report !== undefined) reportHostProgress(report, event.payload);
  });

  async function otherLiveThreadUsesPath(args: {
    hostId: string;
    path: string;
    threadId: string | null;
  }): Promise<boolean> {
    const rows = await bb.sdk.environments.list({
      hostId: args.hostId,
      path: args.path,
    });
    for (const row of rows) {
      const threads = await bb.sdk.threads.list({
        environmentId: row.id,
        archived: false,
      });
      if (
        threads.some(
          (thread) =>
            thread.id !== args.threadId &&
            LIVE_THREAD_STATUSES.has(thread.status),
        )
      ) {
        return true;
      }
    }
    return false;
  }

  async function branchSwitchBlocker(args: {
    hostId: string;
    path: string;
    branch: CheckoutBranchSelection;
  }): Promise<string | null> {
    let inspection;
    try {
      inspection = await host.call(
        "inspectCheckout",
        { path: args.path },
        { hostId: args.hostId },
      );
    } catch {
      return null;
    }
    if (!inspection.isGitRepo) {
      return null;
    }
    const { checkout, operation } = inspection;
    if (
      args.branch.kind === "existing" &&
      (checkout.kind === "branch" || checkout.kind === "unborn") &&
      checkout.branchName === args.branch.name
    ) {
      return null;
    }
    switch (checkout.kind) {
      case "branch":
        break;
      case "detached":
        return DETACHED_MESSAGE;
      case "unborn":
        return UNBORN_MESSAGE;
      case "unknown":
        return null;
    }
    if (operation.kind !== "none" && operation.hasConflicts) {
      return CONFLICTS_MESSAGE;
    }
    if (operation.kind !== "none") {
      return `Checkout blocked by an in-progress ${operation.kind}`;
    }
    if (inspection.hasUncommittedChanges) {
      return DIRTY_MESSAGE;
    }
    return null;
  }

  async function foreignEnvironmentAtPath(args: {
    hostId: string;
    path: string;
  }): Promise<string | null> {
    const rows = await bb.sdk.environments.list({
      hostId: args.hostId,
      path: args.path,
    });
    const environment = rows.find(
      (row) =>
        row.status !== "destroyed" &&
        row.environmentProviderId !== null &&
        row.environmentProviderId !== PROJECT_CHECKOUT_ENVIRONMENT_PROVIDER_ID,
    );
    return environment?.id ?? null;
  }

  bb.experimental_environments.register({
    id: PROJECT_CHECKOUT_ENVIRONMENT_PROVIDER_ID,
    displayName: "Project checkout",
    icon: "Laptop",
    requires: { projectCheckout: true },
    inputs: checkoutInputsSchema,
    policy: { retireGraceMs: null },
    async validate(context) {
      const branch = context.inputs.branch;
      const path = context.inputs.path ?? context.projectCheckout.path;
      const foreignEnvironmentId = await foreignEnvironmentAtPath({
        hostId: context.host.id,
        path,
      });
      if (foreignEnvironmentId !== null) {
        return {
          action: "refuse",
          message: `This directory belongs to environment ${foreignEnvironmentId}; reuse that environment instead.`,
        };
      }
      if (branch === undefined) {
        return { action: "accept" };
      }
      if (
        await otherLiveThreadUsesPath({
          hostId: context.host.id,
          path,
          threadId: null,
        })
      ) {
        return { action: "refuse", message: LIVE_THREAD_MESSAGE };
      }
      const blocker = await branchSwitchBlocker({
        hostId: context.host.id,
        path,
        branch,
      });
      return blocker === null
        ? { action: "accept" }
        : { action: "refuse", message: blocker };
    },
    async create(context) {
      const hostId = context.host.id;
      const path = context.inputs.path ?? context.projectCheckout.path;
      const branchInput = context.inputs.branch;
      if (
        branchInput !== undefined &&
        (await otherLiveThreadUsesPath({
          hostId,
          path,
          threadId: context.thread.id,
        }))
      ) {
        return {
          status: "failed",
          failure: "terminal",
          message: LIVE_THREAD_MESSAGE,
        };
      }
      const branch =
        branchInput === undefined
          ? null
          : branchInput.kind === "existing"
            ? { kind: "existing" as const, name: branchInput.name }
            : {
                kind: "new" as const,
                name: context.suggestedBranchName,
                baseBranch: branchInput.baseBranch,
              };
      const operationId = `${context.pathKey}#${context.attempt}`;
      reports.set(operationId, context.report);
      try {
        const result = await host.call(
          "attach",
          { operationId, path, branch },
          { hostId, signal: context.signal, timeoutMs: ATTACH_TIMEOUT_MS },
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
          ownsPath: false,
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
    async remove() {
      return { status: "removed" };
    },
  });
}
