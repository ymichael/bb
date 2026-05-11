import { FilePreview as FilePreviewSurface } from "./FilePreview";
import { PINNED_STORAGE_FILE_PATH } from "./managerStorage";
import { HttpError } from "@/lib/api";
import type { FilePreview } from "@/lib/file-preview";

interface ThreadStorageFilePreviewProps {
  activePath: string;
  error?: Error | null;
  filePreview: FilePreview | undefined;
  isLoading: boolean;
}

export function ThreadStorageFilePreview({
  activePath,
  error,
  filePreview,
  isLoading,
}: ThreadStorageFilePreviewProps) {
  if (error) {
    const isNotFound = error instanceof HttpError && error.status === 404;
    if (isNotFound && activePath === PINNED_STORAGE_FILE_PATH) {
      return <FilePreviewSurface state={{ kind: "manager-status-pending" }} />;
    }
    return (
      <FilePreviewSurface state={{ kind: isNotFound ? "not-found" : "error" }} />
    );
  }

  if (isLoading || !filePreview || filePreview.path !== activePath) {
    return <FilePreviewSurface state={{ kind: "loading" }} />;
  }

  if (filePreview.kind === "text") {
    if (filePreview.content.length === 0) {
      return <FilePreviewSurface state={{ kind: "empty" }} />;
    }
    return (
      <FilePreviewSurface
        state={{
          kind: "ready",
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
      <div className="flex items-center justify-center rounded-md border border-border/70 bg-background/45 p-3">
        <img
          src={filePreview.url}
          alt={filePreview.path}
          className="max-h-[34rem] w-auto max-w-full rounded-md border border-border/70 bg-background object-contain"
        />
      </div>
    );
  }

  return (
    <FilePreviewSurface
      state={{
        kind: "error",
        message: `Preview not available for ${filePreview.mimeType}.`,
      }}
    />
  );
}
