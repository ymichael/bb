import { Button } from "@/components/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui";

export interface HostDeleteDialogTarget {
  id: string;
  name: string;
}

interface HostDeleteDialogProps {
  target: HostDeleteDialogTarget | null;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onDelete: (hostId: string) => void;
}

export function HostDeleteDialog({
  target,
  pending,
  onOpenChange,
  onDelete,
}: HostDeleteDialogProps) {
  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        {target ? (
          <HostDeleteDialogContent
            target={target}
            pending={pending}
            onDelete={onDelete}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export interface HostDeleteDialogContentProps {
  target: HostDeleteDialogTarget;
  pending: boolean;
  onDelete: (hostId: string) => void;
}

export function HostDeleteDialogContent({
  target,
  pending,
  onDelete,
}: HostDeleteDialogContentProps) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Remove host?</DialogTitle>
        <DialogDescription>
          {`Remove "${target.name}" and all of its project sources? This cannot be undone.`}
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button
          type="button"
          variant="destructive"
          disabled={pending}
          onClick={() => onDelete(target.id)}
        >
          Remove host
        </Button>
      </DialogFooter>
    </>
  );
}
