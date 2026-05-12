import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui";
import { Input } from "@/components/ui";

export interface ProjectRenameDialogTarget {
  id: string;
  currentName: string;
}

interface ProjectRenameDialogProps {
  target: ProjectRenameDialogTarget | null;
  pending?: boolean;
  onOpenChange: (open: boolean) => void;
  onRename: (projectId: string, name: string) => void;
}

export interface ProjectRenameDialogContentProps {
  target: ProjectRenameDialogTarget;
  pending: boolean;
  onRename: (projectId: string, name: string) => void;
}

export function ProjectRenameDialog({
  target,
  pending = false,
  onOpenChange,
  onRename,
}: ProjectRenameDialogProps) {
  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        {target ? (
          <ProjectRenameDialogContent
            key={target.id}
            target={target}
            pending={pending}
            onRename={onRename}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export function ProjectRenameDialogContent({
  target,
  pending,
  onRename,
}: ProjectRenameDialogContentProps) {
  const inputId = useId();
  const [nextName, setNextName] = useState(target.currentName);
  const [validationMessage, setValidationMessage] = useState<string | null>(
    null,
  );

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;

    const trimmedName = nextName.trim();
    if (!trimmedName) {
      setValidationMessage("Project name cannot be empty.");
      return;
    }

    onRename(target.id, trimmedName);
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Rename project</DialogTitle>
        <DialogDescription>
          Choose a new name for this project.
        </DialogDescription>
      </DialogHeader>
      <form className="space-y-4" onSubmit={handleSubmit}>
        <div className="space-y-2">
          <Input
            id={inputId}
            aria-label="Project name"
            value={nextName}
            autoFocus
            autoCapitalize="words"
            autoCorrect="off"
            spellCheck={false}
            disabled={pending}
            onChange={(event) => {
              setNextName(event.target.value);
              if (validationMessage) {
                setValidationMessage(null);
              }
            }}
          />
          {validationMessage ? (
            <p className="text-sm text-destructive">{validationMessage}</p>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="submit" disabled={pending}>
            Rename project
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
