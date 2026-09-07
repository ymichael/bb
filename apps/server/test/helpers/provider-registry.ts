import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostDaemonBridgeLaunch } from "@bb/host-daemon-contract";
import { buildPluginHost, resolvePluginBuildToolchain } from "@bb/plugin-build";
import {
  validatePluginProviderDeclaration,
  type NormalizedPluginProviderDeclaration,
} from "@get-bb/plugin-sdk/internal/host-policy";
import {
  EMPTY_PROVIDER_NATIVE_ROOTS,
  EMPTY_PROVIDER_RESOLVED_NATIVE_ROOTS,
  type JsonValue,
  parseNamespacedGlyph,
  pluginPackageJsonSchema,
  type ProviderInfo,
  type ProviderNativeRootSet,
} from "@bb/domain";
import type { PluginProviderDeclaration } from "@get-bb/plugin-sdk";
import {
  captureFirstPartyProviderDeclarations,
  firstPartyPluginRootDir,
} from "@bb/agent-runtime/test";
import { buildPluginProviderRegistration } from "../../src/services/providers/plugin-provider-registration.js";
import { readPluginProviderIcon } from "../../src/services/plugins/plugin-runtime.js";
import {
  createProviderRegistryService,
  type ProviderRegistration,
  type ProviderRegistryService,
  type ProviderServerCapabilities,
} from "../../src/services/providers/provider-registry.js";
import { PluginHostArtifactRegistry } from "../../src/services/plugins/plugin-host-artifact-registry.js";
import type { PluginHostArtifactSnapshot } from "../../src/services/plugins/plugin-service-internal.js";

const FIRST_PARTY_PROVIDER_PLUGIN_IDS = [
  "provider-codex",
  "provider-claude-code",
  "provider-pi",
  "provider-acp",
] as const;

export async function loadFirstPartyProviderDeclarations(): Promise<
  ReadonlyMap<string, readonly NormalizedPluginProviderDeclaration[]>
> {
  const entries = await Promise.all(
    FIRST_PARTY_PROVIDER_PLUGIN_IDS.map(
      async (pluginId) =>
        [
          pluginId,
          await captureFirstPartyProviderDeclarations(pluginId),
        ] as const,
    ),
  );
  return new Map(entries);
}

const NO_PLUGIN_SETTINGS = (): Readonly<Record<string, never>> => ({});

async function declaredIcons(pluginId: string): Promise<Map<string, string>> {
  const manifest = pluginPackageJsonSchema.parse(
    JSON.parse(
      await readFile(
        join(firstPartyPluginRootDir(pluginId), "package.json"),
        "utf8",
      ),
    ),
  );
  return new Map(Object.entries(manifest.bb.branding.experimental_icons ?? {}));
}

function providerIconSnapshot(args: {
  pluginId: string;
  icon: string | undefined;
  icons: ReadonlyMap<string, string>;
}): { bytes: Uint8Array; contentType: string; hash: string } | null {
  const namespaced =
    args.icon === undefined ? null : parseNamespacedGlyph(args.icon);
  const asset =
    namespaced === null
      ? args.icon
      : namespaced.pluginId === args.pluginId
        ? args.icons.get(namespaced.name)
        : undefined;
  return readPluginProviderIcon(firstPartyPluginRootDir(args.pluginId), asset);
}

export async function registerFirstPartyProviders(
  registry: ProviderRegistryService,
  options: {
    excludePluginIds?: readonly string[];
    unavailablePluginIds?: readonly string[];
    artifacts?: PluginHostArtifactRegistry;
  } = {},
): Promise<void> {
  const excluded = new Set(options.excludePluginIds ?? []);
  const unavailable = new Set(options.unavailablePluginIds ?? []);
  for (const pluginId of FIRST_PARTY_PROVIDER_PLUGIN_IDS) {
    if (excluded.has(pluginId)) {
      continue;
    }
    const declarations = await captureFirstPartyProviderDeclarations(pluginId);
    const icons = await declaredIcons(pluginId);
    if (
      options.artifacts !== undefined &&
      !unavailable.has(pluginId) &&
      (await hasHostEntry(firstPartyPluginRootDir(pluginId)))
    ) {
      options.artifacts.set(pluginId, stubHostArtifact(pluginId));
    }
    for (const declaration of declarations) {
      const icon = providerIconSnapshot({
        pluginId,
        icon: declaration.icon,
        icons,
      });
      registry.register({
        ...buildPluginProviderRegistration({
          available: !unavailable.has(pluginId),
          pluginId,
          declaration,
          iconHash: null,
          readSettings: NO_PLUGIN_SETTINGS,
        }),
        ...(icon === null ? {} : { icon }),
        pluginId,
        iconNames: new Set(icons.keys()),
        installRank: {
          bundledIndex: FIRST_PARTY_PROVIDER_PLUGIN_IDS.indexOf(pluginId),
          installedAt: 0,
        },
      });
    }
  }
}

