import { SourceLoadingSkeleton } from "@/components/code/code-loading-skeletons";
import {
  type CSSProperties,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { UrlTransform } from "react-markdown";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Button } from "@bb/shared-ui/button";
import { SourceCodeHost } from "@/components/code/SourceCodeHost";
import { COARSE_POINTER_TEXT_SM_CLASS } from "@bb/shared-ui/coarse-pointer-sizing";
import { EmptyStatePanel } from "@bb/shared-ui/empty-state";
import { CopyButton } from "@/components/ui/copy-button.js";
import { Icon } from "@bb/shared-ui/icon";
import { OpenInEditorButton } from "@/components/ui/open-in-editor-button.js";
import { useAppCommandShortcut } from "@/components/commands/AppCommandProvider";
import { AppCommandShortcutHint } from "@/components/commands/AppCommandShortcutHint";
import type { MarkdownLinkRouting } from "@/components/ui/markdown-link-routing.js";
import { MarkdownPreview } from "@/components/ui/markdown-preview.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@bb/shared-ui/tooltip";
import { TruncateStart } from "@/components/ui/truncate-start.js";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";
import type {
  FilePreviewLineRange,
  WorkspaceFilePreviewStatusLabel,
} from "@bb/client-core";
import {
  DEFAULT_CODE_OVERFLOW_MODE,
  type CodeOverflowMode,
  type CodeOverflowModeChangeHandler,
} from "@/lib/code-overflow-mode";
import { cn } from "@bb/shared-ui/lib/utils";
import { SecondaryPanelSelectionActions } from "./SecondaryPanelSelectionActions.js";

export interface FilePreviewFile {
  cacheKey?: string;
  name: string;
  contents: string;
}

type IframePreviewSandbox = "allow-scripts";

interface IframeFilePreviewTarget {
  sandbox: IframePreviewSandbox | null;
  title: string;
  url: string;
}

type FilePreviewState =
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "not-found" }
  | { kind: "error"; message?: string }
  | { kind: "image"; url: string }
  | { kind: "video"; url: string }
  | ({ kind: "iframe" } & IframeFilePreviewTarget)
  | {
      kind: "html";
      file: FilePreviewFile;
      iframe: IframeFilePreviewTarget;
      lineRange: FilePreviewLineRange | null;
    }
  | {
      kind: "ready";
      file: FilePreviewFile;
      lineRange: FilePreviewLineRange | null;
      textPreviewKind: TextFilePreviewKind | null;
      markdownUrlTransform?: UrlTransform;
    };

interface FilePreviewProps {
  state: FilePreviewState;
  path: string;
  copyPath?: string | null;
  headerMode?: FilePreviewHeaderMode;
  onSelectionAddToChat?: (text: string) => void;
  onOpenInEditor?: (path: string) => void;
  onRefresh?: () => void;
  isRefreshing?: boolean;
  markdownLinkRouting?: MarkdownLinkRouting;
  statusLabel?: WorkspaceFilePreviewStatusLabel | null;
}

interface FilePreviewBodyProps {
  state: FilePreviewState;
  path: string;
  lineOverflowMode: CodeOverflowMode;
  viewMode: FilePreviewViewMode;
  markdownLinkRouting?: MarkdownLinkRouting;
  onSelectionAddToChat?: (text: string) => void;
}

interface HtmlFilePreviewBodyProps {
  lineOverflowMode: CodeOverflowMode;
  onSelectionAddToChat?: (text: string) => void;
  state: Extract<FilePreviewState, { kind: "html" }>;
  viewMode: FilePreviewViewMode;
}

interface FilePreviewHeaderProps {
  path: string;
  copyPath: string | null;
  rawContents: string | null;
  externalUrl: string | null;
  onOpenInEditor?: (path: string) => void;
  onRefresh?: () => void;
  isRefreshing: boolean;
  statusLabel: WorkspaceFilePreviewStatusLabel | null;
  toggleKind: FilePreviewToggleKind | null;
  showLineOverflowToggle: boolean;
  lineOverflowMode: CodeOverflowMode;
  onLineOverflowModeChange: CodeOverflowModeChangeHandler;
  viewMode: FilePreviewViewMode;
  onViewModeChange: (mode: FilePreviewViewMode) => void;
}

