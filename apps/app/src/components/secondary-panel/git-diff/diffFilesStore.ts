import { useCallback, useMemo } from "react";
import { atom, useAtomValue } from "jotai";
import { useAtomCallback } from "jotai/utils";
import { atomFamily } from "jotai-family";
import type { DiffFileEntry } from "@bb/server-contract";
import type { GitDiffStats } from "../../git-diff/git-diff-parsing";
import { GIT_DIFF_AUTO_COLLAPSE_FILE_THRESHOLD } from "./gitDiffPanelHelpers";

export function summarizeDiffFileEntries(
  files: readonly DiffFileEntry[],
): GitDiffStats {
  let insertions = 0;
  let deletions = 0;
  for (const file of files) {
    insertions += file.additions;
    deletions += file.deletions;
  }
  return { filesCount: files.length, insertions, deletions };
}

interface DiffFileCardUiState {
  collapsed: boolean;
}

interface DiffFileCardInitialStateArgs {
  entry: DiffFileEntry;
  fileCount: number;
}

export function resolveDiffFileCardInitialState({
  entry,
  fileCount,
}: DiffFileCardInitialStateArgs): DiffFileCardUiState {
  const collapsed =
    fileCount > GIT_DIFF_AUTO_COLLAPSE_FILE_THRESHOLD ||
    entry.changeKind === "deleted";
  return { collapsed };
}

interface DiffFileCardStateKey {
  diffIdentity: string;
  path: string;
}

function diffFileCardStateKeyEquals(
  a: DiffFileCardStateKey,
  b: DiffFileCardStateKey,
): boolean {
  return a.diffIdentity === b.diffIdentity && a.path === b.path;
}

export const diffFileCardStateAtomFamily = atomFamily(
  (_key: DiffFileCardStateKey) => atom<DiffFileCardUiState | null>(null),
  diffFileCardStateKeyEquals,
);

export function resolveCardCollapsed(
  storedState: DiffFileCardUiState | null,
  entry: DiffFileEntry,
  fileCount: number,
): boolean {
  return (
    storedState?.collapsed ??
    resolveDiffFileCardInitialState({ entry, fileCount }).collapsed
  );
}

interface DiffFilesCollapseControls {
  areAllCollapsed: boolean;
  toggleAllCollapsed: () => void;
  hasFiles: boolean;
}

export function useDiffFilesCollapseControls(
  diffIdentity: string,
  files: readonly DiffFileEntry[],
): DiffFilesCollapseControls {
  const areAllCollapsedAtom = useMemo(
    () =>
      atom((get) => {
        if (files.length === 0) {
          return false;
        }
        return files.every((entry) =>
          resolveCardCollapsed(
            get(
              diffFileCardStateAtomFamily({ diffIdentity, path: entry.path }),
            ),
            entry,
            files.length,
          ),
        );
      }),
    [diffIdentity, files],
  );
  const areAllCollapsed = useAtomValue(areAllCollapsedAtom);

  const setAllCollapsed = useAtomCallback(
    useCallback(
      (get, set, collapsed: boolean) => {
        for (const entry of files) {
          const stateAtom = diffFileCardStateAtomFamily({
            diffIdentity,
            path: entry.path,
          });
          const current = get(stateAtom);
          if (current?.collapsed === collapsed) {
            continue;
          }
          set(stateAtom, { ...(current ?? {}), collapsed });
        }
      },
      [diffIdentity, files],
    ),
  );

  const toggleAllCollapsed = useCallback(() => {
    setAllCollapsed(!areAllCollapsed);
  }, [areAllCollapsed, setAllCollapsed]);

  return {
    areAllCollapsed,
    toggleAllCollapsed,
    hasFiles: files.length > 0,
  };
}

export function clearDiffFileCardStates(activeDiffIdentity: string): void {
  for (const key of diffFileCardStateAtomFamily.getParams()) {
    if (key.diffIdentity !== activeDiffIdentity) {
      diffFileCardStateAtomFamily.remove(key);
    }
  }
}

export const DIFF_CARD_HEADER_HEIGHT_PX = 40;
const DIFF_CARD_LINE_HEIGHT_PX = 18;
const DIFF_CARD_BODY_PADDING_PX = 16;
const DIFF_CARD_MAX_ESTIMATED_LINES = 80;

interface EstimateCardHeightArgs {
  entry: DiffFileEntry;
  collapsed: boolean;
}

export function estimateCardHeight({
  entry,
  collapsed,
}: EstimateCardHeightArgs): number {
  if (collapsed) {
    return DIFF_CARD_HEADER_HEIGHT_PX;
  }
  const changedLines = entry.additions + entry.deletions;
  if (changedLines === 0) {
    return DIFF_CARD_HEADER_HEIGHT_PX;
  }
  const renderedLines = Math.min(changedLines, DIFF_CARD_MAX_ESTIMATED_LINES);
  return (
    DIFF_CARD_HEADER_HEIGHT_PX +
    DIFF_CARD_BODY_PADDING_PX +
    renderedLines * DIFF_CARD_LINE_HEIGHT_PX
  );
}