export function minimalProviderRegistration(args: {
  pluginId: string;
  info: ProviderInfo;
  serverCapabilities: ProviderServerCapabilities;
}): ProviderRegistration {
  return {
    info: args.info,
    serverCapabilities: args.serverCapabilities,
    pluginId: args.pluginId,
    bridgeOptions: {},
    extensionKinds: {},
    visibility: "always",
    fallbackModels: [],
    envPassthrough: [],
    nativeSkillRoots: EMPTY_PROVIDER_NATIVE_ROOTS,
    nativeCommandRoots: EMPTY_PROVIDER_NATIVE_ROOTS,
    resolvesNativeRoots: false,
    deriveProviderOptions: () => ({}),
    iconNames: new Set<string>(),
  };
}

export function stubHostArtifact(pluginId: string): PluginHostArtifactSnapshot {
  const bytes = Buffer.from(`// stub host artifact for ${pluginId}\n`);
  const path = join(tmpdir(), `bb-stub-host-artifact-${pluginId}.mjs`);
  writeFileSync(path, bytes);
  return {
    digest: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength,
    path,
    generation: `stub-${pluginId}`,
  };
}

const firstPartyBridgeArtifactBuilds = new Map<
  string,
  Promise<PluginHostArtifactSnapshot | null>
>();

async function buildFirstPartyBridgeArtifact(
  pluginId: string,
): Promise<PluginHostArtifactSnapshot | null> {
  const rootDir = firstPartyPluginRootDir(pluginId);
  if (!(await hasHostEntry(rootDir))) {
    return null;
  }
  const toolchain = await resolvePluginBuildToolchain(
    join(tmpdir(), "bb-plugin-build-toolchain"),
  );
  const build = await buildPluginHost(rootDir, "0.0.0-test", toolchain);
  const bytes = await readFile(build.jsPath);
  return {
    digest: build.artifactDigest,
    byteLength: bytes.byteLength,
    path: build.jsPath,
    generation: `test-${pluginId}`,
  };
}

export async function recordFirstPartyProviderBridgeArtifacts(
  artifacts: PluginHostArtifactRegistry,
): Promise<void> {
  for (const pluginId of FIRST_PARTY_PROVIDER_PLUGIN_IDS) {
    let build = firstPartyBridgeArtifactBuilds.get(pluginId);
    if (!build) {
      build = buildFirstPartyBridgeArtifact(pluginId);
      firstPartyBridgeArtifactBuilds.set(pluginId, build);
    }
    const snapshot = await build;
    if (snapshot !== null) {
      artifacts.set(pluginId, snapshot);
    }
  }
}

async function hasHostEntry(rootDir: string): Promise<boolean> {
  const raw = await readFile(join(rootDir, "package.json"), "utf8");
  const parsed: unknown = JSON.parse(raw);
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    typeof (parsed as { bb?: unknown }).bb === "object" &&
    (parsed as { bb: { host?: unknown } }).bb.host !== undefined
  );
}

export function declaredNativeRootSet(
  registry: ProviderRegistryService,
  providerId: string,
): ProviderNativeRootSet {
  const registration = registry.get(providerId);
  if (registration === null) {
    throw new Error(`provider "${providerId}" is not registered`);
  }
  return {
    skills: registration.nativeSkillRoots,
    commands: registration.nativeCommandRoots,
    resolved: EMPTY_PROVIDER_RESOLVED_NATIVE_ROOTS,
  };
}

export async function createTestProviderRegistry(): Promise<ProviderRegistryService> {
  const registry = createProviderRegistryService();
  await registerFirstPartyProviders(registry);
  return registry;
}

