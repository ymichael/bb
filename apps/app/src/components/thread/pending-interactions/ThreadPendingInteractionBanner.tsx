import { useMemo, type ReactNode } from "react";
import {
  assertNever,
  buildPendingInteractionApprovalResolution,
  formatPendingInteractionSummary,
  formatPendingInteractionSubjectDetailLines,
} from "@bb/core-ui";
import { extractShellCommandFromString } from "@bb/thread-view";
import {
  isApprovalPendingInteractionPayload,
  isUserQuestionPendingInteractionPayload,
  type ApprovalPendingInteractionPayload,
  type PendingInteraction,
  type PendingInteractionApprovalDecision,
  type PendingInteractionResolution,
  type UserQuestionPendingInteractionPayload,
} from "@bb/domain";
import { Button } from "@/components/ui/button.js";
import { ExpandableLine } from "@/components/ui/expandable-line.js";
import { Icon } from "@/components/ui/icon.js";
import { getDetailScrollMaxHeightClass } from "@/components/ui/detail-scroll-size.js";
import { UserQuestionAnswerForm } from "@/components/thread/user-questions/UserQuestionInteractionContent.js";
import { useResolveThreadPendingInteraction } from "@/hooks/mutations/thread-interaction-mutations";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import { cn } from "@/lib/utils";

interface ThreadPendingInteractionBannerProps {
  interaction: PendingInteraction;
  threadId: string;
}

interface ApprovalPendingInteractionBannerProps {
  interaction: PendingInteraction;
  payload: ApprovalPendingInteractionPayload;
  threadId: string;
}

interface UserQuestionPendingInteractionBannerProps {
  interaction: PendingInteraction;
  payload: UserQuestionPendingInteractionPayload;
  threadId: string;
}

interface BannerShellProps {
  title: string;
  errorMessage?: string | null;
  footer?: ReactNode;
  children?: ReactNode;
}

interface ApprovalSubject {
  title: string;
  body: ReactNode;
}

interface BuildApprovalSubjectInput {
  interaction: PendingInteraction;
  payload: ApprovalPendingInteractionPayload;
}

export function ThreadPendingInteractionBanner({
  interaction,
  threadId,
}: ThreadPendingInteractionBannerProps) {
  if (isUserQuestionPendingInteractionPayload(interaction.payload)) {
    return (
      <ThreadUserQuestionPendingInteractionBanner
        interaction={interaction}
        payload={interaction.payload}
        threadId={threadId}
      />
    );
  }

  if (!isApprovalPendingInteractionPayload(interaction.payload)) {
    return assertNever(interaction.payload);
  }

  return (
    <ApprovalPendingInteractionBanner
      interaction={interaction}
      payload={interaction.payload}
      threadId={threadId}
    />
  );
}

function BannerShell({
  title,
  errorMessage,
  footer,
  children,
}: BannerShellProps) {
  return (
    <div className="mb-2 rounded-lg border border-border bg-surface-recessed px-4 py-3 text-xs text-muted-foreground">
      <h3 className="min-w-0 text-sm font-semibold text-foreground">
        <ExpandableLine fullText={title} collapsedClassName="line-clamp-2">
          {title}
        </ExpandableLine>
      </h3>
      {children ? <div className="mt-3">{children}</div> : null}
      {footer ? (
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
          {footer}
        </div>
      ) : null}
      {errorMessage ? (
        <div className="mt-2 rounded-md border border-surface-destructive-border bg-surface-destructive px-2 py-1 text-xs text-destructive">
          {errorMessage}
        </div>
      ) : null}
    </div>
  );
}

function ApprovalPendingInteractionBanner({
  interaction,
  payload,
  threadId,
}: ApprovalPendingInteractionBannerProps) {
  const resolvePendingInteraction = useResolveThreadPendingInteraction();
  const isResolving = interaction.status === "resolving";
  const submittedDecision = approvalResolutionDecision(interaction.resolution);
  const subject = useMemo(
    () => buildApprovalSubject({ interaction, payload }),
    [interaction, payload],
  );
  const mutationErrorMessage = resolvePendingInteraction.error
    ? getMutationErrorMessage({
        error: resolvePendingInteraction.error,
        fallbackMessage: "Failed to resolve pending interaction.",
      })
    : null;
  const submitDisabled = resolvePendingInteraction.isPending || isResolving;

  const submitDecision = (
    decision: PendingInteractionApprovalDecision,
  ): void => {
    const resolution = buildPendingInteractionApprovalResolution(
      interaction,
      decision,
    );
    void resolvePendingInteraction
      .mutateAsync({
        threadId,
        interactionId: interaction.id,
        resolution,
      })
      .catch(() => {});
  };

  return (
    <BannerShell
      title={subject.title}
      errorMessage={mutationErrorMessage}
      footer={payload.availableDecisions.map((decision) => (
        <ApprovalDecisionButton
          key={decision}
          decision={decision}
          disabled={submitDisabled}
          isLoading={isResolving && submittedDecision === decision}
          onClick={() => submitDecision(decision)}
        />
      ))}
    >
      {subject.body}
    </BannerShell>
  );
}

