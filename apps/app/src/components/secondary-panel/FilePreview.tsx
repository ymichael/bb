import {
  type CSSProperties,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { File as PierreFile } from "@pierre/diffs/react";
import type { SelectedLineRange, SupportedLanguages } from "@pierre/diffs";
import { Button } from "@/components/ui/button.js";
import { CopyButton } from "@/components/ui/copy-button.js";
import { Icon } from "@/components/ui/icon.js";
import { MarkdownPreview } from "@/components/ui/markdown-preview.js";
import { Skeleton } from "@/components/ui/skeleton.js";
import { TruncateStart } from "@/components/ui/truncate-start.js";
import { usePreferredTheme } from "@/hooks/useTheme";
import type { WorkspaceFilePreviewStatusLabel } from "@/lib/file-preview";

export interface FilePreviewFile {
  name: string;
  contents: string;
  lang?: SupportedLanguages;
}

export type FilePreviewState =
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "not-found" }
  | { kind: "manager-status-pending" }
  | { kind: "error"; message?: string }
  | { kind: "image"; url: string }
  | { kind: "html"; file: FilePreviewFile }
  | { kind: "iframe"; title: string; url: string }
  | { kind: "ready"; file: FilePreviewFile; lineNumber: number | null };

export interface FilePreviewProps {
  state: FilePreviewState;
  path: string;
  copyPath?: string | null;
  onOpenInEditor?: (path: string) => void;
  statusLabel?: WorkspaceFilePreviewStatusLabel | null;
}

interface FilePreviewBodyProps {
  state: FilePreviewState;
  path: string;
  markdownMode: MarkdownViewMode;
}

interface FilePreviewHeaderProps {
  path: string;
  copyPath: string | null;
  onOpenInEditor?: (path: string) => void;
  statusLabel: WorkspaceFilePreviewStatusLabel | null;
  markdownMode: MarkdownViewMode | null;
  onMarkdownModeChange: (mode: MarkdownViewMode) => void;
}

interface HtmlFilePreviewProps {
  file: FilePreviewFile;
}

interface IframeFilePreviewProps {
  title: string;
  url: string;
}

type MarkdownViewMode = "preview" | "source";

const MARKDOWN_EXTENSIONS: ReadonlySet<string> = new Set([
  "md",
  "mdx",
  "markdown",
]);

const FILE_PREVIEW_VIEW_STYLE = {
  "--diffs-font-size": "12px",
  "--diffs-line-height": "18px",
  // Pierre paints its theme bg inside this gap, so the top breathing room of
  // the code body lives on Pierre's bg — not on the panel's bg-background.
  // Without this, the gap above Pierre would show a visible bg-color seam.
  "--diffs-gap-block": "16px",
} as CSSProperties;

// `--md-content-w` tells MarkdownPreview the surrounding text-column width so
// narrow tables sit flush with the prose on the left instead of centering in
// the panel. `100cqi` resolves against the `@container/page` scope on the
// wrapper below — i.e. the panel width.
const FILE_PREVIEW_WRAPPER_STYLE = {
  "--md-content-w": "100cqi",
} as CSSProperties;

const HTML_FILE_PREVIEW_IFRAME_STYLE = {
  width: "100%",
  height: "100%",
  border: 0,
} as CSSProperties;

function isMarkdownFile(name: string): boolean {
  const extension = name.split(".").pop()?.toLowerCase();
  return extension !== undefined && MARKDOWN_EXTENSIONS.has(extension);
}

export function FilePreview({
  state,
  path,
  copyPath = null,
  onOpenInEditor,
  statusLabel = null,
}: FilePreviewProps) {
  const isReadyMarkdown =
    state.kind === "ready" && isMarkdownFile(state.file.name);
  const [markdownMode, setMarkdownMode] = useState<MarkdownViewMode>("preview");
  // Each new file opens in rendered preview by default; the user re-toggles per
  // file rather than carrying their last choice across unrelated files.
  useEffect(() => {
    setMarkdownMode("preview");
  }, [path]);

  // Establish a `@container/page` scope so MarkdownPreview's `100cqw`-based
  // table breakout sizes against this panel, not the viewport.
  return (
    <div
      className={
        state.kind === "html" || state.kind === "iframe"
          ? "@container/page flex h-full min-h-0 flex-col"
          : "@container/page"
      }
      style={FILE_PREVIEW_WRAPPER_STYLE}
    >
      <FilePreviewHeader
        path={path}
        copyPath={copyPath}
        onOpenInEditor={onOpenInEditor}
        statusLabel={statusLabel}
        markdownMode={isReadyMarkdown ? markdownMode : null}
        onMarkdownModeChange={setMarkdownMode}
      />
      <FilePreviewBody
        state={state}
        path={path}
        markdownMode={isReadyMarkdown ? markdownMode : "preview"}
      />
    </div>
  );
}

