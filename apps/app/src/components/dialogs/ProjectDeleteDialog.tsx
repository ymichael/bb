import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";

export interface ProjectDeleteDialogTarget {
  id: string;
  name: string;
}

interface ProjectDeleteDialogProps {
  target: ProjectDeleteDialogTarget | null;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onDelete: (projectId: string) => void;
}

export function ProjectDeleteDialog({
  target,
  pending,
  onOpenChange,
  onDelete,
}: ProjectDeleteDialogProps) {
  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        {target ? (
          <ProjectDeleteDialogContent
            target={target}
            pending={pending}
            onDelete={onDelete}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export interface ProjectDeleteDialogContentProps {
  target: ProjectDeleteDialogTarget;
  pending: boolean;
  onDelete: (projectId: string) => void;
}

export function ProjectDeleteDialogContent({
  target,
  pending,
  onDelete,
}: ProjectDeleteDialogContentProps) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Remove project?</DialogTitle>
        <DialogDescription>
          {`Remove "${target.name}" and all of its threads? This cannot be undone.`}
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button
          type="button"
          variant="destructive"
          disabled={pending}
          onClick={() => onDelete(target.id)}
        >
          Remove project
        </Button>
      </DialogFooter>
    </>
  );
}
