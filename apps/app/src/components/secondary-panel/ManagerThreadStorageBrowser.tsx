import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import type { WorkspaceFile } from "@bb/server-contract";
import { assertNever } from "@bb/core-ui";
import {
  AlertTriangle,
  FileQuestion,
  FileText,
  Image as ImageIcon,
  Search,
} from "lucide-react";
import {
  CopyButton,
  EmptyState,
  Input,
  MarkdownPreview,
} from "@/components/ui";
import { usePreferredTheme } from "@/hooks/useTheme";
import { cn } from "@/lib/utils";
import {
  isMarkdownFilePreview,
  type FilePreview,
  type TextFilePreview,
} from "@/lib/file-preview";

export const MARKDOWN_PREVIEW_RENDER_MAX_CHARS = 200_000;
const SOURCE_PREVIEW_MAX_CHARS = 200_000;
const STORAGE_PREVIEW_MAX_HEIGHT_CLASS = "max-h-[34rem]";

interface FileTreeHostStyle extends CSSProperties {
  "--trees-accent-override": string;
  "--trees-bg-muted-override": string;
  "--trees-bg-override": string;
  "--trees-border-color-override": string;
  "--trees-fg-muted-override": string;
  "--trees-fg-override": string;
  "--trees-focus-ring-color-override": string;
  "--trees-font-family-override": string;
  "--trees-font-size-override": string;
  "--trees-item-margin-x-override": string;
  "--trees-padding-inline-override": string;
  "--trees-scrollbar-thumb-override": string;
  "--trees-selected-bg-override": string;
  "--trees-selected-fg-override": string;
  "--trees-selected-focused-border-color-override": string;
}

const FILE_TREE_BASE_HOST_STYLE: FileTreeHostStyle = {
  "--trees-accent-override": "var(--ring)",
  "--trees-bg-muted-override":
    "color-mix(in srgb, var(--muted) 45%, transparent)",
  "--trees-bg-override": "transparent",
  "--trees-border-color-override": "var(--border)",
  "--trees-fg-muted-override": "var(--muted-foreground)",
  "--trees-fg-override": "var(--foreground)",
  "--trees-focus-ring-color-override": "var(--ring)",
  "--trees-font-family-override": "var(--font-sans)",
  "--trees-font-size-override": "var(--text-sm)",
  "--trees-item-margin-x-override": "0.25rem",
  "--trees-padding-inline-override": "0.5rem",
  "--trees-scrollbar-thumb-override":
    "color-mix(in srgb, var(--muted-foreground) 35%, transparent)",
  "--trees-selected-bg-override":
    "color-mix(in srgb, var(--accent) 65%, transparent)",
  "--trees-selected-fg-override": "var(--foreground)",
  "--trees-selected-focused-border-color-override": "var(--ring)",
  height: "100%",
};
const EMPTY_STORAGE_FILES: readonly WorkspaceFile[] = [];

interface ManagerThreadStorageBrowserProps {
  fileError?: Error | null;
  filePreview?: FilePreview;
  files?: readonly WorkspaceFile[];
  filesError?: Error | null;
  isFileLoading: boolean;
  isFilesLoading: boolean;
  onSelectPath: ManagerThreadStoragePathSelectHandler;
  selectedPath: string | null;
  truncated: boolean;
}

interface FilePreviewPaneProps {
  fileError?: Error | null;
  filePreview?: FilePreview;
  isFileLoading: boolean;
  selectedPath: string | null;
}

interface SourcePreviewProps {
  content: string;
  label: string;
}

interface MarkdownTextPreviewProps {
  preview: TextFilePreview;
}

interface UnsupportedPreviewProps {
  mimeType: string;
}

interface StorageBrowserPaneProps {
  bodyClassName?: string;
  children: ReactNode;
  header: ReactNode;
}

type ManagerThreadStoragePathSelectHandler = (path: string) => void;

function buildDirectoryPaths(paths: readonly string[]): string[] {
  const directoryPaths = new Set<string>();

  for (const path of paths) {
    const segments = path.split("/").filter((segment) => segment.length > 0);
    let currentPath = "";

    for (const segment of segments.slice(0, -1)) {
      currentPath = `${currentPath}${segment}/`;
      directoryPaths.add(currentPath);
    }
  }

  return Array.from(directoryPaths);
}

function filterFilesByQuery(
  files: readonly WorkspaceFile[],
  query: string,
): readonly WorkspaceFile[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) {
    return files;
  }

  return files.filter((file) =>
    file.path.toLowerCase().includes(normalizedQuery),
  );
}

function truncatePreviewContent(content: string): string {
  if (content.length <= SOURCE_PREVIEW_MAX_CHARS) {
    return content;
  }

  return content.slice(0, SOURCE_PREVIEW_MAX_CHARS);
}

function formatFileCount(count: number): string {
  return count === 1 ? "1 file" : `${count.toLocaleString()} files`;
}