function FilePreviewBody({ state, path, markdownMode }: FilePreviewBodyProps) {
  if (state.kind === "loading") {
    return <FilePreviewLoading />;
  }
  if (state.kind === "empty") {
    return <FilePreviewMessage message="Empty file." />;
  }
  if (state.kind === "not-found") {
    return <FilePreviewMessage message="File not found." role="alert" />;
  }
  if (state.kind === "manager-status-pending") {
    return (
      <FilePreviewMessage message="Manager hasn't written a status yet." />
    );
  }
  if (state.kind === "error") {
    return (
      <FilePreviewMessage
        message={state.message ?? "Failed to load file"}
        role={state.message === undefined ? "alert" : undefined}
      />
    );
  }
  if (state.kind === "image") {
    return <FilePreviewImage url={state.url} alt={path} />;
  }
  if (state.kind === "html") {
    return <HtmlFilePreview file={state.file} />;
  }
  if (state.kind === "iframe") {
    return <IframeFilePreview title={state.title} url={state.url} />;
  }
  if (isMarkdownFile(state.file.name) && markdownMode === "preview") {
    return <MarkdownFilePreview file={state.file} />;
  }
  return (
    <FilePreviewCode file={state.file} lineNumber={state.lineNumber ?? null} />
  );
}

function FilePreviewHeader({
  path,
  copyPath,
  onOpenInEditor,
  statusLabel,
  markdownMode,
  onMarkdownModeChange,
}: FilePreviewHeaderProps) {
  // The fade is `absolute top-full` so the bar's bottom border is the actual
  // overflow edge — content scrolls under right at the border. The fade lives
  // in the sticky element so it pins with the header, but `absolute` keeps it
  // out of flow so the body's `pt-4` controls the initial gap, not this strip.
  return (
    <div className="sticky top-0 z-10">
      <div className="flex h-9 items-center gap-2 border-b border-border bg-background px-4">
        <div className="flex min-w-0 items-center gap-1">
          <TruncateStart
            className="min-w-0 font-mono text-xs font-medium leading-5 text-foreground"
            title={path}
          >
            {path}
          </TruncateStart>
          {statusLabel === null ? null : (
            <span className="shrink-0 text-xs leading-5 text-muted-foreground">
              ({statusLabel})
            </span>
          )}
          {copyPath === null ? null : (
            <CopyButton
              text={copyPath}
              label="Copy file path"
              className="shrink-0 rounded-md hover:bg-state-hover hover:text-foreground"
            />
          )}
          {onOpenInEditor ? (
            <button
              type="button"
              onClick={() => onOpenInEditor(path)}
              aria-label="Open in editor"
              title="Open in editor"
              className="inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <Icon name="ExternalLink" aria-hidden className="size-3" />
            </button>
          ) : null}
        </div>
        {markdownMode !== null ? (
          <div
            className="ml-auto inline-flex shrink-0 items-center gap-0.5 rounded-md border border-border p-0.5"
            role="tablist"
            aria-label="Markdown view mode"
          >
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-5 rounded-sm px-2 text-xs text-muted-foreground"
              onClick={() => onMarkdownModeChange("preview")}
              aria-pressed={markdownMode === "preview"}
              title="Rendered preview"
            >
              Preview
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-5 rounded-sm px-2 text-xs text-muted-foreground"
              onClick={() => onMarkdownModeChange("source")}
              aria-pressed={markdownMode === "source"}
              title="Markdown source"
            >
              Raw
            </Button>
          </div>
        ) : null}
      </div>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-full h-4 bg-gradient-to-b from-background to-transparent"
      />
    </div>
  );
}

function MarkdownFilePreview({ file }: { file: FilePreviewFile }) {
  return (
    <div className="px-4 pt-4">
      <MarkdownPreview allowHtml content={file.contents} />
    </div>
  );
}

function FilePreviewImage({ url, alt }: { url: string; alt: string }) {
  return (
    <div className="pt-4">
      <img
        src={url}
        alt={alt}
        className="block max-h-[34rem] w-full object-contain"
      />
    </div>
  );
}

