import { atom } from "jotai";

export const threadSecondaryPanelResizingAtom = atom(false);

/** Collapsed file keys in the diff panel. Set by useGitDiffFileRenderQueue, read by ThreadSecondaryPanel. */
export const gitDiffCollapsedFileKeysAtom = atom<ReadonlySet<string>>(
  new Set<string>(),
);

/** File keys with pending render timers. Set by useGitDiffFileRenderQueue, read by ThreadSecondaryPanel. */
export const gitDiffLoadingFileKeysAtom = atom<ReadonlySet<string>>(
  new Set<string>(),
);

/** User-selected merge-base branch override. Read by prompt banner + diff panel + git-action dialog. */
export const selectedMergeBaseBranchAtom = atom<string | undefined>(undefined);

/** Set by openDiffFile (prompt banner), consumed by useGitDiffPanelState to scroll to file. */
export const pendingGitDiffScrollPathAtom = atom<string | null>(null);
