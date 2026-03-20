import type {
  SystemHealthEnvironmentDaemonCapabilities,
  SystemHealthEnvironmentDaemonCompatibility,
} from "@bb/core";
import {
  inferEnvironmentDaemonSessionCapabilities,
  normalizeEnvironmentDaemonSessionCapabilities,
  ENVIRONMENT_DAEMON_SESSION_SUPPORTED_PROTOCOL_VERSIONS,
  type EnvironmentDaemonSessionCapabilities,
} from "./session-protocol.js";

const REQUIRED_COMMANDS = [
  "provider.ensure",
  "thread.start",
  "thread.resume",
  "turn.run",
] as const;

const OPTIONAL_COMMANDS = [
  "thread.rename",
  "provider.list_catalog",
  "workspace.status",
  "workspace.diff",
] as const;

const OPTIONAL_FEATURES = [
  "worker_metadata",
  "provider_metadata",
  "provider_runtime_version",
  "control_endpoint",
] as const;

export interface EnvironmentDaemonSessionCompatibilityInput {
  protocolVersion: number;
  workerName?: string;
  workerVersion?: string;
  workerBuildId?: string;
  providerMetadata?: unknown;
  selectedCapabilities?: unknown;
  controlBaseUrl?: string;
}

function toCapabilities(
  session: EnvironmentDaemonSessionCompatibilityInput,
): SystemHealthEnvironmentDaemonCapabilities {
  const selected = session.selectedCapabilities;
  if (selected && typeof selected === "object") {
    const normalized = normalizeEnvironmentDaemonSessionCapabilities(
      selected as Partial<EnvironmentDaemonSessionCapabilities>,
    );
    if (normalized.commands.length > 0 || normalized.features.length > 0) {
      return normalized;
    }
  }
  return inferEnvironmentDaemonSessionCapabilities({
    ...(session.workerName && session.workerVersion
      ? {
          worker: {
            name: session.workerName,
            version: session.workerVersion,
            ...(session.workerBuildId ? { buildId: session.workerBuildId } : {}),
          },
        }
      : {}),
    ...(Array.isArray(session.providerMetadata)
      ? { providers: session.providerMetadata }
      : {}),
    ...(session.controlBaseUrl
      ? { controlEndpoint: { baseUrl: session.controlBaseUrl, authToken: "" } }
      : {}),
  });
}

export function assessEnvironmentDaemonSessionCompatibility(
  session: EnvironmentDaemonSessionCompatibilityInput,
): {
  capabilities: SystemHealthEnvironmentDaemonCapabilities;
  compatibility: SystemHealthEnvironmentDaemonCompatibility;
} {
  const capabilities = toCapabilities(session);
  const missingRequiredCommands = REQUIRED_COMMANDS.filter(
    (command) => !capabilities.commands.includes(command),
  );
  const missingOptionalCommands = OPTIONAL_COMMANDS.filter(
    (command) => !capabilities.commands.includes(command),
  );
  const missingOptionalFeatures = OPTIONAL_FEATURES.filter(
    (feature) => !capabilities.features.includes(feature),
  );
  const protocolCompatible =
    ENVIRONMENT_DAEMON_SESSION_SUPPORTED_PROTOCOL_VERSIONS.includes(
      session.protocolVersion as (typeof ENVIRONMENT_DAEMON_SESSION_SUPPORTED_PROTOCOL_VERSIONS)[number],
    );
  const disposition: SystemHealthEnvironmentDaemonCompatibility["disposition"] =
    !protocolCompatible || missingRequiredCommands.length > 0
      ? "replace"
      : missingOptionalCommands.length > 0 || missingOptionalFeatures.length > 0
        ? "degrade"
        : "reuse";

  return {
    capabilities,
    compatibility: {
      disposition,
      missingRequiredCommands: [...missingRequiredCommands],
      missingOptionalCommands: [...missingOptionalCommands],
      missingOptionalFeatures: [...missingOptionalFeatures],
    },
  };
}
