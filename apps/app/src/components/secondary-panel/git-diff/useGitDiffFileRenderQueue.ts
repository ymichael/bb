import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useSetAtom } from "jotai";
import { useAtomCallback } from "jotai/utils";
import type { ParsedGitDiffFileEntry } from "../../git-diff/git-diff-parsing";
import {
  gitDiffCollapsedFileKeysAtom,
  gitDiffLoadingFileKeysAtom,
} from "../threadSecondaryPanelAtoms";
import {
  GIT_DIFF_AUTO_COLLAPSE_FILE_THRESHOLD,
  reconcileGitDiffCollapsedFileKeys,
  type GitDiffBulkCollapsePreference,
} from "./gitDiffPanelHelpers";

const GIT_DIFF_FILE_RENDER_SPINNER_MS = 150;
const GIT_DIFF_FILE_INITIAL_RENDER_COUNT = 4;
const GIT_DIFF_FILE_RENDER_BATCH_SIZE = 6;
const GIT_DIFF_FILE_INITIAL_DELAY_MS = 30;
const GIT_DIFF_FILE_RENDER_BATCH_DELAY_MS = 70;

interface UseGitDiffFileRenderQueueParams {
  environmentId?: string;
  gitDiffIdentity: string;
  expectedGitDiffFileCount: number;
  parsedGitDiffFileEntries: ParsedGitDiffFileEntry[];
  isDiffPanelActive: boolean;
  isParsingGitDiffFiles: boolean;
}

interface ScheduleGitDiffFileRenderOptions {
  initialBatchSize?: number;
  initialDelayMs?: number;
  batchSize?: number;
  batchDelayMs?: number;
}

function areSetsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}

