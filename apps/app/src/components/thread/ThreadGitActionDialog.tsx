import { useMemo, useState, type FormEvent } from "react";
import { assertNever, type PromptInput, type ThreadType, type ThreadWorkStatus } from "@bb/core";
import { DetailCard, DetailRow } from "@bb/ui-core";
import { WorkspaceChangesList } from "@/components/shared/WorkspaceChangesList";
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
import {
  getMergeBaseBranchCandidates,
  MergeBaseBranchPicker,
} from "@/components/thread/MergeBaseBranchPicker";
import { threadTypeLabel } from "@/lib/thread-title";

export type ThreadGitActionDialogTarget =
  | { kind: "commit" }
  | { kind: "commit_and_squash_merge" }
  | { kind: "squash_merge" };

export class ThreadGitActionDialogError extends Error {
  readonly askAgentInput?: PromptInput[];

  constructor(message: string, options?: { askAgentInput?: PromptInput[] }) {
    super(message);
    this.name = "ThreadGitActionDialogError";
    this.askAgentInput = options?.askAgentInput;
  }
}

interface ThreadGitActionDialogProps {
  target: ThreadGitActionDialogTarget | null;
  pending?: boolean;
  askAgentPending?: boolean;
  branchName?: string;
  gitStatusLabel?: string;
  gitStatusSummary?: string;
  changedFiles?: ThreadWorkStatus["files"];
  threadId?: string;
  threadType?: ThreadType;
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
  onAskAgentToFix?: (input: PromptInput[]) => Promise<void>;
}

