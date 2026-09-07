import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pluginPackageJsonSchema } from "@bb/domain";
import type { PluginSettingValue } from "@get-bb/plugin-sdk";
import type { NormalizedPluginProviderDeclaration } from "@get-bb/plugin-sdk/internal/host-policy";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";

export function firstPartyPluginRootDir(pluginId: string): string {
  return fileURLToPath(
    new URL(`../../../../plugins/${pluginId}`, import.meta.url),
  );
}

async function declaredIconNames(pluginId: string): Promise<string[]> {
  const manifest = pluginPackageJsonSchema.parse(
    JSON.parse(
      await readFile(
        path.join(firstPartyPluginRootDir(pluginId), "package.json"),
        "utf8",
      ),
    ),
  );
  return Object.keys(manifest.bb.branding.experimental_icons ?? {});
}

export interface CaptureFirstPartyProviderDeclarationsOptions {
  settings?: Record<string, PluginSettingValue>;
}

export async function captureFirstPartyProviderDeclarations(
  pluginId: string,
  options: CaptureFirstPartyProviderDeclarationsOptions = {},
): Promise<NormalizedPluginProviderDeclaration[]> {
  const moduleUrl = new URL(
    `../../../../plugins/${pluginId}/server.ts`,
    import.meta.url,
  ).href;
  const loaded: unknown = await import(/* @vite-ignore */ moduleUrl);
  const entry = (loaded as { default?: unknown }).default;
  if (typeof entry !== "function") {
    throw new Error(`${pluginId} has no default plugin export`);
  }
  const host = createFakePluginHost({
    pluginId,
    dataDir: firstPartyPluginRootDir("__no-such-data-dir__"),
    experimental_declaredIconNames: await declaredIconNames(pluginId),
    ...(options.settings === undefined ? {} : { settings: options.settings }),
  });
  try {
    await entry(host.bb);
    const captured = [...host.harness.registrations.providerRegistrations];
    if (captured.length === 0) {
      throw new Error(`${pluginId} registered no provider declaration`);
    }
    return captured;
  } finally {
    await host.harness.dispose();
  }
}
