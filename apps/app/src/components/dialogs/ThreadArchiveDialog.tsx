import type { Thread } from "@bb/domain";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { threadTypeLabel } from "@/lib/thread-title";

export interface ThreadDirtyWorkspaceWarning {
  hasUncommittedChanges: boolean;
  hasCommittedUnmergedChanges: boolean;
}

export interface ThreadArchiveDialogTarget {
  thread: Thread;
  /** Present iff manager thread with one or more assigned children. */
  assignedChildCount?: number;
  /** Present iff the workspace is managed and has uncommitted/unmerged work. */
  workspaceWarning?: ThreadDirtyWorkspaceWarning;
}

interface ThreadArchiveDialogProps {
  target: ThreadArchiveDialogTarget | null;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onArchive: (target: ThreadArchiveDialogTarget) => void;
}

export function ThreadArchiveDialog({
  target,
  pending,
  onOpenChange,
  onArchive,
}: ThreadArchiveDialogProps) {
  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        {target ? (
          <ThreadArchiveDialogContent
            target={target}
            pending={pending}
            onOpenChange={onOpenChange}
            onArchive={onArchive}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export interface ThreadArchiveDialogContentProps {
  target: ThreadArchiveDialogTarget;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onArchive: (target: ThreadArchiveDialogTarget) => void;
}

export function ThreadArchiveDialogContent({
  target,
  pending,
  onOpenChange,
  onArchive,
}: ThreadArchiveDialogContentProps) {
  const label = threadTypeLabel(target.thread.type);
  const title = target.workspaceWarning
    ? `Archive ${label} with uncommitted changes?`
    : `Archive ${label}?`;

  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          {[
            target.assignedChildCount
              ? "Assigned threads will be unassigned."
              : null,
            target.workspaceWarning
              ? formatWorkspaceWarningSentence(target.workspaceWarning)
              : null,
          ]
            .filter((part): part is string => part !== null)
            .join(" ")}
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() => onOpenChange(false)}
        >
          Cancel
        </Button>
        <Button
          type="button"
          variant="destructive"
          disabled={pending}
          onClick={() => onArchive(target)}
        >
          {target.workspaceWarning ? "Archive anyway" : `Archive ${label}`}
        </Button>
      </DialogFooter>
    </>
  );
}

function formatWorkspaceWarningSentence(
  warning: ThreadDirtyWorkspaceWarning,
): string {
  if (
    warning.hasUncommittedChanges &&
    warning.hasCommittedUnmergedChanges
  ) {
    return "Its workspace has uncommitted changes and unmerged commits that will be removed.";
  }
  if (warning.hasUncommittedChanges) {
    return "Its workspace has uncommitted changes that will be removed.";
  }
  return "Its workspace has unmerged commits that will be removed.";
}
