import { describe, expect, it } from "vitest";
import { createProviderRegistryService } from "../../src/services/providers/provider-registry.js";
import { minimalProviderRegistration } from "../helpers/provider-registry.js";

const CURSOR_LIKE_INFO = {
  pluginId: "provider-acp",
  available: true,
  maintenance: { health: true, usage: true, installation: false },
  capabilities: {
    supportsThreadArchive: false,
    supportsThreadRename: false,
    supportsServiceTier: false,
    supportsNativeUserQuestion: false,
    supportsFork: false,
    supportsSessionRewind: false,
    modelCatalogScope: "workspace" as const,
    permissionModes: ["full" as const],
  },
  composerActions: [],
  displayName: "Plugin Provider",
  id: "plugin-provider",
  logoUrl: null,
};

const MINIMAL_SERVER_CAPABILITIES = {
  supportsManualCompaction: false,
  reasoningLevels: ["medium" as const],
  fork: "none" as const,
};

function registerProvider(
  registry: ReturnType<typeof createProviderRegistryService>,
  id: string,
  pluginId: string,
  installRank?: { bundledIndex: number | null; installedAt: number },
): { dispose(): void } {
  return registry.register({
    ...minimalProviderRegistration({
      pluginId,
      info: { ...CURSOR_LIKE_INFO, id },
      serverCapabilities: MINIMAL_SERVER_CAPABILITIES,
    }),
    ...(installRank === undefined ? {} : { installRank }),
  });
}

describe("provider registry policy accessors", () => {
  it("answers from the registration, not a core seed", () => {
    const registry = createProviderRegistryService();
    registry.register(
      minimalProviderRegistration({
        pluginId: "provider-codex",
        info: {
          ...CURSOR_LIKE_INFO,
          id: "codex",
          capabilities: {
            ...CURSOR_LIKE_INFO.capabilities,
            supportsFork: true,
            supportsSessionRewind: true,
            modelCatalogScope: "workspace",
            permissionModes: ["accept-edits", "full"],
          },
        },
        serverCapabilities: MINIMAL_SERVER_CAPABILITIES,
      }),
    );
    expect(registry.getServerCapabilities("codex")).toStrictEqual(
      MINIMAL_SERVER_CAPABILITIES,
    );
    expect(registry.getSupportedPermissionModes("codex")).toStrictEqual([
      "accept-edits",
      "full",
    ]);
    expect(registry.supportsFork("codex")).toBe(true);
  });

  it("answers for an unregistered acp-* id exactly as for any unknown id", () => {
    const registry = createProviderRegistryService();
    expect(registry.getServerCapabilities("acp-custom-agent")).toBeNull();
    expect(registry.getSupportedPermissionModes("acp-custom-agent")).toBeNull();
    expect(registry.supportsFork("acp-custom-agent")).toBe(false);
    expect(registry.supportsSessionRewind("acp-custom-agent")).toBe(false);
    expect(registry.supportsManualCompaction("acp-opencode")).toBe(false);
  });

  it("answers null/false for unknown provider ids", () => {
    const registry = createProviderRegistryService();
    expect(registry.getServerCapabilities("nope")).toBeNull();
    expect(registry.getSupportedPermissionModes("nope")).toBeNull();
    expect(registry.supportsFork("nope")).toBe(false);
  });

  it("stops claiming capabilities for a provider whose plugin is gone", () => {
    const registry = createProviderRegistryService();
    const handle = registry.register(
      minimalProviderRegistration({
        pluginId: "provider-codex",
        info: { ...CURSOR_LIKE_INFO, id: "codex" },
        serverCapabilities: {
          ...MINIMAL_SERVER_CAPABILITIES,
          supportsManualCompaction: true,
        },
      }),
    );
    expect(registry.supportsManualCompaction("codex")).toBe(true);

    handle.dispose();
    expect(registry.get("codex")).toBeNull();
    expect(registry.supportsManualCompaction("codex")).toBe(false);
    expect(registry.getServerCapabilities("codex")).toBeNull();
  });
});