interface FilePreviewLineWrapButtonProps {
  showLineOverflowToggle: boolean;
  lineOverflowMode: CodeOverflowMode;
  onLineOverflowModeChange: CodeOverflowModeChangeHandler;
}

interface FilePreviewPathProps {
  path: string;
  copyPath: string | null;
}

interface MarkdownFilePreviewProps {
  file: FilePreviewFile;
  onSelectionAddToChat?: (text: string) => void;
  urlTransform?: UrlTransform;
  markdownLinkRouting?: MarkdownLinkRouting;
}

interface CsvFilePreviewProps {
  file: FilePreviewFile;
  onSelectionAddToChat?: (text: string) => void;
}

interface FilePreviewImageProps {
  url: string;
  alt: string;
}

interface FilePreviewVideoProps {
  url: string;
  title: string;
}

interface FilePreviewMessageProps {
  message: string;
  role?: "alert";
}

interface FilePreviewCodeProps {
  file: FilePreviewFile;
  lineOverflowMode: CodeOverflowMode;
  lineRange: FilePreviewLineRange | null;
  onSelectionAddToChat?: (text: string) => void;
  path: string;
}

interface GetInitialFilePreviewViewModeArgs {
  lineRange: FilePreviewLineRange | null;
  toggleKind: FilePreviewToggleKind | null;
}

interface CsvPreviewData {
  columnCount: number;
  rows: string[][];
  truncatedColumns: boolean;
  truncatedRows: boolean;
}

type FilePreviewViewMode = "preview" | "source";
export type TextFilePreviewKind = "csv" | "markdown";
type FilePreviewToggleKind = "csv" | "html" | "markdown";
type FilePreviewHeaderMode = "file" | "none";
type IframeLoadState = "loading" | "loaded" | "error";

const CSV_PREVIEW_MAX_COLUMNS = 100;
const CSV_PREVIEW_MAX_ROWS = 500;
const CSV_PREVIEW_ROW_HEIGHT_PX = 29;
const CSV_PREVIEW_OVERSCAN_ROWS = 8;

const FILE_PREVIEW_WRAPPER_STYLE = {
  "--md-content-w": "100cqi",
} as CSSProperties;

const HTML_FILE_PREVIEW_IFRAME_STYLE = {
  width: "100%",
  height: "100%",
  border: 0,
} as CSSProperties;
const IFRAME_LOADING_INDICATOR_DELAY_MS = 160;
const FILE_PREVIEW_HEADER_ICON_BUTTON_CLASS =
  "h-5 w-5 rounded-sm p-0 [&_svg]:size-3 max-md:pointer-coarse:h-9 max-md:pointer-coarse:w-9 max-md:pointer-coarse:[&_svg]:size-5";
const FILE_PREVIEW_VIEW_MODE_BUTTON_CLASS =
  "h-5 rounded-sm px-2 text-muted-foreground max-md:pointer-coarse:h-[30px]";

function getFilePreviewExternalUrl(state: FilePreviewState): string | null {
  if (state.kind === "iframe") {
    return state.url;
  }
  if (state.kind === "html") {
    return state.iframe.url;
  }
  return null;
}

function toAbsolutePreviewUrl(url: string): string {
  if (typeof window === "undefined") {
    return url;
  }
  return new URL(url, window.location.href).toString();
}

function getFilePreviewToggleKind(
  state: FilePreviewState,
): FilePreviewToggleKind | null {
  if (state.kind === "html") {
    return "html";
  }
  if (state.kind === "ready") {
    return state.textPreviewKind;
  }
  return null;
}

