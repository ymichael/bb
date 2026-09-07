import { useCallback } from "react";
import type { FixedPanelTab } from "@/lib/fixed-panel-tabs-state";
import { sdk } from "@/lib/sdk";
import { DEFAULT_THREAD_STORAGE_FILE_LIST_OPTIONS } from "@/lib/thread-storage-files";
import { useThreadStorageFiles } from "../../hooks/queries/thread-queries";

interface UseThreadStorageViewerParams {
  fileListEnabled?: boolean;
  threadId?: string;
}

export function useThreadStorageViewer({
  fileListEnabled = true,
  threadId,
}: UseThreadStorageViewerParams) {
  const hasThread = Boolean(threadId);
  const {
    data: threadStorageFiles,
    isLoading: isThreadStorageFilesLoading,
    error: threadStorageFilesError,
    refetch: refetchThreadStorageFiles,
  } = useThreadStorageFiles(
    threadId ?? "",
    DEFAULT_THREAD_STORAGE_FILE_LIST_OPTIONS,
    {
      enabled: hasThread && fileListEnabled,
    },
  );
  const checkThreadStorageFileExists = useCallback(
    async (path: string): Promise<boolean> => {
      if (!threadId) return false;
      const result = await sdk.threads.storageFiles({
        limit: "1",
        query: path,
        threadId,
      });
      return result.files.some((file) => file.path === path);
    },
    [threadId],
  );

  return {
    checkThreadStorageFileExists,
    isThreadStorageFilesLoading,
    threadStorageFilesError,
    threadStorageFiles,
    threadStorageRootPath: threadStorageFiles?.storageRootPath ?? null,
    refetchThreadStorageFiles,
  };
}

interface ShouldLoadThreadStorageFileListArgs {
  hasThread: boolean;
  isSecondaryPanelOpen: boolean;
  secondaryTabs: readonly Pick<FixedPanelTab, "kind">[];
}

export function shouldLoadThreadStorageFileList({
  hasThread,
  isSecondaryPanelOpen,
  secondaryTabs,
}: ShouldLoadThreadStorageFileListArgs): boolean {
  if (!hasThread) {
    return false;
  }
  return (
    isSecondaryPanelOpen ||
    secondaryTabs.some((tab) => tab.kind === "thread-storage-file-preview")
  );
}
