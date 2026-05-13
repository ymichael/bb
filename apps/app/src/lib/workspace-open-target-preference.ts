import { useAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import {
  workspaceOpenTargetIdSchema,
  type WorkspaceOpenTarget,
  type WorkspaceOpenTargetId,
} from "@bb/host-daemon-contract";
import { createNullableLocalStorageEnumStorage } from "./browser-storage";

export const WORKSPACE_OPEN_TARGET_STORAGE_KEY = "bb.workspaceOpenTarget";

export type StoredWorkspaceOpenTargetPreference = WorkspaceOpenTargetId | null;

interface ResolvePreferredWorkspaceOpenTargetArgs {
  preferredTargetId: StoredWorkspaceOpenTargetPreference;
  targets: WorkspaceOpenTarget[];
}

function resolveFallbackWorkspaceOpenTarget(
  targets: WorkspaceOpenTarget[],
): WorkspaceOpenTarget | null {
  return targets.find((target) => target.kind === "editor") ?? targets[0] ?? null;
}

function isStoredWorkspaceOpenTargetPreference(
  value: string,
): value is WorkspaceOpenTargetId {
  return workspaceOpenTargetIdSchema.safeParse(value).success;
}

const workspaceOpenTargetPreferenceStorage =
  createNullableLocalStorageEnumStorage<WorkspaceOpenTargetId>(
    isStoredWorkspaceOpenTargetPreference,
  );

export const workspaceOpenTargetPreferenceAtom =
  atomWithStorage<StoredWorkspaceOpenTargetPreference>(
    WORKSPACE_OPEN_TARGET_STORAGE_KEY,
    null,
    workspaceOpenTargetPreferenceStorage,
    { getOnInit: true },
  );

export function resolvePreferredWorkspaceOpenTarget(
  args: ResolvePreferredWorkspaceOpenTargetArgs,
): WorkspaceOpenTarget | null {
  if (args.preferredTargetId !== null) {
    const preferredTarget = args.targets.find(
      (target) => target.id === args.preferredTargetId,
    );
    if (preferredTarget) {
      return preferredTarget;
    }
  }

  // Preserve stale preferences rather than clearing them. The app may be
  // temporarily unavailable and should become primary again after reinstall.
  return resolveFallbackWorkspaceOpenTarget(args.targets);
}

export function useWorkspaceOpenTargetPreference() {
  return useAtom(workspaceOpenTargetPreferenceAtom);
}
