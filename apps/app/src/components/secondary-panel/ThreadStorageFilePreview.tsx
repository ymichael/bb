import type { ReactNode } from "react";
import { FilePreview as FilePreviewSurface } from "./FilePreview";
import { PINNED_STORAGE_FILE_PATH } from "./managerStorage";
import { HttpError } from "@/lib/api";
import type {
  FilePreview,
  WorkspaceFilePreviewStatusLabel,
} from "@/lib/file-preview";

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
  statusLabel?: WorkspaceFilePreviewStatusLabel | null;
}

interface FilePreviewStatusLabelProps {
  label: WorkspaceFilePreviewStatusLabel;
}

export function SecondaryPanelFilePreview({
  activePath,
  error,
  filePreview,
  isLoading,
  lineNumber = null,
  onOpenInEditor,
  pendingNotFoundPath,
  statusLabel = null,
}: SecondaryPanelFilePreviewProps) {
  const statusMarkup =
    statusLabel === null ? null : (
      <FilePreviewStatusLabel label={statusLabel} />
    );
  const renderWithStatus = (content: ReactNode) => (
    <>
      {statusMarkup}
      {content}
    </>
  );

  if (error) {
    const isNotFound = error instanceof HttpError && error.status === 404;
    if (isNotFound && activePath === pendingNotFoundPath) {
      return renderWithStatus(
        <FilePreviewSurface
          path={activePath}
          onOpenInEditor={onOpenInEditor}
          state={{ kind: "manager-status-pending" }}
        />,
      );
    }
    return renderWithStatus(
      <FilePreviewSurface
        path={activePath}
        onOpenInEditor={onOpenInEditor}
        state={{ kind: isNotFound ? "not-found" : "error" }}
      />,
    );
  }

  if (isLoading || !filePreview || filePreview.path !== activePath) {
    return renderWithStatus(
      <FilePreviewSurface
        path={activePath}
        onOpenInEditor={onOpenInEditor}
        state={{ kind: "loading" }}
      />,
    );
  }

  if (filePreview.kind === "text") {
    if (filePreview.content.length === 0) {
      return renderWithStatus(
        <FilePreviewSurface
          path={activePath}
          onOpenInEditor={onOpenInEditor}
          state={{ kind: "empty" }}
        />,
      );
    }
    return renderWithStatus(
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
      />,
    );
  }

  if (filePreview.kind === "image") {
    return renderWithStatus(
      <FilePreviewSurface
        path={activePath}
        onOpenInEditor={onOpenInEditor}
        state={{ kind: "image", url: filePreview.url }}
      />,
    );
  }

  return renderWithStatus(
    <FilePreviewSurface
      path={activePath}
      onOpenInEditor={onOpenInEditor}
      state={{
        kind: "error",
        message: `Preview not available for ${filePreview.mimeType}.`,
      }}
    />,
  );
}

function FilePreviewStatusLabel({ label }: FilePreviewStatusLabelProps) {
  return (
    <div className="px-4 pb-2 pt-1 text-xs font-medium text-muted-foreground">
      ({label})
    </div>
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
