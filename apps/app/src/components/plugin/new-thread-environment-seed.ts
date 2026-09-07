import {
  PROJECT_CHECKOUT_ENVIRONMENT_PROVIDER_ID,
  PERSONAL_WORKSPACE_ENVIRONMENT_PROVIDER_ID,
  GIT_WORKTREE_ENVIRONMENT_PROVIDER_ID,
} from "@bb/client-core";
import type { EnvironmentMachineSelection, JsonValue } from "@bb/domain";
import type {
  CreateThreadEnvironmentArgs,
  ProviderEnvironmentArgs,
  WorkspaceArgs,
} from "@bb/server-contract";
import {
  encodeReuseValue,
  encodeProviderValue,
} from "@/components/pickers/environment-picker-value";

interface NewThreadEnvironmentSeed {
  selectionValue: string;
  providerMachine: EnvironmentMachineSelection | null;
  providerHostId: string | null;
  providerInputs: JsonValue | null;
}

function workspaceAsProviderSugar(
  hostId: string,
  workspace: WorkspaceArgs,
): ProviderEnvironmentArgs {
  switch (workspace.type) {
    case "personal":
      return {
        type: "provider",
        environmentProviderId: PERSONAL_WORKSPACE_ENVIRONMENT_PROVIDER_ID,
        machine: { type: "existing", hostId },
        inputs: null,
      };
    case "managed-worktree":
      return {
        type: "provider",
        environmentProviderId: GIT_WORKTREE_ENVIRONMENT_PROVIDER_ID,
        machine: { type: "existing", hostId },
        inputs: { branch: workspace.baseBranch },
      };
    case "unmanaged":
      return {
        type: "provider",
        environmentProviderId: PROJECT_CHECKOUT_ENVIRONMENT_PROVIDER_ID,
        machine: { type: "existing", hostId },
        inputs: {
          ...(workspace.path === null ? {} : { path: workspace.path }),
          ...(workspace.branch === undefined
            ? {}
            : { branch: workspace.branch }),
        },
      };
  }
}

export function newThreadEnvironmentArgsToSeed(
  environment: CreateThreadEnvironmentArgs,
): NewThreadEnvironmentSeed | null {
  if (environment.type === "project-default") {
    return null;
  }
  if (environment.type === "provider") {
    return {
      selectionValue: encodeProviderValue(environment.environmentProviderId),
      providerMachine: environment.machine,
      providerHostId:
        environment.machine.type === "existing"
          ? environment.machine.hostId
          : null,
      providerInputs: environment.inputs,
    };
  }
  if (environment.type === "reuse") {
    return {
      selectionValue: encodeReuseValue(environment.environmentId),
      providerMachine: null,
      providerHostId: null,
      providerInputs: null,
    };
  }
  if (environment.hostId === undefined) {
    return null;
  }
  return newThreadEnvironmentArgsToSeed(
    workspaceAsProviderSugar(environment.hostId, environment.workspace),
  );
}
