import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ChevronDown,
} from "lucide-react";
import {
  formatPendingInteractionKindLabel,
  formatPendingInteractionSummary,
} from "@bb/core-ui";
import {
  type PendingInteraction,
  type PendingInteractionCommandApprovalDecision,
} from "@bb/domain";
import {
  StatusPill,
} from "@bb/ui-core";
import { useResolveThreadPendingInteraction } from "@/hooks/mutations/thread-interaction-mutations";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import { cn } from "@/lib/utils";
import {
  buildPermissionDecisionButtons,
  describeCommandDecision,
  hasExpandableDetails,
  type FileChangeDecisionAction,
  type PermissionDecisionButtonConfig,
} from "./pending-interactions/banner-helpers";
import { renderPendingInteractionDetails } from "./pending-interactions/PendingInteractionDetails";
import { Button } from "../ui/button";

interface ThreadPendingInteractionBannerProps {
  interaction: PendingInteraction;
  threadId: string;
}

interface PendingInteractionSectionProps {
  children: ReactNode;
  isExpanded: boolean;
}

interface PendingInteractionActionButtonProps {
  children: ReactNode;
  disabled: boolean;
  onClick: () => void;
  variant: "default" | "outline" | "ghost";
}

function PendingInteractionSection({
  children,
  isExpanded,
}: PendingInteractionSectionProps) {
  return (
    <div
      className={cn(
        "grid overflow-hidden transition-[grid-template-rows,opacity,margin,padding,border-color] duration-200 ease-out",
        isExpanded
          ? "mt-2 grid-rows-[1fr] border-t border-border/50 pt-2 opacity-100"
          : "grid-rows-[0fr] border-t border-transparent pt-0 opacity-0",
      )}
    >
      <div className="overflow-hidden">{children}</div>
    </div>
  );
}

function PendingInteractionActionButton({
  children,
  disabled,
  onClick,
  variant,
}: PendingInteractionActionButtonProps) {
  return (
    <Button
      type="button"
      size="sm"
      variant={variant}
      disabled={disabled}
      onClick={onClick}
      className="h-7"
    >
      {children}
    </Button>
  );
}

export function ThreadPendingInteractionBanner({
  interaction,
  threadId,
}: ThreadPendingInteractionBannerProps) {
  const resolvePendingInteraction = useResolveThreadPendingInteraction();
  const [isExpanded, setIsExpanded] = useState(false);
  const isResolving = interaction.status === "resolving";

  useEffect(() => {
    setIsExpanded(false);
  }, [interaction.id]);

  const details = useMemo(
    () => renderPendingInteractionDetails(interaction),
    [interaction],
  );
  const canExpand = hasExpandableDetails(interaction);
  const mutationErrorMessage =
    resolvePendingInteraction.error
      ? getMutationErrorMessage({
          error: resolvePendingInteraction.error,
          fallbackMessage: "Failed to resolve pending interaction.",
        })
      : null;

  const handleCommandDecision = (decision: PendingInteractionCommandApprovalDecision) => {
    void resolvePendingInteraction.mutateAsync({
      threadId,
      interactionId: interaction.id,
      resolution: {
        kind: "command_approval",
        decision,
      },
    }).catch(() => {});
  };

  const handleFileChangeDecision = (decision: FileChangeDecisionAction) => {
    void resolvePendingInteraction.mutateAsync({
      threadId,
      interactionId: interaction.id,
      resolution: {
        kind: "file_change_approval",
        decision,
      },
    }).catch(() => {});
  };

  const handlePermissionDecision = (decision: PermissionDecisionButtonConfig) => {
    void resolvePendingInteraction.mutateAsync({
      threadId,
      interactionId: interaction.id,
      resolution: decision.resolution,
    }).catch(() => {});
  };

  return (
    <div className="mb-2 rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <StatusPill variant="outline">
              {formatPendingInteractionKindLabel({
                kind: interaction.payload.kind,
                surface: "app",
              })}
            </StatusPill>
            {isResolving ? (
              <StatusPill variant="secondary">
                Delivering
              </StatusPill>
            ) : null}
            <span className="truncate text-sm text-foreground">
              {formatPendingInteractionSummary({
                interaction,
                surface: "app",
              })}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{interaction.providerId}</span>
            {interaction.payload.kind === "permission_request" && interaction.payload.toolName ? (
              <span>Tool: {interaction.payload.toolName}</span>
            ) : null}
          </div>
        </div>
        {canExpand ? (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7 text-muted-foreground"
            onClick={() => {
              setIsExpanded((current) => !current);
            }}
            aria-label={isExpanded ? "Hide interaction details" : "Show interaction details"}
          >
            <ChevronDown
              className={cn(
                "size-3.5 transition-transform duration-200",
                isExpanded && "rotate-180",
              )}
            />
          </Button>
        ) : null}
      </div>

      {isResolving ? (
        <div className="mt-2 rounded-md border border-border/50 bg-background/60 px-2 py-1 text-xs text-muted-foreground">
          Answer submitted. Delivering it to the provider.
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {interaction.payload.kind === "command_approval"
            ? interaction.payload.availableDecisions.map((decision) => {
                const button = describeCommandDecision(decision);
                return (
                  <PendingInteractionActionButton
                    key={button.label}
                    variant={button.variant}
                    disabled={resolvePendingInteraction.isPending}
                    onClick={() => {
                      handleCommandDecision(button.decision);
                    }}
                  >
                    {button.label}
                  </PendingInteractionActionButton>
                );
              })
            : null}
          {interaction.payload.kind === "file_change_approval" ? (
            <>
              <PendingInteractionActionButton
                variant="default"
                disabled={resolvePendingInteraction.isPending}
                onClick={() => {
                  handleFileChangeDecision("accept_for_session");
                }}
              >
                Approve for session
              </PendingInteractionActionButton>
              <PendingInteractionActionButton
                variant="outline"
                disabled={resolvePendingInteraction.isPending}
                onClick={() => {
                  handleFileChangeDecision("decline");
                }}
              >
                Deny
              </PendingInteractionActionButton>
              <PendingInteractionActionButton
                variant="ghost"
                disabled={resolvePendingInteraction.isPending}
                onClick={() => {
                  handleFileChangeDecision("cancel");
                }}
              >
                Cancel
              </PendingInteractionActionButton>
            </>
          ) : null}
          {interaction.payload.kind === "permission_request"
            ? buildPermissionDecisionButtons(interaction.payload.permissions).map((decision) => (
                <PendingInteractionActionButton
                  key={decision.label}
                  variant={decision.variant}
                  disabled={resolvePendingInteraction.isPending}
                  onClick={() => {
                    handlePermissionDecision(decision);
                  }}
                >
                  {decision.label}
                </PendingInteractionActionButton>
              ))
            : null}
        </div>
      )}

      {details ? (
        <PendingInteractionSection isExpanded={isExpanded}>
          {details}
        </PendingInteractionSection>
      ) : null}

      {mutationErrorMessage ? (
        <div className="mt-2 rounded-md border border-destructive/30 bg-destructive/[0.06] px-2 py-1 text-xs text-destructive">
          {mutationErrorMessage}
        </div>
      ) : null}
    </div>
  );
}
