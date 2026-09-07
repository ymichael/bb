import { describe, expect, it } from "vitest";
import { listSystemProviderInfos } from "../../../src/services/system/execution-options.js";
import {
  withTestHarness,
  type TestAppHarness,
} from "../../helpers/test-app.js";

const FIRST_PARTY_PROVIDER_DECLARATIONS = [
  {
    builtinName: "provider-codex",
    pluginId: "provider-codex",
    providerId: "codex",
    displayName: "Codex",
    supportsThreadArchive: true,
    supportsThreadRename: true,
    fork: "checkpoint",
    supportsManualCompaction: true,
    supportsUsage: true,
    visibility: "always",
    hasLogo: true,
  },
  {
    builtinName: "provider-claude-code",
    pluginId: "provider-claude-code",
    providerId: "claude-code",
    displayName: "Claude Code",
    supportsThreadArchive: false,
    supportsThreadRename: false,
    fork: "checkpoint",
    supportsManualCompaction: true,
    supportsUsage: true,
    visibility: "always",
    hasLogo: true,
  },
  {
    builtinName: "provider-pi",
    pluginId: "provider-pi",
    providerId: "pi",
    displayName: "Pi",
    supportsThreadArchive: false,
    supportsThreadRename: false,
    fork: "checkpoint",
    supportsManualCompaction: true,
    supportsUsage: false,
    visibility: "always",
    hasLogo: true,
  },
  {
    builtinName: "provider-acp",
    pluginId: "provider-acp",
    providerId: "acp-cursor",
    displayName: "Cursor",
    supportsThreadArchive: false,
    supportsThreadRename: false,
    fork: "none",
    supportsManualCompaction: false,
    supportsUsage: true,
    visibility: "always",
    hasLogo: true,
  },
  {
    builtinName: "provider-acp",
    pluginId: "provider-acp",
    providerId: "acp-opencode",
    displayName: "opencode",
    supportsThreadArchive: false,
    supportsThreadRename: false,
    fork: "tip",
    supportsManualCompaction: true,
    supportsUsage: false,
    visibility: "installed",
    hasLogo: true,
  },
  {
    builtinName: "provider-acp",
    pluginId: "provider-acp",
    providerId: "acp-omp",
    displayName: "omp",
    supportsThreadArchive: false,
    supportsThreadRename: false,
    fork: "tip",
    supportsManualCompaction: true,
    supportsUsage: false,
    visibility: "installed",
    hasLogo: true,
  },
  {
    builtinName: "provider-acp",
    pluginId: "provider-acp",
    providerId: "acp-grok",
    displayName: "Grok Build",
    supportsThreadArchive: false,
    supportsThreadRename: false,
    fork: "none",
    supportsManualCompaction: false,
    supportsUsage: false,
    visibility: "installed",
    hasLogo: true,
  },
  {
    builtinName: "provider-acp",
    pluginId: "provider-acp",
    providerId: "acp-hermes-agent",
    displayName: "Hermes Agent",
    supportsThreadArchive: false,
    supportsThreadRename: false,
    fork: "tip",
    supportsManualCompaction: false,
    supportsUsage: false,
    visibility: "installed",
    hasLogo: true,
  },
] as const;

const PROVIDER_IDS = FIRST_PARTY_PROVIDER_DECLARATIONS.map(
  (plugin) => plugin.providerId,
);
const ALWAYS_VISIBLE_PROVIDER_IDS = FIRST_PARTY_PROVIDER_DECLARATIONS.filter(
  (plugin) => plugin.visibility === "always",
).map((plugin) => plugin.providerId);

function expectedLogoUrl(
  registry: TestAppHarness["deps"]["providerRegistry"],
  providerId: string,
): string {
  const hash = registry.get(providerId)?.icon?.hash;
  if (hash === undefined) {
    throw new Error(`${providerId} registered no icon hash`);
  }
  return `/api/v1/system/providers/${providerId}/logo?h=${hash}`;
}

async function installFirstPartyProviderPlugins(
  harness: TestAppHarness,
): Promise<void> {
  for (const builtinName of new Set(
    FIRST_PARTY_PROVIDER_DECLARATIONS.map((plugin) => plugin.builtinName),
  )) {
    const entry = await harness.pluginService.install(
      `builtin:${builtinName}`,
      { kind: "root" },
    );
    expect(entry.status, `${builtinName}: ${entry.statusDetail ?? ""}`).toBe(
      "running",
    );
  }
}

