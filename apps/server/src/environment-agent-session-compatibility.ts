import type {
  SystemHealthEnvironmentAgentCapabilities,
  SystemHealthEnvironmentAgentCompatibility,
} from "@bb/core";
import type { EnvironmentAgentSessionRecord } from "@bb/db";
import {
  inferEnvironmentAgentSessionCapabilities,
  normalizeEnvironmentAgentSessionCapabilities,
  ENVIRONMENT_AGENT_SESSION_SUPPORTED_PROTOCOL_VERSIONS,
  type EnvironmentAgentSessionCapabilities,
} from "@bb/environment-daemon";

const REQUIRED_COMMANDS = [
  "provider.ensure",
  "thread.start",
  "thread.resume",
  "turn.run",
] as const;

const OPTIONAL_COMMANDS = [
  "turn.start",
  "turn.steer",
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

function toCapabilities(
  session: EnvironmentAgentSessionRecord,
): SystemHealthEnvironmentAgentCapabilities {
  const selected = session.selectedCapabilities;
  if (selected && typeof selected === "object") {
    const normalized = normalizeEnvironmentAgentSessionCapabilities(
      selected as Partial<EnvironmentAgentSessionCapabilities>,
    );
    if (normalized.commands.length > 0 || normalized.features.length > 0) {
      return normalized;
    }
  }
  return inferEnvironmentAgentSessionCapabilities({
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

export function assessEnvironmentAgentSessionCompatibility(
  session: EnvironmentAgentSessionRecord,
): {
  capabilities: SystemHealthEnvironmentAgentCapabilities;
  compatibility: SystemHealthEnvironmentAgentCompatibility;
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
    ENVIRONMENT_AGENT_SESSION_SUPPORTED_PROTOCOL_VERSIONS.includes(
      session.protocolVersion as (typeof ENVIRONMENT_AGENT_SESSION_SUPPORTED_PROTOCOL_VERSIONS)[number],
    );
  const disposition: SystemHealthEnvironmentAgentCompatibility["disposition"] =
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
