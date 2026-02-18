import { useCallback, useEffect, useMemo, useState } from "react";

const TASK_DRAFT_STORAGE_PREFIX = "beanbag.taskcomposer.contents";
const TASK_DRAFT_STORAGE_VERSION = "1";

interface TaskDraftScope {
  projectId?: string | null;
}

interface TaskDraftValue {
  title: string;
  description: string;
}

const EMPTY_TASK_DRAFT: TaskDraftValue = {
  title: "",
  description: "",
};

function normalizeStorageSegment(value: string): string {
  return encodeURIComponent(value.trim());
}

function getObjectStringProperty(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") return null;
  const property = Reflect.get(value, key);
  return typeof property === "string" ? property : null;
}

function decodeTaskDraft(raw: string | null): TaskDraftValue {
  if (!raw) return EMPTY_TASK_DRAFT;
  try {
    const parsed = JSON.parse(raw);
    const title = getObjectStringProperty(parsed, "title");
    const description = getObjectStringProperty(parsed, "description");
    if (title === null || description === null) {
      return EMPTY_TASK_DRAFT;
    }
    return { title, description };
  } catch {
    return EMPTY_TASK_DRAFT;
  }
}

function readTaskDraft(storageKey: string | null): TaskDraftValue {
  if (!storageKey || typeof window === "undefined") return EMPTY_TASK_DRAFT;
  return decodeTaskDraft(window.localStorage.getItem(storageKey));
}

function writeTaskDraft(storageKey: string | null, draft: TaskDraftValue): void {
  if (!storageKey || typeof window === "undefined") return;
  if (draft.title.length === 0 && draft.description.length === 0) {
    window.localStorage.removeItem(storageKey);
    return;
  }
  window.localStorage.setItem(storageKey, JSON.stringify(draft));
}

export function getTaskDraftStorageKey({
  projectId,
}: TaskDraftScope): string | null {
  if (!projectId) return null;
  const normalizedProjectId = normalizeStorageSegment(projectId);
  return `${TASK_DRAFT_STORAGE_PREFIX}-${normalizedProjectId}-draft-${TASK_DRAFT_STORAGE_VERSION}`;
}

export function useTaskDraftStorage(scope: TaskDraftScope) {
  const storageKey = useMemo(
    () =>
      getTaskDraftStorageKey({
        projectId: scope.projectId,
      }),
    [scope.projectId],
  );
  const [draft, setDraft] = useState(() => readTaskDraft(storageKey));

  useEffect(() => {
    setDraft(readTaskDraft(storageKey));
  }, [storageKey]);

  const setTitle = useCallback(
    (nextTitle: string) => {
      setDraft((previousDraft) => {
        const nextDraft = {
          ...previousDraft,
          title: nextTitle,
        };
        writeTaskDraft(storageKey, nextDraft);
        return nextDraft;
      });
    },
    [storageKey],
  );

  const setDescription = useCallback(
    (nextDescription: string) => {
      setDraft((previousDraft) => {
        const nextDraft = {
          ...previousDraft,
          description: nextDescription,
        };
        writeTaskDraft(storageKey, nextDraft);
        return nextDraft;
      });
    },
    [storageKey],
  );

  const clear = useCallback(() => {
    const nextDraft = {
      title: "",
      description: "",
    };
    setDraft(nextDraft);
    writeTaskDraft(storageKey, nextDraft);
  }, [storageKey]);

  return {
    storageKey,
    title: draft.title,
    description: draft.description,
    setTitle,
    setDescription,
    clear,
  };
}