function ThreadUserQuestionPendingInteractionBanner({
  interaction,
  payload,
  threadId,
}: UserQuestionPendingInteractionBannerProps) {
  const isResolving = interaction.status === "resolving";
  const title = formatPendingInteractionSummary({
    interaction,
    surface: "app",
  });

  return (
    <BannerShell title={title}>
      <UserQuestionAnswerForm
        interactionId={interaction.id}
        isResolving={isResolving}
        questions={payload.questions}
        threadId={threadId}
      />
    </BannerShell>
  );
}

interface ApprovalDecisionButtonProps {
  decision: PendingInteractionApprovalDecision;
  disabled: boolean;
  isLoading: boolean;
  onClick: () => void;
}

function ApprovalDecisionButton({
  decision,
  disabled,
  isLoading,
  onClick,
}: ApprovalDecisionButtonProps) {
  return (
    <Button
      type="button"
      size="sm"
      variant={approvalDecisionButtonVariant(decision)}
      disabled={disabled}
      onClick={onClick}
    >
      {isLoading ? (
        <Icon name="Spinner" className="size-3 animate-spin" />
      ) : null}
      {labelForApprovalDecision(decision)}
    </Button>
  );
}

function approvalDecisionButtonVariant(
  decision: PendingInteractionApprovalDecision,
): "default" | "outline" | "ghost" {
  // Three-level hierarchy: filled primary for the safest yes, outline for the
  // longer-lived yes, ghost for the dismissive no. Keeps Deny visible without
  // letting it compete with the affirmative actions.
  switch (decision) {
    case "allow_once":
      return "default";
    case "allow_for_session":
      return "outline";
    case "deny":
      return "ghost";
  }
}

function approvalResolutionDecision(
  resolution: PendingInteractionResolution | null,
): PendingInteractionApprovalDecision | null {
  if (!resolution || "kind" in resolution) {
    return null;
  }
  return resolution.decision;
}

function buildApprovalSubject({
  interaction,
  payload,
}: BuildApprovalSubjectInput): ApprovalSubject {
  switch (payload.subject.kind) {
    case "command": {
      const rawCommand = payload.subject.command;
      const command = rawCommand
        ? (extractShellCommandFromString(rawCommand) ?? rawCommand)
        : null;
      // The cwd value is a self-describing absolute path, so the "Cwd: "
      // prefix from the shared formatter reads as redundant in the banner.
      // Strip the label here; other prefixed lines (Action:, Session grant:)
      // need their labels to be readable.
      const detailLines = formatPendingInteractionSubjectDetailLines(
        interaction,
      )
        .filter((line) => !line.startsWith("Command: "))
        .map((line) =>
          line.startsWith("Cwd: ") ? line.slice("Cwd: ".length) : line,
        );
      return {
        title: payload.reason ?? "Do you want to run this command?",
        body: command ? (
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            <pre
              className={cn(
                getDetailScrollMaxHeightClass("base"),
                "overflow-auto whitespace-pre px-4 py-3 font-mono text-sm leading-tight text-foreground",
              )}
            >
              $ {command}
            </pre>
            {detailLines.length > 0 ? (
              <ul className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
                {detailLines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null,
      };
    }
    case "file_change": {
      const detailLines =
        formatPendingInteractionSubjectDetailLines(interaction);
      return {
        title: payload.reason ?? "Do you want to make these changes?",
        body:
          detailLines.length > 0 ? (
            <ul className="rounded-lg border border-border bg-card px-4 py-3 text-xs text-muted-foreground">
              {detailLines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null,
      };
    }
    case "permission_grant": {
      const detailLines =
        formatPendingInteractionSubjectDetailLines(interaction);
      return {
        title: payload.reason ?? "Do you want to grant this permission?",
        body:
          detailLines.length > 0 ? (
            <ul className="rounded-lg border border-border bg-card px-4 py-3 text-xs text-muted-foreground">
              {detailLines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null,
      };
    }
    default:
      return assertNever(payload.subject);
  }
}

function labelForApprovalDecision(
  decision: PendingInteractionApprovalDecision,
): string {
  switch (decision) {
    case "allow_once":
      return "Allow once";
    case "allow_for_session":
      return "Allow for session";
    case "deny":
      return "Deny";
  }
}
