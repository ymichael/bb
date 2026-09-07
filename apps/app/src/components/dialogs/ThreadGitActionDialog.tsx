import type { FormEvent } from "react";
import {
  DetailCard,
  DetailRow,
  DetailRowIconLabel,
} from "@/components/ui/detail-card.js";
import type { ThreadGitStatusDisplay } from "@/components/workspace/workspace-status";
import { ChangedFilesDetailRow } from "@/components/workspace/ChangedFilesDetailRow";
import type { WorkspaceChangedFilesSection } from "@/components/workspace/workspace-change-summary";
import { Button } from "@bb/shared-ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@bb/shared-ui/dialog";

export type ThreadGitActionDialogTarget = { kind: "commit" };

interface ThreadGitActionDialogProps {
  target: ThreadGitActionDialogTarget | null;
  branchName?: string;
  gitStatusDisplay?: ThreadGitStatusDisplay;
  changedFilesSection?: WorkspaceChangedFilesSection | null;
  onOpenChange: (open: boolean) => void;
  onCommit: () => Promise<void>;
}

export function ThreadGitActionDialog({
  target,
  branchName,
  gitStatusDisplay,
  changedFilesSection,
  onOpenChange,
  onCommit,
}: ThreadGitActionDialogProps) {
  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[34rem] gap-0 overflow-hidden border-border bg-background p-0 shadow-sm">
        {target ? (
          <ThreadGitActionDialogContent
            key={target.kind}
            branchName={branchName}
            gitStatusDisplay={gitStatusDisplay}
            changedFilesSection={changedFilesSection}
            onOpenChange={onOpenChange}
            onCommit={onCommit}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

type ThreadGitActionDialogContentProps = Omit<
  ThreadGitActionDialogProps,
  "target"
>;

export function ThreadGitActionDialogContent({
  branchName,
  gitStatusDisplay,
  changedFilesSection,
  onOpenChange,
  onCommit,
}: ThreadGitActionDialogContentProps) {
  const shouldShowChangedFilesRow = Boolean(
    changedFilesSection && changedFilesSection.files.length > 0,
  );

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onOpenChange(false);
    void onCommit();
  };

  return (
    <>
      <DialogHeader className="px-6 pt-5 pb-3">
        <DialogTitle>Commit changes</DialogTitle>
        <DialogDescription>
          Create a commit from the current workspace changes.
        </DialogDescription>
      </DialogHeader>
      <form className="space-y-4 px-6 pt-1 pb-5" onSubmit={handleSubmit}>
        {branchName || gitStatusDisplay || shouldShowChangedFilesRow ? (
          <DetailCard appearance="flat">
            {branchName ? (
              <DetailRow
                label={
                  <DetailRowIconLabel icon="GitBranch">
                    Branch
                  </DetailRowIconLabel>
                }
                valueClassName="min-w-0 truncate"
              >
                <span className="block truncate" title={branchName}>
                  {branchName}
                </span>
              </DetailRow>
            ) : null}
            {gitStatusDisplay ? (
              <DetailRow
                label={
                  <DetailRowIconLabel icon="FileDiff">
                    Git status
                  </DetailRowIconLabel>
                }
                valueClassName="min-w-0"
              >
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
            {shouldShowChangedFilesRow && changedFilesSection ? (
              <ChangedFilesDetailRow
                sections={[changedFilesSection]}
                rowClassName="mt-3"
                rowValueClassName="pt-0.5"
                listClassName="max-h-40"
              />
            ) : null}
          </DetailCard>
        ) : null}
        <DialogFooter className="flex-row flex-wrap items-center justify-end gap-x-2 gap-y-1 sm:space-x-0">
          <Button type="submit" size="sm" className="shrink-0">
            Commit changes
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
