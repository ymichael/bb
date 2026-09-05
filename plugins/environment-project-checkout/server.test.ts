import type {
  PluginEnvironmentProviderCreateContext,
  PluginEnvironmentProviderValidateContext,
} from "@get-bb/plugin-sdk/environment-provider";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { PROJECT_CHECKOUT_ENVIRONMENT_PROVIDER_ID } from "./provider-id.js";
import plugin from "./server.js";

type Environment = NonNullable<
  PluginEnvironmentProviderCreateContext["previous"]
>["environment"];
type ThreadRow = { id: string; environmentId: string | null; status: string };

const HOST: NonNullable<PluginEnvironmentProviderCreateContext["host"]> = {
  id: "host-a",
  name: "Fake machine",
  status: "connected",
  machineProviderId: null,
  machineProviderSelection: null,
  lifecycle: {
    phase: "active",
    suspendedAt: null,
    retireAt: null,
    progress: null,
    teardown: null,
  },
  maxPermissionMode: "full",
  lastSeenAt: null,
  lastRejectedProtocolVersion: null,
  createdAt: 0,
  updatedAt: 0,
};
const PROJECT: PluginEnvironmentProviderCreateContext["project"] = {
  id: "project-1",
  kind: "standard",
  name: "bb",
  gitRemoteUrl: null,
  createdAt: 1,
  updatedAt: 1,
};
const CHECKOUT_PATH = "/checkouts/bb";

function environmentAt(path: string): Environment {
  return {
    id: "env_1",
    name: null,
    projectId: PROJECT.id,
    hostId: HOST.id,
    path,
    isGitRepo: true,
    branchName: "main",
    baseBranch: null,
    mergeBaseBranch: null,
    status: "ready",
    environmentProviderId: PROJECT_CHECKOUT_ENVIRONMENT_PROVIDER_ID,
    environmentProviderInstanceKey: null,
    environmentProviderSelection: null,
    createdAt: 1,
    updatedAt: 1,
  } as Environment;
}

async function validateWith(args: {
  environments: Environment[];
  threads: ThreadRow[];
  inputs: PluginEnvironmentProviderValidateContext["inputs"];
  inspectCheckout?: () => unknown;
}) {
  const { bb, harness } = createFakePluginHost({
    pluginId: "environment-project-checkout",
    experimental_callHostRpc: (call) => {
      if (call.method === "inspectCheckout" && args.inspectCheckout) {
        return args.inspectCheckout();
      }
      throw new Error(`unexpected host call ${call.method}`);
    },
    sdk: {
      environments: {
        list: (filters?: { hostId?: string; path?: string }) =>
          args.environments.filter(
            (row) =>
              (filters?.hostId === undefined ||
                row.hostId === filters.hostId) &&
              (filters?.path === undefined || row.path === filters.path),
          ),
      },
      threads: {
        list: (filters?: { environmentId?: string }) =>
          args.threads.filter(
            (row) =>
              filters?.environmentId === undefined ||
              row.environmentId === filters.environmentId,
          ),
      },
    },
  });
  await plugin(bb);
  const provider = harness.registrations.environmentProviders.get(
    PROJECT_CHECKOUT_ENVIRONMENT_PROVIDER_ID,
  );
  if (provider === undefined || provider.validate === null) {
    throw new Error("the checkout provider registered no validate");
  }
  return provider.validate({
    project: PROJECT,
    host: HOST,
    projectCheckout: { path: CHECKOUT_PATH },
    gitRemote: null,
    inputs: args.inputs,
  });
}

