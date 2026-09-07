import { useMemo, type ReactNode } from "react";
import type { GitDiffFileChangeKind } from "@bb/server-contract";
import { CopyButton } from "@/components/ui/copy-button.js";
import { DiffStatsTally } from "@/components/ui/diff-stats-tally.js";
import { FilePathLink } from "@/components/ui/file-path-link.js";
import { Icon } from "@bb/shared-ui/icon";
import { OpenInEditorButton } from "@/components/ui/open-in-editor-button.js";
import { TruncateStart } from "@/components/ui/truncate-start.js";
import { resolveAbsoluteFilePath } from "@/lib/absolute-file-path";
import { cn } from "@bb/shared-ui/lib/utils";
import type { DiffImageSizeStat } from "./GitDiffCardBody";

export interface GitDiffCardHeaderModel {
  label: string;
  path: string;
  openablePath: string | null;
  changeKind: GitDiffFileChangeKind;
  insertions: number;
  deletions: number;
}

interface GitDiffCardHeaderProps {
  model: GitDiffCardHeaderModel;
  previousPath: string | null;
  filePathRoot?: string | null;
  onOpenFileInEditor?: (path: string) => void;
  onOpenFilePreview?: (path: string) => void;
  isCollapsed?: boolean;
  onToggleCollapsed?: () => void;
  hasChanges: boolean;
  statSlot?: ReactNode;
  actionSlot?: ReactNode;
}

const BYTES_PER_UNIT = 1024;

