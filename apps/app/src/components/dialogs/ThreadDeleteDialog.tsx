import type { Thread } from "@bb/domain";
import { assertNever } from "@bb/core-ui";
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

export type ThreadDeleteDialogTarget =
  | { kind: "standard"; thread: Thread }
  | {
      kind: "assigned-children";
      thread: Thread;
      assignedChildCount: number;
    };

interface ThreadDeleteDialogProps {
  target: ThreadDeleteDialogTarget | null;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onDelete: (target: ThreadDeleteDialogTarget) => void;
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
            onOpenChange={onOpenChange}
            onDelete={onDelete}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export interface ThreadDeleteDialogContentProps {
  target: ThreadDeleteDialogTarget;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onDelete: (target: ThreadDeleteDialogTarget) => void;
}

export function ThreadDeleteDialogContent({
  target,
  pending,
  onOpenChange,
  onDelete,
}: ThreadDeleteDialogContentProps) {
  switch (target.kind) {
    case "standard":
      return (
        <StandardBody target={target} pending={pending} onDelete={onDelete} />
      );
    case "assigned-children":
      return (
        <AssignedChildrenBody
          target={target}
          pending={pending}
          onOpenChange={onOpenChange}
          onDelete={onDelete}
        />
      );
    default:
      return assertNever(target);
  }
}

function formatAssignedChildSentence(count: number): string {
  return count === 1
    ? "1 child thread is assigned to this manager and will lose its manager."
    : `${count} child threads are assigned to this manager and will lose their manager.`;
}

function StandardBody({
  target,
  pending,
  onDelete,
}: {
  target: Extract<ThreadDeleteDialogTarget, { kind: "standard" }>;
  pending: boolean;
  onDelete: (target: ThreadDeleteDialogTarget) => void;
}) {
  const label = threadTypeLabel(target.thread.type);
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

function AssignedChildrenBody({
  target,
  pending,
  onOpenChange,
  onDelete,
}: {
  target: Extract<ThreadDeleteDialogTarget, { kind: "assigned-children" }>;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onDelete: (target: ThreadDeleteDialogTarget) => void;
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Delete manager?</DialogTitle>
        <DialogDescription>
          {formatAssignedChildSentence(target.assignedChildCount)} This action
          cannot be undone.
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
          onClick={() => onDelete(target)}
        >
          Delete manager
        </Button>
      </DialogFooter>
    </>
  );
}
