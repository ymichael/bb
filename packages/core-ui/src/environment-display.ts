import type { Environment } from "@bb/domain";

type EnvironmentDisplayHostLocality = "local" | "remote";

interface EnvironmentDisplayHostIdentity {
  name: string;
  connected: boolean;
}

export interface EnvironmentDisplayHostContext {
  locality: EnvironmentDisplayHostLocality;
  identity: EnvironmentDisplayHostIdentity | null;
}

export interface EnvironmentDisplayProvider {
  id: string;
  displayName: string;
  icon: string | null;
}

export type EnvironmentDisplayProviderLookup =
  | { status: "loading" }
  | { status: "loaded"; provider: EnvironmentDisplayProvider | null };

export interface EnvironmentDisplayNameSource {
  name: string | null;
  branchName: string | null;
  path: string | null;
  environmentProviderId: string | null;
}

export interface EnvironmentDisplayInfo {
  modeLabel: string;
  compactModeLabel: string;
  typeLabel: string;
  providerLabel: string | null;
  lifecycle: "provisioning" | "destroyed" | null;
  id: string;
}

interface FormatEnvironmentDisplayArgs {
  environment: Environment;
  host: EnvironmentDisplayHostContext;
  providerLookup: EnvironmentDisplayProviderLookup;
}

export function resolveEnvironmentDisplayProvider(
  lookup: EnvironmentDisplayProviderLookup,
): EnvironmentDisplayProvider | null {
  return lookup.status === "loaded" ? lookup.provider : null;
}

export function resolveEnvironmentProviderLabel(
  environmentProviderId: string | null,
  lookup: EnvironmentDisplayProviderLookup,
): string | null {
  if (environmentProviderId === null || lookup.status === "loading") {
    return null;
  }
  return lookup.provider === null
    ? environmentProviderId
    : lookup.provider.displayName;
}

export function resolveWorkspaceFolderName(
  workspacePath: string | null,
): string | null {
  if (workspacePath === null) return null;
  const segments = workspacePath.split(/[\\/]+/u).filter(Boolean);
  return segments[segments.length - 1] ?? null;
}

export function resolveEnvironmentDisplayName(
  source: EnvironmentDisplayNameSource,
  lookup: EnvironmentDisplayProviderLookup,
): string | null {
  return (
    source.name ??
    source.branchName ??
    resolveWorkspaceFolderName(source.path) ??
    resolveEnvironmentProviderLabel(source.environmentProviderId, lookup)
  );
}

export function formatEnvironmentDisplay({
  environment,
  host,
  providerLookup,
}: FormatEnvironmentDisplayArgs): EnvironmentDisplayInfo {
  const lifecycle: EnvironmentDisplayInfo["lifecycle"] =
    environment.status === "destroyed"
      ? "destroyed"
      : environment.status === "provisioning"
        ? "provisioning"
        : null;
  const lifecycleLabel =
    lifecycle === "destroyed"
      ? "Destroyed"
      : lifecycle === "provisioning"
        ? "Provisioning"
        : null;
  const providerLabel = resolveEnvironmentProviderLabel(
    environment.environmentProviderId,
    providerLookup,
  );
  const localityLabel = host.locality === "remote" ? "Remote" : "Local";
  const namedLabel =
    providerLabel ??
    (host.locality === "remote" ? "Working remotely" : "Working locally");
  const namedCompactLabel = providerLabel ?? localityLabel;

  return {
    modeLabel: environment.name ?? lifecycleLabel ?? namedLabel,
    compactModeLabel: environment.name ?? lifecycleLabel ?? namedCompactLabel,
    typeLabel:
      providerLabel === null
        ? localityLabel
        : `${providerLabel} · ${localityLabel}`,
    providerLabel,
    lifecycle,
    id: environment.id,
  };
}
