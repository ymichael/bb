import { useCallback, useEffect, useRef } from "react";
import { useSetAtom } from "jotai";
import { useAtomCallback } from "jotai/utils";
import type { ParsedGitDiffFile } from "./git-diff-parsing";
import {
  gitDiffCollapsedFileKeysAtom,
  gitDiffLoadingFileKeysAtom,
} from "../threadSecondaryPanelAtoms";

const GIT_DIFF_FILE_RENDER_SPINNER_MS = 150;
const GIT_DIFF_PARSE_BATCH_THRESHOLD = 24;
const GIT_DIFF_FILE_INITIAL_RENDER_COUNT = 4;
const GIT_DIFF_FILE_RENDER_BATCH_SIZE = 6;
const GIT_DIFF_FILE_INITIAL_DELAY_MS = 30;
const GIT_DIFF_FILE_RENDER_BATCH_DELAY_MS = 70;

interface ParsedGitDiffFileEntry {
  key: string;
  fileDiff: ParsedGitDiffFile;
}

export function useGitDiffFileRenderQueue({
  environmentId,
  gitDiff,
  parsedGitDiffFileEntries,
  isDiffPanelActive,
  isParsingGitDiffFiles,
}: {
  environmentId?: string;
  gitDiff?: string;
  parsedGitDiffFileEntries: ParsedGitDiffFileEntry[];
  isDiffPanelActive: boolean;
  isParsingGitDiffFiles: boolean;
}) {
  const getCollapsedFileKeys = useAtomCallback(
    useCallback((get) => get(gitDiffCollapsedFileKeysAtom), []),
  );
  const setCollapsedFileKeys = useSetAtom(gitDiffCollapsedFileKeysAtom);
  const setLoadingFileKeys = useSetAtom(gitDiffLoadingFileKeysAtom);
  const gitDiffFileRenderTimersRef = useRef<Map<string, number>>(new Map());
  const queuedGitDiffFileRenderKeysRef = useRef<Set<string>>(new Set());
  const gitDiffFileRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  useEffect(() => {
    for (const timerId of gitDiffFileRenderTimersRef.current.values()) {
      window.clearTimeout(timerId);
    }
    gitDiffFileRenderTimersRef.current.clear();
    setCollapsedFileKeys(new Set());
    setLoadingFileKeys(new Set());
  }, [environmentId, gitDiff, setCollapsedFileKeys, setLoadingFileKeys]);

  useEffect(() => {
    queuedGitDiffFileRenderKeysRef.current.clear();
  }, [environmentId, gitDiff]);

  useEffect(
    () => () => {
      for (const timerId of gitDiffFileRenderTimersRef.current.values()) {
        window.clearTimeout(timerId);
      }
      gitDiffFileRenderTimersRef.current.clear();
      queuedGitDiffFileRenderKeysRef.current.clear();
    },
    [],
  );

  const scheduleGitDiffFileRender = useCallback(
    (
      fileKeys: readonly string[],
      options?: {
        initialBatchSize?: number;
        initialDelayMs?: number;
        batchSize?: number;
        batchDelayMs?: number;
      },
    ) => {
      if (fileKeys.length === 0) return;

      const initialBatchSize = Math.max(
        1,
        Math.min(options?.initialBatchSize ?? fileKeys.length, fileKeys.length),
      );
      const batchSize = Math.max(1, options?.batchSize ?? fileKeys.length);
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
        for (const key of fileKeys) {
          nextKeys.add(key);
        }
        return nextKeys;
      });

      for (let index = 0; index < fileKeys.length; index += 1) {
        const key = fileKeys[index]!;
        const existingTimer = gitDiffFileRenderTimersRef.current.get(key);
        if (existingTimer !== undefined) {
          window.clearTimeout(existingTimer);
        }
        const delay =
          index < initialBatchSize
            ? initialDelayMs
            : initialDelayMs +
              (Math.floor((index - initialBatchSize) / batchSize) + 1) *
                batchDelayMs;
        const timerId = window.setTimeout(() => {
          setLoadingFileKeys((currentKeys) => {
            if (!currentKeys.has(key)) return currentKeys;
            const nextKeys = new Set(currentKeys);
            nextKeys.delete(key);
            return nextKeys;
          });
          gitDiffFileRenderTimersRef.current.delete(key);
        }, delay);
        gitDiffFileRenderTimersRef.current.set(key, timerId);
      }
    },
    [setLoadingFileKeys],
  );

  useEffect(() => {
    if (!isDiffPanelActive || parsedGitDiffFileEntries.length === 0) {
      return;
    }

    const collapsed = getCollapsedFileKeys();
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
      parsedGitDiffFileEntries.length > GIT_DIFF_PARSE_BATCH_THRESHOLD ||
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
    isDiffPanelActive,
    isParsingGitDiffFiles,
    parsedGitDiffFileEntries,
    scheduleGitDiffFileRender,
    getCollapsedFileKeys,
  ]);

  const toggleGitDiffFileCollapsed = useCallback(
    (fileKey: string) => {
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
      const existingTimer = gitDiffFileRenderTimersRef.current.get(fileKey);
      if (existingTimer !== undefined) {
        window.clearTimeout(existingTimer);
        gitDiffFileRenderTimersRef.current.delete(fileKey);
      }
      setLoadingFileKeys((currentKeys) => {
        if (!currentKeys.has(fileKey)) return currentKeys;
        const nextKeys = new Set(currentKeys);
        nextKeys.delete(fileKey);
        return nextKeys;
      });
    },
    [
      scheduleGitDiffFileRender,
      setCollapsedFileKeys,
      setLoadingFileKeys,
      getCollapsedFileKeys,
    ],
  );

  const expandGitDiffFile = useCallback(
    (fileKey: string) => {
      setCollapsedFileKeys((currentKeys) => {
        if (!currentKeys.has(fileKey)) {
          return currentKeys;
        }
        const nextKeys = new Set(currentKeys);
        nextKeys.delete(fileKey);
        return nextKeys;
      });
      scheduleGitDiffFileRender([fileKey]);
    },
    [scheduleGitDiffFileRender, setCollapsedFileKeys],
  );

  const toggleAllGitDiffFilesCollapsed = useCallback(() => {
    if (parsedGitDiffFileEntries.length === 0) return;
    const allFileKeys = parsedGitDiffFileEntries.map(({ key }) => key);
    const currentCollapsed = getCollapsedFileKeys();
    const areAllCollapsed = allFileKeys.every((key) =>
      currentCollapsed.has(key),
    );
    if (areAllCollapsed) {
      setCollapsedFileKeys(new Set());
      scheduleGitDiffFileRender(allFileKeys);
      return;
    }
    for (const timerId of gitDiffFileRenderTimersRef.current.values()) {
      window.clearTimeout(timerId);
    }
    gitDiffFileRenderTimersRef.current.clear();
    setCollapsedFileKeys(new Set(allFileKeys));
    setLoadingFileKeys(new Set());
  }, [
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
    expandGitDiffFile,
    gitDiffFileRefs,
    queuedGitDiffFileRenderKeys: queuedGitDiffFileRenderKeysRef.current,
    setGitDiffFileRef,
    toggleAllGitDiffFilesCollapsed,
    toggleGitDiffFileCollapsed,
  };
}
