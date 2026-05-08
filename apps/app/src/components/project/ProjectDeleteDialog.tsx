import { Button } from "@/components/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui";

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
        <DialogHeader>
          <DialogTitle>Remove project?</DialogTitle>
          <DialogDescription>
            {target
              ? `Remove "${target.name}" and all of its threads? This cannot be undone.`
              : "Remove this project and all of its threads? This cannot be undone."}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="destructive"
            disabled={!target || pending}
            onClick={() => {
              if (!target) return;
              onDelete(target.id);
            }}
          >
            Remove project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
