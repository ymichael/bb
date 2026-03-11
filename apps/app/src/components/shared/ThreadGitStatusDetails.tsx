import { type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { type ThreadWorkStatus } from "@beanbag/agent-core";
import { DetailCard, DetailRow } from "@beanbag/ui-core";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { MergeBaseBranchPicker } from "./MergeBaseBranchPicker";
import { WorkspaceChangesList } from "./WorkspaceChangesList";

function normalizeMergeBaseCandidates(
  mergeBaseBranch: string | undefined,
  mergeBaseBranchOptions: readonly string[] | undefined,
): readonly string[] {
  const candidates = mergeBaseBranchOptions ?? [];
  if (!mergeBaseBranch || candidates.includes(mergeBaseBranch)) {
    return candidates;
  }
  return [mergeBaseBranch, ...candidates];
}

function shouldShowMergeBaseControl({
  currentBranch,
  defaultBranch,
  mergeBaseBranch,
}: {
  currentBranch?: string;
  defaultBranch?: string;
  mergeBaseBranch?: string;
}): boolean {
  if (!mergeBaseBranch) {
    return false;
  }
  if (!currentBranch || !defaultBranch) {
    return true;
  }
  return currentBranch !== defaultBranch;
}

export function ThreadGitStatusDetails({
  statusLabel,
  statusSummary,
  statusLabelClassName,
  currentBranch,
  defaultBranch,
  mergeBaseBranch,
  mergeBaseBranchOptions,
  mergeBaseBranchOptionsLoading = false,
  onMergeBaseBranchChange,
  onMergeBaseBranchPickerOpenChange,
  pending = false,
  branchContent,
  changedFiles,
  changedFilesContent,
  threadId,
  onFileClick,
  extraRows,
  collapsible = false,
  expanded = true,
  onToggleExpanded,
  onSummaryClick,
  summaryClassName,
  className,
  bodyClassName,
}: {
  statusLabel?: string;
  statusSummary?: string;
  statusLabelClassName?: string;
  currentBranch?: string;
  defaultBranch?: string;
  mergeBaseBranch?: string;
  mergeBaseBranchOptions?: readonly string[];
  mergeBaseBranchOptionsLoading?: boolean;
  onMergeBaseBranchChange?: (branch: string) => void;
  onMergeBaseBranchPickerOpenChange?: (open: boolean) => void;
  pending?: boolean;
  branchContent?: ReactNode;
  changedFiles?: ThreadWorkStatus["files"];
  changedFilesContent?: ReactNode;
  threadId?: string;
  onFileClick?: (file: NonNullable<ThreadWorkStatus["files"]>[number]) => void;
  extraRows?: ReactNode;
  collapsible?: boolean;
  expanded?: boolean;
  onToggleExpanded?: () => void;
  onSummaryClick?: () => void;
  summaryClassName?: string;
  className?: string;
  bodyClassName?: string;
}) {
  const mergeBaseCandidates = normalizeMergeBaseCandidates(
    mergeBaseBranch,
    mergeBaseBranchOptions,
  );
  const showMergeBaseControl = shouldShowMergeBaseControl({
    currentBranch,
    defaultBranch,
    mergeBaseBranch,
  });
  const canSelectMergeBase =
    showMergeBaseControl &&
    Boolean(onMergeBaseBranchChange) &&
    mergeBaseCandidates.length > 0;
  const showChangedFiles =
    changedFilesContent !== undefined || Boolean(changedFiles && changedFiles.length > 0);
  const hasBody = Boolean(branchContent || extraRows || showChangedFiles);
  const isExpanded = !collapsible || expanded;
  const summaryContent = (
    <div className={cn("min-w-0", summaryClassName)}>
      {statusLabel ? (
        <div className="flex min-w-0 items-baseline gap-2">
          <span
            className={cn(
              "shrink-0 text-sm font-medium text-foreground",
              statusLabelClassName,
            )}
          >
            {statusLabel}
          </span>
          {statusSummary ? (
            <span className="min-w-0 truncate text-sm text-muted-foreground">
              {statusSummary}
            </span>
          ) : null}
        </div>
      ) : statusSummary ? (
        <p className="truncate text-sm text-muted-foreground">{statusSummary}</p>
      ) : null}
    </div>
  );

  return (
    <div
      className={cn(
        "rounded-md border border-border/70 bg-muted/20",
        className,
      )}
    >
      <div className="flex items-start gap-3 px-3 py-2">
        {onSummaryClick ? (
          <button
            type="button"
            className="min-w-0 flex-1 text-left"
            onClick={onSummaryClick}
          >
            {summaryContent}
          </button>
        ) : (
          <div className="min-w-0 flex-1">{summaryContent}</div>
        )}
        <div className="flex shrink-0 items-center gap-2">
          {showMergeBaseControl && mergeBaseBranch ? (
            canSelectMergeBase ? (
              <MergeBaseBranchPicker
                value={mergeBaseBranch}
                options={mergeBaseCandidates}
                loading={mergeBaseBranchOptionsLoading}
                disabled={pending}
                onChange={(branch) => onMergeBaseBranchChange?.(branch)}
                onOpenChange={onMergeBaseBranchPickerOpenChange}
                className="max-w-[12rem]"
              />
            ) : (
              <span
                className="max-w-[12rem] truncate text-xs text-muted-foreground"
                title={mergeBaseBranch}
              >
                {mergeBaseBranch}
              </span>
            )
          ) : null}
          {collapsible && hasBody ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 w-7 rounded-md p-0 text-muted-foreground hover:bg-accent/45 hover:text-foreground"
              onClick={onToggleExpanded}
              aria-label={expanded ? "Collapse git status details" : "Expand git status details"}
              title={expanded ? "Collapse" : "Expand"}
            >
              <ChevronDown
                className={cn(
                  "size-3.5 transition-transform duration-200",
                  expanded && "rotate-180",
                )}
              />
            </Button>
          ) : null}
        </div>
      </div>
      {isExpanded && hasBody ? (
        <div className={cn("border-t border-border/60 px-3 py-2", bodyClassName)}>
          <DetailCard className="border-0 bg-transparent px-0 py-0">
            {branchContent ? (
              <DetailRow label="Branch" valueClassName="min-w-0">
                {branchContent}
              </DetailRow>
            ) : null}
            {extraRows}
            {showChangedFiles ? (
              <DetailRow
                label="Changed files"
                layout="vertical"
                valueClassName="pt-0.5"
              >
                {changedFilesContent ?? (
                  <WorkspaceChangesList
                    files={changedFiles}
                    threadId={threadId}
                    onFileClick={onFileClick}
                    maxHeightClassName="max-h-48"
                  />
                )}
              </DetailRow>
            ) : null}
          </DetailCard>
        </div>
      ) : null}
    </div>
  );
}
