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

export type ThreadArchiveDialogTarget =
  | {
      kind: "assigned-children";
      thread: Thread;
      assignedChildCount: number;
    }
  | {
      kind: "workspace-dirty";
      thread: Thread;
      managerChildThreadsConfirmed: boolean;
    };

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
  switch (target.kind) {
    case "assigned-children":
      return (
        <AssignedChildrenBody
          target={target}
          pending={pending}
          onOpenChange={onOpenChange}
          onArchive={onArchive}
        />
      );
    case "workspace-dirty":
      return (
        <WorkspaceDirtyBody
          target={target}
          pending={pending}
          onArchive={onArchive}
        />
      );
    default:
      return assertNever(target);
  }
}

function formatAssignedChildSentence(count: number): string {
  return count === 1
    ? "1 child thread is assigned to this manager."
    : `${count} child threads are assigned to this manager.`;
}

function AssignedChildrenBody({
  target,
  pending,
  onOpenChange,
  onArchive,
}: {
  target: Extract<ThreadArchiveDialogTarget, { kind: "assigned-children" }>;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onArchive: (target: ThreadArchiveDialogTarget) => void;
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Archive manager?</DialogTitle>
        <DialogDescription>
          {formatAssignedChildSentence(target.assignedChildCount)} They&apos;ll
          keep their assignment, but won&apos;t have an active manager until
          this one is unarchived.
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
          Archive manager
        </Button>
      </DialogFooter>
    </>
  );
}

function WorkspaceDirtyBody({
  target,
  pending,
  onArchive,
}: {
  target: Extract<ThreadArchiveDialogTarget, { kind: "workspace-dirty" }>;
  pending: boolean;
  onArchive: (target: ThreadArchiveDialogTarget) => void;
}) {
  const label = threadTypeLabel(target.thread.type);
  return (
    <>
      <DialogHeader>
        <DialogTitle>Archive {label} with uncommitted changes?</DialogTitle>
        <DialogDescription>
          This {label} has uncommitted or unmerged work in its workspace.
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
