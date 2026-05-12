import type { ThreadType } from "@bb/domain";
import {
  DEFAULT_THREAD_STORAGE_FILE_LIST_OPTIONS,
  type ThreadStorageFileListOptions,
} from "@/lib/thread-storage-files";
import {
  useThreadStorageFilePreview,
  useThreadStorageFiles,
} from "../../hooks/queries/thread-queries";

interface UseThreadStorageViewerParams {
  activePath: string | null;
  fileListEnabled?: boolean;
  fileListOptions?: ThreadStorageFileListOptions;
  filePreviewEnabled?: boolean;
  threadId?: string;
  threadType?: ThreadType;
}

export function useThreadStorageViewer({
  activePath,
  fileListEnabled = true,
  fileListOptions = DEFAULT_THREAD_STORAGE_FILE_LIST_OPTIONS,
  filePreviewEnabled = true,
  threadId,
  threadType,
}: UseThreadStorageViewerParams) {
  const isManagerThread = threadType === "manager";
  const {
    data: threadStorageFiles,
    isLoading: isThreadStorageFilesLoading,
    error: threadStorageFilesError,
  } = useThreadStorageFiles(threadId ?? "", fileListOptions, {
    enabled: isManagerThread && fileListEnabled,
  });
  const {
    data: threadStorageFilePreview,
    isLoading: isThreadStorageFilePreviewLoading,
    error: threadStorageFilePreviewError,
  } = useThreadStorageFilePreview(threadId ?? "", activePath, {
    enabled: isManagerThread && filePreviewEnabled && activePath !== null,
  });

  return {
    isThreadStorageFilePreviewLoading,
    isThreadStorageFilesLoading,
    threadStorageFilePreview,
    threadStorageFilePreviewError,
    threadStorageFilesError,
    threadStorageFiles,
  };
}
