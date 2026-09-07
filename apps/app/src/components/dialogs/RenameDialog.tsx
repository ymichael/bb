import { capitalize } from "@bb/thread-view";
import {
  useId,
  useState,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Button } from "@bb/shared-ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@bb/shared-ui/dialog";
import { Input } from "@bb/shared-ui/input";
import { useNameValidation } from "./useNameValidation.js";
import { useRenameDialogAutoFocus } from "./useRenameDialogAutoFocus.js";

interface RenameDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shellClassName?: string;
  children: (inputRef: RefObject<HTMLInputElement | null>) => ReactNode;
}

export function RenameDialog({
  open,
  onOpenChange,
  shellClassName,
  children,
}: RenameDialogProps) {
  const { inputRef, handleOpenAutoFocus } = useRenameDialogAutoFocus();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={shellClassName}
        onOpenAutoFocus={handleOpenAutoFocus}
      >
        {children(inputRef)}
      </DialogContent>
    </Dialog>
  );
}

interface RenameDialogContentProps {
  entityLabel: string;
  initialName: string;
  pending: boolean;
  errorMessage?: string | null;
  placeholder?: string;
  inputDetails?: ReactNode;
  maxLength?: { limit: number; message: string };
  autoCapitalize: "words" | "sentences";
  compact?: boolean;
  clearAction?: { label: string; onClear: () => void };
  onRename: (name: string) => void;
  inputRef: RefObject<HTMLInputElement | null>;
}

export function RenameDialogContent({
  entityLabel,
  initialName,
  pending,
  errorMessage,
  placeholder,
  inputDetails,
  maxLength,
  autoCapitalize,
  compact = false,
  clearAction,
  onRename,
  inputRef,
}: RenameDialogContentProps) {
  const inputId = useId();
  const [nextName, setNextName] = useState(initialName);
  const { validationMessage, validate, clearMessage } = useNameValidation({
    emptyMessage: `${capitalize(entityLabel)} name cannot be empty.`,
    maxLength,
  });

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;

    const trimmedName = validate(nextName);
    if (trimmedName === null) return;

    onRename(trimmedName);
  };
  const displayedErrorMessage = validationMessage ?? errorMessage;

  return (
    <>
      <DialogHeader>
        <DialogTitle>Rename {entityLabel}</DialogTitle>
        <DialogDescription>
          Choose a new name for this {entityLabel}.
        </DialogDescription>
      </DialogHeader>
      <form
        className={compact ? "space-y-3" : "space-y-4"}
        onSubmit={handleSubmit}
      >
        <div className={compact ? "space-y-1.5" : "space-y-2"}>
          <Input
            ref={inputRef}
            id={inputId}
            aria-label={`${capitalize(entityLabel)} name`}
            value={nextName}
            placeholder={placeholder}
            maxLength={maxLength?.limit}
            autoCapitalize={autoCapitalize}
            autoCorrect="off"
            spellCheck={false}
            disabled={pending}
            onChange={(event) => {
              setNextName(event.target.value);
              clearMessage();
            }}
          />
          {inputDetails}
          {displayedErrorMessage ? (
            <p className="text-sm text-destructive">{displayedErrorMessage}</p>
          ) : null}
        </div>
        <DialogFooter>
          {clearAction ? (
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={clearAction.onClear}
            >
              {clearAction.label}
            </Button>
          ) : null}
          <Button type="submit" disabled={pending}>
            Rename {entityLabel}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
