import { useAtom } from "jotai";
import { atom } from "jotai/vanilla";
import { useCallback, useEffect, useState } from "react";
import type { RootComposeSelectedBranch } from "./root-compose-thread-environment";

interface BranchSelectionScopeArgs {
  environmentValue: string;
  projectId: string | undefined;
}

interface UseScopedBranchSelectionResult {
  onBranchChange: (name: string) => void;
  onClearBranch: () => void;
  onCreateBranch: (currentBranch: string | null) => void;
  onCreateBranchFrom: (name: string) => void;
  selectedBranch: RootComposeSelectedBranch | null;
}

interface BranchSelectionState {
  scopeKey: string | null;
  selectedBranch: RootComposeSelectedBranch | null;
}

const newThreadBranchSelectionAtom = atom<BranchSelectionState>({
  scopeKey: null,
  selectedBranch: null,
});

export function getBranchSelectionScopeKey(
  args: BranchSelectionScopeArgs,
): string | null {
  if (!args.projectId || !args.environmentValue) {
    return null;
  }
  return `${args.projectId}\u0000${args.environmentValue}`;
}

export function carryBranchSelectionAcrossScope(args: {
  previousScopeKey: string | null;
  currentScopeKey: string | null;
  selectedBranch: RootComposeSelectedBranch | null;
}): RootComposeSelectedBranch | null {
  return args.currentScopeKey === args.previousScopeKey
    ? args.selectedBranch
    : null;
}

export function useScopedBranchSelection(
  args: BranchSelectionScopeArgs & {
    selectionScope: "component-local" | "new-thread";
  },
): UseScopedBranchSelectionResult {
  const scopeKey = getBranchSelectionScopeKey(args);
  const scopeUsable = scopeKey !== null;
  const [localState, setLocalState] = useState<BranchSelectionState>(() => ({
    scopeKey,
    selectedBranch: null,
  }));
  const [newThreadState, setNewThreadState] = useAtom(
    newThreadBranchSelectionAtom,
  );
  const selectionState =
    args.selectionScope === "new-thread" ? newThreadState : localState;
  const setSelectionState =
    args.selectionScope === "new-thread" ? setNewThreadState : setLocalState;

  const selectedBranch = carryBranchSelectionAcrossScope({
    previousScopeKey: selectionState.scopeKey,
    currentScopeKey: scopeKey,
    selectedBranch: selectionState.selectedBranch,
  });

  useEffect(() => {
    if (selectionState.scopeKey === scopeKey) return;
    setSelectionState({ scopeKey, selectedBranch: null });
  }, [scopeKey, selectionState.scopeKey, setSelectionState]);

  const onBranchChange = useCallback(
    (name: string) => {
      if (!scopeUsable) return;
      setSelectionState({
        scopeKey,
        selectedBranch: { name, isNew: false },
      });
    },
    [scopeKey, scopeUsable, setSelectionState],
  );

  const onCreateBranch = useCallback(
    (currentBranch: string | null) => {
      if (!scopeUsable) return;
      const branchName = selectedBranch?.name ?? currentBranch;
      setSelectionState({
        scopeKey,
        selectedBranch: branchName ? { name: branchName, isNew: true } : null,
      });
    },
    [scopeKey, scopeUsable, selectedBranch?.name, setSelectionState],
  );

  const onCreateBranchFrom = useCallback(
    (name: string) => {
      if (!scopeUsable) return;
      setSelectionState({
        scopeKey,
        selectedBranch: { name, isNew: true },
      });
    },
    [scopeKey, scopeUsable, setSelectionState],
  );

  const onClearBranch = useCallback(() => {
    if (!scopeUsable) return;
    setSelectionState({ scopeKey, selectedBranch: null });
  }, [scopeKey, scopeUsable, setSelectionState]);

  return {
    onBranchChange,
    onClearBranch,
    onCreateBranch,
    onCreateBranchFrom,
    selectedBranch,
  };
}
