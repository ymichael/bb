import type {
  PluginEnvironmentProviderCreateContext,
  PluginEnvironmentProviderProgress,
} from "@get-bb/plugin-sdk/environment-provider";
import {
  createFakePluginHost,
  makeThreadResponse,
  type FakePluginHarness,
} from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin from "./server.js";
type Host = NonNullable<PluginEnvironmentProviderCreateContext["host"]>;
type Project = PluginEnvironmentProviderCreateContext["project"];
type HostRpcCall = FakePluginHarness["experimental_hostRpcCalls"][number];
import { personalWorkspaceHostContract } from "./contract.js";
import { PERSONAL_WORKSPACE_ENVIRONMENT_PROVIDER_ID } from "./provider-id.js";
const HOST_ID = "host_a";
const PROJECT_ID = "personal";
const THREAD_ID = "thr_1";
const DATA_DIR = "/data/plugins/environment-personal-workspace/host-data";

function workspacePathFor(pathKey: string): string {
  return `${DATA_DIR}/workspaces/${pathKey}`;
}

const WORKSPACE_PATH = workspacePathFor(THREAD_ID);

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

const PERSONAL_PROJECT: Project = {
  id: PROJECT_ID,
  kind: "personal",
  name: "Personal",
  gitRemoteUrl: null,
  createdAt: 1,
  updatedAt: 1,
};

function createFakeWorkspaceHost() {
  const directories = new Set<string>();
  return {
    directories,
    async call(request: HostRpcCall): Promise<unknown> {
      switch (request.method) {
        case "createWorkspace": {
          const input =
            personalWorkspaceHostContract.createWorkspace.input.parse(
              request.input,
            );
          const path = workspacePathFor(input.pathKey);
          directories.add(path);
          return { path };
        }
        case "removeWorkspace": {
          const input =
            personalWorkspaceHostContract.removeWorkspace.input.parse(
              request.input,
            );
          return {
            removed: directories.delete(
              input.path ?? workspacePathFor(input.pathKey),
            ),
          };
        }
        default:
          throw new Error(`unexpected host method ${request.method}`);
      }
    },
  };
}

async function setup() {
  const host = createFakeWorkspaceHost();
  const { bb, harness } = createFakePluginHost({
    experimental_callHostRpc: (call) => host.call(call),
  });
  await plugin(bb);
  const provider = harness.registrations.environmentProviders.get(
    PERSONAL_WORKSPACE_ENVIRONMENT_PROVIDER_ID,
  );
  if (provider === undefined) throw new Error("Provider not registered");
  const steps: string[] = [];
  const logs: string[] = [];
  const report: PluginEnvironmentProviderProgress = {
    step: (text) => steps.push(text),
    log: (text) => logs.push(text),
  };
  const context: PluginEnvironmentProviderCreateContext = {
    thread: makeThreadResponse({ id: THREAD_ID, projectId: PROJECT_ID }),
    project: PERSONAL_PROJECT,
    host: PROVISION_HOST,
    projectCheckout: null,
    gitRemote: null,
    inputs: null,
    suggestedBranchName: "bb/test",
    attempt: 1,
    pathKey: THREAD_ID,
    rebuild: false,
    previous: null,
    report,
    signal: new AbortController().signal,
  };
  return { host, harness, provider, context, steps, logs };
}

describe("personal workspace resource operations", () => {
  it("creates the directory for the path key core supplies", async () => {
    const f = await setup();
    expect(await f.provider.create(f.context)).toEqual({
      status: "created",
      path: WORKSPACE_PATH,
      ownsPath: true,
    });
    expect(f.steps).toEqual(["Preparing personal workspace…"]);
    expect([...f.host.directories]).toEqual([WORKSPACE_PATH]);
  });
  it("keeps distinct path keys in distinct directories", async () => {
    const f = await setup();
    await f.provider.create(f.context);
    await f.provider.create({ ...f.context, pathKey: "second" });
    expect(f.host.directories.size).toBe(2);
  });
  it("removes the directory core supplies", async () => {
    const f = await setup();
    await f.provider.create(f.context);
    await f.provider.remove({
      environment: null,
      hostId: HOST_ID,
      path: WORKSPACE_PATH,
      pathKey: THREAD_ID,
      resource: null,
      attempt: 1,
      report: f.context.report,
      signal: new AbortController().signal,
    });
    expect(f.host.directories.size).toBe(0);
  });
  it("removes an interrupted directory by path key before core knows its path", async () => {
    const f = await setup();
    await f.provider.create(f.context);
    await f.provider.remove({
      environment: null,
      hostId: HOST_ID,
      path: null,
      pathKey: THREAD_ID,
      resource: null,
      attempt: 1,
      report: f.context.report,
      signal: new AbortController().signal,
    });
    expect(f.host.directories.size).toBe(0);
  });
  it("uses core's rebuild path key", async () => {
    const f = await setup();
    expect(
      await f.provider.create({
        ...f.context,
        pathKey: "rebuilt",
        rebuild: true,
      }),
    ).toMatchObject({ path: workspacePathFor("rebuilt") });
    expect(f.steps).toEqual(["Restoring personal workspace…"]);
  });
});
