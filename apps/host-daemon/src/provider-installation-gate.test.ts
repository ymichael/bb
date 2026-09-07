import type { HostDaemonBridgeLaunch } from "@bb/host-daemon-contract";
import type { ProviderInstallationStatus } from "@bb/provider-bridge-protocol";
import { createDeferredPromise } from "@bb/test-helpers";
import { describe, expect, it, vi } from "vitest";
import {
  createProviderInstallationGate,
  providerInstallationGateKey,
} from "./provider-installation-gate.js";

const BRIDGE_LAUNCH: HostDaemonBridgeLaunch = {
  pluginId: "provider-codex",
  source: {
    kind: "artifact",
    digest: "a".repeat(64),
    byteLength: 128,
  },
  providerOptions: { launch: { command: "codex" } },
  envPassthrough: [],
  capabilities: {
    providerInstallation: true,
    supportsServiceTier: false,
    permissionModes: ["full"],
    supportsThreadArchive: false,
    supportsThreadRename: false,
    fork: "none",
  },
};

function status(
  overrides: Partial<ProviderInstallationStatus> = {},
): ProviderInstallationStatus {
  return {
    executableName: "codex",
    executablePath: "/usr/local/bin/codex",
    installed: true,
    installSource: "npmGlobal",
    currentVersion: "0.146.0",
    latestVersion: null,
    minimumSupportedVersion: "0.136.0",
    npmPackageName: "@openai/codex",
    npmGlobalPackageVersion: "0.146.0",
    installAction: null,
    needsUpdate: false,
    versionUnsupported: false,
    ...overrides,
  };
}

