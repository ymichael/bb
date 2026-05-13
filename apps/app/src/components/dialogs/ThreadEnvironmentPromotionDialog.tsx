import { useState, type FormEvent } from "react";
import { assertNever } from "@bb/core-ui";
import { Button, DetailCard, DetailRow, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormError, Icon } from "@/components/ui";
import type { EnvironmentPromotionUnavailableReason } from "@bb/server-contract";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import { PROMOTION_UNAVAILABLE_COPY } from "@/lib/promotion-copy";

export type ThreadEnvironmentPromotionDialogTarget =
  | { kind: "promote" }
  | { kind: "demote" };

interface ThreadEnvironmentPromotionDialogProps {
  agentActive: boolean;
  blockers: EnvironmentPromotionUnavailableReason[];
  branchName: string | null;
  defaultBranch: string | null;
  primaryCheckoutPath?: string;
  pending?: boolean;
  target: ThreadEnvironmentPromotionDialogTarget | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (target: ThreadEnvironmentPromotionDialogTarget) => Promise<void>;
}

interface PromotionDialogIssuesProps {
  agentActive: boolean;
  blockers: EnvironmentPromotionUnavailableReason[];
}

interface DialogCopy {
  description: string;
  plannedChange: string;
  submitLabel: string;
  title: string;
}

function getDialogCopy(
  target: ThreadEnvironmentPromotionDialogTarget,
  branchName: string | null,
  defaultBranch: string | null,
): DialogCopy {
  const branchLabel = branchName ?? "the environment branch";
  const defaultLabel = defaultBranch ?? "the default branch";
  switch (target.kind) {
    case "promote":
      return {
        title: "Promote environment",
        description: "Move this branch into the primary checkout.",
        plannedChange: `Check out ${branchLabel} in the primary checkout and return the worktree to ${defaultLabel}.`,
        submitLabel: "Promote",
      };
    case "demote":
      return {
        title: "Demote environment",
        description: "Move this branch back into its worktree.",
        plannedChange: `Check out ${branchLabel} in the worktree and return the primary checkout to ${defaultLabel}.`,
        submitLabel: "Demote",
      };
    default:
      return assertNever(target);
  }
}

export function ThreadEnvironmentPromotionDialog({
  agentActive,
  blockers,
  branchName,
  defaultBranch,
  primaryCheckoutPath,
  pending = false,
  target,
  onOpenChange,
  onSubmit,
}: ThreadEnvironmentPromotionDialogProps) {
  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[32rem] gap-0 overflow-hidden border-border/80 bg-background p-0 shadow-xl">
        {target ? (
          <ThreadEnvironmentPromotionDialogContent
            target={target}
            agentActive={agentActive}
            blockers={blockers}
            branchName={branchName}
            defaultBranch={defaultBranch}
            primaryCheckoutPath={primaryCheckoutPath}
            pending={pending}
            onOpenChange={onOpenChange}
            onSubmit={onSubmit}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export type ThreadEnvironmentPromotionDialogContentProps = Omit<
  ThreadEnvironmentPromotionDialogProps,
  "target"
> & {
  target: ThreadEnvironmentPromotionDialogTarget;
};

export function ThreadEnvironmentPromotionDialogContent({
  target,
  agentActive,
  blockers,
  branchName,
  defaultBranch,
  primaryCheckoutPath,
  pending = false,
  onOpenChange,
  onSubmit,
}: ThreadEnvironmentPromotionDialogContentProps) {
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const dialogCopy = getDialogCopy(target, branchName, defaultBranch);
  const submitDisabled = pending || blockers.length > 0 || agentActive;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitDisabled) {
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
    <>
      <DialogHeader className="px-6 pt-5 pb-3">
        <DialogTitle>{dialogCopy.title}</DialogTitle>
        <DialogDescription>{dialogCopy.description}</DialogDescription>
      </DialogHeader>
      <form className="space-y-4 px-6 pt-3 pb-5" onSubmit={handleSubmit}>
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
              <span className="block truncate" title={primaryCheckoutPath}>
                {primaryCheckoutPath}
              </span>
            </DetailRow>
          ) : null}
          <DetailRow label="Planned change" valueClassName="min-w-0">
            <span className="text-muted-foreground">
              {dialogCopy.plannedChange}
            </span>
          </DetailRow>
        </DetailCard>
        {blockers.length > 0 || agentActive ? (
          <PromotionDialogIssues
            agentActive={agentActive}
            blockers={blockers}
          />
        ) : null}
        <FormError message={errorMessage} />
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={submitDisabled}>
            {pending ? <Icon name="Spinner" className="size-4 animate-spin" /> : null}
            {dialogCopy.submitLabel}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

function PromotionDialogIssues({
  agentActive,
  blockers,
}: PromotionDialogIssuesProps) {
  return (
    <div className="rounded-md border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-foreground">
      <div className="flex items-center gap-2 font-medium">
        <Icon name="AlertCircle" className="size-4 text-warning" />
        Resolve before continuing
      </div>
      <ul className="mt-2 ml-6 list-disc space-y-1 text-muted-foreground">
        {agentActive ? (
          <li>Wait for the agent to finish before continuing.</li>
        ) : null}
        {blockers.map((reason) => (
          <li key={reason}>{PROMOTION_UNAVAILABLE_COPY[reason]}</li>
        ))}
      </ul>
    </div>
  );
}
