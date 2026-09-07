import {
  providerOperations,
  type TestEnvironmentProviderContext,
  type TestProviderDecision,
} from "./provider-decisions.js";
import { gitBranchSelectionSchema } from "@bb/domain";
import type { PluginEnvironmentValidateDecision } from "@get-bb/plugin-sdk";
import type {
  PluginEnvironmentProviderAvailability,
  PluginEnvironmentProviderValidateContext,
} from "@get-bb/plugin-sdk/environment-provider";
import { expect, onTestFinished, vi } from "vitest";
import {
  validatePluginEnvironmentProviderDeclaration,
  type NormalizedPluginEnvironmentProvider,
} from "@get-bb/plugin-sdk/internal/host-policy";
import { z } from "zod";
import {
  setPluginEnvironmentProviderBridge,
  type PluginEnvironmentProviderRecord,
} from "../../src/services/plugins/plugin-environment-provider-registry.js";
import { DEFAULT_ENVIRONMENT_PROVIDER_ID } from "../../src/services/environments/environment-provider-ids.js";
import { forgetAllActiveThreadProvisionContexts } from "../../src/services/threads/thread-provisioning-active-context.js";

export interface FakeEnvironmentProvider {
  contexts: TestEnvironmentProviderContext[];
  waitForProvision(): Promise<TestEnvironmentProviderContext>;
}

export interface InstallFakeEnvironmentProviderArgs {
  id: string;
  pluginId: string;
  displayName: string;
  requires: NormalizedPluginEnvironmentProvider["requires"];
  inputs?: z.ZodType;
  validate?: (
    context: PluginEnvironmentProviderValidateContext,
  ) => PluginEnvironmentValidateDecision;
  availability?: () => PluginEnvironmentProviderAvailability;
  decide: (context: TestEnvironmentProviderContext) => TestProviderDecision;
}

export const worktreeProviderInputsSchema = z.object({
  branch: gitBranchSelectionSchema,
});

export const checkoutProviderInputsSchema = z.object({
  path: z.string().min(1).optional(),
  branch: z
    .discriminatedUnion("kind", [
      z
        .object({ kind: z.literal("existing"), name: z.string().min(1) })
        .strict(),
      z
        .object({ kind: z.literal("new"), baseBranch: z.string().min(1) })
        .strict(),
    ])
    .optional(),
});

function checkoutInputsOf(context: TestEnvironmentProviderContext): {
  path?: string;
} {
  const inputs = context.inputs;
  return typeof inputs === "object" && inputs !== null && !Array.isArray(inputs)
    ? { ...(typeof inputs.path === "string" ? { path: inputs.path } : {}) }
    : {};
}

export function defaultEnvironmentProviderRecords(): PluginEnvironmentProviderRecord[] {
  const checkout = validatePluginEnvironmentProviderDeclaration({
    id: DEFAULT_ENVIRONMENT_PROVIDER_ID.projectCheckout,
    displayName: "Checkout",
    requires: { projectCheckout: true },
    inputs: checkoutProviderInputsSchema,
    ...providerOperations((context) => {
      const host = context.host;
      const path =
        checkoutInputsOf(context).path ?? context.projectCheckout?.path;
      if (host === null || path === undefined) {
        return {
          action: "reject",
          message: "Checkout needs a machine with the project",
        };
      }
      return {
        action: "ready",
        environment: { type: "host", hostId: host.id, path },
      };
    }),
  });
  return [{ pluginId: "environment-project-checkout", provider: checkout }];
}

export function installDefaultEnvironmentProviders(): void {
  const records = defaultEnvironmentProviderRecords();
  setPluginEnvironmentProviderBridge({
    listEnvironmentProviders: () => records,
    getEnvironmentProvider: (id) =>
      records.find((record) => record.provider.id === id),
    invokeProvider: async (_pluginId, _label, run) => {
      try {
        return { ok: true, value: await run() };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    decisionTimeoutMs: 10_000,
  });
}

export function installFakeEnvironmentProvider(
  args: InstallFakeEnvironmentProviderArgs,
): FakeEnvironmentProvider {
  const contexts: TestEnvironmentProviderContext[] = [];
  const normalized = validatePluginEnvironmentProviderDeclaration({
    id: args.id,
    displayName: args.displayName,
    requires: args.requires,
    ...(args.inputs === undefined ? {} : { inputs: args.inputs }),
    ...(args.validate === undefined ? {} : { validate: args.validate }),
    ...(args.availability === undefined
      ? {}
      : { availability: args.availability }),
    ...providerOperations((context) => {
      contexts.push(context);
      return args.decide(context);
    }),
  });
  const record: PluginEnvironmentProviderRecord = {
    pluginId: args.pluginId,
    provider: normalized,
  };
  setPluginEnvironmentProviderBridge({
    listEnvironmentProviders: () => [record],
    getEnvironmentProvider: (id) => (id === args.id ? record : undefined),
    invokeProvider: async (_pluginId, _label, run) => {
      try {
        return { ok: true, value: await run() };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    decisionTimeoutMs: 10_000,
  });
  onTestFinished(() => {
    forgetAllActiveThreadProvisionContexts();
    setPluginEnvironmentProviderBridge(undefined);
  });

  return {
    contexts,
    async waitForProvision() {
      await vi.waitFor(() => {
        expect(contexts.length).toBeGreaterThan(0);
      });
      const context = contexts[0];
      if (context === undefined) {
        throw new Error(`Expected the ${args.id} provider to be asked`);
      }
      return context;
    },
  };
}

export type FakeWorktreeProvider = FakeEnvironmentProvider;

export function installFakeGitWorktreeProvider(
  decide: (
    context: TestEnvironmentProviderContext,
  ) => TestProviderDecision = () => ({
    action: "wait",
    reason: "Creating worktree…",
  }),
): FakeWorktreeProvider {
  return installFakeEnvironmentProvider({
    id: DEFAULT_ENVIRONMENT_PROVIDER_ID.gitWorktree,
    pluginId: "environment-git-worktree",
    displayName: "Worktree",
    requires: {
      projectCheckout: true,
      gitCheckout: true,
      gitRemote: false,
      projectless: false,
    },
    inputs: worktreeProviderInputsSchema,
    decide,
  });
}

export function installFakePersonalWorkspaceProvider(
  decide: (
    context: TestEnvironmentProviderContext,
  ) => TestProviderDecision = () => ({
    action: "wait",
    reason: "Preparing personal workspace",
  }),
): FakeEnvironmentProvider {
  return installFakeEnvironmentProvider({
    id: DEFAULT_ENVIRONMENT_PROVIDER_ID.personalWorkspace,
    pluginId: "environment-personal-workspace",
    displayName: "Personal workspace",
    requires: {
      projectCheckout: false,
      gitCheckout: false,
      gitRemote: false,
      projectless: true,
    },
    decide,
  });
}
