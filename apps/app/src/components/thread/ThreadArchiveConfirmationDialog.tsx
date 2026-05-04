import type { Thread } from "@bb/domain";
import { Button } from "@bb/ui-core";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@bb/ui-core";

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
            disabled={!target || pending}
            onClick={() => {
              if (!target) return;
              onArchive(target);
            }}
          >
            Archive anyway
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
