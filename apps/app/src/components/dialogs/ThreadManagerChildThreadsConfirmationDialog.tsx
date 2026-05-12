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

export type ThreadManagerChildThreadsAction = "archive" | "delete";

export interface ThreadManagerChildThreadsDialogTarget {
  action: ThreadManagerChildThreadsAction;
  nonDeletedAssignedChildCount: number;
  thread: Thread;
}

interface ThreadManagerChildThreadsConfirmationDialogProps {
  target: ThreadManagerChildThreadsDialogTarget | null;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (target: ThreadManagerChildThreadsDialogTarget) => void;
}

interface DialogCopy {
  confirmLabel: string;
  impact: string;
  title: string;
}

function formatNonDeletedAssignedChildThreadCount(count: number): string {
  return `${count} non-deleted assigned child thread${count === 1 ? "" : "s"}`;
}

function getDialogCopy(action: ThreadManagerChildThreadsAction): DialogCopy {
  if (action === "archive") {
    return {
      confirmLabel: "Archive manager",
      impact:
        "Archiving the manager can leave those assignments without an active manager if the child threads are resumed later.",
      title: "Archive manager with non-deleted assigned child threads?",
    };
  }

  return {
    confirmLabel: "Delete manager",
    impact:
      "Deleting the manager cannot be undone and can leave those assignments without a manager if the child threads are resumed later.",
    title: "Delete manager with non-deleted assigned child threads?",
  };
}

export function ThreadManagerChildThreadsConfirmationDialog({
  target,
  pending,
  onOpenChange,
  onConfirm,
}: ThreadManagerChildThreadsConfirmationDialogProps) {
  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        {target ? (
          <ThreadManagerChildThreadsConfirmationDialogContent
            target={target}
            pending={pending}
            onOpenChange={onOpenChange}
            onConfirm={onConfirm}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export interface ThreadManagerChildThreadsConfirmationDialogContentProps {
  target: ThreadManagerChildThreadsDialogTarget;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (target: ThreadManagerChildThreadsDialogTarget) => void;
}

export function ThreadManagerChildThreadsConfirmationDialogContent({
  target,
  pending,
  onOpenChange,
  onConfirm,
}: ThreadManagerChildThreadsConfirmationDialogContentProps) {
  const copy = getDialogCopy(target.action);
  const childCountLabel = formatNonDeletedAssignedChildThreadCount(
    target.nonDeletedAssignedChildCount,
  );

  return (
    <>
      <DialogHeader>
        <DialogTitle>{copy.title}</DialogTitle>
        <DialogDescription>
          This manager has {childCountLabel}. Archived child threads are
          included; deleted child threads are not. {copy.impact} Continue only
          if this managed work should no longer depend on the manager.
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
          onClick={() => onConfirm(target)}
        >
          {copy.confirmLabel}
        </Button>
      </DialogFooter>
    </>
  );
}
