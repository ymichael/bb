import { useRef, useState } from "react";
import { isBackgroundAgentTaskType } from "@bb/domain";
import type { TimelineWorkflowWorkRow } from "@bb/server-contract";
import { durationToCompactString } from "@bb/thread-view";
import { useResizeObserver } from "usehooks-ts";
import { AnimatedBody } from "@/components/promptbox/banner/AnimatedBody";
import {
  PROMPT_STACK_CARD_ROW_HEIGHT,
  PromptStackCard,
} from "@/components/promptbox/banner/PromptStackCard";
import { useSecondTick } from "@/hooks/useSecondTick";
import { Icon } from "@bb/shared-ui/icon";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import {
  activityIconClass,
  activityMetaClass,
  activityRowClass,
  activityTextClass,
} from "@bb/shared-ui/activity-row-styles";
import { cn } from "@bb/shared-ui/lib/utils";

const BODY_ID = "thread-background-commands-card-body";
const TOGGLE_ID = "thread-background-commands-card-toggle";
const COMPACT_PROMPT_SHELL_MAX_WIDTH_REM = 34;
const DEFAULT_ROOT_FONT_SIZE_PX = 16;

function isCompactPromptShellWidth(width: number): boolean {
  const parsedRootFontSize =
    typeof window === "undefined"
      ? Number.NaN
      : Number.parseFloat(
          window.getComputedStyle(document.documentElement).fontSize,
        );
  const rootFontSize = Number.isFinite(parsedRootFontSize)
    ? parsedRootFontSize
    : DEFAULT_ROOT_FONT_SIZE_PX;
  return width <= COMPACT_PROMPT_SHELL_MAX_WIDTH_REM * rootFontSize;
}

interface BackgroundActivityDisplay {
  icon: "Terminal" | "UserRoundPlus";
  label: string;
  runningPrefix: string;
}

function backgroundActivityDisplay(
  row: TimelineWorkflowWorkRow,
): BackgroundActivityDisplay {
  if (isBackgroundAgentTaskType(row.taskType)) {
    return {
      icon: "UserRoundPlus",
      label: "Background agent",
      runningPrefix: "Running background agent:",
    };
  }
  return {
    icon: "Terminal",
    label: "Background command",
    runningPrefix: "Running background command:",
  };
}

function backgroundActivityGroupLabel(
  rows: readonly TimelineWorkflowWorkRow[],
): string {
  const hasAgent = rows.some((row) => isBackgroundAgentTaskType(row.taskType));
  const hasCommand = rows.some(
    (row) => !isBackgroundAgentTaskType(row.taskType),
  );
  if (hasAgent && hasCommand) {
    return "Background activity";
  }
  return hasAgent ? "Background agents" : "Background commands";
}

function backgroundActivityModel(row: TimelineWorkflowWorkRow): string | null {
  return isBackgroundAgentTaskType(row.taskType) ? row.model : null;
}

function backgroundActivityAriaLabel(
  row: TimelineWorkflowWorkRow,
  label = backgroundActivityDisplay(row).label,
): string {
  const model = backgroundActivityModel(row);
  return model
    ? `${label}: ${row.description} · Model ${model}`
    : `${label}: ${row.description}`;
}

function compactBackgroundActivityLabel(
  rows: readonly TimelineWorkflowWorkRow[],
): string {
  const agentCount = rows.filter((row) =>
    isBackgroundAgentTaskType(row.taskType),
  ).length;
  const commandCount = rows.length - agentCount;
  if (commandCount === 0) {
    return `Running ${agentCount} background agent${agentCount === 1 ? "" : "s"}`;
  }
  if (agentCount === 0) {
    return `Running ${commandCount} background command${commandCount === 1 ? "" : "s"}`;
  }
  return `Running ${rows.length} background activities`;
}

function BackgroundActivityDuration({ startedAt }: { startedAt: number }) {
  const elapsed = useSecondTick() - startedAt;
  if (elapsed <= 1_000) {
    return null;
  }
  return (
    <span className="tabular-nums">{durationToCompactString(elapsed)}</span>
  );
}

function BackgroundActivitySummary({
  row,
  showDuration,
  active = false,
}: {
  row: TimelineWorkflowWorkRow;
  showDuration: boolean;
  active?: boolean;
}) {
  const display = backgroundActivityDisplay(row);
  const model = backgroundActivityModel(row);
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1 text-left">
      {}
      <span
        className={cn(
          "shrink-0 whitespace-nowrap",
          active ? activityMetaClass("active") : "text-muted-foreground",
        )}
      >
        {display.runningPrefix}
      </span>
      <span
        className={cn(
          "min-w-0 truncate",
          active
            ? activityTextClass("active")
            : "font-medium text-foreground opacity-70",
        )}
        title={row.description}
      >
        {row.description}
      </span>
      {model ? (
        <span
          className={cn(
            "shrink-0 whitespace-nowrap font-mono text-2xs",
            active ? activityMetaClass("active") : "text-subtle-foreground",
          )}
          title={`Model: ${model}`}
        >
          {model}
        </span>
      ) : null}
      {showDuration ? (
        <span
          className={cn(
            "shrink-0",
            active ? activityMetaClass("active") : "text-muted-foreground",
          )}
        >
          <BackgroundActivityDuration startedAt={row.startedAt} />
        </span>
      ) : null}
    </span>
  );
}

