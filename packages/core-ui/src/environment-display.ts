import type { Environment, EnvironmentWorkspaceDisplayKind } from "@bb/domain";
import { resolveEnvironmentWorkspaceDisplayKind } from "@bb/domain";

type EnvironmentDisplayHostLocality = "local" | "remote";

interface EnvironmentDisplayHostIdentity {
  name: string;
  connected: boolean;
}

export interface EnvironmentDisplayHostContext {
  locality: EnvironmentDisplayHostLocality;
  identity: EnvironmentDisplayHostIdentity | null;
}

export interface EnvironmentDisplayInfo {
  modeLabel: string;
  compactModeLabel: string;
  lifecycle: "provisioning" | "destroying" | "destroyed" | null;
  id: string;
  mode: "direct" | "worktree";
  workspaceDisplayKind: EnvironmentWorkspaceDisplayKind;
}

interface FormatEnvironmentDisplayArgs {
  environment: Environment;
  host: EnvironmentDisplayHostContext;
}

export function formatEnvironmentDisplay({
  environment,
  host,
}: FormatEnvironmentDisplayArgs): EnvironmentDisplayInfo {
  const mode: EnvironmentDisplayInfo["mode"] = environment.isWorktree
    ? "worktree"
    : "direct";
  const workspaceDisplayKind = resolveEnvironmentWorkspaceDisplayKind({
    environment: {
      isWorktree: environment.isWorktree,
      workspaceProvisionType: environment.workspaceProvisionType,
    },
  });

  const goneLabel =
    environment.status === "destroying"
      ? "Destroying"
      : environment.status === "destroyed"
        ? "Destroyed"
        : null;
  const isProvisioningDisplay =
    goneLabel === null &&
    (environment.status === "provisioning" ||
      (environment.workspaceProvisionType === "managed-worktree" &&
        environment.path === null));
  const directModeLabel =
    host.locality === "remote" ? "Working remotely" : "Working locally";
  const directCompactModeLabel =
    host.locality === "remote" ? "Remote" : "Local";
  const generatedModeLabel = goneLabel
    ? goneLabel
    : isProvisioningDisplay
      ? "Provisioning"
      : mode === "worktree"
        ? "Worktree"
        : directModeLabel;
  const generatedCompactModeLabel = goneLabel
    ? goneLabel
    : isProvisioningDisplay
      ? "Provisioning"
      : mode === "worktree"
        ? "Worktree"
        : directCompactModeLabel;
  const modeLabel = environment.name ?? generatedModeLabel;
  const compactModeLabel = environment.name ?? generatedCompactModeLabel;
  const lifecycle = isProvisioningDisplay
    ? "provisioning"
    : environment.status === "destroying"
      ? "destroying"
      : environment.status === "destroyed"
        ? "destroyed"
        : null;

  return {
    modeLabel,
    compactModeLabel,
    lifecycle,
    id: environment.id,
    mode,
    workspaceDisplayKind,
  };
}