export const TRANSPORT_TEST_BRIDGE_LAUNCH: HostDaemonBridgeLaunch = {
  pluginId: "provider-pi",
  source: { kind: "artifact", digest: "a".repeat(64), byteLength: 1 },
  providerOptions: {},
  envPassthrough: [],
  capabilities: {
    providerInstallation: false,
    supportsServiceTier: false,
    permissionModes: ["full"],
    supportsThreadArchive: false,
    supportsThreadRename: false,
    fork: "none",
  },
};

const FAKE_PROVIDER_IDS = ["fake", "fake-alpha", "fake-beta"] as const;

export function scriptedEchoProviderRootDir(): string {
  return fileURLToPath(
    new URL("../../../../tests/scripted-echo-provider", import.meta.url),
  );
}

export async function buildScriptedEchoProviderArtifact(): Promise<PluginHostArtifactSnapshot> {
  const toolchain = await resolvePluginBuildToolchain(
    join(tmpdir(), "bb-plugin-build-toolchain"),
  );
  const build = await buildPluginHost(
    scriptedEchoProviderRootDir(),
    "0.0.0-test",
    toolchain,
  );
  const bytes = await readFile(build.jsPath);
  return {
    digest: build.artifactDigest,
    byteLength: bytes.byteLength,
    path: build.jsPath,
    generation: "test-scripted-echo",
  };
}

export async function registerFakeProviders(
  registry: ProviderRegistryService,
  artifacts: PluginHostArtifactRegistry,
): Promise<void> {
  const artifact = await buildScriptedEchoProviderArtifact();
  for (const providerId of FAKE_PROVIDER_IDS) {
    const pluginId = `provider-${providerId}`;
    registry.register({
      ...buildPluginProviderRegistration({
        iconHash: null,
        available: true,
        pluginId,
        declaration: validatePluginProviderDeclaration({
          id: providerId,
          displayName: providerId,
          maintenance: { health: true, usage: true, installation: false },
          capabilities: {
            supportsServiceTier: true,
            supportsNativeUserQuestion: true,
            fork: "checkpoint",
            supportsManualCompaction: true,
            supportsThreadArchive: true,
            supportsThreadRename: true,
            permissionModes: ["accept-edits", "auto", "full"],
            reasoningLevels: ["low", "medium", "high"],
          },
          composerActions: ["plan", "goal"],
        }),
        readSettings: NO_PLUGIN_SETTINGS,
      }),
      pluginId,
      iconNames: new Set<string>(),
    });
    artifacts.set(pluginId, artifact);
  }
}

export async function acpProviderDeclarationsFromSetting(
  entries: readonly JsonValue[],
): Promise<NormalizedPluginProviderDeclaration[]> {
  const shipped = new Set(
    (await captureFirstPartyProviderDeclarations("provider-acp")).map(
      (declaration) => declaration.id,
    ),
  );
  const withSetting = await captureFirstPartyProviderDeclarations(
    "provider-acp",
    {
      settings: { customAgents: JSON.stringify(entries) },
    },
  );
  const configured = withSetting.filter(
    (declaration) => !shipped.has(declaration.id),
  );
  if (configured.length !== entries.length) {
    throw new Error(
      `the ACP plugin registered ${configured.length} of ${entries.length} configured agents; check the setting entries`,
    );
  }
  return configured;
}

export async function configuredAcpProvider(
  entry: Record<string, JsonValue>,
): Promise<{ declaration: PluginProviderDeclaration; pluginId: string }> {
  const [declaration] = await acpProviderDeclarationsFromSetting([entry]);
  if (declaration === undefined) {
    throw new Error("the ACP plugin registered no provider for this entry");
  }
  return { declaration, pluginId: "provider-acp" };
}

export async function registerConfiguredAcpProvider(
  registry: ProviderRegistryService,
  entry: Record<string, JsonValue>,
): Promise<void> {
  const pluginId = "provider-acp";
  for (const declaration of await acpProviderDeclarationsFromSetting([entry])) {
    registry.register({
      ...buildPluginProviderRegistration({
        available: true,
        pluginId,
        declaration,
        iconHash: null,
        readSettings: NO_PLUGIN_SETTINGS,
      }),
      pluginId,
      iconNames: new Set<string>(),
    });
  }
}
