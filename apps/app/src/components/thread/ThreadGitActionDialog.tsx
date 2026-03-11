import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import { assertNever, type ThreadWorkStatus } from "@beanbag/agent-core";
import { DetailRow } from "@beanbag/ui-core";
import { ThreadGitStatusDetails } from "@/components/shared/ThreadGitStatusDetails";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";

export type ThreadGitActionDialogTarget =
  | { kind: "commit" }
  | { kind: "commit_and_squash_merge" }
  | { kind: "squash_merge" };

interface ThreadGitActionDialogProps {
  target: ThreadGitActionDialogTarget | null;
  pending?: boolean;
  branchName?: string;
  defaultBranch?: string;
  gitStatusLabel?: string;
  gitStatusSummary?: string;
  changedFiles?: ThreadWorkStatus["files"];
  threadId?: string;
  showMergeBaseDetails?: boolean;
  mergeBaseBranch?: string;
  mergeBaseBranchOptions?: string[];
  mergeBaseBranchOptionsLoading?: boolean;
  onMergeBaseBranchChange?: (branch: string) => void;
  onMergeBaseBranchPickerOpenChange?: (open: boolean) => void;
  onOpenChange: (open: boolean) => void;
  onCommit: (args: { includeUnstaged: boolean }) => Promise<void>;
  onSquashMerge: (args: {
    commitIfNeeded: boolean;
    includeUnstaged: boolean;
    mergeBaseBranch?: string;
  }) => Promise<void>;
}

function getDialogCopy(target: ThreadGitActionDialogTarget) {
  switch (target.kind) {
    case "commit":
      return {
        title: "Commit changes",
        description: "Create a commit from the current workspace changes.",
        submitLabel: "Commit changes",
        showCommitControls: true,
        showMergeBase: false,
      };
    case "commit_and_squash_merge":
      return {
        title: "Commit and squash merge",
        description: "Commit the current workspace changes, then squash merge this thread branch.",
        submitLabel: "Commit + squash merge",
        showCommitControls: true,
        showMergeBase: true,
      };
    case "squash_merge":
      return {
        title: "Squash merge",
        description: "Squash merge this thread branch into the selected merge base.",
        submitLabel: "Squash merge",
        showCommitControls: false,
        showMergeBase: true,
      };
    default:
      return assertNever(target);
  }
}

export function ThreadGitActionDialog({
  target,
  pending = false,
  branchName,
  defaultBranch,
  gitStatusLabel,
  gitStatusSummary,
  changedFiles,
  threadId,
  showMergeBaseDetails = false,
  mergeBaseBranch,
  mergeBaseBranchOptions,
  mergeBaseBranchOptionsLoading = false,
  onMergeBaseBranchChange,
  onMergeBaseBranchPickerOpenChange,
  onOpenChange,
  onCommit,
  onSquashMerge,
}: ThreadGitActionDialogProps) {
  const [includeUnstaged, setIncludeUnstaged] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!target) {
      setIncludeUnstaged(true);
      setErrorMessage(null);
      return;
    }

    setIncludeUnstaged(true);
    setErrorMessage(null);
  }, [target]);

  const dialogCopy = useMemo(
    () => (target ? getDialogCopy(target) : null),
    [target],
  );
  const isStagedOnlyCommitScope =
    Boolean(dialogCopy?.showCommitControls) && !includeUnstaged;
  const displayedGitStatusLabel = isStagedOnlyCommitScope ? "Staged only" : gitStatusLabel;
  const displayedGitStatusSummary = isStagedOnlyCommitScope
    ? "Only staged changes will be included. Unstaged edits stay in the workspace."
    : gitStatusSummary;
  const shouldShowChangedFilesRow =
    Boolean(changedFiles && changedFiles.length > 0) || isStagedOnlyCommitScope;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!target || pending) {
      return;
    }
    setErrorMessage(null);

    try {
      switch (target.kind) {
        case "commit":
          await onCommit({
            includeUnstaged,
          });
          break;
        case "commit_and_squash_merge":
          await onSquashMerge({
            commitIfNeeded: true,
            includeUnstaged,
            mergeBaseBranch,
          });
          break;
        case "squash_merge":
          await onSquashMerge({
            commitIfNeeded: false,
            includeUnstaged: false,
            mergeBaseBranch,
          });
          break;
        default:
          assertNever(target);
      }
      onOpenChange(false);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to start git action",
      );
    }
  };

  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[34rem] gap-0 overflow-hidden border-border/80 bg-background p-0 shadow-xl">
        {target && dialogCopy ? (
          <>
            <DialogHeader className="px-6 pt-5 pb-3">
              <DialogTitle>{dialogCopy.title}</DialogTitle>
              <DialogDescription>{dialogCopy.description}</DialogDescription>
            </DialogHeader>
            <form className="space-y-5 px-6 pt-3 pb-5" onSubmit={handleSubmit}>
              {branchName || displayedGitStatusLabel || shouldShowChangedFilesRow ? (
                <ThreadGitStatusDetails
                  statusLabel={displayedGitStatusLabel}
                  statusSummary={displayedGitStatusSummary}
                  currentBranch={branchName}
                  defaultBranch={defaultBranch}
                  mergeBaseBranch={
                    dialogCopy.showMergeBase && showMergeBaseDetails
                      ? mergeBaseBranch
                      : undefined
                  }
                  mergeBaseBranchOptions={mergeBaseBranchOptions}
                  mergeBaseBranchOptionsLoading={mergeBaseBranchOptionsLoading}
                  onMergeBaseBranchChange={
                    dialogCopy.showMergeBase && showMergeBaseDetails
                      ? onMergeBaseBranchChange
                      : undefined
                  }
                  onMergeBaseBranchPickerOpenChange={
                    dialogCopy.showMergeBase && showMergeBaseDetails
                      ? onMergeBaseBranchPickerOpenChange
                      : undefined
                  }
                  pending={pending}
                  branchContent={
                    branchName ? (
                      <span className="block truncate" title={branchName}>
                        {branchName}
                      </span>
                    ) : undefined
                  }
                  changedFiles={isStagedOnlyCommitScope ? undefined : changedFiles}
                  changedFilesContent={
                    isStagedOnlyCommitScope ? (
                      <p className="ui-text-sm leading-5 text-muted-foreground">
                        Only staged changes will be committed. Per-file staged preview is not available here.
                      </p>
                    ) : undefined
                  }
                  threadId={threadId}
                  extraRows={
                    dialogCopy.showCommitControls ? (
                      <DetailRow label="Include unstaged" valueClassName="min-w-0">
                        <div className="flex min-w-0 items-center gap-3">
                          <Switch
                            checked={includeUnstaged}
                            disabled={pending}
                            aria-label="Include unstaged changes"
                            onCheckedChange={setIncludeUnstaged}
                            className="h-4 w-7 [&>span]:size-3 [&>span[data-state=checked]]:translate-x-3"
                          />
                          <span className="min-w-0 truncate text-muted-foreground">
                            {includeUnstaged ? "All workspace changes" : "Only staged changes"}
                          </span>
                        </div>
                      </DetailRow>
                    ) : undefined
                  }
                />
              ) : null}
              {errorMessage ? (
                <p className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                  {errorMessage}
                </p>
              ) : null}
              <DialogFooter className="px-0 pt-4 sm:justify-end">
                <Button type="submit" disabled={pending}>
                  {pending ? "Starting..." : dialogCopy.submitLabel}
                </Button>
              </DialogFooter>
            </form>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