describe("createProviderInstallationGate", () => {
  it("serves a remembered supported status without probing again", async () => {
    const gate = createProviderInstallationGate({ ttlMs: 1_000, now: () => 0 });
    const probe = vi.fn(async () => status());

    await expect(gate.run("codex", probe)).resolves.toEqual(status());
    await expect(gate.run("codex", probe)).resolves.toEqual(status());

    expect(probe).toHaveBeenCalledOnce();
  });

  it("never remembers an unsupported status", async () => {
    const gate = createProviderInstallationGate({ ttlMs: 1_000, now: () => 0 });
    const unsupported = status({
      currentVersion: "0.135.0",
      versionUnsupported: true,
    });
    const probe = vi
      .fn<() => Promise<ProviderInstallationStatus>>()
      .mockResolvedValueOnce(unsupported)
      .mockResolvedValueOnce(status());

    await expect(gate.run("codex", probe)).resolves.toEqual(unsupported);
    await expect(gate.run("codex", probe)).resolves.toEqual(status());

    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("never remembers a not-installed status from a bridge with a minimum version", async () => {
    const gate = createProviderInstallationGate({ ttlMs: 1_000, now: () => 0 });
    const notInstalled = status({
      installed: false,
      executablePath: null,
      currentVersion: null,
      npmGlobalPackageVersion: null,
      installAction: {
        kind: "install",
        label: "Install",
        command: "npm i -g @openai/codex",
      },
    });
    const tooOld = status({
      currentVersion: "0.135.0",
      versionUnsupported: true,
    });
    const probe = vi
      .fn<() => Promise<ProviderInstallationStatus>>()
      .mockResolvedValueOnce(notInstalled)
      .mockResolvedValueOnce(tooOld);

    await expect(gate.run("codex", probe)).resolves.toEqual(notInstalled);
    await expect(gate.run("codex", probe)).resolves.toEqual(tooOld);

    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("remembers a not-installed status from a bridge with no minimum version", async () => {
    const gate = createProviderInstallationGate({ ttlMs: 1_000, now: () => 0 });
    const notInstalled = status({
      executableName: "claude",
      executablePath: null,
      installed: false,
      installSource: "notInstalled",
      currentVersion: null,
      minimumSupportedVersion: null,
      npmPackageName: "@anthropic-ai/claude-code",
      npmGlobalPackageVersion: null,
    });
    const probe = vi.fn(async () => notInstalled);

    await expect(gate.run("claude", probe)).resolves.toEqual(notInstalled);
    await expect(gate.run("claude", probe)).resolves.toEqual(notInstalled);

    expect(probe).toHaveBeenCalledOnce();
  });

  it("shares one in-flight probe between concurrent callers", async () => {
    const gate = createProviderInstallationGate({ ttlMs: 1_000, now: () => 0 });
    const deferred = createDeferredPromise<ProviderInstallationStatus>();
    const probe = vi.fn(() => deferred.promise);

    const first = gate.run("codex", probe);
    const second = gate.run("codex", probe);
    deferred.resolve(status());

    await expect(Promise.all([first, second])).resolves.toEqual([
      status(),
      status(),
    ]);
    expect(probe).toHaveBeenCalledOnce();
  });

  it("retries after a rejected probe instead of storing or retaining it", async () => {
    const gate = createProviderInstallationGate({ ttlMs: 1_000, now: () => 0 });
    const probe = vi
      .fn<() => Promise<ProviderInstallationStatus>>()
      .mockRejectedValueOnce(new Error("bridge unavailable"))
      .mockResolvedValueOnce(status());

    await expect(gate.run("codex", probe)).rejects.toThrow(
      "bridge unavailable",
    );
    await expect(gate.run("codex", probe)).resolves.toEqual(status());

    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("retries an in-flight probe that is interrupted by invalidation", async () => {
    const gate = createProviderInstallationGate({ ttlMs: 1_000, now: () => 0 });
    const staleProbe = createDeferredPromise<ProviderInstallationStatus>();
    const probe = vi
      .fn<() => Promise<ProviderInstallationStatus>>()
      .mockReturnValueOnce(staleProbe.promise)
      .mockResolvedValueOnce(status());

    const result = gate.run("codex", probe);
    gate.clear();
    staleProbe.reject(new Error("Runtime shutting down"));

    await expect(result).resolves.toEqual(status());
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("probes again once the remembered status expires", async () => {
    let currentTime = 0;
    const gate = createProviderInstallationGate({
      ttlMs: 100,
      now: () => currentTime,
    });
    const probe = vi.fn(async () => status());

    await gate.run("codex", probe);
    currentTime = 99;
    await gate.run("codex", probe);
    expect(probe).toHaveBeenCalledOnce();

    currentTime = 100;
    await gate.run("codex", probe);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("forgets settled entries on clear", async () => {
    const gate = createProviderInstallationGate({ ttlMs: 1_000, now: () => 0 });
    const probe = vi.fn(async () => status());

    await gate.run("codex", probe);
    gate.clear();
    await gate.run("codex", probe);

    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("replaces a stale in-flight answer after the gate is cleared", async () => {
    const gate = createProviderInstallationGate({ ttlMs: 1_000, now: () => 0 });
    const staleProbe = createDeferredPromise<ProviderInstallationStatus>();
    const probe = vi
      .fn<() => Promise<ProviderInstallationStatus>>()
      .mockReturnValueOnce(staleProbe.promise)
      .mockResolvedValue(status());

    const stale = gate.run("codex", probe);
    gate.clear();
    const fresh = gate.run("codex", probe);
    staleProbe.resolve(status({ currentVersion: "0.140.0" }));
    await expect(stale).resolves.toEqual(status());
    await expect(fresh).resolves.toEqual(status());
    expect(probe).toHaveBeenCalledTimes(2);

    await expect(gate.run("codex", probe)).resolves.toEqual(status());
    expect(probe).toHaveBeenCalledTimes(2);
  });
});

describe("providerInstallationGateKey", () => {
  const baseKey = providerInstallationGateKey({
    providerId: "codex",
    bridgeLaunch: BRIDGE_LAUNCH,
  });

  it("separates providers, requirements, and bridge process identity", () => {
    expect(
      providerInstallationGateKey({
        providerId: "pi",
        bridgeLaunch: BRIDGE_LAUNCH,
      }),
    ).not.toBe(baseKey);
    expect(
      providerInstallationGateKey({
        providerId: "codex",
        bridgeLaunch: BRIDGE_LAUNCH,
        requirement: "thread_rewind",
      }),
    ).not.toBe(baseKey);
    expect(
      providerInstallationGateKey({
        providerId: "codex",
        bridgeLaunch: {
          ...BRIDGE_LAUNCH,
          source: { ...BRIDGE_LAUNCH.source, digest: "b".repeat(64) },
        },
      }),
    ).not.toBe(baseKey);
    expect(
      providerInstallationGateKey({
        providerId: "codex",
        bridgeLaunch: {
          ...BRIDGE_LAUNCH,
          capabilities: {
            ...BRIDGE_LAUNCH.capabilities,
            supportsThreadRename: true,
          },
        },
      }),
    ).not.toBe(baseKey);
    expect(
      providerInstallationGateKey({
        providerId: "codex",
        bridgeLaunch: {
          ...BRIDGE_LAUNCH,
          providerOptions: { launch: { command: "codex-nightly" } },
        },
      }),
    ).not.toBe(baseKey);
  });

  it("ignores launch facts that do not change which binary answers", () => {
    expect(
      providerInstallationGateKey({
        providerId: "codex",
        bridgeLaunch: {
          ...BRIDGE_LAUNCH,
          pluginId: "provider-codex-fork",
          envPassthrough: ["OPENAI_API_KEY"],
          source: { ...BRIDGE_LAUNCH.source, byteLength: 256 },
        },
      }),
    ).toBe(baseKey);
  });
});
