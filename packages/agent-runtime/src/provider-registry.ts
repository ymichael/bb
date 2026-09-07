import {
  createBridgeProtocolAdapter,
  type BridgeProtocolAdapter,
} from "./bridge-protocol-adapter.js";
import { resolveBridgeWorkerProcessArgs } from "./shared/bridge-path.js";
import type { CreateBridgeAdapterOptions } from "./provider-adapter.js";

function buildPluginStaticProviderOptions(
  options: CreateBridgeAdapterOptions,
): { staticProviderOptions?: Record<string, unknown> } {
  const additionalWorkspaceWriteRoots = options.additionalWorkspaceWriteRoots;
  const staticProviderOptions = {
    ...options.bridgeLaunch.providerOptions,
    ...(additionalWorkspaceWriteRoots.length > 0
      ? { additionalWorkspaceWriteRoots: [...additionalWorkspaceWriteRoots] }
      : {}),
  };
  return Object.keys(staticProviderOptions).length > 0
    ? { staticProviderOptions }
    : {};
}

export function createProviderForId(
  providerId: string,
  adapterOptions: CreateBridgeAdapterOptions,
): BridgeProtocolAdapter {
  const { bridgeLaunch } = adapterOptions;
  return createBridgeProtocolAdapter({
    id: providerId,
    capabilities: {
      ...bridgeLaunch.capabilities,
      permissionModes: [...bridgeLaunch.capabilities.permissionModes],
      supportsNativeUserQuestion: false,
    },
    process: {
      command: adapterOptions.bridgeNodeExecutablePath ?? "node",
      args: [
        ...resolveBridgeWorkerProcessArgs({
          ...(adapterOptions.bridgeBundleDir === undefined
            ? {}
            : { bridgeBundleDir: adapterOptions.bridgeBundleDir }),
        }),
        bridgeLaunch.source.artifactPath,
        bridgeLaunch.pluginId,
        bridgeLaunch.dataDir,
      ],
      env: {
        ...pickDeclaredEnv(process.env, bridgeLaunch.envPassthrough),
        ...adapterOptions.bridgeNodeEnv,
      },
    },
    ...buildPluginStaticProviderOptions(adapterOptions),
  });
}

function pickDeclaredEnv(
  env: NodeJS.ProcessEnv,
  names: readonly string[],
): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value !== "") picked[name] = value;
  }
  return picked;
}
