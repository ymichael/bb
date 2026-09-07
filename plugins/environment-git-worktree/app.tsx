import { useEffect } from "react";
import {
  definePluginApp,
  experimental_BranchPicker,
  type JsonValue,
  type PluginEnvironmentProviderInputsProps,
} from "@get-bb/plugin-sdk/app";
import { GIT_WORKTREE_ENVIRONMENT_PROVIDER_ID } from "./provider-id.js";
import type { WorktreeInputs } from "./server.js";

const BranchPicker = experimental_BranchPicker;
const DEFAULT_INPUTS: WorktreeInputs = { branch: { kind: "default" } };

export function selectedBranchName(value: JsonValue | null): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const branch = value.branch;
  if (typeof branch !== "object" || branch === null || Array.isArray(branch)) {
    return null;
  }
  return branch.kind === "named" && typeof branch.name === "string"
    ? branch.name
    : null;
}

function WorktreeInputsControl({
  projectId,
  hostId,
  value,
  onChange,
}: PluginEnvironmentProviderInputsProps) {
  useEffect(() => {
    if (value === null) {
      onChange({ status: "ready", value: DEFAULT_INPUTS });
    }
  }, [value, onChange]);
  return (
    <BranchPicker
      hostId={hostId}
      projectId={projectId}
      label="Branch from:"
      value={selectedBranchName(value)}
      onChange={(next) => {
        const inputs: WorktreeInputs =
          next === null
            ? DEFAULT_INPUTS
            : { branch: { kind: "named", name: next } };
        onChange({ status: "ready", value: inputs });
      }}
    />
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_environmentProviderInputs({
    environmentProviderId: GIT_WORKTREE_ENVIRONMENT_PROVIDER_ID,
    component: WorktreeInputsControl,
  });
});
