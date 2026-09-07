import {
  FilePreview as FilePreviewSurface,
  type FilePreviewFile,
  type TextFilePreviewKind,
} from "./FilePreview";
import { hashSourceContents } from "@/components/code/source-code-budget";
import type { MarkdownLinkRouting } from "@/components/ui/markdown-link-routing.js";
import { HttpError } from "@/lib/api";
import { buildThreadStorageRawContentUrl } from "@/lib/file-content-urls";
import type {
  FilePreview,
  FilePreviewLineRange,
  TextFilePreview,
  WorkspaceFilePreviewStatusLabel,
} from "@bb/client-core";
import {
  isCsvFilePreview,
  isHtmlFilePreviewPath,
  isMarkdownFilePreview,
} from "@bb/client-core";

const GENERIC_HTML_IFRAME_SANDBOX = "allow-scripts";

interface FilePreviewBaseProps {
  activePath: string;
  copyPath?: string | null;
  error?: Error | null;
  filePreview: FilePreview | undefined;
  isLoading: boolean;
  isRefreshing?: boolean;
  lineRange?: FilePreviewLineRange | null;
  markdownLinkRouting?: MarkdownLinkRouting;
  onSelectionAddToChat?: (text: string) => void;
  onOpenInEditor?: (path: string) => void;
  onRefresh?: () => void;
}

interface ThreadStorageFilePreviewProps extends FilePreviewBaseProps {
  threadId: string;
}

interface SecondaryPanelFilePreviewProps extends FilePreviewBaseProps {
  htmlPreviewUrl?: string | null;
  statusLabel?: WorkspaceFilePreviewStatusLabel | null;
}

interface BuildTextPreviewFileArgs {
  activePath: string;
  filePreview: TextFilePreview;
}

function buildTextPreviewCacheKey({
  activePath,
  filePreview,
}: BuildTextPreviewFileArgs): string {
  return [
    "file-preview",
    filePreview.url,
    filePreview.path,
    filePreview.name ?? activePath,
    filePreview.mimeType,
    hashSourceContents(filePreview.content),
  ].join(":");
}

function buildTextPreviewFile({
  activePath,
  filePreview,
}: BuildTextPreviewFileArgs): FilePreviewFile {
  return {
    cacheKey: buildTextPreviewCacheKey({ activePath, filePreview }),
    name: filePreview.name ?? activePath,
    contents: filePreview.content,
  };
}

function getTextPreviewKind(
  filePreview: TextFilePreview,
): TextFilePreviewKind | null {
  if (isCsvFilePreview(filePreview)) {
    return "csv";
  }
  if (isMarkdownFilePreview(filePreview)) {
    return "markdown";
  }
  return null;
}

