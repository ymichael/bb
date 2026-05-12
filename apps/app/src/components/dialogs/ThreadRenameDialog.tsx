import type { ThreadType } from "@bb/domain";
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
import { threadTypeLabel } from "@/lib/thread-title";

export interface ThreadRenameDialogTarget {
  id: string;
  currentTitle: string;
  threadType?: ThreadType;
}

interface ThreadRenameDialogProps {
  target: ThreadRenameDialogTarget | null;
  pending?: boolean;
  onOpenChange: (open: boolean) => void;
  onRename: (threadId: string, title: string) => void;
}

export function ThreadRenameDialog({
  target,
  pending = false,
  onOpenChange,
  onRename,
}: ThreadRenameDialogProps) {
  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        {target ? (
          <ThreadRenameDialogContent
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

export interface ThreadRenameDialogContentProps {
  target: ThreadRenameDialogTarget;
  pending: boolean;
  onRename: (threadId: string, title: string) => void;
}

export function ThreadRenameDialogContent({
  target,
  pending,
  onRename,
}: ThreadRenameDialogContentProps) {
  const inputId = useId();
  const [nextTitle, setNextTitle] = useState(target.currentTitle);
  const [validationMessage, setValidationMessage] = useState<string | null>(
    null,
  );

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;

    const trimmedTitle = nextTitle.trim();
    if (!trimmedTitle) {
      setValidationMessage(
        `${label.charAt(0).toUpperCase() + label.slice(1)} name cannot be empty.`,
      );
      return;
    }

    onRename(target.id, trimmedTitle);
  };

  const label = threadTypeLabel(target.threadType ?? "standard");

  return (
    <>
      <DialogHeader>
        <DialogTitle>Rename {label}</DialogTitle>
        <DialogDescription>
          Choose a new name for this {label}.
        </DialogDescription>
      </DialogHeader>
      <form className="space-y-4" onSubmit={handleSubmit}>
        <div className="space-y-2">
          <Input
            id={inputId}
            aria-label={`${label.charAt(0).toUpperCase() + label.slice(1)} name`}
            value={nextTitle}
            autoFocus
            autoCapitalize="sentences"
            autoCorrect="off"
            spellCheck={false}
            disabled={pending}
            onChange={(event) => {
              setNextTitle(event.target.value);
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
            Rename {label}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
