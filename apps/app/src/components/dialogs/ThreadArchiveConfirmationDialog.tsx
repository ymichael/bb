import type { Thread } from "@bb/domain";
import { Button } from "@/components/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui";

export interface ThreadArchiveConfirmationDialogTarget {
  managerChildThreadsConfirmed: boolean;
  thread: Thread;
}

interface ThreadArchiveConfirmationDialogProps {
  target: ThreadArchiveConfirmationDialogTarget | null;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onArchive: (target: ThreadArchiveConfirmationDialogTarget) => void;
}

export function ThreadArchiveConfirmationDialog({
  target,
  pending,
  onOpenChange,
  onArchive,
}: ThreadArchiveConfirmationDialogProps) {
  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        {target ? (
          <ThreadArchiveConfirmationDialogContent
            target={target}
            pending={pending}
            onArchive={onArchive}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export interface ThreadArchiveConfirmationDialogContentProps {
  target: ThreadArchiveConfirmationDialogTarget;
  pending: boolean;
  onArchive: (target: ThreadArchiveConfirmationDialogTarget) => void;
}

export function ThreadArchiveConfirmationDialogContent({
  target,
  pending,
  onArchive,
}: ThreadArchiveConfirmationDialogContentProps) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Archive and clean up workspace?</DialogTitle>
        <DialogDescription>
          This thread has uncommitted or unmerged work in its workspace.
          Archiving will remove the workspace and changes may be lost.
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button
          type="button"
          variant="destructive"
          disabled={pending}
          onClick={() => onArchive(target)}
        >
          Archive anyway
        </Button>
      </DialogFooter>
    </>
  );
}
