import { useCallback, useMemo, useState } from "react";
import type { ProjectMainSelectedBranch } from "./project-main-thread-environment";

interface BranchSelectionScope {
  environmentValue: string;
  projectId: string;
}

interface BranchSelectionScopeArgs {
  environmentValue: string;
  projectId: string | undefined;
}

interface ScopedSelectedBranch {
  branch: ProjectMainSelectedBranch;
  scope: BranchSelectionScope;
}

export interface UseScopedBranchSelectionArgs extends BranchSelectionScopeArgs {
  /**
   * The branch the env will use if the user doesn't pick one. Used as the
   * seed when starting the "create new branch" flow.
   */
  currentBranch: string | null;
}

export interface UseScopedBranchSelectionResult {
  onBranchChange: (name: string) => void;
  onCreateBranch: () => void;
  selectedBranch: ProjectMainSelectedBranch | null;
}

function resolveBranchSelectionScope(
  args: BranchSelectionScopeArgs,
): BranchSelectionScope | null {
  if (!args.projectId || !args.environmentValue) {
    return null;
  }

  return {
    environmentValue: args.environmentValue,
    projectId: args.projectId,
  };
}

function matchesBranchSelectionScope(
  left: BranchSelectionScope | undefined,
  right: BranchSelectionScope | null,
) {
  return (
    left !== undefined &&
    right !== null &&
    left.projectId === right.projectId &&
    left.environmentValue === right.environmentValue
  );
}

export function useScopedBranchSelection(
  args: UseScopedBranchSelectionArgs,
): UseScopedBranchSelectionResult {
  const [selectedBranchState, setSelectedBranchState] =
    useState<ScopedSelectedBranch | null>(null);
  const scope = useMemo(
    () =>
      resolveBranchSelectionScope({
        environmentValue: args.environmentValue,
        projectId: args.projectId,
      }),
    [args.environmentValue, args.projectId],
  );
  const selectedBranch =
    selectedBranchState !== null &&
    matchesBranchSelectionScope(selectedBranchState.scope, scope)
      ? selectedBranchState.branch
      : null;

  const onBranchChange = useCallback(
    (name: string) => {
      if (!scope) {
        return;
      }

      setSelectedBranchState({
        scope,
        branch: { name, isNew: false },
      });
    },
    [scope],
  );

  const onCreateBranch = useCallback(() => {
    if (!scope) {
      return;
    }

    setSelectedBranchState((previous) => {
      const scopedPrevious = matchesBranchSelectionScope(previous?.scope, scope)
        ? previous?.branch
        : null;
      const branchName = scopedPrevious?.name ?? args.currentBranch;
      if (!branchName) {
        return matchesBranchSelectionScope(previous?.scope, scope)
          ? null
          : previous;
      }

      return {
        scope,
        branch: {
          name: branchName,
          isNew: true,
        },
      };
    });
  }, [args.currentBranch, scope]);

  return {
    onBranchChange,
    onCreateBranch,
    selectedBranch,
  };
}
