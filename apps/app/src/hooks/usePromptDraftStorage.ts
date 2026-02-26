import { useCallback, useEffect, useMemo, useState } from "react";

const PROMPT_DRAFT_STORAGE_PREFIX = "beanbag.promptbox.contents";
const PROMPT_DRAFT_STORAGE_VERSION = "2";

interface PromptDraftScope {
  projectId?: string | null;
  threadId?: string | null;
}

function normalizeStorageSegment(value: string): string {
  return encodeURIComponent(value.trim());
}

function readPromptDraft(storageKey: string | null): string {
  if (!storageKey || typeof window === "undefined") return "";
  return window.localStorage.getItem(storageKey) ?? "";
}

function writePromptDraft(storageKey: string | null, value: string): void {
  if (!storageKey || typeof window === "undefined") return;
  if (value.length === 0) {
    window.localStorage.removeItem(storageKey);
    return;
  }
  window.localStorage.setItem(storageKey, value);
}

export function getPromptDraftStorageKey({
  projectId,
  threadId,
}: PromptDraftScope): string | null {
  if (!projectId) return null;
  const normalizedProjectId = normalizeStorageSegment(projectId);
  if (threadId) {
    const normalizedThreadId = normalizeStorageSegment(threadId);
    return `${PROMPT_DRAFT_STORAGE_PREFIX}-${normalizedProjectId}-${normalizedThreadId}-${PROMPT_DRAFT_STORAGE_VERSION}`;
  }
  return `${PROMPT_DRAFT_STORAGE_PREFIX}-${normalizedProjectId}-draft-${PROMPT_DRAFT_STORAGE_VERSION}`;
}

export function usePromptDraftStorage(scope: PromptDraftScope) {
  const storageKey = useMemo(
    () =>
      getPromptDraftStorageKey({
        projectId: scope.projectId,
        threadId: scope.threadId,
      }),
    [scope.projectId, scope.threadId],
  );
  const [value, setValue] = useState(() => readPromptDraft(storageKey));

  useEffect(() => {
    setValue(readPromptDraft(storageKey));
  }, [storageKey]);

  const setValueAndPersist = useCallback(
    (nextValue: string) => {
      setValue(nextValue);
      writePromptDraft(storageKey, nextValue);
    },
    [storageKey],
  );

  const clear = useCallback(() => {
    setValue("");
    writePromptDraft(storageKey, "");
  }, [storageKey]);

  return {
    storageKey,
    value,
    setValue: setValueAndPersist,
    clear,
  };
}
