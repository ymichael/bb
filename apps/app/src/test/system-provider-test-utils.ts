import type { SystemProviderInfo } from "@bb/server-contract";

export type TestSystemProviderCapabilities =
  SystemProviderInfo["capabilities"];

export interface TestSystemProviderOverrides
  extends Omit<Partial<SystemProviderInfo>, "capabilities"> {
  capabilities?: Partial<TestSystemProviderCapabilities>;
}

const DEFAULT_CAPABILITIES: TestSystemProviderCapabilities = {
  supportsArchive: true,
  supportsRename: true,
  supportsServiceTier: false,
  supportsUserQuestion: false,
  supportedPermissionModes: ["full", "workspace-write", "readonly"],
};

export function createTestSystemProvider(
  overrides: TestSystemProviderOverrides = {},
): SystemProviderInfo {
  const { capabilities, ...providerOverrides } = overrides;

  return {
    available: true,
    capabilities: {
      ...DEFAULT_CAPABILITIES,
      ...capabilities,
      supportedPermissionModes: [
        ...(capabilities?.supportedPermissionModes ??
          DEFAULT_CAPABILITIES.supportedPermissionModes),
      ],
    },
    displayName: "Codex",
    id: "codex",
    ...providerOverrides,
  };
}
