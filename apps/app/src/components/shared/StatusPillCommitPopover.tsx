import { useState } from "react";
import { assertNever, type ThreadWorkStatus } from "@beanbag/agent-core";
import { PromptOptionPicker } from "@/components/promptbox/PromptOptionPicker";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import {
  formatWorkspaceChangedFilesLabel,
  hasWorkspaceLineChanges,
} from "@/lib/workspace-change-summary";
import { DetailCard, DetailRow } from "./DetailCard";
import { StatusPill, type StatusPillVariant } from "./StatusPill";
import { WorkspaceChangesList } from "./WorkspaceChangesList";

export function StatusPillCommitPopover({
  status,
  label,
  variant,
  cleanTitle,
  showMergeBaseDetails,
  mergeBaseBranch,
  mergeBaseBranchOptions,
  onMergeBaseBranchChange,
  canCommit,
  canSquashMerge,
  isCommitting,
  isSquashMerging,
  onCommit,
  onSquashMerge,
}: {
  status: ThreadWorkStatus | undefined;
  label: string;
  variant: StatusPillVariant;
  cleanTitle?: string;
  showMergeBaseDetails?: boolean;
  mergeBaseBranch?: string;
  mergeBaseBranchOptions?: string[];
  onMergeBaseBranchChange?: (branch: string) => void;
  canCommit: boolean;
  canSquashMerge?: boolean;
  isCommitting: boolean;
  isSquashMerging?: boolean;
  onCommit: (args: { includeUnstaged: boolean; message?: string }) => Promise<void>;
  onSquashMerge?: (args: {
    commitIfNeeded: boolean;
    includeUnstaged: boolean;
    commitMessage?: string;
    mergeBaseBranch?: string;
  }) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [includeUnstaged, setIncludeUnstaged] = useState(true);
  const [commitMessage, setCommitMessage] = useState("");
  const branchName = status?.currentBranch;
  const mergeDeltaSummary = status
    ? `${status.aheadCount} ahead · ${status.behindCount} behind`
    : "unknown";
  const isClean = status?.state === "clean";
  const isUpToDate = isClean && (status?.aheadCount ?? 0) === 0 && (status?.behindCount ?? 0) === 0;
  const hasMergeBaseDelta = (status?.aheadCount ?? 0) > 0 || (status?.behindCount ?? 0) > 0;
  const canShowMergeBaseDetails = showMergeBaseDetails === true;
  const mergeBaseCandidates = (() => {
    const fromProps = mergeBaseBranchOptions ?? status?.mergeBaseBranches ?? [];
    const selected = mergeBaseBranch ?? status?.mergeBaseBranch;
    if (!selected || fromProps.includes(selected)) {
      return fromProps;
    }
    return [selected, ...fromProps];
  })();
  const selectedMergeBaseBranch =
    mergeBaseBranch ??
    status?.mergeBaseBranch ??
    mergeBaseCandidates[0] ??
    status?.defaultBranch;
  const mergeBaseBranchOptionItems = mergeBaseCandidates.map((candidate) => ({
    value: candidate,
    label: candidate,
  }));
  const mergeBaseBranchPickerValue =
    selectedMergeBaseBranch ??
    mergeBaseCandidates[0];
  const canSelectMergeBaseBranch =
    canShowMergeBaseDetails &&
    Boolean(onMergeBaseBranchChange) &&
    mergeBaseCandidates.length > 0;
  const hasWorkspaceDelta =
    (status?.workspaceChangedFiles ?? 0) > 0 ||
    (status?.workspaceInsertions ?? 0) > 0 ||
    (status?.workspaceDeletions ?? 0) > 0;
  const hasWorkspaceLineDelta = status ? hasWorkspaceLineChanges(status) : false;
  const canShowChangedFiles = Boolean(
    status &&
      (
        status.state === "dirty_uncommitted" ||
        status.state === "dirty_and_committed_unmerged" ||
        status.state === "committed_unmerged"
      ),
  );
  const showStatusCard = !isUpToDate || Boolean(branchName);
  const title = (() => {
    if (canCommit) return "Commit your changes";
    if (!status) return "Status unavailable";
    switch (status.state) {
      case "clean":
        return isUpToDate ? (cleanTitle ?? "Up to date") : "Working tree clean";
      case "untracked":
        return "Not a Git repository";
      case "deleted":
        return "Workspace deleted";
      case "committed_unmerged":
        return "Branch ahead";
      case "dirty_uncommitted":
      case "dirty_and_committed_unmerged":
        return "Workspace changes";
      default:
        return assertNever(status.state);
    }
  })();
  const statusSummary = (() => {
    if (!status) {
      return "Workspace status is unavailable.";
    }
    switch (status.state) {
      case "clean":
        return isUpToDate
          ? "No local or merge-base differences."
          : "No local file changes in the workspace.";
      case "untracked":
        return "Workspace is outside a Git repository.";
      case "deleted":
        return "This workspace no longer exists on disk.";
      case "dirty_uncommitted":
        return "You have local changes that have not been committed yet.";
      case "committed_unmerged":
        return "You have local commits that have not been merged yet.";
      case "dirty_and_committed_unmerged":
        return "You have both uncommitted changes and local commits waiting to be merged.";
      default:
        return assertNever(status.state);
    }
  })();

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="inline-flex items-center rounded-sm align-middle">
          <StatusPill variant={variant}>{label}</StatusPill>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[420px]">
        <div className="space-y-4 text-sm">
          <div className="space-y-1">
            <h3 className="text-base font-semibold leading-tight">{title}</h3>
            <p className="text-xs leading-relaxed text-muted-foreground">{statusSummary}</p>
          </div>

          {showStatusCard ? (
            <DetailCard>
              {branchName ? (
                <DetailRow label="Branch" valueClassName="truncate">
                  <span className="font-medium">{branchName}</span>
                </DetailRow>
              ) : null}
              {canShowMergeBaseDetails && (canSelectMergeBaseBranch || Boolean(selectedMergeBaseBranch)) ? (
                <DetailRow label="Merge base">
                  {canSelectMergeBaseBranch ? (
                    mergeBaseBranchPickerValue ? (
                      <PromptOptionPicker
                        label="Merge base branch"
                        value={mergeBaseBranchPickerValue}
                        options={mergeBaseBranchOptionItems}
                        onChange={(branch) => onMergeBaseBranchChange?.(branch)}
                        className="h-7 max-w-[220px] px-0 text-xs text-foreground hover:text-foreground [&_svg]:!text-foreground"
                      />
                    ) : null
                  ) : (
                    <span className="truncate font-medium">
                      {selectedMergeBaseBranch ?? "unknown"}
                    </span>
                  )}
                </DetailRow>
              ) : null}
              {canShowMergeBaseDetails && (!isUpToDate || hasMergeBaseDelta || Boolean(selectedMergeBaseBranch)) ? (
                <DetailRow label="Merge base status">
                  <span className="font-medium">{mergeDeltaSummary}</span>
                </DetailRow>
              ) : null}
              {(!isUpToDate || hasWorkspaceDelta) ? (
                <DetailRow label="Changes">
                  <span className="font-medium">
                    <span className="text-foreground">
                      {formatWorkspaceChangedFilesLabel(status?.workspaceChangedFiles ?? 0)}
                    </span>
                    {hasWorkspaceLineDelta ? (
                      <>
                        <span className="text-foreground">, </span>
                        <span className="text-emerald-600 dark:text-emerald-400">
                          +{status?.workspaceInsertions ?? 0}
                        </span>{" "}
                        <span className="text-rose-600 dark:text-rose-400">
                          -{status?.workspaceDeletions ?? 0}
                        </span>
                      </>
                    ) : null}
                  </span>
                </DetailRow>
              ) : null}
              {canCommit ? (
                <>
                  <DetailRow label="Include unstaged">
                    <label className="inline-flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={includeUnstaged}
                        onChange={(event) => setIncludeUnstaged(event.target.checked)}
                      />
                    </label>
                  </DetailRow>
                  <div className="px-1 pb-1">
                    <div className="rounded-md border border-border/70 bg-muted/40 px-2 py-1.5 text-xs text-muted-foreground">
                      Include all unstaged edits in this commit. Turn off to commit only currently
                      staged changes.
                    </div>
                  </div>
                </>
              ) : null}
            </DetailCard>
          ) : null}

          {canShowChangedFiles ? (
            <div className="space-y-1.5">
              <span className="text-xs text-muted-foreground">Changed files</span>
              <WorkspaceChangesList
                files={status?.files}
                workspaceRoot={status?.workspaceRoot}
                maxHeightClassName="max-h-36"
                emptyMessage="No changed files in the current workspace."
              />
            </div>
          ) : null}

          {canCommit ? (
            <>
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">Commit message</label>
                <Textarea
                  rows={3}
                  value={commitMessage}
                  onChange={(event) => setCommitMessage(event.target.value)}
                  placeholder="Leave blank to autogenerate a commit message"
                />
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  type="button"
                  disabled={!canCommit || isCommitting || Boolean(isSquashMerging)}
                  onClick={async () => {
                    setOpen(false);
                    const nextCommitMessage = commitMessage.trim() || undefined;
                    setCommitMessage("");
                    await onCommit({
                      includeUnstaged,
                      message: nextCommitMessage,
                    });
                  }}
                >
                  {isCommitting ? "Committing..." : "Commit changes"}
                </Button>
                {canSquashMerge && onSquashMerge ? (
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={isCommitting || Boolean(isSquashMerging)}
                    onClick={async () => {
                      setOpen(false);
                      const nextCommitMessage = commitMessage.trim() || undefined;
                      setCommitMessage("");
                      await onSquashMerge({
                        commitIfNeeded: true,
                        includeUnstaged,
                        commitMessage: nextCommitMessage,
                        mergeBaseBranch: selectedMergeBaseBranch,
                      });
                    }}
                  >
                    {isSquashMerging ? "Squashing..." : "Commit + squash merge"}
                  </Button>
                ) : null}
              </div>
            </>
          ) : null}
          {!canCommit && canSquashMerge && onSquashMerge ? (
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                disabled={Boolean(isSquashMerging)}
                onClick={async () => {
                  setOpen(false);
                  await onSquashMerge({
                    commitIfNeeded: false,
                    includeUnstaged,
                    mergeBaseBranch: selectedMergeBaseBranch,
                  });
                }}
              >
                {isSquashMerging ? "Squashing..." : "Squash merge"}
              </Button>
            </div>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