export function SecondaryPanelFilePreview({
  activePath,
  copyPath = null,
  error,
  filePreview,
  htmlPreviewUrl = null,
  isLoading,
  isRefreshing = false,
  lineRange = null,
  markdownLinkRouting,
  onSelectionAddToChat,
  onOpenInEditor,
  onRefresh,
  statusLabel = null,
}: SecondaryPanelFilePreviewProps) {
  if (error) {
    const isNotFound = error instanceof HttpError && error.status === 404;
    return (
      <FilePreviewSurface
        path={activePath}
        copyPath={copyPath}
        onSelectionAddToChat={onSelectionAddToChat}
        onOpenInEditor={onOpenInEditor}
        onRefresh={onRefresh}
        isRefreshing={isRefreshing}
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
        onSelectionAddToChat={onSelectionAddToChat}
        onOpenInEditor={onOpenInEditor}
        onRefresh={onRefresh}
        isRefreshing={isRefreshing}
        statusLabel={statusLabel}
        state={{ kind: "loading" }}
      />
    );
  }

  if (htmlPreviewUrl !== null && isHtmlFilePreviewPath(activePath)) {
    if (filePreview.kind !== "text") {
      return (
        <FilePreviewSurface
          path={activePath}
          copyPath={copyPath}
          onSelectionAddToChat={onSelectionAddToChat}
          onOpenInEditor={onOpenInEditor}
          onRefresh={onRefresh}
          isRefreshing={isRefreshing}
          statusLabel={statusLabel}
          state={{
            kind: "iframe",
            sandbox: GENERIC_HTML_IFRAME_SANDBOX,
            title: activePath,
            url: htmlPreviewUrl,
          }}
        />
      );
    }

    return (
      <FilePreviewSurface
        path={activePath}
        copyPath={copyPath}
        onSelectionAddToChat={onSelectionAddToChat}
        onOpenInEditor={onOpenInEditor}
        onRefresh={onRefresh}
        isRefreshing={isRefreshing}
        statusLabel={statusLabel}
        state={{
          kind: "html",
          file: buildTextPreviewFile({ activePath, filePreview }),
          iframe: {
            sandbox: GENERIC_HTML_IFRAME_SANDBOX,
            title: activePath,
            url: htmlPreviewUrl,
          },
          lineRange,
        }}
      />
    );
  }

  if (filePreview.kind === "text") {
    if (filePreview.content.length === 0) {
      return (
        <FilePreviewSurface
          path={activePath}
          copyPath={copyPath}
          onSelectionAddToChat={onSelectionAddToChat}
          onOpenInEditor={onOpenInEditor}
          onRefresh={onRefresh}
          isRefreshing={isRefreshing}
          statusLabel={statusLabel}
          state={{ kind: "empty" }}
        />
      );
    }
    return (
      <FilePreviewSurface
        path={activePath}
        copyPath={copyPath}
        onSelectionAddToChat={onSelectionAddToChat}
        onOpenInEditor={onOpenInEditor}
        onRefresh={onRefresh}
        isRefreshing={isRefreshing}
        markdownLinkRouting={markdownLinkRouting}
        statusLabel={statusLabel}
        state={{
          kind: "ready",
          lineRange,
          textPreviewKind: getTextPreviewKind(filePreview),
          file: buildTextPreviewFile({ activePath, filePreview }),
        }}
      />
    );
  }

  if (filePreview.kind === "image") {
    return (
      <FilePreviewSurface
        path={activePath}
        copyPath={copyPath}
        onSelectionAddToChat={onSelectionAddToChat}
        onOpenInEditor={onOpenInEditor}
        onRefresh={onRefresh}
        isRefreshing={isRefreshing}
        statusLabel={statusLabel}
        state={{ kind: "image", url: filePreview.url }}
      />
    );
  }

  if (filePreview.kind === "video") {
    return (
      <FilePreviewSurface
        path={activePath}
        copyPath={copyPath}
        onSelectionAddToChat={onSelectionAddToChat}
        onOpenInEditor={onOpenInEditor}
        onRefresh={onRefresh}
        isRefreshing={isRefreshing}
        statusLabel={statusLabel}
        state={{ kind: "video", url: filePreview.url }}
      />
    );
  }

  return (
    <FilePreviewSurface
      path={activePath}
      copyPath={copyPath}
      onSelectionAddToChat={onSelectionAddToChat}
      onOpenInEditor={onOpenInEditor}
      onRefresh={onRefresh}
      isRefreshing={isRefreshing}
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
  isRefreshing,
  lineRange,
  markdownLinkRouting,
  onSelectionAddToChat,
  onOpenInEditor,
  onRefresh,
  threadId,
}: ThreadStorageFilePreviewProps) {
  return (
    <SecondaryPanelFilePreview
      activePath={activePath}
      copyPath={copyPath}
      error={error}
      filePreview={filePreview}
      htmlPreviewUrl={buildThreadStorageRawContentUrl(threadId, activePath)}
      isLoading={isLoading}
      isRefreshing={isRefreshing}
      lineRange={lineRange}
      markdownLinkRouting={markdownLinkRouting}
      onSelectionAddToChat={onSelectionAddToChat}
      onOpenInEditor={onOpenInEditor}
      onRefresh={onRefresh}
    />
  );
}
