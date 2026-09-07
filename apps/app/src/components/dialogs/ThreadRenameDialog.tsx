import type { RefObject } from "react";
import { RenameDialog, RenameDialogContent } from "./RenameDialog";

export const THREAD_RENAME_DIALOG_SHELL_CLASS = "max-w-[24rem] sm:gap-3 sm:p-5";

export interface ThreadRenameDialogTarget {
  id: string;
  currentTitle: string;
}

export interface ThreadRenameDialogPayload {
  title: string;
}

interface ThreadRenameDialogProps {
  target: ThreadRenameDialogTarget | null;
  pending?: boolean;
  onOpenChange: (open: boolean) => void;
  onRename: (threadId: string, payload: ThreadRenameDialogPayload) => void;
}

export function ThreadRenameDialog({
  target,
  pending = false,
  onOpenChange,
  onRename,
}: ThreadRenameDialogProps) {
  return (
    <RenameDialog
      open={target !== null}
      onOpenChange={onOpenChange}
      shellClassName={THREAD_RENAME_DIALOG_SHELL_CLASS}
    >
      {(inputRef) =>
        target ? (
          <ThreadRenameDialogContent
            key={target.id}
            target={target}
            pending={pending}
            onRename={onRename}
            inputRef={inputRef}
          />
        ) : null
      }
    </RenameDialog>
  );
}

interface ThreadRenameDialogContentProps {
  target: ThreadRenameDialogTarget;
  pending: boolean;
  onRename: (threadId: string, payload: ThreadRenameDialogPayload) => void;
  inputRef: RefObject<HTMLInputElement | null>;
}

export function ThreadRenameDialogContent({
  target,
  pending,
  onRename,
  inputRef,
}: ThreadRenameDialogContentProps) {
  return (
    <RenameDialogContent
      entityLabel="thread"
      initialName={target.currentTitle}
      pending={pending}
      autoCapitalize="sentences"
      compact
      onRename={(title) => onRename(target.id, { title })}
      inputRef={inputRef}
    />
  );
}