function getToggleAriaLabel(kind: FilePreviewToggleKind): string {
  switch (kind) {
    case "csv":
      return "CSV view mode";
    case "html":
      return "HTML view mode";
    case "markdown":
      return "Markdown view mode";
  }
}

function getFileContentsCopyLabel(kind: FilePreviewToggleKind | null): string {
  if (kind === "csv") {
    return "Copy CSV";
  }
  if (kind === "markdown") {
    return "Copy markdown";
  }
  if (kind === "html") {
    return "Copy HTML source";
  }
  return "Copy file contents";
}

function getLineWrapToggleLabel(lineOverflowMode: CodeOverflowMode): string {
  return lineOverflowMode === "wrap" ? "Disable line wrap" : "Wrap lines";
}

function getFilePreviewLineRange(
  state: FilePreviewState,
): FilePreviewLineRange | null {
  if (state.kind === "html" || state.kind === "ready") {
    return state.lineRange;
  }
  return null;
}

function getRawFilePreviewContents(state: FilePreviewState): string | null {
  if (state.kind === "html" || state.kind === "ready") {
    return state.file.contents;
  }
  return null;
}

function getInitialFilePreviewViewMode({
  lineRange,
  toggleKind,
}: GetInitialFilePreviewViewModeArgs): FilePreviewViewMode {
  if (
    toggleKind === "csv" ||
    toggleKind === "html" ||
    toggleKind === "markdown"
  ) {
    return "preview";
  }
  return lineRange === null ? "preview" : "source";
}

function usesCodeViewLayout(
  state: FilePreviewState,
  viewMode: FilePreviewViewMode,
): boolean {
  if (state.kind === "html") {
    return viewMode === "source";
  }

  if (state.kind !== "ready") {
    return false;
  }

  return state.textPreviewKind === null || viewMode === "source";
}

interface ParsedCsvRows {
  rows: string[][];
  truncatedRows: boolean;
}

