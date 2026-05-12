import { useMemo, useState, type FormEvent } from "react";
import { assertNever } from "@bb/core-ui";
import type { ThreadType, WorkspaceStatus } from "@bb/domain";
import { DetailCard, DetailRow } from "@/components/ui";
import type { ThreadGitStatusDisplay } from "@/components/workspace/workspace-status";
import { WorkspaceChangesList } from "@/components/thread/WorkspaceChangesList";
import { FormError } from "@/components/ui";
import { Button } from "@/components/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui";
import {
  getMergeBaseBranchCandidates,
  BranchPicker,
} from "@/components/pickers/BranchPicker";

export type ThreadGitActionDialogTarget =
  | { kind: "commit" }
  | { kind: "commit_and_squash_merge" }
  | { kind: "squash_merge" };

interface ThreadGitActionDialogProps {
  target: ThreadGitActionDialogTarget | null;
  branchName?: string;
  gitStatusDisplay?: ThreadGitStatusDisplay;
  changedFiles?: WorkspaceStatus["workingTree"]["files"];
  threadId?: string;
  threadType?: ThreadType;
  showMergeBaseDetails?: boolean;
  mergeBaseBranch?: string;
  mergeBaseBranchOptions?: string[];
  mergeBaseBranchOptionsLoading?: boolean;
  onMergeBaseBranchChange?: (branch: string) => void;
  onOpenChange: (open: boolean) => void;
  onCommit: () => Promise<void>;
  onSquashMerge: (args: { mergeBaseBranch: string }) => Promise<void>;
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
        description:
          "Commit the current workspace changes, then squash merge this branch.",
        submitLabel: "Commit + squash merge",
        showCommitControls: true,
        showMergeBase: true,
      };
    case "squash_merge":
      return {
        title: "Squash merge",
        description: "Squash merge this branch into the selected merge base.",
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
  branchName,
  gitStatusDisplay,
  changedFiles,
  threadId,
  threadType,
  showMergeBaseDetails = false,
  mergeBaseBranch,
  mergeBaseBranchOptions,
  mergeBaseBranchOptionsLoading = false,
  onMergeBaseBranchChange,
  onOpenChange,
  onCommit,
  onSquashMerge,
}: ThreadGitActionDialogProps) {
  const dialogCopy = useMemo(
    () => (target ? getDialogCopy(target) : null),
    [target],
  );

  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[34rem] gap-0 overflow-hidden border-border/80 bg-background p-0 shadow-xl">
        {target && dialogCopy ? (
          <ThreadGitActionDialogContent
            key={target.kind}
            target={target}
            branchName={branchName}
            gitStatusDisplay={gitStatusDisplay}
            changedFiles={changedFiles}
            threadId={threadId}
            threadType={threadType}
            showMergeBaseDetails={showMergeBaseDetails}
            mergeBaseBranch={mergeBaseBranch}
            mergeBaseBranchOptions={mergeBaseBranchOptions}
            mergeBaseBranchOptionsLoading={mergeBaseBranchOptionsLoading}
            onMergeBaseBranchChange={onMergeBaseBranchChange}
            onOpenChange={onOpenChange}
            onCommit={onCommit}
            onSquashMerge={onSquashMerge}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export type ThreadGitActionDialogContentProps = Omit<
  ThreadGitActionDialogProps,
  "target"
> & {
  target: ThreadGitActionDialogTarget;
};

export function ThreadGitActionDialogContent({
  target,
  branchName,
  gitStatusDisplay,
  changedFiles,
  threadId,
  threadType,
  showMergeBaseDetails,
  mergeBaseBranch,
  mergeBaseBranchOptions,
  mergeBaseBranchOptionsLoading,
  onMergeBaseBranchChange,
  onOpenChange,
  onCommit,
  onSquashMerge,
}: ThreadGitActionDialogContentProps) {
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const dialogCopy = getDialogCopy(target);
  const mergeBaseCandidates = getMergeBaseBranchCandidates({
    mergeBaseBranch,
    mergeBaseBranchOptions,
  });
  const selectedMergeBaseBranch = mergeBaseBranch ?? mergeBaseCandidates[0];
  const canSelectMergeBase =
    dialogCopy.showMergeBase &&
    showMergeBaseDetails === true &&
    Boolean(onMergeBaseBranchChange) &&
    mergeBaseCandidates.length > 0;
  const canShowMergeBase =
    dialogCopy.showMergeBase &&
    showMergeBaseDetails === true &&
    (canSelectMergeBase || Boolean(selectedMergeBaseBranch));
  const shouldShowChangedFilesRow = Boolean(
    changedFiles && changedFiles.length > 0,
  );

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrorMessage(null);

    switch (target.kind) {
      case "commit":
        onOpenChange(false);
        void onCommit();
        break;
      case "commit_and_squash_merge":
        if (!selectedMergeBaseBranch) {
          setErrorMessage("A merge base branch is required");
          return;
        }
        onOpenChange(false);
        void onSquashMerge({
          mergeBaseBranch: selectedMergeBaseBranch,
        });
        break;
      case "squash_merge":
        if (!selectedMergeBaseBranch) {
          setErrorMessage("A merge base branch is required");
          return;
        }
        onOpenChange(false);
        void onSquashMerge({
          mergeBaseBranch: selectedMergeBaseBranch,
        });
        break;
      default:
        assertNever(target);
    }
  };

  return (
    <>
      <DialogHeader className="px-6 pt-5 pb-3">
        <DialogTitle>{dialogCopy.title}</DialogTitle>
        <DialogDescription>{dialogCopy.description}</DialogDescription>
      </DialogHeader>
      <form className="space-y-5 px-6 pt-3 pb-5" onSubmit={handleSubmit}>
        {branchName ||
        gitStatusDisplay ||
        canShowMergeBase ||
        shouldShowChangedFilesRow ? (
          <DetailCard className="border-border/70 bg-muted/20">
            {branchName ? (
              <DetailRow label="Branch" valueClassName="min-w-0 truncate">
                <span className="block truncate" title={branchName}>
                  {branchName}
                </span>
              </DetailRow>
            ) : null}
            {gitStatusDisplay ? (
              <DetailRow label="Git status" valueClassName="min-w-0">
                <div
                  className="flex min-w-0 items-baseline gap-2 whitespace-nowrap"
                  title={`${gitStatusDisplay.label} ${gitStatusDisplay.summary}`.trim()}
                >
                  <span className="shrink-0 font-medium">
                    {gitStatusDisplay.label}
                  </span>
                  <span className="min-w-0 truncate text-muted-foreground">
                    {gitStatusDisplay.summaryContent}
                  </span>
                </div>
              </DetailRow>
            ) : null}
            {canShowMergeBase && selectedMergeBaseBranch ? (
              <DetailRow label="Merge base" valueClassName="min-w-0">
                {canSelectMergeBase ? (
                  <BranchPicker
                    value={selectedMergeBaseBranch}
                    options={mergeBaseCandidates}
                    loading={mergeBaseBranchOptionsLoading}
                    onChange={(branch) => onMergeBaseBranchChange?.(branch)}
                    className="max-w-full"
                  />
                ) : (
                  <span
                    className="block truncate"
                    title={selectedMergeBaseBranch}
                  >
                    {selectedMergeBaseBranch}
                  </span>
                )}
              </DetailRow>
            ) : null}
            {shouldShowChangedFilesRow ? (
              <DetailRow
                label="Changed files"
                orientation="vertical"
                valueClassName="pt-0.5"
              >
                <WorkspaceChangesList
                  files={changedFiles ?? []}
                  maxHeightClassName="max-h-40"
                />
              </DetailRow>
            ) : null}
          </DetailCard>
        ) : null}
        <FormError message={errorMessage} />
        <DialogFooter>
          <Button
            type="submit"
            disabled={dialogCopy.showMergeBase && !selectedMergeBaseBranch}
          >
            {dialogCopy.submitLabel}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
