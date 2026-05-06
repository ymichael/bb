import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  assertNever,
  buildPendingInteractionApprovalResolution,
  formatPendingInteractionSubjectDetailLines,
} from "@bb/core-ui";
import { extractShellCommandFromString } from "@bb/thread-view";
import {
  type PendingInteraction,
  type PendingInteractionResolution,
} from "@bb/domain";
import {
  ExpandableLine,
  StatusPill,
  getDetailScrollMaxHeightClass,
} from "@bb/ui-core";
import { useResolveThreadPendingInteraction } from "@/hooks/mutations/thread-interaction-mutations";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import { cn } from "@/lib/utils";
import { labelForApprovalDecision } from "./pending-interactions/banner-helpers";
import { Button } from "@bb/ui-core";

interface ThreadPendingInteractionBannerProps {
  interaction: PendingInteraction;
  threadId: string;
}

interface BannerOption {
  label: string;
  resolution: PendingInteractionResolution;
}

interface BannerModel {
  title: string;
  subject: ReactNode | null;
  options: BannerOption[];
  skip: BannerOption | null;
}

export function ThreadPendingInteractionBanner({
  interaction,
  threadId,
}: ThreadPendingInteractionBannerProps) {
  const resolvePendingInteraction = useResolveThreadPendingInteraction();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const isResolving = interaction.status === "resolving";

  useEffect(() => {
    setSelectedIndex(0);
  }, [interaction.id]);

  const model = useMemo(() => buildBannerModel(interaction), [interaction]);
  const mutationErrorMessage = resolvePendingInteraction.error
    ? getMutationErrorMessage({
        error: resolvePendingInteraction.error,
        fallbackMessage: "Failed to resolve pending interaction.",
      })
    : null;

  const submitIndex = Math.min(selectedIndex, model.options.length - 1);
  const submitOption = model.options[submitIndex] ?? null;
  const skipOption = model.skip;
  const showSubmit = !isResolving && submitOption !== null;
  const showSkip = !isResolving && skipOption !== null;
  const showFooter = showSubmit || showSkip;

  const submitResolution = (resolution: PendingInteractionResolution) => {
    void resolvePendingInteraction
      .mutateAsync({
        threadId,
        interactionId: interaction.id,
        resolution,
      })
      .catch(() => {});
  };

  return (
    <div className="mb-2 rounded-lg border border-border/60 bg-muted/40 px-4 py-3 text-xs text-muted-foreground">
      <div className="flex min-w-0 items-center gap-2">
        <h3 className="min-w-0 flex-1 text-sm font-semibold text-foreground">
          <ExpandableLine
            fullText={model.title}
            collapsedClassName="line-clamp-2"
          >
            {model.title}
          </ExpandableLine>
        </h3>
        {isResolving ? (
          <StatusPill variant="secondary">Delivering</StatusPill>
        ) : null}
      </div>

      {model.subject ? <div className="mt-3">{model.subject}</div> : null}

      {isResolving ? (
        <div className="mt-3 rounded-md border border-border/50 bg-background/60 px-3 py-2 text-xs text-muted-foreground">
          Answer submitted. Delivering it to the provider.
        </div>
      ) : null}

      {!isResolving && model.options.length > 0 ? (
        <ol className="mt-3 flex flex-col">
          {model.options.map((option, index) => {
            const isSelected = index === submitIndex;
            return (
              <li key={option.label}>
                <button
                  type="button"
                  onClick={() => setSelectedIndex(index)}
                  disabled={resolvePendingInteraction.isPending}
                  className={cn(
                    "flex w-full items-center rounded-md px-3 py-2 text-left text-sm transition-colors",
                    isSelected
                      ? "bg-foreground/15 font-bold text-foreground"
                      : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
                    resolvePendingInteraction.isPending && "opacity-60",
                  )}
                  aria-pressed={isSelected}
                >
                  <span className="flex-1 truncate">{option.label}</span>
                </button>
              </li>
            );
          })}
        </ol>
      ) : null}

      {showFooter ? (
        <div className="mt-3 flex items-center justify-end gap-2">
          {showSkip && skipOption ? (
            <Button
              type="button"
              size="sm"
              variant="link"
              disabled={resolvePendingInteraction.isPending}
              onClick={() => submitResolution(skipOption.resolution)}
            >
              {skipOption.label}
            </Button>
          ) : null}
          {showSubmit && submitOption ? (
            <Button
              type="button"
              size="sm"
              variant="default"
              disabled={resolvePendingInteraction.isPending}
              onClick={() => submitResolution(submitOption.resolution)}
            >
              Submit
            </Button>
          ) : null}
        </div>
      ) : null}

      {mutationErrorMessage ? (
        <div className="mt-2 rounded-md border border-destructive/30 bg-destructive/[0.06] px-2 py-1 text-xs text-destructive">
          {mutationErrorMessage}
        </div>
      ) : null}
    </div>
  );
}

function buildBannerModel(interaction: PendingInteraction): BannerModel {
  const options = interaction.payload.availableDecisions.map((decision) => ({
    label: labelForApprovalDecision(decision),
    resolution: buildPendingInteractionApprovalResolution(
      interaction,
      decision,
    ),
  }));

  switch (interaction.payload.subject.kind) {
    case "command": {
      const rawCommand = interaction.payload.subject.command;
      const command = rawCommand
        ? (extractShellCommandFromString(rawCommand) ?? rawCommand)
        : null;
      const detailLines = formatPendingInteractionSubjectDetailLines(
        interaction,
      ).filter((line) => !line.startsWith("Command: "));
      const subject = command ? (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <pre
            className={cn(
              getDetailScrollMaxHeightClass("base"),
              "overflow-auto whitespace-pre px-4 py-3 font-mono ui-text-sm leading-tight text-foreground",
            )}
          >
            $ {command}
          </pre>
          {detailLines.length > 0 ? (
            <ul className="border-t border-border/60 px-4 py-3 text-xs text-muted-foreground">
              {detailLines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null;

      return {
        title: interaction.payload.reason ?? "Do you want to run this command?",
        subject,
        options,
        skip: null,
      };
    }
    case "file_change": {
      const detailLines =
        formatPendingInteractionSubjectDetailLines(interaction);
      return {
        title:
          interaction.payload.reason ?? "Do you want to make these changes?",
        subject:
          detailLines.length > 0 ? (
            <ul className="rounded-lg border border-border bg-card px-4 py-3 text-xs text-muted-foreground">
              {detailLines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null,
        options,
        skip: null,
      };
    }
    case "permission_grant": {
      const detailLines =
        formatPendingInteractionSubjectDetailLines(interaction);
      return {
        title:
          interaction.payload.reason ?? "Do you want to grant this permission?",
        subject:
          detailLines.length > 0 ? (
            <ul className="rounded-lg border border-border bg-card px-4 py-3 text-xs text-muted-foreground">
              {detailLines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null,
        options,
        skip: null,
      };
    }
    default:
      return assertNever(interaction.payload.subject);
  }
}
