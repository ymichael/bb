import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  jsonObjectSchema,
  permissionModeSchema,
  providerForkSchema,
} from "@bb/domain";
import type { AgentRuntimeBridgeLaunch } from "../types.js";

export const INTEGRATION_PROVIDER_BRIDGE_MANIFEST_PATH = join(
  tmpdir(),
  "bb-agent-runtime-integration-provider-bridges.json",
);

const bridgeLaunchSchema = z.object({
  pluginId: z.string(),
  dataDir: z.string(),
  source: z.object({
    kind: z.literal("artifact"),
    digest: z.string(),
    artifactPath: z.string(),
  }),
  providerOptions: jsonObjectSchema.default({}),
  envPassthrough: z.array(z.string()).default([]),
  capabilities: z.object({
    providerInstallation: z.boolean().default(false),
    supportsServiceTier: z.boolean(),
    permissionModes: z.array(permissionModeSchema),
    supportsThreadArchive: z.boolean(),
    supportsThreadRename: z.boolean(),
    fork: providerForkSchema,
  }),
});

const manifestSchema = z.record(z.string(), bridgeLaunchSchema);

export type IntegrationProviderBridgeManifest = z.infer<typeof manifestSchema>;

let cachedManifest: IntegrationProviderBridgeManifest | null = null;

function readManifest(): IntegrationProviderBridgeManifest {
  if (cachedManifest !== null) {
    return cachedManifest;
  }
  let raw: string;
  try {
    raw = readFileSync(INTEGRATION_PROVIDER_BRIDGE_MANIFEST_PATH, "utf8");
  } catch {
    throw new Error(
      `No provider bridge manifest at ${INTEGRATION_PROVIDER_BRIDGE_MANIFEST_PATH}. ` +
        `Integration tests must run through vitest.integration.config.ts, whose ` +
        `global setup builds the first-party bridge artifacts.`,
    );
  }
  cachedManifest = manifestSchema.parse(JSON.parse(raw));
  return cachedManifest;
}

export function resolveIntegrationBridgeLaunch(
  providerId: string,
): AgentRuntimeBridgeLaunch {
  const manifest = readManifest();
  const direct = manifest[providerId];
  if (direct !== undefined) {
    return direct;
  }
  if (providerId.startsWith("acp-")) {
    const acpEntry = Object.entries(manifest).find(([id]) =>
      id.startsWith("acp-"),
    );
    if (acpEntry) {
      return acpEntry[1];
    }
  }
  throw new Error(
    `No provider bridge artifact recorded for "${providerId}". ` +
      `Known: ${Object.keys(manifest).join(", ") || "none"}`,
  );
}