describe("first-party provider plugins", () => {
  it("are the sole source of the built-in providers", async () => {
    await withTestHarness(
      { seedFirstPartyProviders: false },
      async (harness) => {
        const registry = harness.deps.providerRegistry;
        expect(registry.list()).toEqual([]);

        await installFirstPartyProviderPlugins(harness);

        const after = registry.list();
        expect(after.map((entry) => entry.info.id)).toEqual(PROVIDER_IDS);

        for (const [index, registration] of after.entries()) {
          const plugin = FIRST_PARTY_PROVIDER_DECLARATIONS[index];
          if (plugin === undefined) {
            throw new Error(`missing expectation at index ${index}`);
          }
          const label = plugin.providerId;
          expect(registration.pluginId, label).toBe(plugin.pluginId);
          expect(registration.info.displayName, label).toBe(plugin.displayName);
          expect(registration.info.logoUrl, label).toBe(
            plugin.hasLogo
              ? expectedLogoUrl(registry, plugin.providerId)
              : null,
          );
          expect(registration.icon !== undefined, label).toBe(plugin.hasLogo);
          expect(registration.visibility, label).toBe(plugin.visibility);
          expect(
            registration.info.capabilities.supportsThreadArchive,
            label,
          ).toBe(plugin.supportsThreadArchive);
          expect(
            registration.info.capabilities.supportsThreadRename,
            label,
          ).toBe(plugin.supportsThreadRename);
          expect(registry.supportsManualCompaction(plugin.providerId)).toBe(
            plugin.supportsManualCompaction,
          );
          expect(registration.serverCapabilities.fork, label).toBe(plugin.fork);
          expect(registry.supportsFork(plugin.providerId), label).toBe(
            plugin.fork !== "none",
          );
          expect(registration.info.maintenance.usage, label).toBe(
            plugin.supportsUsage,
          );
          expect(registration.info.id, label).toBe(plugin.providerId);
        }

        const infos = await listSystemProviderInfos(harness.deps, {});
        expect(infos.map((info) => info.id)).toEqual(
          ALWAYS_VISIBLE_PROVIDER_IDS,
        );
        expect(infos.map((info) => info.logoUrl)).toEqual(
          ALWAYS_VISIBLE_PROVIDER_IDS.map((providerId) =>
            expectedLogoUrl(registry, providerId),
          ),
        );
        expect(
          infos.map((info) => [info.id, info.capabilities.supportsFork]),
        ).toEqual(
          FIRST_PARTY_PROVIDER_DECLARATIONS.filter(
            (plugin) => plugin.visibility === "always",
          ).map((plugin) => [plugin.providerId, plugin.fork !== "none"]),
        );
      },
    );
  }, 60_000);

  it("pins the client-read ProviderInfo fields of the four core providers", async () => {
    await withTestHarness(
      { seedFirstPartyProviders: false },
      async (harness) => {
        await installFirstPartyProviderPlugins(harness);
        const clientFields = (providerId: string) => {
          const info = harness.deps.providerRegistry.get(providerId)?.info;
          if (info === undefined) throw new Error(`${providerId} missing`);
          const {
            id,
            displayName,
            logoUrl,
            available,
            maintenance,
            capabilities,
            composerActions,
          } = info;
          return {
            id,
            displayName,
            logoUrl,
            available,
            maintenance,
            capabilities,
            composerActions,
          };
        };
        const skills = { kind: "skills", trigger: "/" } as const;
        const plan = {
          kind: "plan",
          command: { trigger: "/", name: "plan", trailingText: " " },
        } as const;
        const goal = {
          kind: "goal",
          command: { trigger: "/", name: "goal", trailingText: " " },
        } as const;

        expect(clientFields("codex")).toStrictEqual({
          id: "codex",
          displayName: "Codex",
          logoUrl: expectedLogoUrl(harness.deps.providerRegistry, "codex"),
          available: true,
          maintenance: { health: true, usage: true, installation: true },
          capabilities: {
            supportsThreadArchive: true,
            supportsThreadRename: true,
            supportsServiceTier: true,
            supportsNativeUserQuestion: false,
            permissionModes: ["accept-edits", "auto", "full"],
            supportsFork: true,
            supportsSessionRewind: true,
            modelCatalogScope: "host",
          },
          composerActions: [skills, plan, goal],
        });
        expect(clientFields("claude-code")).toStrictEqual({
          id: "claude-code",
          displayName: "Claude Code",
          logoUrl: expectedLogoUrl(
            harness.deps.providerRegistry,
            "claude-code",
          ),
          available: true,
          maintenance: { health: true, usage: true, installation: true },
          capabilities: {
            supportsThreadArchive: false,
            supportsThreadRename: false,
            supportsServiceTier: false,
            supportsNativeUserQuestion: true,
            permissionModes: ["accept-edits", "auto", "full"],
            supportsFork: true,
            supportsSessionRewind: true,
            modelCatalogScope: "host",
          },
          composerActions: [skills, plan],
        });
        expect(clientFields("pi")).toStrictEqual({
          id: "pi",
          displayName: "Pi",
          logoUrl: expectedLogoUrl(harness.deps.providerRegistry, "pi"),
          available: true,
          maintenance: { health: true, usage: false, installation: true },
          capabilities: {
            supportsThreadArchive: false,
            supportsThreadRename: false,
            supportsServiceTier: false,
            supportsNativeUserQuestion: false,
            permissionModes: ["full"],
            supportsFork: true,
            supportsSessionRewind: true,
            modelCatalogScope: "workspace",
          },
          composerActions: [skills],
        });
        expect(clientFields("acp-cursor")).toStrictEqual({
          id: "acp-cursor",
          displayName: "Cursor",
          logoUrl: expectedLogoUrl(harness.deps.providerRegistry, "acp-cursor"),
          available: true,
          maintenance: { health: true, usage: true, installation: true },
          capabilities: {
            supportsThreadArchive: false,
            supportsThreadRename: false,
            supportsServiceTier: true,
            supportsNativeUserQuestion: false,
            permissionModes: ["accept-edits", "full"],
            supportsFork: false,
            supportsSessionRewind: false,
            modelCatalogScope: "host",
          },
          composerActions: [skills],
        });

        const claude = harness.deps.providerRegistry.get("claude-code");
        expect(claude?.info.strings?.signInHint).toMatch(/claude/);
        expect(claude?.info.reasoningLevels?.map((level) => level.id)).toEqual([
          "low",
          "medium",
          "high",
          "xhigh",
          "ultracode",
          "max",
        ]);
        expect(claude?.fallbackModels.map((model) => model.id)).toContain(
          "claude-opus-5[1m]",
        );
        expect(claude?.envPassthrough).toEqual(["BB_CLAUDE_CODE_EXECUTABLE"]);
        expect(
          harness.deps.providerRegistry
            .get("codex")
            ?.info.serviceTiers?.map((tier) => tier.id),
        ).toEqual(["default", "fast"]);
      },
    );
  }, 60_000);

  it("disabling a provider plugin removes its provider, and re-enabling restores its position", async () => {
    await withTestHarness(
      { seedFirstPartyProviders: false },
      async (harness) => {
        const registry = harness.deps.providerRegistry;
        await installFirstPartyProviderPlugins(harness);
        expect(registry.get("pi")?.pluginId).toBe("provider-pi");

        await harness.pluginService.setEnabled("provider-pi", false);

        expect(registry.get("pi")).toBeNull();
        expect(registry.getServerCapabilities("pi")).toBeNull();
        expect(registry.getSupportedPermissionModes("pi")).toBeNull();
        expect(registry.supportsFork("pi")).toBe(false);
        expect(registry.supportsManualCompaction("pi")).toBe(false);
        expect(registry.list().map((entry) => entry.info.id)).toEqual([
          "codex",
          "claude-code",
          "acp-cursor",
          "acp-opencode",
          "acp-omp",
          "acp-grok",
          "acp-hermes-agent",
        ]);
        const infos = await listSystemProviderInfos(harness.deps, {});
        expect(infos.find((info) => info.id === "pi")).toBeUndefined();

        await harness.pluginService.setEnabled("provider-pi", true);
        expect(registry.get("pi")?.pluginId).toBe("provider-pi");
        expect(registry.list().map((entry) => entry.info.id)).toEqual(
          PROVIDER_IDS,
        );
      },
    );
  }, 60_000);
});
