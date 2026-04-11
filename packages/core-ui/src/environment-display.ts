import type { Environment, HostType } from "@bb/domain";

export interface EnvironmentDisplayInfo {
  /** Human-readable mode: "Direct" or "Worktree", or the sandbox provider name for cloud. */
  modeLabel: string;
  /** Host display name, if available. Null for cloud environments or when the host has no name. */
  hostLabel: string | null;
  id: string;
  /** "local" for the user's machine, "remote" for other persistent hosts, "cloud" for sandbox hosts. */
  location: "local" | "remote" | "cloud";
  mode: "direct" | "worktree";
}

interface FormatEnvironmentDisplayArgs {
  environment: Environment;
  isLocalHost: boolean;
  hostName?: string;
  hostType?: HostType;
  /** Sandbox provider identifier from the host record (e.g. "e2b"). Used to derive the display name for ephemeral hosts. */
  hostProvider?: string;
}

/**
 * Format an environment for display across app, CLI, and prompt labels.
 */
const sandboxProviderDisplayNames: Record<string, string> = {
  e2b: "E2B",
};

export function formatEnvironmentDisplay({
  environment,
  isLocalHost,
  hostName,
  hostType,
  hostProvider,
}: FormatEnvironmentDisplayArgs): EnvironmentDisplayInfo {
  const mode: EnvironmentDisplayInfo["mode"] = environment.isWorktree ? "worktree" : "direct";

  const modeLabel = mode === "worktree" ? "Worktree" : "Direct";

  if (hostType === "ephemeral") {
    const providerName = hostProvider
      ? (sandboxProviderDisplayNames[hostProvider] ?? hostProvider)
      : undefined;
    const providerLabel = providerName ? `${providerName} Sandbox` : "Sandbox";
    return {
      modeLabel: providerLabel,
      hostLabel: null,
      id: environment.id,
      location: "cloud",
      mode,
    };
  }

  const location: EnvironmentDisplayInfo["location"] = isLocalHost ? "local" : "remote";

  return { modeLabel, hostLabel: hostName ?? null, id: environment.id, location, mode };
}
