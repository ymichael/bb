import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { PromptDraftAttachment, PromptDraftState } from "@/lib/prompt-draft";
import {
  emptyPromptDraftState,
  isPromptDraftEmpty,
  parsePromptDraftStorage,
  serializePromptDraftStorage,
} from "@/lib/prompt-draft";

const PROMPT_DRAFT_STORAGE_PREFIX = "bb.promptbox.contents";
const PROMPT_DRAFT_STORAGE_VERSION = "3";

interface PromptDraftScope {
  projectId?: string | null;
  threadId?: string | null;
}

interface PromptDraftCacheEntry {
  rawValue: string | null;
  draft: PromptDraftState;
}

type PromptDraftListener = () => void;

const EMPTY_PROMPT_DRAFT = emptyPromptDraftState();
const promptDraftCache = new Map<string, PromptDraftCacheEntry>();
const promptDraftSubscribers = new Map<string, Set<PromptDraftListener>>();
let promptDraftStorageObserverInitialized = false;

function normalizeStorageSegment(value: string): string {
  return encodeURIComponent(value.trim());
}

function readPromptDraft(storageKey: string | null): PromptDraftState {
  if (!storageKey || typeof window === "undefined") {
    return EMPTY_PROMPT_DRAFT;
  }

  const rawValue = window.localStorage.getItem(storageKey);
  const cachedEntry = promptDraftCache.get(storageKey);
  if (cachedEntry && cachedEntry.rawValue === rawValue) {
    return cachedEntry.draft;
  }

  const draft = parsePromptDraftStorage(rawValue);
  promptDraftCache.set(storageKey, {
    rawValue,
    draft,
  });
  return draft;
}

function emitPromptDraftChange(storageKey: string): void {
  const listeners = promptDraftSubscribers.get(storageKey);
  if (!listeners || listeners.size === 0) return;

  for (const listener of listeners) {
    listener();
  }
}

function ensurePromptDraftStorageObserver(): void {
  if (promptDraftStorageObserverInitialized || typeof window === "undefined") {
    return;
  }

  promptDraftStorageObserverInitialized = true;
  window.addEventListener("storage", (event) => {
    if (!event.key) return;
    promptDraftCache.delete(event.key);
    emitPromptDraftChange(event.key);
  });
}

function subscribePromptDraft(
  storageKey: string | null,
  listener: PromptDraftListener,
): () => void {
  if (!storageKey) {
    return () => {};
  }

  ensurePromptDraftStorageObserver();

  let listeners = promptDraftSubscribers.get(storageKey);
  if (!listeners) {
    listeners = new Set();
    promptDraftSubscribers.set(storageKey, listeners);
  }

  listeners.add(listener);
  return () => {
    const existingListeners = promptDraftSubscribers.get(storageKey);
    if (!existingListeners) return;

    existingListeners.delete(listener);
    if (existingListeners.size === 0) {
      promptDraftSubscribers.delete(storageKey);
    }
  };
}

function writePromptDraft(storageKey: string | null, value: PromptDraftState): void {
  if (!storageKey || typeof window === "undefined") return;

  // Keep all prompt composer mounts in sync, including late async completions from
  // a previously unmounted thread view.
  const serialized = serializePromptDraftStorage(value);
  if (!serialized) {
    window.localStorage.removeItem(storageKey);
    promptDraftCache.set(storageKey, {
      rawValue: null,
      draft: EMPTY_PROMPT_DRAFT,
    });
    emitPromptDraftChange(storageKey);
    return;
  }

  window.localStorage.setItem(storageKey, serialized);
  promptDraftCache.set(storageKey, {
    rawValue: serialized,
    draft: value,
  });
  emitPromptDraftChange(storageKey);
}

function restorePromptDraftIfEmpty(
  storageKey: string | null,
  value: PromptDraftState,
): boolean {
  if (!storageKey || typeof window === "undefined" || isPromptDraftEmpty(value)) {
    return false;
  }

  if (!isPromptDraftEmpty(readPromptDraft(storageKey))) {
    return false;
  }

  writePromptDraft(storageKey, value);
  return true;
}

function getPromptDraftStorageKey({
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
  const draft = useSyncExternalStore(
    useCallback(
      (listener) => subscribePromptDraft(storageKey, listener),
      [storageKey],
    ),
    useCallback(() => readPromptDraft(storageKey), [storageKey]),
    () => EMPTY_PROMPT_DRAFT,
  );

  const setDraftAndPersist = useCallback(
    (nextDraft: PromptDraftState) => {
      writePromptDraft(storageKey, nextDraft);
    },
    [storageKey],
  );

  const getCurrent = useCallback((): PromptDraftState => {
    return readPromptDraft(storageKey);
  }, [storageKey]);

  const setText = useCallback((nextText: string) => {
    writePromptDraft(storageKey, {
      ...readPromptDraft(storageKey),
      text: nextText,
    });
  }, [storageKey]);

  const appendText = useCallback((chunk: string) => {
    const normalizedChunk = chunk.replace(/\s+/g, " ").trim();
    if (normalizedChunk.length === 0) return;

    const currentDraft = readPromptDraft(storageKey);
    const trimmedCurrent = currentDraft.text.trimEnd();
    const nextText =
      trimmedCurrent.length === 0
        ? normalizedChunk
        : `${trimmedCurrent} ${normalizedChunk}`;
    writePromptDraft(storageKey, {
      ...currentDraft,
      text: nextText,
    });
  }, [storageKey]);

  const addAttachment = useCallback((attachment: PromptDraftAttachment) => {
    const currentDraft = readPromptDraft(storageKey);
    const alreadyExists = currentDraft.attachments.some(
      (existingAttachment) => existingAttachment.path === attachment.path,
    );
    if (alreadyExists) return;

    writePromptDraft(storageKey, {
      ...currentDraft,
      attachments: [...currentDraft.attachments, attachment],
    });
  }, [storageKey]);

  const removeAttachment = useCallback((path: string) => {
    const currentDraft = readPromptDraft(storageKey);
    const nextAttachments = currentDraft.attachments.filter(
      (attachment) => attachment.path !== path,
    );
    if (nextAttachments.length === currentDraft.attachments.length) {
      return;
    }

    writePromptDraft(storageKey, {
      ...currentDraft,
      attachments: nextAttachments,
    });
  }, [storageKey]);

  const clear = useCallback(() => {
    setDraftAndPersist(EMPTY_PROMPT_DRAFT);
  }, [setDraftAndPersist]);

  const setAttachments = useCallback((attachments: PromptDraftAttachment[]) => {
    writePromptDraft(storageKey, {
      ...readPromptDraft(storageKey),
      attachments,
    });
  }, [storageKey]);

  const restoreIfEmpty = useCallback((nextDraft: PromptDraftState) => {
    restorePromptDraftIfEmpty(storageKey, nextDraft);
  }, [storageKey]);

  return {
    storageKey,
    getCurrent,
    value: draft.text,
    text: draft.text,
    attachments: draft.attachments,
    setValue: setText,
    setText,
    setAttachments,
    appendText,
    addAttachment,
    removeAttachment,
    clear,
    restoreIfEmpty,
  };
}