export function useGitDiffFileRenderQueue({
  environmentId,
  gitDiffIdentity,
  expectedGitDiffFileCount,
  parsedGitDiffFileEntries,
  isDiffPanelActive,
  isParsingGitDiffFiles,
}: UseGitDiffFileRenderQueueParams) {
  const getCollapsedFileKeys = useAtomCallback(
    useCallback((get) => get(gitDiffCollapsedFileKeysAtom), []),
  );
  const setCollapsedFileKeys = useSetAtom(gitDiffCollapsedFileKeysAtom);
  const setLoadingFileKeys = useSetAtom(gitDiffLoadingFileKeysAtom);
  const gitDiffFileRenderTimerBatchesRef = useRef<Map<number, Set<string>>>(
    new Map(),
  );
  const gitDiffFileRenderTimerIdByKeyRef = useRef<Map<string, number>>(
    new Map(),
  );
  const bulkCollapsePreferenceRef =
    useRef<GitDiffBulkCollapsePreference>("default");
  const focusedGitDiffFileKeyRef = useRef<string | null>(null);
  const knownGitDiffFileKeysRef = useRef<ReadonlySet<string>>(
    new Set<string>(),
  );
  const queuedGitDiffFileRenderKeysRef = useRef<Set<string>>(new Set());
  const gitDiffFileRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const clearScheduledGitDiffFileRender = useCallback((fileKey: string) => {
    const timerId = gitDiffFileRenderTimerIdByKeyRef.current.get(fileKey);
    if (timerId === undefined) return;

    gitDiffFileRenderTimerIdByKeyRef.current.delete(fileKey);
    const batchFileKeys = gitDiffFileRenderTimerBatchesRef.current.get(timerId);
    if (!batchFileKeys) return;

    batchFileKeys.delete(fileKey);
    if (batchFileKeys.size === 0) {
      window.clearTimeout(timerId);
      gitDiffFileRenderTimerBatchesRef.current.delete(timerId);
    }
  }, []);

  const clearAllScheduledGitDiffFileRenders = useCallback(() => {
    for (const timerId of gitDiffFileRenderTimerBatchesRef.current.keys()) {
      window.clearTimeout(timerId);
    }
    gitDiffFileRenderTimerBatchesRef.current.clear();
    gitDiffFileRenderTimerIdByKeyRef.current.clear();
  }, []);

  useLayoutEffect(() => {
    clearAllScheduledGitDiffFileRenders();
    bulkCollapsePreferenceRef.current = "default";
    focusedGitDiffFileKeyRef.current = null;
    knownGitDiffFileKeysRef.current = new Set<string>();
    queuedGitDiffFileRenderKeysRef.current.clear();
    setCollapsedFileKeys(new Set());
    setLoadingFileKeys(new Set());
  }, [
    environmentId,
    gitDiffIdentity,
    clearAllScheduledGitDiffFileRenders,
    setCollapsedFileKeys,
    setLoadingFileKeys,
  ]);

  useEffect(
    () => () => {
      clearAllScheduledGitDiffFileRenders();
      queuedGitDiffFileRenderKeysRef.current.clear();
    },
    [clearAllScheduledGitDiffFileRenders],
  );

  const scheduleGitDiffFileRender = useCallback(
    (
      fileKeys: readonly string[],
      options?: ScheduleGitDiffFileRenderOptions,
    ) => {
      if (fileKeys.length === 0) return;

      const uniqueFileKeys: string[] = [];
      const seenFileKeys = new Set<string>();
      for (const key of fileKeys) {
        if (seenFileKeys.has(key)) continue;
        seenFileKeys.add(key);
        uniqueFileKeys.push(key);
      }
      if (uniqueFileKeys.length === 0) return;

      const initialBatchSize = Math.max(
        1,
        Math.min(
          options?.initialBatchSize ?? uniqueFileKeys.length,
          uniqueFileKeys.length,
        ),
      );
      const batchSize = Math.max(
        1,
        options?.batchSize ?? uniqueFileKeys.length,
      );
      const initialDelayMs = Math.max(
        0,
        options?.initialDelayMs ?? GIT_DIFF_FILE_RENDER_SPINNER_MS,
      );
      const batchDelayMs = Math.max(
        0,
        options?.batchDelayMs ?? GIT_DIFF_FILE_RENDER_SPINNER_MS,
      );

      setLoadingFileKeys((currentKeys) => {
        const nextKeys = new Set(currentKeys);
        for (const key of uniqueFileKeys) {
          nextKeys.add(key);
        }
        return nextKeys;
      });

      for (const key of uniqueFileKeys) {
        clearScheduledGitDiffFileRender(key);
      }

      const scheduleBatch = (
        batchFileKeys: readonly string[],
        delay: number,
      ) => {
        const batchFileKeySet = new Set(batchFileKeys);
        let timerId = 0;
        timerId = window.setTimeout(() => {
          const completedFileKeys =
            gitDiffFileRenderTimerBatchesRef.current.get(timerId);
          if (!completedFileKeys) return;

          gitDiffFileRenderTimerBatchesRef.current.delete(timerId);
          for (const key of completedFileKeys) {
            gitDiffFileRenderTimerIdByKeyRef.current.delete(key);
          }

          setLoadingFileKeys((currentKeys) => {
            let changed = false;
            const nextKeys = new Set(currentKeys);
            for (const key of completedFileKeys) {
              changed = nextKeys.delete(key) || changed;
            }
            return changed ? nextKeys : currentKeys;
          });
        }, delay);

        gitDiffFileRenderTimerBatchesRef.current.set(timerId, batchFileKeySet);
        for (const key of batchFileKeySet) {
          gitDiffFileRenderTimerIdByKeyRef.current.set(key, timerId);
        }
      };

      scheduleBatch(uniqueFileKeys.slice(0, initialBatchSize), initialDelayMs);

      let batchIndex = 0;
      for (
        let startIndex = initialBatchSize;
        startIndex < uniqueFileKeys.length;
        startIndex += batchSize
      ) {
        const delay = initialDelayMs + (batchIndex + 1) * batchDelayMs;
        scheduleBatch(
          uniqueFileKeys.slice(startIndex, startIndex + batchSize),
          delay,
        );
        batchIndex += 1;
      }
    },
    [clearScheduledGitDiffFileRender, setLoadingFileKeys],
  );

  useLayoutEffect(() => {
    if (!isDiffPanelActive) {
      return;
    }

    if (
      parsedGitDiffFileEntries.length === 0 &&
      !isParsingGitDiffFiles &&
      expectedGitDiffFileCount === 0
    ) {
      knownGitDiffFileKeysRef.current = new Set<string>();
      queuedGitDiffFileRenderKeysRef.current.clear();
      setCollapsedFileKeys((currentKeys) =>
        currentKeys.size === 0 ? currentKeys : new Set(),
      );
      setLoadingFileKeys((currentKeys) =>
        currentKeys.size === 0 ? currentKeys : new Set(),
      );
      clearAllScheduledGitDiffFileRenders();
      return;
    }

    if (parsedGitDiffFileEntries.length === 0) {
      return;
    }

    const nextKnownFileKeys = new Set(
      parsedGitDiffFileEntries.map(({ key }) => key),
    );
    if (
      focusedGitDiffFileKeyRef.current !== null &&
      !nextKnownFileKeys.has(focusedGitDiffFileKeyRef.current)
    ) {
      focusedGitDiffFileKeyRef.current = null;
    }
    for (const key of queuedGitDiffFileRenderKeysRef.current) {
      if (!nextKnownFileKeys.has(key)) {
        queuedGitDiffFileRenderKeysRef.current.delete(key);
      }
    }

    const collapsed = reconcileGitDiffCollapsedFileKeys({
      bulkCollapsePreference: bulkCollapsePreferenceRef.current,
      currentCollapsedFileKeys: getCollapsedFileKeys(),
      expectedFileCount: expectedGitDiffFileCount,
      focusedFileKey: focusedGitDiffFileKeyRef.current,
      parsedGitDiffFileEntries,
      previousFileKeys: knownGitDiffFileKeysRef.current,
    });
    knownGitDiffFileKeysRef.current = nextKnownFileKeys;
    setCollapsedFileKeys((currentKeys) =>
      areSetsEqual(currentKeys, collapsed) ? currentKeys : collapsed,
    );

    const newKeysToRender: string[] = [];
    for (const { key } of parsedGitDiffFileEntries) {
      if (queuedGitDiffFileRenderKeysRef.current.has(key)) {
        continue;
      }
      queuedGitDiffFileRenderKeysRef.current.add(key);
      if (!collapsed.has(key)) {
        newKeysToRender.push(key);
      }
    }

    if (newKeysToRender.length === 0) {
      return;
    }

    const shouldBatchRender =
      expectedGitDiffFileCount > GIT_DIFF_AUTO_COLLAPSE_FILE_THRESHOLD ||
      isParsingGitDiffFiles ||
      newKeysToRender.length > GIT_DIFF_FILE_INITIAL_RENDER_COUNT;
    scheduleGitDiffFileRender(
      newKeysToRender,
      shouldBatchRender
        ? {
            initialBatchSize: GIT_DIFF_FILE_INITIAL_RENDER_COUNT,
            initialDelayMs: GIT_DIFF_FILE_INITIAL_DELAY_MS,
            batchSize: GIT_DIFF_FILE_RENDER_BATCH_SIZE,
            batchDelayMs: GIT_DIFF_FILE_RENDER_BATCH_DELAY_MS,
          }
        : undefined,
    );
  }, [
    clearAllScheduledGitDiffFileRenders,
    expectedGitDiffFileCount,
    getCollapsedFileKeys,
    isDiffPanelActive,
    isParsingGitDiffFiles,
    parsedGitDiffFileEntries,
    scheduleGitDiffFileRender,
    setCollapsedFileKeys,
    setLoadingFileKeys,
  ]);

  const toggleGitDiffFileCollapsed = useCallback(
    (fileKey: string) => {
      bulkCollapsePreferenceRef.current = "default";
      focusedGitDiffFileKeyRef.current = null;
      const currentCollapsed = getCollapsedFileKeys();
      const isExpandingFile = currentCollapsed.has(fileKey);
      setCollapsedFileKeys((currentKeys) => {
        const nextKeys = new Set(currentKeys);
        if (isExpandingFile) {
          nextKeys.delete(fileKey);
        } else {
          nextKeys.add(fileKey);
        }
        return nextKeys;
      });
      if (isExpandingFile) {
        scheduleGitDiffFileRender([fileKey]);
        return;
      }
      clearScheduledGitDiffFileRender(fileKey);
      setLoadingFileKeys((currentKeys) => {
        if (!currentKeys.has(fileKey)) return currentKeys;
        const nextKeys = new Set(currentKeys);
        nextKeys.delete(fileKey);
        return nextKeys;
      });
    },
    [
      clearScheduledGitDiffFileRender,
      scheduleGitDiffFileRender,
      setCollapsedFileKeys,
      setLoadingFileKeys,
      getCollapsedFileKeys,
    ],
  );

  const focusGitDiffFile = useCallback(
    (fileKey: string) => {
      if (parsedGitDiffFileEntries.length === 0) return;
      const allFileKeys = parsedGitDiffFileEntries.map(({ key }) => key);
      if (!allFileKeys.includes(fileKey)) return;

      bulkCollapsePreferenceRef.current = "default";
      focusedGitDiffFileKeyRef.current = fileKey;
      queuedGitDiffFileRenderKeysRef.current.add(fileKey);

      const currentCollapsed = getCollapsedFileKeys();
      const isExpandingTarget = currentCollapsed.has(fileKey);
      for (const key of allFileKeys) {
        if (key !== fileKey) {
          clearScheduledGitDiffFileRender(key);
        }
      }

      setCollapsedFileKeys(
        new Set(allFileKeys.filter((key) => key !== fileKey)),
      );
      setLoadingFileKeys((currentKeys) => {
        let changed = false;
        const nextKeys = new Set(currentKeys);
        for (const key of currentKeys) {
          if (key !== fileKey) {
            changed = nextKeys.delete(key) || changed;
          }
        }
        return changed ? nextKeys : currentKeys;
      });

      if (isExpandingTarget) {
        scheduleGitDiffFileRender([fileKey]);
      }
    },
    [
      clearScheduledGitDiffFileRender,
      getCollapsedFileKeys,
      parsedGitDiffFileEntries,
      scheduleGitDiffFileRender,
      setCollapsedFileKeys,
      setLoadingFileKeys,
    ],
  );

  const toggleAllGitDiffFilesCollapsed = useCallback(() => {
    if (parsedGitDiffFileEntries.length === 0) return;
    const allFileKeys = parsedGitDiffFileEntries.map(({ key }) => key);
    const currentCollapsed = getCollapsedFileKeys();
    const areAllCollapsed = allFileKeys.every((key) =>
      currentCollapsed.has(key),
    );
    if (areAllCollapsed) {
      bulkCollapsePreferenceRef.current = "expanded-all";
      focusedGitDiffFileKeyRef.current = null;
      setCollapsedFileKeys(new Set());
      scheduleGitDiffFileRender(allFileKeys);
      return;
    }
    bulkCollapsePreferenceRef.current = "collapsed-all";
    focusedGitDiffFileKeyRef.current = null;
    clearAllScheduledGitDiffFileRenders();
    setCollapsedFileKeys(new Set(allFileKeys));
    setLoadingFileKeys(new Set());
  }, [
    clearAllScheduledGitDiffFileRenders,
    parsedGitDiffFileEntries,
    scheduleGitDiffFileRender,
    setCollapsedFileKeys,
    setLoadingFileKeys,
    getCollapsedFileKeys,
  ]);

  const setGitDiffFileRef = useCallback(
    (fileKey: string, element: HTMLDivElement | null) => {
      if (element) {
        gitDiffFileRefs.current.set(fileKey, element);
        return;
      }
      gitDiffFileRefs.current.delete(fileKey);
    },
    [],
  );

  return {
    focusGitDiffFile,
    gitDiffFileRefs,
    queuedGitDiffFileRenderKeys: queuedGitDiffFileRenderKeysRef.current,
    setGitDiffFileRef,
    toggleAllGitDiffFilesCollapsed,
    toggleGitDiffFileCollapsed,
  };
}
