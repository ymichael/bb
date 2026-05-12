import { useCallback, useEffect } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { useAtomCallback } from "jotai/utils";
import { useEnvironmentMergeBaseBranches } from "../../../hooks/queries/environment-queries";
import {
  activeSecondaryPanelAtom,
  useSetThreadSecondaryPanel,
  type ThreadSecondaryPanel as ThreadSecondaryPanelTab,
} from "@/lib/thread-secondary-panel";
import {
  pendingGitDiffScrollPathAtom,
  selectedMergeBaseBranchAtom,
} from "../threadSecondaryPanelAtoms";

interface UseGitDiffPanelParams {
  defaultMergeBaseBranch?: string;
  environmentId?: string;
  mergeBaseBranchOptionsEnabled?: boolean;
}

export function useGitDiffPanel({
  defaultMergeBaseBranch,
  environmentId,
  mergeBaseBranchOptionsEnabled = false,
}: UseGitDiffPanelParams) {
  const applyThreadSecondaryPanel = useSetThreadSecondaryPanel();
  const activeSecondaryPanel = useAtomValue(activeSecondaryPanelAtom);
  const selectedMergeBaseBranch = useAtomValue(selectedMergeBaseBranchAtom);
  const setSelectedMergeBaseBranch = useSetAtom(selectedMergeBaseBranchAtom);
  const setPendingGitDiffScrollPath = useSetAtom(pendingGitDiffScrollPathAtom);

  const {
    data: mergeBaseBranchOptions,
    isLoading: isLoadingMergeBaseBranchOptions,
  } = useEnvironmentMergeBaseBranches(environmentId ?? "", {
    // Branch options are only needed once the picker can open or the diff
    // panel is visible; initial thread load can use the persisted/default base.
    enabled:
      Boolean(environmentId) &&
      (mergeBaseBranchOptionsEnabled || activeSecondaryPanel === "git-diff"),
  });

  useEffect(() => {
    setSelectedMergeBaseBranch(undefined);
  }, [environmentId, setSelectedMergeBaseBranch]);

  const setThreadSecondaryPanel = useCallback(
    (panel: ThreadSecondaryPanelTab | null) => {
      applyThreadSecondaryPanel(panel);
    },
    [applyThreadSecondaryPanel],
  );

  const openThreadSecondaryPanel = useAtomCallback(
    useCallback(
      (get, _set, panel: ThreadSecondaryPanelTab) => {
        if (get(activeSecondaryPanelAtom) === panel) {
          return;
        }
        setThreadSecondaryPanel(panel);
      },
      [setThreadSecondaryPanel],
    ),
  );

  const openThreadDiffPanel = useCallback(() => {
    openThreadSecondaryPanel("git-diff");
  }, [openThreadSecondaryPanel]);

  const toggleThreadSecondaryPanel = useAtomCallback(
    useCallback(
      (get) => {
        if (get(activeSecondaryPanelAtom) !== null) {
          setThreadSecondaryPanel(null);
          return;
        }
        setThreadSecondaryPanel("thread-info");
      },
      [setThreadSecondaryPanel],
    ),
  );

  const closeThreadSecondaryPanel = useAtomCallback(
    useCallback(
      (get) => {
        if (get(activeSecondaryPanelAtom) === null) {
          return;
        }
        setThreadSecondaryPanel(null);
      },
      [setThreadSecondaryPanel],
    ),
  );

  const openDiffFile = useCallback(
    (path: string) => {
      setPendingGitDiffScrollPath(path);
      openThreadDiffPanel();
    },
    [openThreadDiffPanel, setPendingGitDiffScrollPath],
  );

  return {
    closeThreadSecondaryPanel,
    defaultMergeBaseBranch,
    isLoadingMergeBaseBranchOptions,
    mergeBaseBranchOptions,
    openDiffFile,
    openThreadDiffPanel,
    openThreadSecondaryPanel,
    selectedMergeBaseBranch,
    setSelectedMergeBaseBranch,
    toggleThreadSecondaryPanel,
  };
}