function getDialogCopy(target: ThreadGitActionDialogTarget, label: string) {
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
        description: `Commit the current workspace changes, then squash merge this ${label} branch.`,
        submitLabel: "Commit + squash merge",
        showCommitControls: true,
        showMergeBase: true,
      };
    case "squash_merge":
      return {
        title: "Squash merge",
        description: `Squash merge this ${label} branch into the selected merge base.`,
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
  askAgentPending = false,
  branchName,
  gitStatusLabel,
  gitStatusSummary,
  changedFiles,
  threadId,
  threadType,
  showMergeBaseDetails = false,
  mergeBaseBranch,
  mergeBaseBranchOptions,
  mergeBaseBranchOptionsLoading = false,
  onMergeBaseBranchChange,
  onMergeBaseBranchPickerOpenChange,
  onOpenChange,
  onCommit,
  onSquashMerge,
  onAskAgentToFix,
}: ThreadGitActionDialogProps) {
  const label = threadTypeLabel(threadType ?? "standard");
  const dialogCopy = useMemo(() => (target ? getDialogCopy(target, label) : null), [target, label]);

  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[34rem] gap-0 overflow-hidden border-border/80 bg-background p-0 shadow-xl">
        {target && dialogCopy ? (
          <ThreadGitActionDialogContent
            key={target.kind}
            target={target}
            pending={pending}
            askAgentPending={askAgentPending}
            branchName={branchName}
            gitStatusLabel={gitStatusLabel}
            gitStatusSummary={gitStatusSummary}
            changedFiles={changedFiles}
            threadId={threadId}
            threadType={threadType}
            showMergeBaseDetails={showMergeBaseDetails}
            mergeBaseBranch={mergeBaseBranch}
            mergeBaseBranchOptions={mergeBaseBranchOptions}
            mergeBaseBranchOptionsLoading={mergeBaseBranchOptionsLoading}
            onMergeBaseBranchChange={onMergeBaseBranchChange}
            onMergeBaseBranchPickerOpenChange={onMergeBaseBranchPickerOpenChange}
            onOpenChange={onOpenChange}
            onCommit={onCommit}
            onSquashMerge={onSquashMerge}
            onAskAgentToFix={onAskAgentToFix}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ThreadGitActionDialogContent({
  target,
  pending,
  askAgentPending,
  branchName,
  gitStatusLabel,
  gitStatusSummary,
  changedFiles,
  threadId,
  threadType,
  showMergeBaseDetails,
  mergeBaseBranch,
  mergeBaseBranchOptions,
  mergeBaseBranchOptionsLoading,
  onMergeBaseBranchChange,
  onMergeBaseBranchPickerOpenChange,
  onOpenChange,
  onCommit,
  onSquashMerge,
  onAskAgentToFix,
}: Omit<ThreadGitActionDialogProps, "target"> & {
  target: ThreadGitActionDialogTarget;
}) {
  const [includeUnstaged, setIncludeUnstaged] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [askAgentInput, setAskAgentInput] = useState<PromptInput[] | null>(null);
  const label = threadTypeLabel(threadType ?? "standard");
  const dialogCopy = getDialogCopy(target, label);
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
  const isStagedOnlyCommitScope = dialogCopy.showCommitControls && !includeUnstaged;
  const displayedGitStatusLabel = isStagedOnlyCommitScope ? "Staged only" : gitStatusLabel;
  const displayedGitStatusSummary = isStagedOnlyCommitScope
    ? "Only staged changes will be included. Unstaged edits stay in the workspace."
    : gitStatusSummary;
  const shouldShowChangedFilesRow =
    Boolean(changedFiles && changedFiles.length > 0) || isStagedOnlyCommitScope;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) {
      return;
    }
    setErrorMessage(null);
    setAskAgentInput(null);

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
            mergeBaseBranch: selectedMergeBaseBranch,
          });
          break;
        case "squash_merge":
          await onSquashMerge({
            commitIfNeeded: false,
            includeUnstaged: false,
            mergeBaseBranch: selectedMergeBaseBranch,
          });
          break;
        default:
          assertNever(target);
      }
      onOpenChange(false);
    } catch (error) {
      setAskAgentInput(
        error instanceof ThreadGitActionDialogError && error.askAgentInput
          ? error.askAgentInput
          : null,
      );
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to start git action",
      );
    }
  };

  const handleAskAgentToFix = async () => {
    if (!askAgentInput || !onAskAgentToFix || askAgentPending) {
      return;
    }
    await onAskAgentToFix(askAgentInput);
    setErrorMessage(null);
    setAskAgentInput(null);
    onOpenChange(false);
  };

  return (
    <>
      <DialogHeader className="px-6 pt-5 pb-3">
        <DialogTitle>{dialogCopy.title}</DialogTitle>
        <DialogDescription>{dialogCopy.description}</DialogDescription>
      </DialogHeader>
      <form className="space-y-5 px-6 pt-3 pb-5" onSubmit={handleSubmit}>
        {branchName || displayedGitStatusLabel || canShowMergeBase || shouldShowChangedFilesRow ? (
          <DetailCard className="border-border/70 bg-muted/20">
            {branchName ? (
              <DetailRow label="Branch" valueClassName="min-w-0 truncate">
                <span className="block truncate" title={branchName}>
                  {branchName}
                </span>
              </DetailRow>
            ) : null}
            {displayedGitStatusLabel ? (
              <DetailRow label="Git status" valueClassName="min-w-0">
                <div
                  className="flex min-w-0 items-baseline gap-2 whitespace-nowrap"
                  title={[displayedGitStatusLabel, displayedGitStatusSummary].filter(Boolean).join(" ")}
                >
                  <span className="shrink-0 font-medium">{displayedGitStatusLabel}</span>
                  {displayedGitStatusSummary ? (
                    <span className="min-w-0 truncate text-muted-foreground">
                      {displayedGitStatusSummary}
                    </span>
                  ) : null}
                </div>
              </DetailRow>
            ) : null}
            {canShowMergeBase && selectedMergeBaseBranch ? (
              <DetailRow label="Merge base" valueClassName="min-w-0">
                {canSelectMergeBase ? (
                  <MergeBaseBranchPicker
                    value={selectedMergeBaseBranch}
                    options={mergeBaseCandidates}
                    loading={mergeBaseBranchOptionsLoading}
                    disabled={pending}
                    onChange={(branch) => onMergeBaseBranchChange?.(branch)}
                    onOpenChange={onMergeBaseBranchPickerOpenChange}
                    className="max-w-full"
                  />
                ) : (
                  <span className="block truncate" title={selectedMergeBaseBranch}>
                    {selectedMergeBaseBranch}
                  </span>
                )}
              </DetailRow>
            ) : null}
            {dialogCopy.showCommitControls ? (
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
            ) : null}
            {shouldShowChangedFilesRow ? (
              <DetailRow
                label="Changed files"
                layout="vertical"
                valueClassName="pt-0.5"
              >
                {isStagedOnlyCommitScope ? (
                  <p className="ui-text-sm leading-5 text-muted-foreground">
                    Only staged changes will be committed. Per-file staged preview is not available here.
                  </p>
                ) : (
                  <WorkspaceChangesList
                    files={changedFiles}
                    threadId={threadId}
                    maxHeightClassName="max-h-40"
                  />
                )}
              </DetailRow>
            ) : null}
          </DetailCard>
        ) : null}
        {errorMessage ? (
          <p className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {errorMessage}
          </p>
        ) : null}
        <DialogFooter className="px-0 pt-4 sm:justify-between">
          {askAgentInput && onAskAgentToFix ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => void handleAskAgentToFix()}
              disabled={pending || askAgentPending}
            >
              {askAgentPending ? "Asking agent..." : "Ask the agent to fix"}
            </Button>
          ) : (
            <span />
          )}
          <Button type="submit" disabled={pending}>
            {pending ? "Starting..." : dialogCopy.submitLabel}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