function SourcePreview({ content, label }: SourcePreviewProps) {
  const displayedContent = truncatePreviewContent(content);
  const isTruncated = displayedContent.length < content.length;

  return (
    <div className="space-y-2">
      {isTruncated ? (
        <p className="text-xs text-muted-foreground">
          Showing the first {SOURCE_PREVIEW_MAX_CHARS.toLocaleString()}{" "}
          characters as source.
        </p>
      ) : null}
      <pre
        aria-label={label}
        className={cn(
          STORAGE_PREVIEW_MAX_HEIGHT_CLASS,
          "overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/70 bg-muted/25 p-3 font-mono text-xs leading-relaxed text-foreground",
        )}
      >
        {displayedContent}
      </pre>
    </div>
  );
}

function MarkdownTextPreview({ preview }: MarkdownTextPreviewProps) {
  if (preview.content.length === 0) {
    return <EmptyState message="Empty file." />;
  }

  if (preview.content.length > MARKDOWN_PREVIEW_RENDER_MAX_CHARS) {
    return (
      <div className="space-y-3">
        <p className="rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          Markdown rendering is disabled for files larger than{" "}
          {MARKDOWN_PREVIEW_RENDER_MAX_CHARS.toLocaleString()} characters.
        </p>
        <SourcePreview content={preview.content} label="Markdown source" />
      </div>
    );
  }

  return (
    <MarkdownPreview
      className="mx-auto w-full max-w-[760px]"
      content={preview.content}
    />
  );
}

function UnsupportedPreview({ mimeType }: UnsupportedPreviewProps) {
  return (
    <div className="flex min-h-40 flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border/70 bg-background/45 px-4 py-8 text-center">
      <FileQuestion className="size-5 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">
        Preview not available for {mimeType}.
      </p>
    </div>
  );
}

function FilePreviewPane({
  fileError,
  filePreview,
  isFileLoading,
  selectedPath,
}: FilePreviewPaneProps) {
  const selectedFilePreview =
    filePreview?.path === selectedPath ? filePreview : undefined;

  if (!selectedPath) {
    return <EmptyState message="Select a file to preview." />;
  }

  if (fileError) {
    return (
      <div className="flex min-h-40 flex-col items-center justify-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-8 text-center">
        <AlertTriangle className="size-5 text-destructive" />
        <p className="text-sm text-destructive">{fileError.message}</p>
      </div>
    );
  }

  if (isFileLoading || !selectedFilePreview) {
    return (
      <p className="rounded-md border border-dashed border-border/70 bg-background/45 px-3 py-6 text-center text-sm text-muted-foreground">
        Loading file...
      </p>
    );
  }

  if (selectedFilePreview.kind === "text") {
    if (isMarkdownFilePreview(selectedFilePreview)) {
      return <MarkdownTextPreview preview={selectedFilePreview} />;
    }

    if (selectedFilePreview.content.length === 0) {
      return <EmptyState message="Empty file." />;
    }

    return (
      <SourcePreview content={selectedFilePreview.content} label="Source" />
    );
  }

  if (selectedFilePreview.kind === "image") {
    return (
      <div className="flex min-h-40 items-center justify-center rounded-md border border-border/70 bg-background/45 p-3">
        <img
          src={selectedFilePreview.url}
          alt={selectedFilePreview.path}
          className={cn(
            STORAGE_PREVIEW_MAX_HEIGHT_CLASS,
            "w-auto max-w-full rounded-md border border-border/70 bg-background object-contain",
          )}
        />
      </div>
    );
  }

  if (selectedFilePreview.kind === "unsupported") {
    return <UnsupportedPreview mimeType={selectedFilePreview.mimeType} />;
  }

  return assertNever(selectedFilePreview, "Unhandled file preview kind");
}

function StorageBrowserPane({
  bodyClassName,
  children,
  header,
}: StorageBrowserPaneProps) {
  return (
    <section className="flex min-h-72 min-w-0 flex-col overflow-hidden rounded-md border border-border/70 bg-background/45">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/70 px-3">
        {header}
      </div>
      <div className={cn("min-h-0 flex-1", bodyClassName)}>{children}</div>
    </section>
  );
}

