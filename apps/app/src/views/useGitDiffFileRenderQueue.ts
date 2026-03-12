import { useCallback, useEffect, useRef, useState } from "react";
import type { ParsedGitDiffFile } from "./threadDetailGitDiff";

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
  threadId,
  gitDiff,
  parsedGitDiffFileEntries,
  isDiffPanelActive,
  isParsingGitDiffFiles,
}: {
  threadId?: string;
  gitDiff?: string;
  parsedGitDiffFileEntries: ParsedGitDiffFileEntry[];
  isDiffPanelActive: boolean;
  isParsingGitDiffFiles: boolean;
}) {
  const [collapsedGitDiffFileKeys, setCollapsedGitDiffFileKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const [loadingGitDiffFileKeys, setLoadingGitDiffFileKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const gitDiffFileRenderTimersRef = useRef<Map<string, number>>(new Map());
  const queuedGitDiffFileRenderKeysRef = useRef<Set<string>>(new Set());
  const gitDiffFileRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  useEffect(() => {
    for (const timerId of gitDiffFileRenderTimersRef.current.values()) {
      window.clearTimeout(timerId);
    }
    gitDiffFileRenderTimersRef.current.clear();
    setCollapsedGitDiffFileKeys(new Set());
    setLoadingGitDiffFileKeys(new Set());
  }, [threadId, gitDiff]);

  useEffect(() => {
    queuedGitDiffFileRenderKeysRef.current.clear();
  }, [threadId, gitDiff]);

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
      const initialDelayMs = Math.max(0, options?.initialDelayMs ?? GIT_DIFF_FILE_RENDER_SPINNER_MS);
      const batchDelayMs = Math.max(0, options?.batchDelayMs ?? GIT_DIFF_FILE_RENDER_SPINNER_MS);

      setLoadingGitDiffFileKeys((currentKeys) => {
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
              (Math.floor((index - initialBatchSize) / batchSize) + 1) * batchDelayMs;
        const timerId = window.setTimeout(() => {
          setLoadingGitDiffFileKeys((currentKeys) => {
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
    [],
  );

  useEffect(() => {
    if (!isDiffPanelActive || parsedGitDiffFileEntries.length === 0) {
      return;
    }

    const newKeysToRender: string[] = [];
    for (const { key } of parsedGitDiffFileEntries) {
      if (queuedGitDiffFileRenderKeysRef.current.has(key)) {
        continue;
      }
      queuedGitDiffFileRenderKeysRef.current.add(key);
      if (!collapsedGitDiffFileKeys.has(key)) {
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
    collapsedGitDiffFileKeys,
    isDiffPanelActive,
    isParsingGitDiffFiles,
    parsedGitDiffFileEntries,
    scheduleGitDiffFileRender,
  ]);

  const toggleGitDiffFileCollapsed = useCallback((fileKey: string) => {
    const isExpandingFile = collapsedGitDiffFileKeys.has(fileKey);
    setCollapsedGitDiffFileKeys((currentKeys) => {
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
    setLoadingGitDiffFileKeys((currentKeys) => {
      if (!currentKeys.has(fileKey)) return currentKeys;
      const nextKeys = new Set(currentKeys);
      nextKeys.delete(fileKey);
      return nextKeys;
    });
  }, [collapsedGitDiffFileKeys, scheduleGitDiffFileRender]);

  const expandGitDiffFile = useCallback((fileKey: string) => {
    setCollapsedGitDiffFileKeys((currentKeys) => {
      if (!currentKeys.has(fileKey)) {
        return currentKeys;
      }
      const nextKeys = new Set(currentKeys);
      nextKeys.delete(fileKey);
      return nextKeys;
    });
    scheduleGitDiffFileRender([fileKey]);
  }, [scheduleGitDiffFileRender]);

  const toggleAllGitDiffFilesCollapsed = useCallback(() => {
    if (parsedGitDiffFileEntries.length === 0) return;
    const allFileKeys = parsedGitDiffFileEntries.map(({ key }) => key);
    const areAllCollapsed = allFileKeys.every((key) => collapsedGitDiffFileKeys.has(key));
    if (areAllCollapsed) {
      setCollapsedGitDiffFileKeys(new Set());
      scheduleGitDiffFileRender(allFileKeys);
      return;
    }
    for (const timerId of gitDiffFileRenderTimersRef.current.values()) {
      window.clearTimeout(timerId);
    }
    gitDiffFileRenderTimersRef.current.clear();
    setCollapsedGitDiffFileKeys(new Set(allFileKeys));
    setLoadingGitDiffFileKeys(new Set());
  }, [collapsedGitDiffFileKeys, parsedGitDiffFileEntries, scheduleGitDiffFileRender]);

  const setGitDiffFileRef = useCallback((fileKey: string, element: HTMLDivElement | null) => {
    if (element) {
      gitDiffFileRefs.current.set(fileKey, element);
      return;
    }
    gitDiffFileRefs.current.delete(fileKey);
  }, []);

  return {
    collapsedGitDiffFileKeys,
    expandGitDiffFile,
    gitDiffFileRefs,
    loadingGitDiffFileKeys,
    queuedGitDiffFileRenderKeys: queuedGitDiffFileRenderKeysRef.current,
    setGitDiffFileRef,
    toggleAllGitDiffFilesCollapsed,
    toggleGitDiffFileCollapsed,
  };
}
