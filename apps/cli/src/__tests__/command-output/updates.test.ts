import { describe, expect, it, vi } from "vitest";
import type { Host } from "@bb/domain";
import type { HostProviderCliStatusResponse } from "@bb/server-contract";
import {
  collectLogPayloads,
  runCommand,
  setupCommandOutputTestEnvironment,
  stubServerApi,
} from "../helpers/command-output-harness.js";
import type { CommandRegistrar } from "../helpers/command-output-harness.js";
import { registerUpdatesCommands } from "../../commands/updates.js";

const hosts: Host[] = [
  {
    id: "host-primary",
    name: "workstation",
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
    lastSeenAt: 1_700_000_000_000,
    lastRejectedProtocolVersion: null,
    createdAt: 1,
    updatedAt: 2,
  },
  {
    id: "host-remote",
    name: "laptop",
    status: "disconnected",
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
    createdAt: 1,
    updatedAt: 2,
  },
];

const version = {
  currentVersion: "0.0.32",
  latestVersion: "0.0.33",
  source: "npm" as const,
  updateAvailable: true,
  isDevelopment: false,
  upgradeCommand: "npx bb-app@latest",
};

function providerStatus(args: {
  codexNeedsUpdate: boolean;
}): HostProviderCliStatusResponse {
  const base = {
    executablePath: "/usr/local/bin/cli",
    installed: true,
    installSource: "npmGlobal" as const,
    minimumSupportedVersion: null,
    npmPackageName: null,
    npmGlobalPackageVersion: null,
    versionUnsupported: false,
  };
  return {
    codex: {
      ...base,
      displayName: "Codex",
      executableName: "codex",
      currentVersion: "0.140.0",
      latestVersion: args.codexNeedsUpdate ? "0.141.0" : "0.140.0",
      needsUpdate: args.codexNeedsUpdate,
      installAction: args.codexNeedsUpdate
        ? {
            kind: "update" as const,
            label: "Update" as const,
            command: "codex update",
          }
        : null,
    },
    "claude-code": {
      ...base,
      displayName: "Claude Code",
      executableName: "claude",
      currentVersion: "2.0.14",
      latestVersion: "2.0.14",
      needsUpdate: false,
      installAction: null,
    },
    "acp-cursor": {
      ...base,
      displayName: "Cursor",
      executableName: "agent",
      currentVersion: null,
      latestVersion: null,
      installed: false,
      needsUpdate: false,
      installAction: null,
    },
  };
}

describe("bb updates command output", () => {
  setupCommandOutputTestEnvironment();

  const register: CommandRegistrar = (program) =>
    registerUpdatesCommands(program, () => "http://server");

  it("bb updates renders bb-app and per-machine provider rows", async () => {
    stubServerApi({
      "v1.system.version.$get": vi.fn(async () => version),
      "v1.hosts.$get": vi.fn(async () => hosts),
      "v1.hosts.:id.provider-clis.status.$get": vi.fn(async () =>
        providerStatus({ codexNeedsUpdate: true }),
      ),
    });

    await runCommand(["updates"], register);

    const output = collectLogPayloads(vi.mocked(console.log)).join("\n");
    expect(output).toContain("bb-app");
    expect(output).toContain("0.0.32 -> 0.0.33");
    expect(output).toContain("Update available (run: npx bb-app@latest)");
    expect(output).toContain("workstation · Codex");
    expect(output).toContain("0.140.0 -> 0.141.0");
    expect(output).toContain("workstation · Claude Code");
    expect(output).toContain("Up to date");
    expect(output).toContain("laptop");
    expect(output).toContain("offline");
  });

  it("bb updates --json prints the aggregate", async () => {
    const status = providerStatus({ codexNeedsUpdate: false });
    stubServerApi({
      "v1.system.version.$get": vi.fn(async () => version),
      "v1.hosts.$get": vi.fn(async () => hosts),
      "v1.hosts.:id.provider-clis.status.$get": vi.fn(async () => status),
    });

    await runCommand(["updates", "--json"], register);

    const payload = JSON.parse(
      String(vi.mocked(console.log).mock.calls[0]?.[0]),
    );
    expect(payload.app).toEqual(version);
    expect(payload.machines).toHaveLength(2);
    expect(payload.machines[0].providerStatus).toEqual(status);
    expect(payload.machines[1].providerStatus).toBeNull();
  });

  it("bb updates apply runs each available provider update", async () => {
    const install = vi.fn(
      async () =>
        new Response(
          [
            JSON.stringify({
              type: "started",
              provider: "codex",
              actionKind: "update",
              command: "codex update",
            }),
            JSON.stringify({
              type: "completed",
              provider: "codex",
              success: true,
              exitCode: 0,
              signal: null,
            }),
          ].join("\n"),
          { status: 200 },
        ),
    );
    stubServerApi({
      "v1.hosts.$get": vi.fn(async () => hosts),
      "v1.hosts.:id.provider-clis.status.$get": vi.fn(async () =>
        providerStatus({ codexNeedsUpdate: true }),
      ),
      "v1.hosts.:id.provider-clis.install.$post": install,
    });

    await runCommand(["updates", "apply"], register);

    expect(install).toHaveBeenCalledOnce();
    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      "Codex on workstation: running update…",
      "Codex on workstation: done",
    ]);
  });

  it("bb updates apply reports when everything is current", async () => {
    stubServerApi({
      "v1.hosts.$get": vi.fn(async () => hosts),
      "v1.hosts.:id.provider-clis.status.$get": vi.fn(async () =>
        providerStatus({ codexNeedsUpdate: false }),
      ),
    });

    await runCommand(["updates", "apply"], register);

    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      "Everything is up to date.",
    ]);
  });

  it("bb updates reports but does not apply manual provider updates", async () => {
    const status = providerStatus({ codexNeedsUpdate: true });
    status.codex.installAction = null;
    stubServerApi({
      "v1.system.version.$get": vi.fn(async () => version),
      "v1.hosts.$get": vi.fn(async () => hosts),
      "v1.hosts.:id.provider-clis.status.$get": vi.fn(async () => status),
    });

    await runCommand(["updates"], register);
    expect(collectLogPayloads(vi.mocked(console.log)).join("\n")).toContain(
      "Update in terminal",
    );

    vi.mocked(console.log).mockClear();
    await runCommand(["updates", "apply"], register);
    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      "No updates bb can apply. Run bb updates status for manual updates.",
    ]);
  });
});
