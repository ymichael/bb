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
  fileListOptions?: ThreadStorageFileListOptions;
  threadId?: string;
  threadType?: ThreadType;
}

export function useThreadStorageViewer({
  activePath,
  fileListOptions = DEFAULT_THREAD_STORAGE_FILE_LIST_OPTIONS,
  threadId,
  threadType,
}: UseThreadStorageViewerParams) {
  const isManagerThread = threadType === "manager";
  const {
    data: threadStorageFiles,
    isLoading: isThreadStorageFilesLoading,
    error: threadStorageFilesError,
  } = useThreadStorageFiles(threadId ?? "", fileListOptions, {
    enabled: isManagerThread,
  });
  const {
    data: threadStorageFilePreview,
    isLoading: isThreadStorageFilePreviewLoading,
    error: threadStorageFilePreviewError,
  } = useThreadStorageFilePreview(threadId ?? "", activePath, {
    enabled: isManagerThread && activePath !== null,
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
