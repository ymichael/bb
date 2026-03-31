import { useCallback, useEffect, useMemo, useState } from "react";
import type { ThreadType } from "@bb/domain";
import {
  useThreadStorageFilePreview,
  useThreadStorageFiles,
} from "../hooks/useApi";

const SHOW_ALL_EVENTS_STORAGE_KEY_PREFIX = "thread-show-all-events:";

interface UseThreadStorageViewerParams {
  threadId?: string;
  threadType?: ThreadType;
}

type ShowAllEventsToggleHandler = (checked: boolean) => void;

function getShowAllEventsStorageKey(threadId: string) {
  return `${SHOW_ALL_EVENTS_STORAGE_KEY_PREFIX}${threadId}`;
}

export function useThreadStorageViewer({
  threadId,
  threadType,
}: UseThreadStorageViewerParams) {
  const isManagerThread = threadType === "manager";
  const [showAllEvents, setShowAllEvents] = useState(false);
  const [selectedThreadStoragePath, setSelectedThreadStoragePath] =
    useState<string | null>(null);
  const { data: threadStorageFiles } = useThreadStorageFiles(
    threadId ?? "",
    {
      enabled: isManagerThread,
    },
  );
  const effectiveThreadStoragePath = useMemo(() => {
    if (!isManagerThread) {
      return null;
    }

    return selectedThreadStoragePath ?? threadStorageFiles?.files?.[0]?.path ?? null;
  }, [isManagerThread, threadStorageFiles?.files, selectedThreadStoragePath]);
  const {
    data: threadStorageFilePreview,
    isLoading: isThreadStorageFilePreviewLoading,
    error: threadStorageFilePreviewError,
  } = useThreadStorageFilePreview(threadId ?? "", effectiveThreadStoragePath, {
    enabled: isManagerThread && effectiveThreadStoragePath !== null,
  });

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    if (!threadId || !isManagerThread) {
      setShowAllEvents(false);
      return;
    }

    const rawValue = window.localStorage.getItem(getShowAllEventsStorageKey(threadId));
    setShowAllEvents(rawValue === "true");
  }, [isManagerThread, threadId]);

  const handleShowAllEventsChange: ShowAllEventsToggleHandler = useCallback(
    (checked) => {
      setShowAllEvents(checked);
      if (typeof window === "undefined" || !threadId || !isManagerThread) {
        return;
      }

      const storageKey = getShowAllEventsStorageKey(threadId);
      if (checked) {
        window.localStorage.setItem(storageKey, "true");
        return;
      }

      window.localStorage.removeItem(storageKey);
    },
    [isManagerThread, threadId],
  );

  useEffect(() => {
    if (!isManagerThread) {
      setSelectedThreadStoragePath(null);
      return;
    }

    const files = threadStorageFiles?.files ?? [];
    if (files.length === 0) {
      setSelectedThreadStoragePath(null);
      return;
    }

    setSelectedThreadStoragePath((currentPath) =>
      currentPath && files.some((file) => file.path === currentPath)
        ? currentPath
        : null,
    );
  }, [isManagerThread, threadStorageFiles?.files]);

  return {
    effectiveThreadStoragePath,
    handleShowAllEventsChange,
    isManagerThread,
    isThreadStorageFilePreviewLoading,
    showAllEvents,
    threadStorageFilePreview,
    threadStorageFilePreviewError,
    threadStorageFiles,
    selectedThreadStoragePath,
    setSelectedThreadStoragePath,
  };
}
