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
  const label = target ? threadTypeLabel(target.type) : "thread";

  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {label}?</DialogTitle>
          <DialogDescription>This action cannot be undone.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="destructive"
            disabled={!target || pending}
            onClick={() => {
              if (!target) return;
              onDelete(target);
            }}
          >
            Delete {label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