describe("checkout provider validate", () => {
  it("registers as Project checkout", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "environment-project-checkout",
    });
    await plugin(bb);

    expect(
      harness.registrations.environmentProviders.get(
        PROJECT_CHECKOUT_ENVIRONMENT_PROVIDER_ID,
      )?.displayName,
    ).toBe("Project checkout");
  });

  it("refuses a branch switch while another thread is live on the checkout", async () => {
    const decision = await validateWith({
      environments: [environmentAt(CHECKOUT_PATH)],
      threads: [{ id: "thr_other", environmentId: "env_1", status: "active" }],
      inputs: { branch: { kind: "existing", name: "release" } },
    });
    expect(decision).toEqual({
      action: "refuse",
      message:
        "Cannot checkout branch while another thread is using this workspace",
    });
  });

  it("accepts an attach without a branch switch even when the checkout is busy", async () => {
    const decision = await validateWith({
      environments: [environmentAt(CHECKOUT_PATH)],
      threads: [{ id: "thr_other", environmentId: "env_1", status: "active" }],
      inputs: {},
    });
    expect(decision).toEqual({ action: "accept" });
  });

  it("refuses a branch switch while another project's thread is idle on the checkout", async () => {
    const decision = await validateWith({
      environments: [environmentAt(CHECKOUT_PATH)],
      threads: [{ id: "thr_done", environmentId: "env_1", status: "idle" }],
      inputs: { branch: { kind: "new", baseBranch: "main" } },
    });
    expect(decision).toEqual({
      action: "refuse",
      message:
        "Cannot checkout branch while another thread is using this workspace",
    });
  });

  it("refuses a provider-owned directory and names the environment to reuse", async () => {
    const environment = {
      ...environmentAt(CHECKOUT_PATH),
      id: "env_worktree_42",
      environmentProviderId: "git-worktree",
    };
    const decision = await validateWith({
      environments: [environment],
      threads: [],
      inputs: { path: CHECKOUT_PATH },
    });

    expect(decision).toEqual({
      action: "refuse",
      message:
        "This directory belongs to environment env_worktree_42; reuse that environment instead.",
    });
  });

  it("refuses a branch switch while the checkout has uncommitted changes", async () => {
    const decision = await validateWith({
      environments: [],
      threads: [],
      inputs: { branch: { kind: "existing", name: "release" } },
      inspectCheckout: () => ({
        isGitRepo: true,
        checkout: { kind: "branch", branchName: "main", headSha: "abc123" },
        hasUncommittedChanges: true,
        operation: { kind: "none" },
      }),
    });
    expect(decision).toEqual({
      action: "refuse",
      message: "Checkout blocked by uncommitted changes",
    });
  });

  it("refuses a branch switch while HEAD is detached", async () => {
    const decision = await validateWith({
      environments: [],
      threads: [],
      inputs: { branch: { kind: "existing", name: "release" } },
      inspectCheckout: () => ({
        isGitRepo: true,
        checkout: { kind: "detached", headSha: "abc123" },
        hasUncommittedChanges: false,
        operation: { kind: "none" },
      }),
    });
    expect(decision).toEqual({
      action: "refuse",
      message: "Checkout blocked while HEAD is detached",
    });
  });

  it("refuses a branch switch during an in-progress rebase before reporting dirt", async () => {
    const decision = await validateWith({
      environments: [],
      threads: [],
      inputs: { branch: { kind: "existing", name: "release" } },
      inspectCheckout: () => ({
        isGitRepo: true,
        checkout: { kind: "branch", branchName: "main", headSha: "abc123" },
        hasUncommittedChanges: true,
        operation: { kind: "rebase", hasConflicts: false },
      }),
    });
    expect(decision).toEqual({
      action: "refuse",
      message: "Checkout blocked by an in-progress rebase",
    });
  });

  it("refuses a branch switch with unresolved conflicts", async () => {
    const decision = await validateWith({
      environments: [],
      threads: [],
      inputs: { branch: { kind: "existing", name: "release" } },
      inspectCheckout: () => ({
        isGitRepo: true,
        checkout: { kind: "branch", branchName: "main", headSha: "abc123" },
        hasUncommittedChanges: true,
        operation: { kind: "merge", hasConflicts: true },
      }),
    });
    expect(decision).toEqual({
      action: "refuse",
      message: "Checkout blocked by unresolved conflicts",
    });
  });

  it("accepts a dirty checkout when the branch is already the current one", async () => {
    const decision = await validateWith({
      environments: [],
      threads: [],
      inputs: { branch: { kind: "existing", name: "main" } },
      inspectCheckout: () => ({
        isGitRepo: true,
        checkout: { kind: "branch", branchName: "main", headSha: "abc123" },
        hasUncommittedChanges: true,
        operation: { kind: "none" },
      }),
    });
    expect(decision).toEqual({ action: "accept" });
  });

  it("accepts a branch switch when the checkout inspection call fails", async () => {
    const decision = await validateWith({
      environments: [],
      threads: [],
      inputs: { branch: { kind: "existing", name: "release" } },
      inspectCheckout: () => {
        throw new Error("machine is offline");
      },
    });
    expect(decision).toEqual({ action: "accept" });
  });

  it("checks the directory the inputs name rather than the project checkout", async () => {
    const decision = await validateWith({
      environments: [environmentAt("/elsewhere/bb")],
      threads: [
        { id: "thr_other", environmentId: "env_1", status: "starting" },
      ],
      inputs: {
        path: "/elsewhere/bb",
        branch: { kind: "existing", name: "release" },
      },
    });
    expect(decision.action).toBe("refuse");
  });
});