export function ManagerThreadStorageBrowser({
  fileError,
  filePreview,
  files,
  filesError,
  isFileLoading,
  isFilesLoading,
  onSelectPath,
  selectedPath,
  truncated,
}: ManagerThreadStorageBrowserProps) {
  const preferredTheme = usePreferredTheme();
  const [searchQuery, setSearchQuery] = useState("");
  const loadedFiles = files ?? EMPTY_STORAGE_FILES;
  const filteredFiles = useMemo(
    () => filterFilesByQuery(loadedFiles, searchQuery),
    [loadedFiles, searchQuery],
  );
  const filteredFilePaths = useMemo(
    () => filteredFiles.map((file) => file.path),
    [filteredFiles],
  );
  const expandedDirectoryPaths = useMemo(
    () => buildDirectoryPaths(filteredFilePaths),
    [filteredFilePaths],
  );
  const fileTreeHostStyle = useMemo<FileTreeHostStyle>(
    () => ({
      ...FILE_TREE_BASE_HOST_STYLE,
      // Keeps native shadow-root chrome such as scrollbars aligned with the app theme.
      colorScheme: preferredTheme,
    }),
    [preferredTheme],
  );
  const filePathSet = useMemo(
    () => new Set(filteredFilePaths),
    [filteredFilePaths],
  );
  const filePathSetRef = useRef<ReadonlySet<string>>(filePathSet);
  const onSelectPathRef = useRef(onSelectPath);

  useEffect(() => {
    filePathSetRef.current = filePathSet;
  }, [filePathSet]);

  useEffect(() => {
    onSelectPathRef.current = onSelectPath;
  }, [onSelectPath]);

  const handleTreeSelectionChange = useCallback(
    (selectedPaths: readonly string[]) => {
      const nextPath = selectedPaths[0];
      if (!nextPath || !filePathSetRef.current.has(nextPath)) {
        return;
      }

      onSelectPathRef.current(nextPath);
    },
    [],
  );

  const { model } = useFileTree({
    density: "compact",
    initialExpansion: "open",
    onSelectionChange: handleTreeSelectionChange,
    paths: [],
    search: false,
  });

  useEffect(() => {
    model.resetPaths(filteredFilePaths, {
      initialExpandedPaths: expandedDirectoryPaths,
    });
  }, [expandedDirectoryPaths, filteredFilePaths, model]);

  useEffect(() => {
    const selectedPaths = model.getSelectedPaths();
    const selectedPathIsVisible =
      selectedPath !== null && filePathSet.has(selectedPath);

    if (selectedPathIsVisible) {
      if (selectedPaths.length !== 1 || selectedPaths[0] !== selectedPath) {
        model.getItem(selectedPath)?.select();
      }
      return;
    }

    for (const path of selectedPaths) {
      model.getItem(path)?.deselect();
    }
  }, [filePathSet, model, selectedPath]);

  if (filesError) {
    return (
      <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-6 text-center text-sm text-destructive">
        {filesError.message}
      </p>
    );
  }

  if (isFilesLoading && !files) {
    return (
      <p className="rounded-lg border border-dashed border-border/70 bg-background/45 px-3 py-6 text-center text-sm text-muted-foreground">
        Loading files...
      </p>
    );
  }

  if (loadedFiles.length === 0) {
    return <EmptyState message="No files yet." />;
  }

  const fileCountLabel =
    filteredFiles.length === loadedFiles.length
      ? formatFileCount(loadedFiles.length)
      : `${filteredFiles.length.toLocaleString()} of ${formatFileCount(
          loadedFiles.length,
        )}`;

  return (
    <div className="flex min-h-0 min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="Search storage files"
              className="h-8 pl-8 text-sm"
              placeholder="Search files"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
            />
          </div>
          <span className="shrink-0 text-xs text-muted-foreground">
            {fileCountLabel}
          </span>
        </div>
        {truncated ? (
          <p className="rounded-md border border-amber-300/40 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-400/30 dark:bg-amber-950/20 dark:text-amber-200">
            File list truncated at {formatFileCount(loadedFiles.length)}. Search
            covers loaded files only.
          </p>
        ) : null}
      </div>

      <div className="grid min-h-0 min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,18rem),1fr))] gap-3">
        <StorageBrowserPane
          bodyClassName="overflow-hidden"
          header={
            <>
              <FileText className="size-3.5 text-muted-foreground" />
              <h3 className="truncate text-xs font-medium text-foreground">
                Storage files
              </h3>
            </>
          }
        >
          {filteredFilePaths.length > 0 ? (
            <FileTree
              aria-label="Thread storage file tree"
              className="block h-full min-h-0"
              model={model}
              style={fileTreeHostStyle}
            />
          ) : (
            <div className="flex h-full min-h-40 items-center justify-center px-4">
              <EmptyState message="No files match search." />
            </div>
          )}
        </StorageBrowserPane>

        <StorageBrowserPane
          bodyClassName="@container/page overflow-auto p-3"
          header={
            <>
              {filePreview?.kind === "image" &&
              filePreview.path === selectedPath ? (
                <ImageIcon className="size-3.5 text-muted-foreground" />
              ) : (
                <FileText className="size-3.5 text-muted-foreground" />
              )}
              <h3
                className={cn(
                  "min-w-0 flex-1 truncate text-xs font-medium",
                  selectedPath ? "text-foreground" : "text-muted-foreground",
                )}
                title={selectedPath ?? undefined}
              >
                {selectedPath ?? "Preview"}
              </h3>
              {selectedPath ? (
                <CopyButton
                  text={selectedPath}
                  label="Copy relative path"
                  className="shrink-0"
                />
              ) : null}
            </>
          }
        >
          <FilePreviewPane
            fileError={fileError}
            filePreview={filePreview}
            isFileLoading={isFileLoading}
            selectedPath={selectedPath}
          />
        </StorageBrowserPane>
      </div>
    </div>
  );
}
