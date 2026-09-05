import type {
  PluginEnvironmentProviderCreateContext,
  PluginEnvironmentProviderProgress,
} from "@get-bb/plugin-sdk/environment-provider";
import {
  createFakePluginHost,
  makeThreadResponse,
  type FakePluginHarness,
} from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { worktreeHostContract } from "./contract.js";
import { GIT_WORKTREE_ENVIRONMENT_PROVIDER_ID } from "./provider-id.js";
import plugin, { worktreeInputsSchema } from "./server.js";

type Host = NonNullable<PluginEnvironmentProviderCreateContext["host"]>;
type Project = PluginEnvironmentProviderCreateContext["project"];
type HostRpcCall = FakePluginHarness["experimental_hostRpcCalls"][number];

const HOST_ID = "host-a";
const PROJECT_ID = "project-1";
const THREAD_ID = "thr_1";
const SOURCE_PATH = "/checkouts/bb";
const WORKTREE_PATH =
  "/data/plugins/environment-git-worktree/worktrees/thr_1/bb";

const PROVISION_HOST: Host = {
  id: HOST_ID,
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

const PROJECT: Project = {
  id: PROJECT_ID,
  kind: "standard",
  name: "bb",
  gitRemoteUrl: null,
  createdAt: 1,
  updatedAt: 1,
};

async function setup(
  callHost: (call: HostRpcCall) => Promise<unknown> | unknown = (call) => {
    if (call.method === "create") {
      return {
        status: "created",
        path: WORKTREE_PATH,
        baseBranch: "main",
      };
    }
    if (call.method === "remove") return { status: "removed" };
    throw new Error(`unexpected host method ${call.method}`);
  },
) {
  const { bb, harness } = createFakePluginHost({
    experimental_callHostRpc: callHost,
  });
  await plugin(bb);
  const provider = harness.registrations.environmentProviders.get(
    GIT_WORKTREE_ENVIRONMENT_PROVIDER_ID,
  );
  if (provider === undefined) throw new Error("Provider not registered");
  const steps: string[] = [];
  const logs: string[] = [];
  const report: PluginEnvironmentProviderProgress = {
    step: (text) => steps.push(text),
    log: (text) => logs.push(text),
  };
  const signal = new AbortController().signal;
  const context: PluginEnvironmentProviderCreateContext = {
    thread: makeThreadResponse({ id: THREAD_ID, projectId: PROJECT_ID }),
    project: PROJECT,
    host: PROVISION_HOST,
    projectCheckout: { path: SOURCE_PATH },
    gitRemote: null,
    inputs: { branch: { kind: "default" } },
    suggestedBranchName: "bb/test",
    attempt: 1,
    pathKey: THREAD_ID,
    rebuild: false,
    previous: null,
    report,
    signal,
  };
  return { context, harness, logs, provider, report, signal, steps };
}

describe("worktree resource operations", () => {
  it("defaults omitted inputs and uses per-attempt path keys", async () => {
    expect(worktreeInputsSchema.parse({})).toEqual({
      branch: { kind: "default" },
    });
    const { provider } = await setup();
    expect(provider.policy.pathKeys).toBe("per-attempt");
  });

  it("runs one long host create and returns its path and base branch", async () => {
    const fixture = await setup();
    expect(await fixture.provider.create(fixture.context)).toEqual({
      status: "created",
      path: WORKTREE_PATH,
      ownsPath: true,
      mergeBaseBranch: "main",
    });
    expect(fixture.harness.experimental_hostRpcCalls[0]).toMatchObject({
      method: "create",
      hostId: HOST_ID,
      input: {
        operationId: `create#${THREAD_ID}#1`,
        branchName: "bb/test",
        pathKey: THREAD_ID,
        baseBranch: { kind: "default" },
        branchMode: "reset",
      },
      signal: fixture.signal,
    });
  });

  it("passes a named base and reuses the branch during rebuild", async () => {
    const fixture = await setup();
    await fixture.provider.create({
      ...fixture.context,
      inputs: { branch: { kind: "named", name: "release" } },
      rebuild: true,
      pathKey: "replacement",
      attempt: 2,
    });
    expect(fixture.harness.experimental_hostRpcCalls[0]?.input).toMatchObject({
      baseBranch: { kind: "named", name: "release" },
      branchMode: "reuse-existing",
      pathKey: "replacement",
    });
  });

  it("rebuilds the previous environment branch after the thread is renamed", async () => {
    const fixture = await setup();
    await fixture.provider.create({
      ...fixture.context,
      suggestedBranchName: "bb/renamed-thread",
      rebuild: true,
      previous: {
        environment: {
          id: "env-retired",
          name: null,
          projectId: PROJECT_ID,
          hostId: HOST_ID,
          path: WORKTREE_PATH,
          isGitRepo: true,
          isWorktree: true,
          branchName: "bb/original-thread",
          baseBranch: "main",
          defaultBranch: "main",
          mergeBaseBranch: "main",
          status: "destroyed",
          environmentProviderId: GIT_WORKTREE_ENVIRONMENT_PROVIDER_ID,
          lifecycle: {
            phase: "destroyed",
            retireAt: null,
            teardown: { status: "removed", attempt: 1 },
          },
          environmentProviderSelection: null,
          environmentProviderInstanceKey: THREAD_ID,
          managed: true,
          workspaceProvisionType: "managed-worktree",
          createdAt: 1,
          updatedAt: 2,
        },
        resource: null,
      },
      pathKey: "replacement",
      attempt: 2,
    });
    expect(fixture.harness.experimental_hostRpcCalls[0]?.input).toMatchObject({
      branchName: "bb/original-thread",
      branchMode: "reuse-existing",
    });
  });

  it("forwards host progress while create is running", async () => {
    let finish: (value: unknown) => void = () => {};
    const fixture = await setup(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const creating = fixture.provider.create(fixture.context);
    await vi.waitFor(() => {
      expect(fixture.harness.experimental_hostRpcCalls).toHaveLength(1);
    });
    await fixture.harness.experimental_emitHostSignal(HOST_ID, "progress", {
      operationId: `create#${THREAD_ID}#1`,
      type: "step",
      text: "Creating worktree",
      status: "started",
    });
    await fixture.harness.experimental_emitHostSignal(HOST_ID, "progress", {
      operationId: `create#${THREAD_ID}#1`,
      type: "output",
      text: "cloning",
      status: null,
    });
    expect(fixture.steps).toEqual(["Creating worktree"]);
    expect(fixture.logs).toEqual(["cloning"]);
    finish({ status: "created", path: WORKTREE_PATH, baseBranch: null });
    await expect(creating).resolves.toMatchObject({ status: "created" });
  });

  it("maps host failures to terminal results and transport failures to transient results", async () => {
    const failed = await setup(() => ({ status: "failed", message: "dirty" }));
    await expect(failed.provider.create(failed.context)).resolves.toEqual({
      status: "failed",
      failure: "terminal",
      message: "dirty",
    });
    const offline = await setup(() => {
      throw new Error("offline");
    });
    await expect(offline.provider.create(offline.context)).resolves.toEqual({
      status: "failed",
      failure: "transient",
      message: "offline",
    });
  });

  it("removes by path key even when create never returned a path", async () => {
    const fixture = await setup();
    expect(
      await fixture.provider.remove({
        environment: null,
        hostId: HOST_ID,
        path: null,
        pathKey: THREAD_ID,
        resource: null,
        attempt: 1,
        report: fixture.report,
        signal: fixture.signal,
      }),
    ).toEqual({ status: "removed" });
    const call = fixture.harness.experimental_hostRpcCalls[0];
    expect(worktreeHostContract.remove.input.parse(call?.input)).toMatchObject({
      pathKey: THREAD_ID,
      path: null,
    });
  });
});
