import { useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { assertNever } from "@bb/core-ui";
import { DetailCard, DetailRow } from "@bb/ui-core";
import { FormError } from "@bb/ui-core";
import { Button } from "@bb/ui-core";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@bb/ui-core";
import { getMutationErrorMessage } from "@/lib/mutation-errors";

export type ThreadEnvironmentPromotionDialogTarget =
  | { kind: "promote" }
  | { kind: "demote" };

interface ThreadEnvironmentPromotionDialogProps {
  branchName: string | null;
  primaryCheckoutPath?: string;
  pending?: boolean;
  target: ThreadEnvironmentPromotionDialogTarget | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (target: ThreadEnvironmentPromotionDialogTarget) => Promise<void>;
}

interface DialogCopy {
  description: string;
  submitLabel: string;
  title: string;
}

function getDialogCopy(
  target: ThreadEnvironmentPromotionDialogTarget,
): DialogCopy {
  switch (target.kind) {
    case "promote":
      return {
        title: "Promote environment",
        description: "Move this branch into the primary checkout.",
        submitLabel: "Promote",
      };
    case "demote":
      return {
        title: "Demote environment",
        description: "Move this branch back into its worktree.",
        submitLabel: "Demote",
      };
    default:
      return assertNever(target);
  }
}

export function ThreadEnvironmentPromotionDialog({
  branchName,
  primaryCheckoutPath,
  pending = false,
  target,
  onOpenChange,
  onSubmit,
}: ThreadEnvironmentPromotionDialogProps) {
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const dialogCopy = target ? getDialogCopy(target) : null;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!target || pending) {
      return;
    }
    setErrorMessage(null);
    try {
      await onSubmit(target);
      onOpenChange(false);
    } catch (error) {
      setErrorMessage(
        getMutationErrorMessage({
          error,
          fallbackMessage: "Failed to update promotion state.",
        }),
      );
    }
  };

  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[32rem] gap-0 overflow-hidden border-border/80 bg-background p-0 shadow-xl">
        {target && dialogCopy ? (
          <>
            <DialogHeader className="px-6 pt-5 pb-3">
              <DialogTitle>{dialogCopy.title}</DialogTitle>
              <DialogDescription>{dialogCopy.description}</DialogDescription>
            </DialogHeader>
            <form className="space-y-5 px-6 pt-3 pb-5" onSubmit={handleSubmit}>
              <DetailCard className="border-border/70 bg-muted/20">
                {branchName ? (
                  <DetailRow label="Branch" valueClassName="min-w-0 truncate">
                    <span className="block truncate" title={branchName}>
                      {branchName}
                    </span>
                  </DetailRow>
                ) : null}
                {primaryCheckoutPath ? (
                  <DetailRow
                    label="Primary checkout"
                    valueClassName="min-w-0 truncate"
                  >
                    <span
                      className="block truncate"
                      title={primaryCheckoutPath}
                    >
                      {primaryCheckoutPath}
                    </span>
                  </DetailRow>
                ) : null}
                <DetailRow label="Preflight" valueClassName="min-w-0">
                  <span className="text-muted-foreground">
                    Both workspaces must be clean.
                  </span>
                </DetailRow>
              </DetailCard>
              <FormError message={errorMessage} />
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={pending}>
                  {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                  {dialogCopy.submitLabel}
                </Button>
              </DialogFooter>
            </form>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
