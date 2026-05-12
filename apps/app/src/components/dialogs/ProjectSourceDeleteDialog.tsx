import { Button } from "@/components/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui";

export interface ProjectSourceDeleteDialogTarget {
  id: string;
  label: string;
}

interface ProjectSourceDeleteDialogProps {
  target: ProjectSourceDeleteDialogTarget | null;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onDelete: (sourceId: string) => void;
}

export function ProjectSourceDeleteDialog({
  target,
  pending,
  onOpenChange,
  onDelete,
}: ProjectSourceDeleteDialogProps) {
  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        {target ? (
          <ProjectSourceDeleteDialogContent
            target={target}
            pending={pending}
            onDelete={onDelete}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export interface ProjectSourceDeleteDialogContentProps {
  target: ProjectSourceDeleteDialogTarget;
  pending: boolean;
  onDelete: (sourceId: string) => void;
}

export function ProjectSourceDeleteDialogContent({
  target,
  pending,
  onDelete,
}: ProjectSourceDeleteDialogContentProps) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Remove source?</DialogTitle>
        <DialogDescription>
          {`Remove "${target.label}" from this project? This cannot be undone.`}
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button
          type="button"
          variant="destructive"
          disabled={pending}
          onClick={() => onDelete(target.id)}
        >
          Remove source
        </Button>
      </DialogFooter>
    </>
  );
}
