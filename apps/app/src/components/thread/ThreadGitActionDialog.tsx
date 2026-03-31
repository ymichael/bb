import { useMemo, useState, type FormEvent } from "react";
import { assertNever } from "@bb/core-ui";
import type { PromptInput, ThreadType, WorkspaceStatus } from "@bb/domain";
import { DetailCard, DetailRow } from "@bb/ui-core";
import { WorkspaceChangesList } from "@/components/shared/WorkspaceChangesList";
import { FormError } from "@/components/shared/FormError";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  changedFiles?: WorkspaceStatus["workingTree"]["files"];
  threadId?: string;
  threadType?: ThreadType;
  showMergeBaseDetails?: boolean;
  mergeBaseBranch?: string;
  mergeBaseBranchOptions?: string[];
  mergeBaseBranchOptionsLoading?: boolean;
  onMergeBaseBranchChange?: (branch: string) => void;
  onMergeBaseBranchPickerOpenChange?: (open: boolean) => void;
  onOpenChange: (open: boolean) => void;
  onCommit: () => Promise<void>;
  onSquashMerge: (args: { mergeBaseBranch: string }) => Promise<void>;
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
  const shouldShowChangedFilesRow = Boolean(changedFiles && changedFiles.length > 0);

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
          await onCommit();
          break;
        case "commit_and_squash_merge":
          if (!selectedMergeBaseBranch) {
            setErrorMessage("A merge base branch is required");
            return;
          }
          await onSquashMerge({
            mergeBaseBranch: selectedMergeBaseBranch,
          });
          break;
        case "squash_merge":
          if (!selectedMergeBaseBranch) {
            setErrorMessage("A merge base branch is required");
            return;
          }
          await onSquashMerge({
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
        {branchName || gitStatusLabel || canShowMergeBase || shouldShowChangedFilesRow ? (
          <DetailCard className="border-border/70 bg-muted/20">
            {branchName ? (
              <DetailRow label="Branch" valueClassName="min-w-0 truncate">
                <span className="block truncate" title={branchName}>
                  {branchName}
                </span>
              </DetailRow>
            ) : null}
            {gitStatusLabel ? (
              <DetailRow label="Git status" valueClassName="min-w-0">
                <div
                  className="flex min-w-0 items-baseline gap-2 whitespace-nowrap"
                  title={[gitStatusLabel, gitStatusSummary].filter(Boolean).join(" ")}
                >
                  <span className="shrink-0 font-medium">{gitStatusLabel}</span>
                  {gitStatusSummary ? (
                    <span className="min-w-0 truncate text-muted-foreground">
                      {gitStatusSummary}
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
            {shouldShowChangedFilesRow ? (
              <DetailRow
                label="Changed files"
                layout="vertical"
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
          <Button
            type="submit"
            disabled={pending || (dialogCopy.showMergeBase && !selectedMergeBaseBranch)}
          >
            {pending ? "Starting..." : dialogCopy.submitLabel}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