function parseCsvRows(contents: string, maxRows: number): ParsedCsvRows {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let quotedField = false;
  let endedWithLineBreak = false;

  for (let index = 0; index < contents.length; index += 1) {
    const character = contents[index];
    endedWithLineBreak = false;

    if (inQuotes) {
      if (character === '"') {
        if (contents[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"' && field.length === 0) {
      inQuotes = true;
      quotedField = true;
      continue;
    }

    if (character === ",") {
      row.push(field);
      field = "";
      quotedField = false;
      continue;
    }

    if (character === "\n" || character === "\r") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      quotedField = false;
      endedWithLineBreak = true;
      if (character === "\r" && contents[index + 1] === "\n") {
        index += 1;
      }
      if (rows.length >= maxRows) {
        return { rows, truncatedRows: index + 1 < contents.length };
      }
      continue;
    }

    field += character;
  }

  if (
    field.length > 0 ||
    row.length > 0 ||
    quotedField ||
    !endedWithLineBreak
  ) {
    row.push(field);
    rows.push(row);
  }

  return { rows, truncatedRows: false };
}

export function buildCsvPreviewData(contents: string): CsvPreviewData {
  const { rows, truncatedRows } = parseCsvRows(
    contents,
    CSV_PREVIEW_MAX_ROWS + 1,
  );
  const columnCount = rows.reduce(
    (maximum, row) => Math.max(maximum, row.length),
    0,
  );

  return {
    columnCount: Math.min(columnCount, CSV_PREVIEW_MAX_COLUMNS),
    rows,
    truncatedColumns: columnCount > CSV_PREVIEW_MAX_COLUMNS,
    truncatedRows,
  };
}

export function getCsvTruncationNote(
  preview: CsvPreviewData,
  dataRowCount: number,
): string | null {
  const limits: string[] = [];
  if (preview.truncatedRows) {
    limits.push(`${dataRowCount.toLocaleString()} rows`);
  }
  if (preview.truncatedColumns) {
    limits.push(`${preview.columnCount.toLocaleString()} columns`);
  }
  if (limits.length === 0) {
    return null;
  }
  return `Showing the first ${limits.join(" and ")}.`;
}

export function FilePreview({
  state,
  path,
  copyPath = null,
  headerMode = "file",
  onSelectionAddToChat,
  onOpenInEditor,
  onRefresh,
  isRefreshing = false,
  markdownLinkRouting,
  statusLabel = null,
}: FilePreviewProps) {
  const toggleKind = getFilePreviewToggleKind(state);
  const filePreviewLineRange = getFilePreviewLineRange(state);
  const rawContents = getRawFilePreviewContents(state);
  const externalUrl = getFilePreviewExternalUrl(state);
  const [viewMode, setViewMode] = useState<FilePreviewViewMode>(
    getInitialFilePreviewViewMode({
      lineRange: filePreviewLineRange,
      toggleKind,
    }),
  );
  const [lineOverflowMode, setLineOverflowMode] = useState<CodeOverflowMode>(
    DEFAULT_CODE_OVERFLOW_MODE,
  );
  useEffect(() => {
    setViewMode(
      getInitialFilePreviewViewMode({
        lineRange: filePreviewLineRange,
        toggleKind,
      }),
    );
  }, [filePreviewLineRange, path, toggleKind]);

  const usesIframeLayout =
    state.kind === "iframe" ||
    (state.kind === "html" && viewMode === "preview");
  const bodyViewMode: FilePreviewViewMode =
    toggleKind === null ? "preview" : viewMode;
  const usesCodeLayout = usesCodeViewLayout(state, bodyViewMode);
  const showLineOverflowToggle = usesCodeLayout;
  const usesMarkdownPreviewLayout =
    state.kind === "ready" &&
    state.textPreviewKind === "markdown" &&
    bodyViewMode === "preview";
  const usesCsvPreviewLayout =
    state.kind === "ready" &&
    state.textPreviewKind === "csv" &&
    bodyViewMode === "preview";
  const usesFullHeightLayout =
    usesIframeLayout || usesCsvPreviewLayout || usesCodeLayout;
  const usesContentHeightLayout = usesMarkdownPreviewLayout;

  return (
    <div
      className={
        usesFullHeightLayout
          ? "@container/page flex h-full min-h-0 flex-col"
          : usesContentHeightLayout
            ? "@container/page flex min-h-full flex-col"
            : "@container/page min-h-full"
      }
      style={FILE_PREVIEW_WRAPPER_STYLE}
    >
      {headerMode === "file" ? (
        <FilePreviewHeader
          path={path}
          copyPath={copyPath}
          rawContents={rawContents}
          externalUrl={externalUrl}
          onOpenInEditor={onOpenInEditor}
          onRefresh={onRefresh}
          isRefreshing={isRefreshing}
          statusLabel={statusLabel}
          toggleKind={toggleKind}
          showLineOverflowToggle={showLineOverflowToggle}
          lineOverflowMode={lineOverflowMode}
          onLineOverflowModeChange={setLineOverflowMode}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
        />
      ) : null}
      <FilePreviewBody
        state={state}
        path={path}
        lineOverflowMode={lineOverflowMode}
        viewMode={bodyViewMode}
        markdownLinkRouting={markdownLinkRouting}
        onSelectionAddToChat={onSelectionAddToChat}
      />
    </div>
  );
}

function FilePreviewBody({
  state,
  path,
  lineOverflowMode,
  viewMode,
  markdownLinkRouting,
  onSelectionAddToChat,
}: FilePreviewBodyProps) {
  if (state.kind === "loading") {
    return <SourceLoadingSkeleton />;
  }
  if (state.kind === "empty") {
    return <FilePreviewMessage message="Empty file." />;
  }
  if (state.kind === "not-found") {
    return <FilePreviewMessage message="File not found." role="alert" />;
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
  if (state.kind === "video") {
    return <FilePreviewVideo url={state.url} title={path} />;
  }
  if (state.kind === "iframe") {
    return (
      <IframeFilePreview
        sandbox={state.sandbox}
        title={state.title}
        url={state.url}
      />
    );
  }
  if (state.kind === "html") {
    return (
      <HtmlFilePreviewBody
        lineOverflowMode={lineOverflowMode}
        onSelectionAddToChat={onSelectionAddToChat}
        state={state}
        viewMode={viewMode}
      />
    );
  }
  if (state.textPreviewKind === "csv" && viewMode === "preview") {
    return (
      <CsvFilePreview
        file={state.file}
        onSelectionAddToChat={onSelectionAddToChat}
      />
    );
  }
  if (state.textPreviewKind === "markdown" && viewMode === "preview") {
    return (
      <MarkdownFilePreview
        file={state.file}
        urlTransform={state.markdownUrlTransform}
        markdownLinkRouting={markdownLinkRouting}
        onSelectionAddToChat={onSelectionAddToChat}
      />
    );
  }
  return (
    <FilePreviewCode
      file={state.file}
      lineOverflowMode={lineOverflowMode}
      lineRange={state.lineRange ?? null}
      onSelectionAddToChat={onSelectionAddToChat}
      path={path}
    />
  );
}

function FilePreviewHeader({
  path,
  copyPath,
  rawContents,
  externalUrl,
  onOpenInEditor,
  onRefresh,
  isRefreshing,
  statusLabel,
  toggleKind,
  showLineOverflowToggle,
  lineOverflowMode,
  onLineOverflowModeChange,
  viewMode,
  onViewModeChange,
}: FilePreviewHeaderProps) {
  const openShortcut = useAppCommandShortcut("workspace.openPreferred");
  const showHeaderControls = showLineOverflowToggle || toggleKind !== null;
  const copyFileContentsLabel = getFileContentsCopyLabel(toggleKind);

  return (
    <div className="sticky top-0 z-10 bg-sidebar">
      <div className="flex h-9 items-center gap-2 bg-surface-raised px-4">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <Icon
            name="File"
            className="size-3.5 shrink-0 text-subtle-foreground"
          />
          <FilePreviewPath path={path} copyPath={copyPath} />
          {statusLabel === null ? null : (
            <span
              className={cn(
                "shrink-0 leading-5 text-muted-foreground",
                COARSE_POINTER_TEXT_SM_CLASS,
              )}
            >
              ({statusLabel})
            </span>
          )}
          <TooltipProvider delayDuration={300}>
            {onRefresh ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className={cn(
                      FILE_PREVIEW_HEADER_ICON_BUTTON_CLASS,
                      "shrink-0 text-muted-foreground hover:bg-state-hover hover:text-foreground",
                    )}
                    onClick={onRefresh}
                    disabled={isRefreshing}
                    aria-label={
                      isRefreshing ? "Refreshing file" : "Refresh file"
                    }
                  >
                    <Icon
                      name={isRefreshing ? "Spinner" : "RotateCcw"}
                      className={cn(isRefreshing && "animate-spin")}
                      aria-hidden
                    />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {isRefreshing ? "Refreshing file" : "Refresh file"}
                </TooltipContent>
              </Tooltip>
            ) : null}
            {rawContents === null ? null : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <CopyButton
                    text={rawContents}
                    label={copyFileContentsLabel}
                    className={cn(
                      FILE_PREVIEW_HEADER_ICON_BUTTON_CLASS,
                      "shrink-0 rounded-md hover:bg-state-hover hover:text-foreground",
                    )}
                  />
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {copyFileContentsLabel}
                </TooltipContent>
              </Tooltip>
            )}
            {externalUrl === null ? null : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className={cn(
                      FILE_PREVIEW_HEADER_ICON_BUTTON_CLASS,
                      "shrink-0 text-muted-foreground hover:bg-state-hover hover:text-foreground",
                    )}
                    onClick={() => {
                      openUrlInExternalBrowser(
                        toAbsolutePreviewUrl(externalUrl),
                      );
                    }}
                    aria-label="Open in external browser"
                  >
                    {}
                    <Icon name="Globe" aria-hidden />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  Open in external browser
                </TooltipContent>
              </Tooltip>
            )}
            {onOpenInEditor ? (
              <>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <OpenInEditorButton
                      onClick={() => onOpenInEditor(path)}
                      className={FILE_PREVIEW_HEADER_ICON_BUTTON_CLASS}
                      label={
                        openShortcut
                          ? `Open in editor (${openShortcut.label})`
                          : "Open in editor"
                      }
                      aria-keyshortcuts={openShortcut?.ariaKeyshortcuts}
                    />
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {openShortcut
                      ? `Open in editor (${openShortcut.label})`
                      : "Open in editor"}
                  </TooltipContent>
                </Tooltip>
                <AppCommandShortcutHint shortcut={openShortcut} />
              </>
            ) : null}
          </TooltipProvider>
        </div>
        {showHeaderControls ? (
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <FilePreviewLineWrapButton
              showLineOverflowToggle={showLineOverflowToggle}
              lineOverflowMode={lineOverflowMode}
              onLineOverflowModeChange={onLineOverflowModeChange}
            />
            {toggleKind !== null ? (
              <div
                className="inline-flex shrink-0 items-center gap-0.5 rounded-md border border-border p-0.5"
                role="tablist"
                aria-label={getToggleAriaLabel(toggleKind)}
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={cn(
                    FILE_PREVIEW_VIEW_MODE_BUTTON_CLASS,
                    COARSE_POINTER_TEXT_SM_CLASS,
                  )}
                  onClick={() => onViewModeChange("preview")}
                  aria-pressed={viewMode === "preview"}
                >
                  Preview
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={cn(
                    FILE_PREVIEW_VIEW_MODE_BUTTON_CLASS,
                    COARSE_POINTER_TEXT_SM_CLASS,
                  )}
                  onClick={() => onViewModeChange("source")}
                  aria-pressed={viewMode === "source"}
                >
                  Raw
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function FilePreviewPath({ path, copyPath }: FilePreviewPathProps) {
  const copyTarget = copyPath ?? path;
  const label = "Copy file path";
  const className = cn(
    "min-w-0 font-mono font-medium leading-5 text-file-accent",
    COARSE_POINTER_TEXT_SM_CLASS,
  );

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={cn(
              className,
              "cursor-pointer rounded-sm text-left underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            )}
            aria-label={label}
            onClick={() => {
              void copyToClipboardWithToast(copyTarget, {
                successMessage: "File path copied",
                errorMessage: "Failed to copy file path",
              });
            }}
          >
            <TruncateStart>{path}</TruncateStart>
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function FilePreviewLineWrapButton({
  showLineOverflowToggle,
  lineOverflowMode,
  onLineOverflowModeChange,
}: FilePreviewLineWrapButtonProps) {
  if (!showLineOverflowToggle) {
    return null;
  }

  const label = getLineWrapToggleLabel(lineOverflowMode);

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(
              FILE_PREVIEW_HEADER_ICON_BUTTON_CLASS,
              "text-muted-foreground",
            )}
            aria-label={label}
            aria-pressed={lineOverflowMode === "wrap"}
            onClick={() => {
              onLineOverflowModeChange(
                lineOverflowMode === "wrap" ? "scroll" : "wrap",
              );
            }}
          >
            <Icon name="TextWrap" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function HtmlFilePreviewBody({
  lineOverflowMode,
  onSelectionAddToChat,
  state,
  viewMode,
}: HtmlFilePreviewBodyProps) {
  const isPreviewVisible = viewMode === "preview";
  return (
    <>
      <div
        className={isPreviewVisible ? "contents" : "hidden"}
        aria-hidden={isPreviewVisible ? undefined : true}
      >
        <IframeFilePreview
          key={state.file.cacheKey}
          sandbox={state.iframe.sandbox}
          title={state.iframe.title}
          url={state.iframe.url}
        />
      </div>
      <div
        className={isPreviewVisible ? "hidden" : "contents"}
        aria-hidden={isPreviewVisible ? true : undefined}
      >
        <FilePreviewCode
          file={state.file}
          lineOverflowMode={lineOverflowMode}
          lineRange={state.lineRange}
          onSelectionAddToChat={onSelectionAddToChat}
          path={state.file.name}
        />
      </div>
    </>
  );
}

function MarkdownFilePreview({
  file,
  onSelectionAddToChat,
  urlTransform,
  markdownLinkRouting,
}: MarkdownFilePreviewProps) {
  return (
    <SecondaryPanelSelectionActions onSelectionAddToChat={onSelectionAddToChat}>
      <div className="flex-auto bg-background px-4 py-4">
        <MarkdownPreview
          allowHtml
          content={file.contents}
          urlTransform={urlTransform}
          linkRouting={markdownLinkRouting}
        />
      </div>
    </SecondaryPanelSelectionActions>
  );
}

function CsvFilePreview({ file, onSelectionAddToChat }: CsvFilePreviewProps) {
  const preview = useMemo(
    () => buildCsvPreviewData(file.contents),
    [file.contents],
  );
  const headerRow = preview.rows[0] ?? [];
  const bodyRows = preview.rows.slice(1);
  const columns = Array.from({ length: preview.columnCount }, (_, index) => ({
    index,
    label: headerRow[index] ?? "",
  }));
  const tableWidth = `max(100%, ${3 + columns.length * 18}rem)`;
  const truncationNote = getCsvTruncationNote(preview, bodyRows.length);

  const scrollRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: bodyRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => CSV_PREVIEW_ROW_HEIGHT_PX,
    overscan: CSV_PREVIEW_OVERSCAN_ROWS,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const totalRowsHeight = rowVirtualizer.getTotalSize();
  const firstVirtualRow = virtualRows[0];
  const lastVirtualRow = virtualRows[virtualRows.length - 1];
  const spacerTopHeight = firstVirtualRow?.start ?? 0;
  const spacerBottomHeight =
    lastVirtualRow === undefined
      ? totalRowsHeight
      : totalRowsHeight - lastVirtualRow.end;

  return (
    <SecondaryPanelSelectionActions onSelectionAddToChat={onSelectionAddToChat}>
      {}
      <div className="flex min-h-0 flex-auto flex-col bg-surface-raised px-4 py-4">
        {}
        <div
          ref={scrollRef}
          className="persistent-scrollbar min-h-0 overflow-auto overscroll-contain rounded-md border border-border bg-background"
        >
          <table
            className="min-w-full table-fixed border-separate border-spacing-0 font-mono text-xs leading-5"
            aria-label={`${file.name} CSV preview`}
            style={{ width: tableWidth }}
          >
            <colgroup>
              <col className="w-12" />
              {columns.map((column) => (
                <col key={column.index} className="w-72" />
              ))}
            </colgroup>
            <thead>
              <tr>
                <th
                  scope="col"
                  className="sticky left-0 top-0 z-30 w-12 min-w-12 border-b border-r border-border bg-surface-recessed-solid px-2 py-1 text-right font-medium text-muted-foreground"
                >
                  #
                </th>
                {columns.map((column) => (
                  <th
                    key={column.index}
                    scope="col"
                    className="sticky top-0 z-20 w-72 max-w-72 border-b border-r border-border bg-surface-recessed-solid px-2 py-1 text-left font-medium text-foreground"
                    title={column.label}
                  >
                    <span className="block max-w-full truncate">
                      {column.label || `Column ${column.index + 1}`}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {spacerTopHeight > 0 ? (
                <tr aria-hidden style={{ height: spacerTopHeight }}>
                  <td colSpan={columns.length + 1} className="p-0" />
                </tr>
              ) : null}
              {virtualRows.map((virtualRow) => {
                const rowIndex = virtualRow.index;
                const row = bodyRows[rowIndex] ?? [];
                return (
                  <tr
                    key={virtualRow.key}
                    data-index={rowIndex}
                    ref={rowVirtualizer.measureElement}
                  >
                    <th
                      scope="row"
                      className="sticky left-0 z-10 w-12 min-w-12 border-b border-r border-border bg-surface-recessed-solid px-2 py-1 text-right font-medium text-muted-foreground"
                    >
                      {rowIndex + 2}
                    </th>
                    {columns.map((column) => {
                      const cell = row[column.index] ?? "";
                      return (
                        <td
                          key={column.index}
                          className="w-72 max-w-72 overflow-hidden border-b border-r border-border px-2 py-1 align-top text-foreground"
                          title={cell}
                        >
                          <span className="block max-w-full truncate">
                            {cell}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
              {spacerBottomHeight > 0 ? (
                <tr aria-hidden style={{ height: spacerBottomHeight }}>
                  <td colSpan={columns.length + 1} className="p-0" />
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        {truncationNote === null ? null : (
          <p className="mt-2 shrink-0 text-xs leading-5 text-muted-foreground">
            {truncationNote}
          </p>
        )}
      </div>
    </SecondaryPanelSelectionActions>
  );
}

function FilePreviewImage({ url, alt }: FilePreviewImageProps) {
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

function FilePreviewVideo({ url, title }: FilePreviewVideoProps) {
  return (
    <div className="pt-4">
      <video
        src={url}
        title={title}
        className="block max-h-[34rem] w-full bg-black"
        controls
        preload="metadata"
      />
    </div>
  );
}

function IframeFilePreview({ sandbox, title, url }: IframeFilePreviewTarget) {
  const [loadState, setLoadState] = useState<IframeLoadState>("loading");
  const [showLoadingIndicator, setShowLoadingIndicator] = useState(false);

  useEffect(() => {
    setLoadState("loading");
  }, [url]);

  useEffect(() => {
    if (loadState !== "loading") {
      setShowLoadingIndicator(false);
      return;
    }

    setShowLoadingIndicator(false);
    const timeoutId = window.setTimeout(() => {
      setShowLoadingIndicator(true);
    }, IFRAME_LOADING_INDICATOR_DELAY_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [loadState, url]);

  if (loadState === "error") {
    return (
      <div className="min-h-0 flex-1 overflow-hidden">
        <FilePreviewMessage
          message="Failed to load HTML preview."
          role="alert"
        />
      </div>
    );
  }

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden">
      {loadState === "loading" && showLoadingIndicator ? (
        <div className="absolute inset-x-0 top-0 z-10">
          <SourceLoadingSkeleton />
        </div>
      ) : null}
      <iframe
        title={title}
        src={url}
        sandbox={sandbox === null ? undefined : sandbox}
        style={HTML_FILE_PREVIEW_IFRAME_STYLE}
        onLoad={() => setLoadState("loaded")}
        onError={() => setLoadState("error")}
      />
    </div>
  );
}

function FilePreviewMessage({ message, role }: FilePreviewMessageProps) {
  return (
    <EmptyStatePanel role={role} className="mx-4 mt-4 rounded-lg">
      {message}
    </EmptyStatePanel>
  );
}

function FilePreviewCode({
  file,
  lineOverflowMode,
  lineRange,
  onSelectionAddToChat,
  path,
}: FilePreviewCodeProps) {
  const highlightedLines = useMemo(
    () =>
      lineRange === null
        ? null
        : { start: lineRange.startLineNumber, end: lineRange.endLineNumber },
    [lineRange],
  );
  return (
    <SourceCodeHost
      content={file.contents}
      path={path}
      cacheKey={file.cacheKey ?? file.name}
      overflow={lineOverflowMode}
      highlightedLines={highlightedLines}
      scrollToHighlightedLines
      fallback={<SourceLoadingSkeleton />}
      onSelectionAddToChat={onSelectionAddToChat}
    />
  );
}
