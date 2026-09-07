export const PROVIDER_BRIDGE_EXPORT_NAME = "experimental_providerBridge";

export interface ProviderBridgeContext {
  pluginId: string;
  dataDir: string;
  tempDir: string;
}

export interface ProviderBridgeDefinition {
  handleLine: (line: string) => void;
  start?: (context: ProviderBridgeContext) => void;
  onClose?: () => void;
  onSigterm?: () => void;
  onSigint?: () => void;
}

export interface ProviderBridgeEntry extends ProviderBridgeDefinition {
  experimental_apiVersion: 1;
}

export function experimental_defineProviderBridge(
  definition: ProviderBridgeDefinition,
): ProviderBridgeEntry {
  return { experimental_apiVersion: 1, ...definition };
}

export function parseProviderBridgeEntry(
  value: unknown,
):
  | { entry: ProviderBridgeEntry; problem: null }
  | { entry: null; problem: string } {
  if (typeof value !== "object" || value === null) {
    return {
      entry: null,
      problem: `exports no "${PROVIDER_BRIDGE_EXPORT_NAME}"`,
    };
  }
  const candidate = value as Partial<ProviderBridgeEntry>;
  if (candidate.experimental_apiVersion !== 1) {
    return {
      entry: null,
      problem: `exports "${PROVIDER_BRIDGE_EXPORT_NAME}" with unsupported apiVersion ${String(candidate.experimental_apiVersion)} (expected 1) — build it with experimental_defineProviderBridge()`,
    };
  }
  if (typeof candidate.handleLine !== "function") {
    return {
      entry: null,
      problem: `exports "${PROVIDER_BRIDGE_EXPORT_NAME}" without a handleLine function`,
    };
  }
  return { entry: candidate as ProviderBridgeEntry, problem: null };
}
