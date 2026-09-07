import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createProviderForId } from "./provider-registry.js";
import type { AgentRuntimeBridgeLaunch } from "./types.js";

const dynamicAcpLaunchSpec = {
  displayName: "Custom ACP",
  command: "custom-agent",
  args: ["serve"],
  env: { CUSTOM_AGENT_TOKEN: "token" },
  cwd: "/agent-home",
  modelCli: {
    listArgs: ["models", "list"],
    selectFlag: "--model",
    primaryModels: ["model-a"],
  },
};

const ACP_BRIDGE_LAUNCH: AgentRuntimeBridgeLaunch = {
  pluginId: "provider-fixture",
  dataDir: "/data/plugins/provider-fixture/bridge-data",
  source: {
    kind: "artifact",
    digest: "e".repeat(64),
    artifactPath: "/data/provider-bridges/acp.mjs",
  },
  providerOptions: {
    acpLaunchSpec: {
      displayName: "Cursor",
      command: "cursor-agent",
      args: ["acp"],
      env: {},
    },
  },
  envPassthrough: [],
  capabilities: {
    providerInstallation: false,
    supportsServiceTier: true,
    permissionModes: ["accept-edits", "full"],
    supportsThreadArchive: false,
    supportsThreadRename: false,
    fork: "tip",
  },
};

const PI_BRIDGE_LAUNCH: AgentRuntimeBridgeLaunch = {
  pluginId: "provider-fixture",
  dataDir: "/data/plugins/provider-fixture/bridge-data",
  source: {
    kind: "artifact",
    digest: "b".repeat(64),
    artifactPath: "/data/provider-bridges/pi.mjs",
  },
  providerOptions: {},
  envPassthrough: [],
  capabilities: {
    providerInstallation: false,
    supportsServiceTier: false,
    permissionModes: ["full"],
    supportsThreadArchive: false,
    supportsThreadRename: false,
    fork: "checkpoint",
  },
};

function expectBridgeSpawn(
  provider: { process: { args: string[] } },
  expected: { module: string | RegExp; bundleDir?: string },
): void {
  const args = provider.process.args;
  expect(args.slice(-2)).toEqual([
    "provider-fixture",
    "/data/plugins/provider-fixture/bridge-data",
  ]);
  const moduleArg = args.at(-3) ?? "";
  if (typeof expected.module === "string") {
    expect(moduleArg).toBe(expected.module);
  } else {
    expect(moduleArg).toMatch(expected.module);
  }
  const workerArgs = args.slice(0, -3);
  if (expected.bundleDir === undefined) {
    expect(workerArgs.slice(0, 3)).toEqual([
      "--conditions=source",
      "--import",
      import.meta.resolve("tsx"),
    ]);
    expect(workerArgs.at(-1)).toMatch(/bridge-worker-entry\.ts$/u);
  } else {
    expect(workerArgs).toEqual([
      `${expected.bundleDir}/bb-provider-bridge-worker.mjs`,
    ]);
  }
}

