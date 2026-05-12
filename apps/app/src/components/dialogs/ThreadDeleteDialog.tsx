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
import { threadTypeLabel } from "@/lib/thread-title";

interface ThreadDeleteDialogProps {
  target: Thread | null;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onDelete: (thread: Thread) => void;
}

export function ThreadDeleteDialog({
  target,
  pending,
  onOpenChange,
  onDelete,
}: ThreadDeleteDialogProps) {
  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        {target ? (
          <ThreadDeleteDialogContent
            target={target}
            pending={pending}
            onDelete={onDelete}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export interface ThreadDeleteDialogContentProps {
  target: Thread;
  pending: boolean;
  onDelete: (thread: Thread) => void;
}

export function ThreadDeleteDialogContent({
  target,
  pending,
  onDelete,
}: ThreadDeleteDialogContentProps) {
  const label = threadTypeLabel(target.type);

  return (
    <>
      <DialogHeader>
        <DialogTitle>Delete {label}?</DialogTitle>
        <DialogDescription>This action cannot be undone.</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button
          type="button"
          variant="destructive"
          disabled={pending}
          onClick={() => onDelete(target)}
        >
          Delete {label}
        </Button>
      </DialogFooter>
    </>
  );
}
