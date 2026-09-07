import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPluginHost, resolvePluginBuildToolchain } from "@bb/plugin-build";
import { ensurePluginProcessDataDir } from "@bb/process-utils";
import type { NormalizedPluginProviderDeclaration } from "@get-bb/plugin-sdk/internal/host-policy";
import {
  captureFirstPartyProviderDeclarations,
  firstPartyPluginRootDir,
} from "./first-party-provider-declarations.js";
import {
  INTEGRATION_PROVIDER_BRIDGE_MANIFEST_PATH,
  type IntegrationProviderBridgeManifest,
} from "./integration-provider-bridges.js";

const PROVIDER_BRIDGE_PLUGIN_IDS = [
  "provider-codex",
  "provider-claude-code",
  "provider-acp",
  "provider-pi",
] as const;

function wireCapabilities(
  declaration: NormalizedPluginProviderDeclaration,
): IntegrationProviderBridgeManifest[string]["capabilities"] {
  const { capabilities } = declaration;
  return {
    providerInstallation: declaration.maintenance?.installation ?? false,
    supportsServiceTier: capabilities.supportsServiceTier,
    permissionModes: [...capabilities.permissionModes],
    supportsThreadArchive: capabilities.supportsThreadArchive,
    supportsThreadRename: capabilities.supportsThreadRename,
    fork: capabilities.fork,
  };
}

export async function setup(): Promise<void> {
  const bridgeDataRoot = join(tmpdir(), "bb-agent-runtime-integration-daemon");
  const toolchain = await resolvePluginBuildToolchain(
    join(tmpdir(), "bb-plugin-build-toolchain"),
  );
  const manifest: IntegrationProviderBridgeManifest = {};
  for (const pluginId of PROVIDER_BRIDGE_PLUGIN_IDS) {
    const rootDir = firstPartyPluginRootDir(pluginId);
    const [declarations, build] = await Promise.all([
      captureFirstPartyProviderDeclarations(pluginId),
      buildPluginHost(rootDir, "0.0.0-integration", toolchain),
    ]);
    const dataDir = await ensurePluginProcessDataDir({
      daemonDataDir: bridgeDataRoot,
      pluginId,
      kind: "bridge-data",
    });
    for (const declaration of declarations) {
      manifest[declaration.id] = {
        pluginId,
        dataDir,
        source: {
          kind: "artifact",
          digest: build.artifactDigest,
          artifactPath: build.jsPath,
        },
        providerOptions: declaration.experimental_bridgeOptions ?? {},
        envPassthrough: [...(declaration.env?.passthrough ?? [])],
        capabilities: wireCapabilities(declaration),
      };
    }
  }
  await writeFile(
    INTEGRATION_PROVIDER_BRIDGE_MANIFEST_PATH,
    JSON.stringify(manifest, null, 2),
  );
}
