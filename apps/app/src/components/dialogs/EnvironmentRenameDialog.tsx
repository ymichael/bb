import type { RefObject } from "react";
import { RenameDialog, RenameDialogContent } from "./RenameDialog";

const ENVIRONMENT_NAME_MAX_LENGTH = 80;

const ENVIRONMENT_NAME_LENGTH_RULE = {
  limit: ENVIRONMENT_NAME_MAX_LENGTH,
  message: `Worktree name must be ${ENVIRONMENT_NAME_MAX_LENGTH} characters or fewer.`,
};

export interface EnvironmentRenameDialogTarget {
  branchName?: string;
  canClearName: boolean;
  id: string;
  currentName: string;
}

interface EnvironmentRenameDialogProps {
  errorMessage?: string | null;
  target: EnvironmentRenameDialogTarget | null;
  pending?: boolean;
  onOpenChange: (open: boolean) => void;
  onRename: (environmentId: string, name: string | null) => void;
}

interface EnvironmentRenameDialogContentProps {
  target: EnvironmentRenameDialogTarget;
  pending: boolean;
  errorMessage?: string | null;
  onRename: (environmentId: string, name: string | null) => void;
  inputRef: RefObject<HTMLInputElement | null>;
}

export function EnvironmentRenameDialog({
  errorMessage,
  target,
  pending = false,
  onOpenChange,
  onRename,
}: EnvironmentRenameDialogProps) {
  return (
    <RenameDialog open={target !== null} onOpenChange={onOpenChange}>
      {(inputRef) =>
        target ? (
          <EnvironmentRenameDialogContent
            key={target.id}
            target={target}
            pending={pending}
            errorMessage={errorMessage}
            onRename={onRename}
            inputRef={inputRef}
          />
        ) : null
      }
    </RenameDialog>
  );
}

export function EnvironmentRenameDialogContent({
  target,
  pending,
  errorMessage,
  onRename,
  inputRef,
}: EnvironmentRenameDialogContentProps) {
  return (
    <RenameDialogContent
      entityLabel="worktree"
      initialName={target.currentName}
      pending={pending}
      errorMessage={errorMessage}
      placeholder={target.branchName ?? "Worktree name"}
      inputDetails={
        target.canClearName && target.branchName ? (
          <p className="truncate text-xs text-muted-foreground">
            Branch: <span className="font-mono">{target.branchName}</span>
          </p>
        ) : undefined
      }
      maxLength={ENVIRONMENT_NAME_LENGTH_RULE}
      autoCapitalize="sentences"
      clearAction={
        target.canClearName
          ? {
              label: "Clear custom name",
              onClear: () => onRename(target.id, null),
            }
          : undefined
      }
      onRename={(name) => onRename(target.id, name)}
      inputRef={inputRef}
    />
  );
}