function formatByteSize(bytes: number): string {
  if (bytes < BYTES_PER_UNIT) {
    return `${bytes} B`;
  }
  const kb = bytes / BYTES_PER_UNIT;
  if (kb < BYTES_PER_UNIT) {
    return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  }
  const mb = kb / BYTES_PER_UNIT;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

interface GitDiffCardImageSizeStatProps {
  stat: DiffImageSizeStat;
}

export function GitDiffCardImageSizeStat({
  stat,
}: GitDiffCardImageSizeStatProps) {
  return (
    <span className="flex shrink-0 items-center gap-1 whitespace-nowrap text-xs tabular-nums">
      {stat.addedBytes !== null ? (
        <span className="text-diff-added">{`+${formatByteSize(stat.addedBytes)}`}</span>
      ) : null}
      {stat.removedBytes !== null ? (
        <span className="text-diff-removed">{`-${formatByteSize(stat.removedBytes)}`}</span>
      ) : null}
    </span>
  );
}

interface GitDiffCardRawToggleProps {
  fileLabel: string;
  isRaw: boolean;
  onToggle: () => void;
}

export function GitDiffCardRawToggle({
  fileLabel,
  isRaw,
  onToggle,
}: GitDiffCardRawToggleProps) {
  const label = isRaw
    ? `Show image preview for ${fileLabel}`
    : `Show raw SVG diff for ${fileLabel}`;
  return (
    <button
      type="button"
      className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring aria-pressed:bg-state-active aria-pressed:text-foreground"
      onClick={onToggle}
      aria-label={label}
      aria-pressed={isRaw}
    >
      <Icon name="Code" aria-hidden className="size-3.5" />
    </button>
  );
}

function resolveRenameInfo(
  model: GitDiffCardHeaderModel,
  previousPath: string | null,
): { from: string; to: string } | null {
  if (model.changeKind !== "renamed" && model.changeKind !== "copied") {
    return null;
  }
  if (previousPath && previousPath !== model.path) {
    return { from: previousPath, to: model.path };
  }
  return null;
}

export function GitDiffCardHeader({
  model,
  previousPath,
  filePathRoot,
  onOpenFileInEditor,
  onOpenFilePreview,
  isCollapsed,
  onToggleCollapsed,
  hasChanges,
  statSlot,
  actionSlot,
}: GitDiffCardHeaderProps) {
  const isAddedFile = model.changeKind === "added";
  const isDeletedFile = model.changeKind === "deleted";
  const headerInsertions = isDeletedFile ? 0 : model.insertions;
  const headerDeletions = isAddedFile ? 0 : model.deletions;
  const hideEmptyHeaderStats = isAddedFile || isDeletedFile;
  const renameInfo = useMemo(
    () => resolveRenameInfo(model, previousPath),
    [model, previousPath],
  );
  const openablePath = model.openablePath;
  const copyablePath = openablePath
    ? resolveAbsoluteFilePath({ path: openablePath, rootPath: filePathRoot })
    : null;
  const canOpenFile = Boolean(openablePath);
  const supportsCollapse =
    isCollapsed !== undefined && onToggleCollapsed !== undefined;

  return (
    <div className="flex w-full min-w-0 items-center justify-between gap-2">
      <span className="flex min-w-0 items-center">
        {supportsCollapse ? (
          <button
            type="button"
            className={cn(
              "inline-flex w-8 shrink-0 items-center justify-center text-muted-foreground transition-colors",
              hasChanges
                ? "hover:text-foreground"
                : "cursor-not-allowed opacity-40",
            )}
            onClick={hasChanges ? onToggleCollapsed : undefined}
            disabled={!hasChanges}
            aria-label={
              hasChanges
                ? `${isCollapsed ? "Expand" : "Collapse"} ${model.label}`
                : `${model.label} has no changes to expand`
            }
            aria-expanded={hasChanges ? !isCollapsed : undefined}
          >
            <Icon
              name="ChevronRight"
              className={cn(
                "size-3.5 shrink-0 transition-transform duration-150",
                hasChanges && !isCollapsed && "rotate-90",
              )}
            />
          </button>
        ) : null}
        <span className={cn("flex min-w-0 items-center gap-1.5", "pl-[1ch]")}>
          {renameInfo ? (
            <TruncateStart
              className="min-w-0 font-mono text-xs leading-5 text-muted-foreground"
              title={renameInfo.from}
            >
              {renameInfo.from}
            </TruncateStart>
          ) : null}
          {renameInfo ? (
            <Icon
              name="ArrowRight"
              aria-hidden="true"
              className="size-3 shrink-0 text-subtle-foreground"
            />
          ) : null}
          <FilePathLink
            path={openablePath ?? model.path}
            displayName={renameInfo ? renameInfo.to : model.label}
            onClick={
              canOpenFile && openablePath && onOpenFilePreview
                ? () => onOpenFilePreview(openablePath)
                : undefined
            }
            className="font-mono font-medium text-foreground"
          />
          {copyablePath ? (
            <CopyButton
              text={copyablePath}
              label={`Copy path for ${model.label}`}
              className="rounded-md hover:bg-state-hover"
            />
          ) : null}
          {canOpenFile && openablePath && onOpenFileInEditor ? (
            <OpenInEditorButton
              onClick={() => onOpenFileInEditor(openablePath)}
              label={`Open ${model.label} in editor`}
            />
          ) : null}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-1">
        {actionSlot}
        {statSlot ?? (
          <DiffStatsTally
            insertions={headerInsertions}
            deletions={headerDeletions}
            hideZero={hideEmptyHeaderStats}
            className="text-xs"
          />
        )}
      </span>
    </div>
  );
}

const GIT_DIFF_CARD_HEADER_WRAPPER_BASE_CLASS =
  "rounded-lg bg-background py-1.5 pl-2 pr-3 text-xs font-medium text-foreground";

interface GitDiffCardHeaderWrapperClassArgs {
  stickyHeader: boolean;
  isBodyHidden: boolean;
  isStuck: boolean;
  showStuckHeaderEdge?: boolean;
}

export function gitDiffCardHeaderWrapperClass({
  stickyHeader,
  isBodyHidden,
  isStuck,
  showStuckHeaderEdge = true,
}: GitDiffCardHeaderWrapperClassArgs): string {
  return cn(
    GIT_DIFF_CARD_HEADER_WRAPPER_BASE_CLASS,
    stickyHeader && "sticky z-30",
    stickyHeader && "top-0",
    !isBodyHidden && "rounded-b-none",
    isStuck && "rounded-t-none",
    isStuck && showStuckHeaderEdge && "shadow-[inset_0_1px_0_var(--border)]",
  );
}