describe("provider registry ordering", () => {
  it("lists bundled plugins first in bundled order, then others by install time", () => {
    const registry = createProviderRegistryService();
    registerProvider(registry, "late-agent", "late", {
      bundledIndex: null,
      installedAt: 2_000,
    });
    registerProvider(registry, "pi", "provider-pi", {
      bundledIndex: 2,
      installedAt: 5_000,
    });
    registerProvider(registry, "early-agent", "early", {
      bundledIndex: null,
      installedAt: 1_000,
    });
    registerProvider(registry, "codex", "provider-codex", {
      bundledIndex: 0,
      installedAt: 9_000,
    });

    expect(registry.list().map((entry) => entry.info.id)).toStrictEqual([
      "codex",
      "pi",
      "early-agent",
      "late-agent",
    ]);
  });

  it("keeps registration order among entries with no install rank", () => {
    const registry = createProviderRegistryService();
    registerProvider(registry, "zeta-agent", "zeta");
    registerProvider(registry, "alpha-agent", "alpha");
    registerProvider(registry, "codex", "provider-codex", {
      bundledIndex: 0,
      installedAt: 0,
    });

    expect(registry.list().map((entry) => entry.info.id)).toStrictEqual([
      "codex",
      "zeta-agent",
      "alpha-agent",
    ]);
  });

  it("re-enabling a provider plugin restores its listing position", () => {
    const registry = createProviderRegistryService();
    registerProvider(registry, "codex", "provider-codex", {
      bundledIndex: 0,
      installedAt: 0,
    });
    const pi = registerProvider(registry, "pi", "provider-pi", {
      bundledIndex: 1,
      installedAt: 0,
    });
    registerProvider(registry, "acp-cursor", "provider-acp", {
      bundledIndex: 2,
      installedAt: 0,
    });

    pi.dispose();
    expect(registry.list().map((entry) => entry.info.id)).toStrictEqual([
      "codex",
      "acp-cursor",
    ]);

    registerProvider(registry, "pi", "provider-pi", {
      bundledIndex: 1,
      installedAt: 0,
    });
    expect(registry.list().map((entry) => entry.info.id)).toStrictEqual([
      "codex",
      "pi",
      "acp-cursor",
    ]);
  });

  it("lets the user's providerOrder lead and reads a default only when registered", () => {
    const preferences = {
      providerOrder: ["acp-cursor", "ghost", "pi"],
      defaultProviderId: "ghost" as string | null,
    };
    const registry = createProviderRegistryService({
      readUserProviderPreferences: () => preferences,
    });
    registerProvider(registry, "codex", "provider-codex", {
      bundledIndex: 0,
      installedAt: 0,
    });
    registerProvider(registry, "pi", "provider-pi", {
      bundledIndex: 1,
      installedAt: 0,
    });
    registerProvider(registry, "acp-cursor", "provider-acp", {
      bundledIndex: 2,
      installedAt: 0,
    });

    expect(registry.list().map((entry) => entry.info.id)).toStrictEqual([
      "acp-cursor",
      "pi",
      "codex",
    ]);
    expect(registry.getUserDefaultProviderId()).toBeNull();
    preferences.defaultProviderId = "codex";
    expect(registry.getUserDefaultProviderId()).toBe("codex");
    preferences.providerOrder = [];
    expect(registry.list().map((entry) => entry.info.id)).toStrictEqual([
      "codex",
      "pi",
      "acp-cursor",
    ]);
  });
});