describe("provider registry", () => {
  it("carries environment write roots to the acp bridge via provider options", () => {
    const provider = createProviderForId("acp-cursor", {
      additionalWorkspaceWriteRoots: ["/extra-root"],
      bridgeLaunch: ACP_BRIDGE_LAUNCH,
    });
    const plan = provider.buildCommandPlan({
      type: "thread/start",
      threadId: "thread-1",
      cwd: "/workspace",
      options: {
        providerOptions: {},
        permissionMode: "full",
        permissionScope: "full",
        approvalReviewer: null,
        permissionEscalation: null,
      },
      instructionMode: "append",
    });
    expect(plan).toMatchObject({
      kind: "request",
      method: "thread/start",
      params: {
        options: {
          providerOptions: {
            additionalWorkspaceWriteRoots: ["/extra-root"],
          },
        },
      },
    });
  });

  it("runs the packaged bootstrap from the configured bridge bundle directory", () => {
    const piProvider = createProviderForId("pi", {
      additionalWorkspaceWriteRoots: [],
      bridgeBundleDir: "/tmp",
      bridgeLaunch: PI_BRIDGE_LAUNCH,
    });

    expectBridgeSpawn(piProvider, {
      module: "/data/provider-bridges/pi.mjs",
      bundleDir: "/tmp",
    });
  });

  it("runs the bridge under the configured bridge node runtime", () => {
    const bridgeNodeEnv = { ELECTRON_RUN_AS_NODE: "1" };
    const provider = createProviderForId("pi", {
      additionalWorkspaceWriteRoots: [],
      bridgeLaunch: PI_BRIDGE_LAUNCH,
      bridgeNodeEnv,
      bridgeNodeExecutablePath: "/Applications/bb.app/Contents/MacOS/bb",
    });

    expect(provider.process.command).toBe(
      "/Applications/bb.app/Contents/MacOS/bb",
    );
    expect(provider.process.env).toEqual(bridgeNodeEnv);
  });

  it("creates pi provider with expected process config", () => {
    const provider = createProviderForId("pi", {
      additionalWorkspaceWriteRoots: [],
      bridgeLaunch: PI_BRIDGE_LAUNCH,
    });
    expect(provider.id).toBe("pi");
    expect(provider.process.command).toBe("node");
    expectBridgeSpawn(provider, { module: "/data/provider-bridges/pi.mjs" });
    expect(existsSync(provider.process.args.at(-4) ?? "")).toBe(true);
  });

  it("passes the requested workspace to Pi model listing", () => {
    const provider = createProviderForId("pi", {
      additionalWorkspaceWriteRoots: [],
      bridgeLaunch: PI_BRIDGE_LAUNCH,
    });

    expect(
      provider.buildCommandPlan({
        type: "model/list",
        cwd: "/tmp/project",
      }),
    ).toEqual({
      kind: "request",
      method: "model/list",
      params: { cwd: "/tmp/project" },
    });
  });

  it("runs every acp id on the acp plugin's verified artifact", () => {
    for (const providerId of ["acp-cursor", "acp-opencode", "acp-custom"]) {
      const provider = createProviderForId(providerId, {
        additionalWorkspaceWriteRoots: [],
        bridgeLaunch: {
          ...ACP_BRIDGE_LAUNCH,
          providerOptions: { acpLaunchSpec: dynamicAcpLaunchSpec },
        },
      });
      expect(provider.id).toBe(providerId);
      expectBridgeSpawn(provider, {
        module: "/data/provider-bridges/acp.mjs",
      });
      expect(provider.capabilities).toMatchObject({
        supportsServiceTier: true,
        supportsFork: true,
        supportsSessionRewind: false,
        permissionModes: ["accept-edits", "full"],
      });
    }
  });

  it("carries the plugin-declared cursor launch spec to the acp bridge", () => {
    const provider = createProviderForId("acp-cursor", {
      additionalWorkspaceWriteRoots: [],
      bridgeLaunch: ACP_BRIDGE_LAUNCH,
    });
    const plan = provider.buildCommandPlan({
      type: "thread/start",
      threadId: "thread-1",
      cwd: "/workspace",
      options: {
        providerOptions: {},
        permissionMode: "full",
        permissionScope: "full",
        approvalReviewer: null,
        permissionEscalation: null,
      },
      instructionMode: "append",
    });
    expect(plan).toMatchObject({
      kind: "request",
      method: "thread/start",
      params: {
        options: {
          providerOptions: {
            acpLaunchSpec: {
              displayName: "Cursor",
              command: "cursor-agent",
              args: ["acp"],
            },
          },
        },
      },
    });
  });

  it("carries a configured acp agent's declared launch spec", () => {
    const provider = createProviderForId("acp-custom", {
      additionalWorkspaceWriteRoots: ["/extra-root"],
      bridgeLaunch: {
        ...ACP_BRIDGE_LAUNCH,
        providerOptions: { acpLaunchSpec: dynamicAcpLaunchSpec },
      },
    });

    expect(provider.id).toBe("acp-custom");
    expect(provider.buildCommandPlan({ type: "model/list" })).toMatchObject({
      kind: "request",
      method: "model/list",
      params: {
        providerOptions: { acpLaunchSpec: dynamicAcpLaunchSpec },
      },
    });

    const startPlan = provider.buildCommandPlan({
      type: "thread/start",
      threadId: "thread-1",
      cwd: "/workspace",
      options: {
        providerOptions: {},
        permissionMode: "full",
        permissionScope: "full",
        approvalReviewer: null,
        permissionEscalation: null,
        envVars: { BB_THREAD_ID: "thread-1" },
      },
      instructionMode: "append",
    });
    expect(startPlan).toMatchObject({
      kind: "request",
      method: "thread/start",
      params: {
        options: {
          providerOptions: {
            acpLaunchSpec: dynamicAcpLaunchSpec,
            additionalWorkspaceWriteRoots: ["/extra-root"],
          },
        },
      },
    });
  });

  it("carries environment write roots and declared capabilities onto an artifact bridge", () => {
    const provider = createProviderForId("codex", {
      additionalWorkspaceWriteRoots: ["/extra-root"],
      bridgeLaunch: {
        pluginId: "provider-fixture",
        dataDir: "/data/plugins/provider-fixture/bridge-data",
        providerOptions: {},
        envPassthrough: [],
        source: {
          kind: "artifact",
          digest: "b".repeat(64),
          artifactPath: "/data/provider-bridges/codex.mjs",
        },
        capabilities: {
          providerInstallation: false,
          supportsServiceTier: true,
          permissionModes: ["accept-edits", "auto", "full"],
          supportsThreadArchive: true,
          supportsThreadRename: true,
          fork: "checkpoint",
        },
      },
    });

    expect(provider.capabilities).toMatchObject({
      supportsThreadArchive: true,
      supportsThreadRename: true,
      supportsFork: true,
      supportsSessionRewind: true,
      supportsServiceTier: true,
      permissionModes: ["accept-edits", "auto", "full"],
    });
    const plan = provider.buildCommandPlan({
      type: "thread/start",
      threadId: "thread-1",
      cwd: "/workspace",
      options: {
        providerOptions: {},
        permissionMode: "full",
        permissionScope: "full",
        approvalReviewer: null,
        permissionEscalation: null,
      },
      instructionMode: "append",
    });
    expect(plan).toMatchObject({
      kind: "request",
      method: "thread/start",
      params: {
        options: {
          providerOptions: {
            additionalWorkspaceWriteRoots: ["/extra-root"],
          },
        },
      },
    });
  });

  it("honors a verified bridge launch for an id the registry does not know", () => {
    const provider = createProviderForId("echo-agent", {
      additionalWorkspaceWriteRoots: [],
      bridgeLaunch: {
        pluginId: "provider-fixture",
        dataDir: "/data/plugins/provider-fixture/bridge-data",
        source: {
          kind: "artifact",
          digest: "d".repeat(64),
          artifactPath: "/data/provider-bridges/artifact.mjs",
        },
        providerOptions: {},
        envPassthrough: [],
        capabilities: {
          providerInstallation: false,
          supportsServiceTier: true,
          permissionModes: ["accept-edits", "full"],
          supportsThreadArchive: false,
          supportsThreadRename: false,
          fork: "none",
        },
      },
    });
    expectBridgeSpawn(provider, {
      module: "/data/provider-bridges/artifact.mjs",
    });
    expect(provider.capabilities.supportsServiceTier).toBe(true);
    expect(provider.capabilities.permissionModes).toEqual([
      "accept-edits",
      "full",
    ]);
  });
});