function HtmlFilePreview({ file }: HtmlFilePreviewProps) {
  return (
    <div className="min-h-0 flex-1">
      <iframe
        title={file.name}
        srcDoc={file.contents}
        style={HTML_FILE_PREVIEW_IFRAME_STYLE}
      />
    </div>
  );
}

function IframeFilePreview({ title, url }: IframeFilePreviewProps) {
  return (
    <div className="min-h-0 flex-1">
      <iframe title={title} src={url} style={HTML_FILE_PREVIEW_IFRAME_STYLE} />
    </div>
  );
}

function clearPreviewTargetLine(container: HTMLElement) {
  const targetLines = container.querySelectorAll(
    "[data-file-preview-target-line]",
  );
  for (const targetLine of targetLines) {
    targetLine.removeAttribute("data-file-preview-target-line");
    targetLine.removeAttribute("data-selected-line");
  }
}

function findPreviewTargetLine(
  container: HTMLElement,
  lineNumber: number,
): HTMLElement | null {
  const lines = container.querySelectorAll(`[data-line="${lineNumber}"]`);
  for (const line of lines) {
    if (line instanceof HTMLElement && line.dataset.lineIndex !== undefined) {
      return line;
    }
  }
  for (const line of lines) {
    if (line instanceof HTMLElement) {
      return line;
    }
  }
  return null;
}

function FilePreviewLoading() {
  return (
    <div className="space-y-2 px-4 pt-4" aria-busy>
      <Skeleton className="h-3 w-3/4 rounded-sm" />
      <Skeleton className="h-3 w-full rounded-sm" />
      <Skeleton className="h-3 w-5/6 rounded-sm" />
      <Skeleton className="h-3 w-2/3 rounded-sm" />
      <Skeleton className="h-3 w-full rounded-sm" />
      <Skeleton className="h-3 w-3/5 rounded-sm" />
    </div>
  );
}

function FilePreviewMessage({
  message,
  role,
}: {
  message: string;
  role?: "alert";
}) {
  return (
    <p
      role={role}
      className="mx-4 mt-4 rounded-lg border border-dashed border-border bg-surface-raised px-3 py-6 text-center text-sm text-muted-foreground"
    >
      {message}
    </p>
  );
}

function FilePreviewCode({
  file,
  lineNumber,
}: {
  file: FilePreviewFile;
  lineNumber: number | null;
}) {
  const preferredTheme = usePreferredTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const options = useMemo(
    () => ({
      themeType: preferredTheme,
      overflow: "scroll" as const,
      disableFileHeader: true,
      enableLineSelection: lineNumber !== null,
    }),
    [lineNumber, preferredTheme],
  );
  const selectedLines = useMemo<SelectedLineRange | null>(
    () =>
      lineNumber === null
        ? null
        : {
            start: lineNumber,
            end: lineNumber,
          },
    [lineNumber],
  );

  useEffect(() => {
    const cleanupContainer = containerRef.current;
    let animationFrame: number | null = null;
    let retryTimer: number | null = null;
    let attempts = 0;

    function scheduleRetry() {
      animationFrame = window.requestAnimationFrame(scrollToLine);
      retryTimer = window.setTimeout(scrollToLine, 16);
    }

    function scrollToLine() {
      const container = containerRef.current;
      if (!container) return;
      clearPreviewTargetLine(container);
      clearPreviewTargetLine(container.ownerDocument.body);
      if (lineNumber === null) return;

      const line =
        findPreviewTargetLine(container, lineNumber) ??
        findPreviewTargetLine(container.ownerDocument.body, lineNumber);
      if (line) {
        line.setAttribute("data-file-preview-target-line", "");
        line.setAttribute("data-selected-line", "single");
        line.scrollIntoView?.({ block: "center" });
        return;
      }

      attempts += 1;
      if (attempts < 8) {
        scheduleRetry();
      }
    }

    scrollToLine();
    return () => {
      if (cleanupContainer) {
        clearPreviewTargetLine(cleanupContainer);
        clearPreviewTargetLine(cleanupContainer.ownerDocument.body);
      }
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
      }
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }
    };
  }, [file.contents, file.name, lineNumber]);

  return (
    <div
      ref={containerRef}
      style={FILE_PREVIEW_VIEW_STYLE}
      data-file-preview-line-number={lineNumber ?? undefined}
    >
      <PierreFile file={file} options={options} selectedLines={selectedLines} />
    </div>
  );
}