describe("provider registry", () => {
  it("starts empty: providers exist only while a plugin declares them", () => {
    expect(createProviderRegistryService().list()).toStrictEqual([]);
  });

  it("rejects plugin registrations that shadow an existing provider", () => {
    const registry = createProviderRegistryService();
    registerProvider(registry, "third-party-agent", "first-plugin");
    expect(() =>
      registerProvider(registry, "third-party-agent", "impostor"),
    ).toThrow(/already registered/);
  });

  it("frees an id the moment its registration is disposed", () => {
    const registry = createProviderRegistryService();
    for (const providerId of ["codex", "pi", "acp-cursor", "acp-anything"]) {
      const handle = registerProvider(registry, providerId, "first-plugin");
      expect(() =>
        registerProvider(registry, providerId, "second-plugin"),
      ).toThrow(/already registered/);
      handle.dispose();
      registerProvider(registry, providerId, "second-plugin").dispose();
    }
  });

  it("adds and disposes plugin registrations", () => {
    const registry = createProviderRegistryService();
    const handle = registry.register(
      minimalProviderRegistration({
        pluginId: "some-plugin",
        info: CURSOR_LIKE_INFO,
        serverCapabilities: MINIMAL_SERVER_CAPABILITIES,
      }),
    );
    expect(registry.get("plugin-provider")).toMatchObject({
      pluginId: "some-plugin",
    });
    expect(registry.list()).toHaveLength(1);

    handle.dispose();
    expect(registry.get("plugin-provider")).toBeNull();
    expect(registry.list()).toHaveLength(0);

    const second = registry.register(
      minimalProviderRegistration({
        pluginId: "other-plugin",
        info: CURSOR_LIKE_INFO,
        serverCapabilities: MINIMAL_SERVER_CAPABILITIES,
      }),
    );
    handle.dispose();
    expect(registry.get("plugin-provider")).toMatchObject({
      pluginId: "other-plugin",
    });
    second.dispose();
  });

  it("releases a provider-scoped boot wait as soon as that provider registers", async () => {
    const registry = createProviderRegistryService({
      deferRegistrationsSettled: true,
    });
    let requestedProviderReady = false;
    let unrelatedProviderReady = false;
    const requestedWait = registry.whenProviderRegistered("codex").then(() => {
      requestedProviderReady = true;
    });
    const unrelatedWait = registry
      .whenProviderRegistered("claude-code")
      .then(() => {
        unrelatedProviderReady = true;
      });

    registerProvider(registry, "codex", "provider-codex");
    await requestedWait;

    expect(requestedProviderReady).toBe(true);
    expect(unrelatedProviderReady).toBe(false);

    registry.markRegistrationsSettled();
    await unrelatedWait;
    expect(unrelatedProviderReady).toBe(true);
  });

  it("releases an ACP wait only on that agent's own registration", async () => {
    const registry = createProviderRegistryService({
      deferRegistrationsSettled: true,
    });
    let released = false;
    const ready = registry.whenProviderRegistered("acp-opencode").then(() => {
      released = true;
    });

    registerProvider(registry, "acp-cursor", "provider-acp");
    await Promise.resolve();
    expect(released).toBe(false);

    registerProvider(registry, "acp-opencode", "provider-acp");
    await ready;
    expect(registry.get("acp-opencode")).not.toBeNull();
  });
});

describe("installed-state cache", () => {
  it("serves a remembered answer and dedupes concurrent probes", async () => {
    const registry = createProviderRegistryService({});
    registerProvider(registry, "codex", "provider-codex");
    const key = {
      hostId: "host_1",
      providerId: "codex",
    };

    expect(registry.lookupInstalled(key)).toBeUndefined();

    let probes = 0;
    const probe = () => {
      probes += 1;
      return Promise.resolve(true);
    };
    const inFlight = probe();
    registry.rememberInstalled(key, inFlight);

    expect(await registry.lookupInstalled(key)).toBe(true);
    expect(await registry.lookupInstalled(key)).toBe(true);
    expect(probes).toBe(1);
  });

  it("drops the answer when the registration revision moves", async () => {
    const registry = createProviderRegistryService({});
    registerProvider(registry, "codex", "provider-codex");
    const key = {
      hostId: "host_1",
      providerId: "codex",
    };
    registry.rememberInstalled(key, Promise.resolve(true));
    expect(await registry.lookupInstalled(key)).toBe(true);

    registerProvider(registry, "claude-code", "provider-claude-code");

    expect(registry.lookupInstalled(key)).toBeUndefined();
  });

  it("forgets one host-provider answer, one provider, or all answers", async () => {
    const registry = createProviderRegistryService({});
    registerProvider(registry, "codex", "provider-codex");
    const hostOneCodex = {
      hostId: "host_1",
      providerId: "codex",
    };
    const hostTwoCodex = {
      hostId: "host_2",
      providerId: "codex",
    };
    const hostOnePi = {
      hostId: "host_1",
      providerId: "pi",
    };
    registry.rememberInstalled(hostOneCodex, Promise.resolve(true));
    registry.rememberInstalled(hostTwoCodex, Promise.resolve(false));
    registry.rememberInstalled(hostOnePi, Promise.resolve(false));

    registry.forgetInstalledKey(hostOneCodex);
    expect(registry.lookupInstalled(hostOneCodex)).toBeUndefined();
    expect(await registry.lookupInstalled(hostTwoCodex)).toBe(false);
    expect(await registry.lookupInstalled(hostOnePi)).toBe(false);

    registry.forgetInstalledProvider("codex");
    expect(registry.lookupInstalled(hostTwoCodex)).toBeUndefined();
    expect(await registry.lookupInstalled(hostOnePi)).toBe(false);

    registry.forgetAllInstalled();
    expect(registry.lookupInstalled(hostOnePi)).toBeUndefined();
  });
});
