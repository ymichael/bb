import type {
  EnvironmentDisplayInfo,
  EnvironmentDisplayProviderLookup,
} from "@bb/core-ui";
import { resolveEnvironmentDisplayProvider } from "@bb/core-ui";
import type { SystemEnvironmentProvider } from "@bb/server-contract";
import type { IconName } from "@bb/shared-ui/icon";
import { pluginIconName } from "@/components/plugin/PluginIcon";
import { PersistentHostIconName } from "@/lib/host-display";

export type EnvironmentWorkspaceDisplayProviderLookup =
  | { status: "loading" }
  | {
      status: "loaded";
      provider: SystemEnvironmentProvider | null;
      environmentProviderId: string | null;
    };

export const UNNAMED_ENVIRONMENT_LABEL = "Environment";
export const REUSE_ENVIRONMENT_ICON_NAME: IconName = "Folder02";

export function shouldShowEnvironmentHostIdentity(
  hasMultipleMachines: boolean,
  isProjectless: boolean,
): boolean {
  return hasMultipleMachines || isProjectless;
}

interface EnvironmentWorkspaceLabelArgs {
  display: EnvironmentDisplayInfo;
  providerLookup: EnvironmentWorkspaceDisplayProviderLookup;
  environmentName: string | null;
}

interface EnvironmentWorkspaceSummaryDisplayArgs extends EnvironmentWorkspaceLabelArgs {
  hasMultipleMachines: boolean;
  hostName: string | null;
  isProjectless: boolean;
}

interface EnvironmentWorkspaceSummaryDisplay {
  label: string;
  compactLabel: string;
  icon: IconName;
  typeLabel: string | undefined;
}

interface EnvironmentWorkspaceInfoDisplayArgs extends EnvironmentWorkspaceLabelArgs {
  hostName: string | null;
}

interface EnvironmentWorkspaceInfoDisplay {
  label: string;
  icon: IconName;
  machineName: string | null;
}

export function findEnvironmentDisplayProvider(
  providers: readonly SystemEnvironmentProvider[] | undefined,
  environmentProviderId: string | null,
): EnvironmentWorkspaceDisplayProviderLookup {
  if (environmentProviderId === null) {
    return { status: "loaded", provider: null, environmentProviderId: null };
  }
  if (providers === undefined) {
    return { status: "loading" };
  }
  return {
    status: "loaded",
    environmentProviderId,
    provider:
      providers.find((candidate) => candidate.id === environmentProviderId) ??
      null,
  };
}

export function getEnvironmentProviderDisplayName(
  providerLookup: EnvironmentWorkspaceDisplayProviderLookup,
): string | null {
  if (providerLookup.status === "loading") return null;
  if (providerLookup.provider !== null) {
    return providerLookup.provider.displayName;
  }
  return providerLookup.environmentProviderId === null
    ? null
    : `${providerLookup.environmentProviderId} (not installed)`;
}

function getEnvironmentWorkspaceLabel({
  display,
  providerLookup,
  environmentName,
}: EnvironmentWorkspaceLabelArgs): string {
  if (display.lifecycle === "provisioning") return "Provisioning";
  if (display.lifecycle === "destroyed") return "Destroyed";
  if (environmentName !== null) return environmentName;
  return (
    getEnvironmentProviderDisplayName(providerLookup) ??
    display.compactModeLabel
  );
}

function machineIsWorkspaceIdentity(
  providerLookup: EnvironmentWorkspaceDisplayProviderLookup,
): boolean {
  if (providerLookup.status === "loading") return false;
  return true;
}

export function getEnvironmentWorkspaceSummaryDisplay({
  display,
  providerLookup,
  environmentName,
  hasMultipleMachines,
  hostName,
  isProjectless,
}: EnvironmentWorkspaceSummaryDisplayArgs): EnvironmentWorkspaceSummaryDisplay | null {
  if (display.lifecycle === "provisioning") {
    return {
      label: "Provisioning",
      compactLabel: "Provisioning",
      icon: "Loading",
      typeLabel: undefined,
    };
  }
  if (display.lifecycle === "destroyed") {
    return {
      label: "Destroyed",
      compactLabel: "Destroyed",
      icon: getEnvironmentLabelIconName(providerLookup),
      typeLabel: display.typeLabel,
    };
  }
  if (environmentName !== null) {
    return {
      label: environmentName,
      compactLabel: environmentName,
      icon: getEnvironmentLabelIconName(providerLookup),
      typeLabel: display.typeLabel,
    };
  }
  if (providerLookup.status === "loading") {
    return null;
  }
  if (machineIsWorkspaceIdentity(providerLookup)) {
    return (hasMultipleMachines || isProjectless) && hostName !== null
      ? {
          label: hostName,
          compactLabel: hostName,
          icon: getEnvironmentLabelIconName(providerLookup),
          typeLabel: display.typeLabel,
        }
      : null;
  }
  const providerDisplayName = getEnvironmentProviderDisplayName(providerLookup);
  return providerDisplayName === null
    ? null
    : {
        label: providerDisplayName,
        compactLabel: providerDisplayName,
        icon: getEnvironmentLabelIconName(providerLookup),
        typeLabel: display.typeLabel,
      };
}

export function getEnvironmentWorkspaceInfoDisplay({
  display,
  providerLookup,
  environmentName,
  hostName,
}: EnvironmentWorkspaceInfoDisplayArgs): EnvironmentWorkspaceInfoDisplay {
  return {
    label: getEnvironmentWorkspaceLabel({
      display,
      providerLookup,
      environmentName,
    }),
    icon: getEnvironmentLabelIconName(providerLookup),
    machineName:
      hostName !== null && machineIsWorkspaceIdentity(providerLookup)
        ? hostName
        : null,
  };
}

export function getEnvironmentDisplayIconName(
  providerLookup: EnvironmentDisplayProviderLookup,
): IconName | null {
  const provider = resolveEnvironmentDisplayProvider(providerLookup);
  return provider === null ? null : pluginIconName(provider.icon);
}

export function getEnvironmentLabelIconName(
  providerLookup: EnvironmentDisplayProviderLookup,
): IconName {
  return (
    getEnvironmentDisplayIconName(providerLookup) ?? PersistentHostIconName
  );
}
