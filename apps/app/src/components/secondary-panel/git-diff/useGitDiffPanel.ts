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
}

export function useGitDiffPanel({
  defaultMergeBaseBranch,
  environmentId,
}: UseGitDiffPanelParams) {
  const applyThreadSecondaryPanel = useSetThreadSecondaryPanel();
  const selectedMergeBaseBranch = useAtomValue(selectedMergeBaseBranchAtom);
  const setSelectedMergeBaseBranch = useSetAtom(selectedMergeBaseBranchAtom);
  const setPendingGitDiffScrollPath = useSetAtom(pendingGitDiffScrollPathAtom);

  const {
    data: mergeBaseBranchOptions,
    isLoading: isLoadingMergeBaseBranchOptions,
  } = useEnvironmentMergeBaseBranches(environmentId ?? "", {
    enabled: Boolean(environmentId),
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
