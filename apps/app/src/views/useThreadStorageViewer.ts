import { useEffect, useMemo, useState } from "react";
import type { ThreadType } from "@bb/domain";
import {
  useThreadStorageFilePreview,
  useThreadStorageFiles,
} from "../hooks/queries/thread-queries";

interface UseThreadStorageViewerParams {
  threadId?: string;
  threadType?: ThreadType;
}

export function useThreadStorageViewer({
  threadId,
  threadType,
}: UseThreadStorageViewerParams) {
  const isManagerThread = threadType === "manager";
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
    isThreadStorageFilePreviewLoading,
    threadStorageFilePreview,
    threadStorageFilePreviewError,
    threadStorageFiles,
    selectedThreadStoragePath,
    setSelectedThreadStoragePath,
  };
}
