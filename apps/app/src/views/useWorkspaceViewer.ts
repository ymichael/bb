import { useCallback, useEffect, useMemo, useState } from "react";
import type { ThreadType } from "@bb/domain";
import {
  useManagerWorkspaceFilePreview,
  useManagerWorkspaceFiles,
} from "../hooks/useApi";

const LEGACY_MANAGER_DEBUG_VIEW_STORAGE_KEY_PREFIX = "thread-manager-debug-view:";
const WORKSPACE_VIEWER_STORAGE_KEY_PREFIX = "thread-manager-workspace-viewer:";

interface UseWorkspaceViewerParams {
  threadId?: string;
  threadType?: ThreadType;
}

type WorkspaceViewerToggleHandler = (checked: boolean) => void;

function getWorkspaceViewerStorageKey(threadId: string) {
  return `${WORKSPACE_VIEWER_STORAGE_KEY_PREFIX}${threadId}`;
}

function getLegacyWorkspaceViewerStorageKey(threadId: string) {
  return `${LEGACY_MANAGER_DEBUG_VIEW_STORAGE_KEY_PREFIX}${threadId}`;
}

export function useWorkspaceViewer({
  threadId,
  threadType,
}: UseWorkspaceViewerParams) {
  const isManagerThread = threadType === "manager";
  const [showWorkspaceViewer, setShowWorkspaceViewer] = useState(false);
  const [selectedWorkspacePath, setSelectedWorkspacePath] =
    useState<string | null>(null);
  const { data: workspaceFiles } = useManagerWorkspaceFiles(
    threadId ?? "",
    {
      enabled: isManagerThread,
    },
  );
  const effectiveWorkspacePath = useMemo(() => {
    if (!isManagerThread) {
      return null;
    }

    return selectedWorkspacePath ?? workspaceFiles?.files?.[0]?.path ?? null;
  }, [isManagerThread, workspaceFiles?.files, selectedWorkspacePath]);
  const {
    data: workspaceFilePreview,
    isLoading: isWorkspaceFilePreviewLoading,
    error: workspaceFilePreviewError,
  } = useManagerWorkspaceFilePreview(threadId ?? "", effectiveWorkspacePath, {
    enabled: isManagerThread && effectiveWorkspacePath !== null,
  });

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    if (!threadId || !isManagerThread) {
      setShowWorkspaceViewer(false);
      return;
    }

    const rawValue =
      window.localStorage.getItem(getWorkspaceViewerStorageKey(threadId)) ??
      window.localStorage.getItem(getLegacyWorkspaceViewerStorageKey(threadId));
    setShowWorkspaceViewer(rawValue === "true");
  }, [isManagerThread, threadId]);

  const handleWorkspaceViewerChange: WorkspaceViewerToggleHandler = useCallback(
    (checked) => {
      setShowWorkspaceViewer(checked);
      if (typeof window === "undefined" || !threadId || !isManagerThread) {
        return;
      }

      const storageKey = getWorkspaceViewerStorageKey(threadId);
      const legacyStorageKey = getLegacyWorkspaceViewerStorageKey(threadId);
      if (checked) {
        window.localStorage.setItem(storageKey, "true");
        window.localStorage.removeItem(legacyStorageKey);
        return;
      }

      window.localStorage.removeItem(storageKey);
      window.localStorage.removeItem(legacyStorageKey);
    },
    [isManagerThread, threadId],
  );

  useEffect(() => {
    if (!isManagerThread) {
      setSelectedWorkspacePath(null);
      return;
    }

    const files = workspaceFiles?.files ?? [];
    if (files.length === 0) {
      setSelectedWorkspacePath(null);
      return;
    }

    setSelectedWorkspacePath((currentPath) =>
      currentPath && files.some((file) => file.path === currentPath)
        ? currentPath
        : null,
    );
  }, [isManagerThread, workspaceFiles?.files]);

  return {
    effectiveWorkspacePath,
    handleWorkspaceViewerChange,
    isManagerThread,
    isWorkspaceFilePreviewLoading,
    workspaceFilePreview,
    workspaceFilePreviewError,
    workspaceFiles,
    selectedWorkspacePath,
    setSelectedWorkspacePath,
    showWorkspaceViewer,
  };
}
