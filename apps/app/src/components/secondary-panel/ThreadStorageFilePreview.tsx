import { FilePreview as FilePreviewSurface } from "./FilePreview";
import { MANAGER_STATUS_FILE_PATH } from "./managerStorage";
import { useThreadStatusVersion } from "@/hooks/queries/thread-queries";
import { HttpError } from "@/lib/api";
import { buildThreadStatusContentUrl } from "@/lib/file-content-urls";
import type {
  FilePreview,
  WorkspaceFilePreviewStatusLabel,
} from "@/lib/file-preview";

interface FilePreviewBaseProps {
  activePath: string;
  copyPath?: string | null;
  error?: Error | null;
  filePreview: FilePreview | undefined;
  isLoading: boolean;
  lineNumber?: number | null;
  onOpenInEditor?: (path: string) => void;
}

interface ThreadStorageFilePreviewProps extends FilePreviewBaseProps {
  pinnedPath: string;
  threadId: string;
}

interface SecondaryPanelFilePreviewProps extends FilePreviewBaseProps {
  pendingNotFoundPath?: string;
  statusLabel?: WorkspaceFilePreviewStatusLabel | null;
}

export function SecondaryPanelFilePreview({
  activePath,
  copyPath = null,
  error,
  filePreview,
  isLoading,
  lineNumber = null,
  onOpenInEditor,
  pendingNotFoundPath,
  statusLabel = null,
}: SecondaryPanelFilePreviewProps) {
  if (error) {
    const isNotFound = error instanceof HttpError && error.status === 404;
    if (isNotFound && activePath === pendingNotFoundPath) {
      return (
        <FilePreviewSurface
          path={activePath}
          copyPath={copyPath}
          onOpenInEditor={onOpenInEditor}
          statusLabel={statusLabel}
          state={{ kind: "manager-status-pending" }}
        />
      );
    }
    return (
      <FilePreviewSurface
        path={activePath}
        copyPath={copyPath}
        onOpenInEditor={onOpenInEditor}
        statusLabel={statusLabel}
        state={{ kind: isNotFound ? "not-found" : "error" }}
      />
    );
  }

  if (isLoading || !filePreview || filePreview.path !== activePath) {
    return (
      <FilePreviewSurface
        path={activePath}
        copyPath={copyPath}
        onOpenInEditor={onOpenInEditor}
        statusLabel={statusLabel}
        state={{ kind: "loading" }}
      />
    );
  }

  if (filePreview.kind === "text") {
    if (filePreview.content.length === 0) {
      return (
        <FilePreviewSurface
          path={activePath}
          copyPath={copyPath}
          onOpenInEditor={onOpenInEditor}
          statusLabel={statusLabel}
          state={{ kind: "empty" }}
        />
      );
    }
    return (
      <FilePreviewSurface
        path={activePath}
        copyPath={copyPath}
        onOpenInEditor={onOpenInEditor}
        statusLabel={statusLabel}
        state={{
          kind: "ready",
          lineNumber,
          file: {
            name: filePreview.name ?? activePath,
            contents: filePreview.content,
          },
        }}
      />
    );
  }

  if (filePreview.kind === "image") {
    return (
      <FilePreviewSurface
        path={activePath}
        copyPath={copyPath}
        onOpenInEditor={onOpenInEditor}
        statusLabel={statusLabel}
        state={{ kind: "image", url: filePreview.url }}
      />
    );
  }

  return (
    <FilePreviewSurface
      path={activePath}
      copyPath={copyPath}
      onOpenInEditor={onOpenInEditor}
      statusLabel={statusLabel}
      state={{
        kind: "error",
        message: `Preview not available for ${filePreview.mimeType}.`,
      }}
    />
  );
}

export function ThreadStorageFilePreview({
  activePath,
  copyPath,
  error,
  filePreview,
  isLoading,
  lineNumber,
  onOpenInEditor,
  pinnedPath,
  threadId,
}: ThreadStorageFilePreviewProps) {
  const statusVersion = useThreadStatusVersion(threadId, {
    enabled: activePath === MANAGER_STATUS_FILE_PATH,
  });

  if (activePath === MANAGER_STATUS_FILE_PATH) {
    return (
      <FilePreviewSurface
        path={activePath}
        copyPath={copyPath}
        state={{
          kind: "iframe",
          title: "Manager status",
          url: buildThreadStatusContentUrl(threadId, statusVersion.data?.hash),
        }}
      />
    );
  }

  return (
    <SecondaryPanelFilePreview
      activePath={activePath}
      copyPath={copyPath}
      error={error}
      filePreview={filePreview}
      isLoading={isLoading}
      lineNumber={lineNumber}
      onOpenInEditor={onOpenInEditor}
      pendingNotFoundPath={pinnedPath}
    />
  );
}