interface ThreadBackgroundCommandsCardProps {
  commands: TimelineWorkflowWorkRow[];
  isExpanded: boolean;
  onToggle: () => void;
}

export function ThreadBackgroundCommandsCard({
  commands,
  isExpanded,
  onToggle,
}: ThreadBackgroundCommandsCardProps) {
  const isCompactViewport = useIsCompactViewport();
  const cardRef = useRef<HTMLElement>(null!);
  const [isCompactCard, setIsCompactCard] = useState<boolean | null>(null);
  useResizeObserver({
    ref: cardRef,
    box: "border-box",
    onResize: ({ width }) => {
      if (width === undefined) return;
      const nextIsCompact = isCompactPromptShellWidth(width);
      setIsCompactCard((previous) =>
        previous === nextIsCompact ? previous : nextIsCompact,
      );
    },
  });
  const primary = commands[0];
  if (!primary) {
    return null;
  }
  const others = commands.slice(1);
  const hasMore = others.length > 0;
  const useCompactSummary = isCompactCard ?? isCompactViewport;
  const canExpand = hasMore || useCompactSummary;
  const expandedRows = useCompactSummary ? commands : others;
  const compactLabel = compactBackgroundActivityLabel(commands);
  const primaryDisplay = backgroundActivityDisplay(primary);
  const groupLabel = backgroundActivityGroupLabel(commands);

  return (
    <PromptStackCard
      rootRef={cardRef}
      ariaLabel={groupLabel}
      className="overflow-hidden"
      style={{ minHeight: PROMPT_STACK_CARD_ROW_HEIGHT }}
    >
      <div className="flex items-center">
        {canExpand ? (
          <button
            type="button"
            id={TOGGLE_ID}
            aria-expanded={isExpanded}
            aria-controls={BODY_ID}
            aria-label={
              useCompactSummary
                ? compactLabel
                : backgroundActivityAriaLabel(primary, groupLabel)
            }
            onClick={onToggle}
            className={activityRowClass(
              "active",
              "flex min-h-8 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-none px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-background/80",
            )}
          >
            <Icon
              name={primaryDisplay.icon}
              className={activityIconClass("active", "size-3.5 shrink-0")}
              aria-hidden="true"
            />
            {useCompactSummary ? (
              <span className="min-w-0 flex-1 truncate text-left font-medium">
                {compactLabel}
              </span>
            ) : (
              <>
                <BackgroundActivitySummary
                  row={primary}
                  showDuration={false}
                  active
                />
                <span className={activityMetaClass("active", "shrink-0")}>
                  +{others.length} more
                </span>
              </>
            )}
            <Icon
              name="ChevronDown"
              className={cn(
                activityIconClass("active"),
                "size-3.5 shrink-0 transition-transform duration-200",
                isExpanded && "rotate-180",
              )}
              aria-hidden="true"
            />
          </button>
        ) : (
          <div
            className={activityRowClass(
              "active",
              "flex min-h-8 w-full min-w-0 cursor-default items-center gap-1.5 rounded-none px-3 py-1.5 text-xs text-foreground",
            )}
            aria-label={backgroundActivityAriaLabel(primary)}
          >
            <Icon
              name={primaryDisplay.icon}
              className={activityIconClass("active", "size-3.5 shrink-0")}
              aria-hidden="true"
            />
            <BackgroundActivitySummary row={primary} showDuration active />
          </div>
        )}
      </div>
      {canExpand ? (
        <AnimatedBody
          id={BODY_ID}
          labelledBy={TOGGLE_ID}
          isExpanded={isExpanded}
          collapsedBorder="none"
        >
          <div className="flex flex-col gap-0.5 py-1">
            {expandedRows.map((row) => {
              const display = backgroundActivityDisplay(row);
              const model = backgroundActivityModel(row);
              return (
                <div
                  key={row.id}
                  className={cn(
                    "flex min-w-0 gap-1.5 px-3 py-0.5 text-xs",
                    useCompactSummary ? "items-start" : "items-center",
                  )}
                >
                  <Icon
                    name={display.icon}
                    className="size-3.5 shrink-0 text-muted-foreground/60"
                    aria-hidden="true"
                  />
                  <span
                    className={cn(
                      "min-w-0 flex-1 text-muted-foreground",
                      useCompactSummary
                        ? "whitespace-normal [overflow-wrap:anywhere]"
                        : "truncate",
                    )}
                    title={row.description}
                  >
                    {row.description}
                  </span>
                  {model ? (
                    <span
                      className="shrink-0 whitespace-nowrap font-mono text-2xs text-subtle-foreground"
                      title={`Model: ${model}`}
                    >
                      {model}
                    </span>
                  ) : null}
                  <span className="shrink-0 whitespace-nowrap text-subtle-foreground">
                    {isExpanded ? (
                      <BackgroundActivityDuration startedAt={row.startedAt} />
                    ) : null}
                  </span>
                </div>
              );
            })}
          </div>
        </AnimatedBody>
      ) : null}
    </PromptStackCard>
  );
}
