import { FilePreview as FilePreviewSurface } from "./FilePreview";
import { PINNED_STORAGE_FILE_PATH } from "./managerStorage";
import { HttpError } from "@/lib/api";
import type { FilePreview } from "@/lib/file-preview";

interface ThreadStorageFilePreviewProps {
  activePath: string;
  error?: Error | null;
  filePreview: FilePreview | undefined;
  isLoading: boolean;
  lineNumber?: number | null;
  onOpenInEditor?: (path: string) => void;
}

interface SecondaryPanelFilePreviewProps extends ThreadStorageFilePreviewProps {
  pendingNotFoundPath?: string;
  onOpenInEditor?: (path: string) => void;
}

export function SecondaryPanelFilePreview({
  activePath,
  error,
  filePreview,
  isLoading,
  lineNumber = null,
  pendingNotFoundPath,
  onOpenInEditor,
}: SecondaryPanelFilePreviewProps) {
  if (error) {
    const isNotFound = error instanceof HttpError && error.status === 404;
    if (isNotFound && activePath === pendingNotFoundPath) {
      return (
        <FilePreviewSurface
          path={activePath}
          state={{ kind: "manager-status-pending" }}
        />
      );
    }
    return (
      <FilePreviewSurface
        path={activePath}
        onOpenInEditor={onOpenInEditor}
        state={{ kind: isNotFound ? "not-found" : "error" }}
      />
    );
  }

  if (isLoading || !filePreview || filePreview.path !== activePath) {
    return (
      <FilePreviewSurface
        path={activePath}
        onOpenInEditor={onOpenInEditor}
        state={{ kind: "loading" }}
      />
    );
  }

  if (filePreview.kind === "text") {
    if (filePreview.content.length === 0) {
      return (
        <FilePreviewSurface
          path={activePath}
          onOpenInEditor={onOpenInEditor}
          state={{ kind: "empty" }}
        />
      );
    }
    return (
      <FilePreviewSurface
        path={activePath}
        onOpenInEditor={onOpenInEditor}
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
        onOpenInEditor={onOpenInEditor}
        state={{ kind: "image", url: filePreview.url }}
      />
    );
  }

  return (
    <FilePreviewSurface
      path={activePath}
      onOpenInEditor={onOpenInEditor}
      state={{
        kind: "error",
        message: `Preview not available for ${filePreview.mimeType}.`,
      }}
    />
  );
}

export function ThreadStorageFilePreview({
  activePath,
  error,
  filePreview,
  isLoading,
  lineNumber,
  onOpenInEditor,
}: ThreadStorageFilePreviewProps) {
  return (
    <SecondaryPanelFilePreview
      activePath={activePath}
      error={error}
      filePreview={filePreview}
      isLoading={isLoading}
      lineNumber={lineNumber}
      onOpenInEditor={onOpenInEditor}
      pendingNotFoundPath={PINNED_STORAGE_FILE_PATH}
    />
  );
}
