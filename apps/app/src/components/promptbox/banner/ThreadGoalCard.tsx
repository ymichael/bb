import type { ThreadTimelineGoal } from "@bb/domain";
import {
  PROMPT_STACK_CARD_ROW_HEIGHT,
  PromptStackCard,
} from "@/components/promptbox/banner/PromptStackCard";
import {
  activityIconClass,
  activityRowClass,
  activityTextClass,
} from "@bb/shared-ui/activity-row-styles";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";

const GOAL_HEADER_GROUP_CLASS = activityRowClass(
  "active",
  "flex w-full items-stretch rounded-none px-0 py-0",
);
const GOAL_HEADER_BUTTON_CLASS =
  "flex min-h-8 min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-none bg-transparent px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-background/80";
const GOAL_CLEAR_BUTTON_CLASS =
  "flex min-h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-none border-l border-border/35 bg-transparent text-muted-foreground transition-colors hover:text-foreground disabled:cursor-wait disabled:text-muted-foreground/60";

function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = Math.round(seconds % 60);
    return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes > 0 ? `${hours}h ${restMinutes}m` : `${hours}h`;
}

function formatTokenUsage(goal: ThreadTimelineGoal): string {
  const used = goal.tokensUsed.toLocaleString();
  if (goal.tokenBudget === null) {
    return `${used} tokens`;
  }
  return `${used} / ${goal.tokenBudget.toLocaleString()} tokens`;
}

interface ThreadGoalCardProps {
  goal: ThreadTimelineGoal | null;
  isClearPending?: boolean;
  isExpanded: boolean;
  onClearGoal?: () => void;
  onToggle: () => void;
}

const BODY_ID = "thread-goal-card-body";
const TOGGLE_ID = "thread-goal-card-toggle";

export function ThreadGoalCard({
  goal,
  isClearPending = false,
  isExpanded,
  onClearGoal,
  onToggle,
}: ThreadGoalCardProps) {
  if (!goal || goal.status !== "active") {
    return null;
  }
  const objective = goal.objective.trim();
  return (
    <PromptStackCard
      ariaLabel="Goal"
      className="overflow-hidden"
      style={{ minHeight: PROMPT_STACK_CARD_ROW_HEIGHT }}
    >
      <div
        role="group"
        aria-label="Goal controls"
        className={GOAL_HEADER_GROUP_CLASS}
      >
        <button
          type="button"
          id={TOGGLE_ID}
          aria-expanded={isExpanded}
          aria-controls={BODY_ID}
          aria-label="Goal"
          onClick={onToggle}
          className={GOAL_HEADER_BUTTON_CLASS}
        >
          <Icon
            name="Target"
            className={activityIconClass("active", "size-3.5 shrink-0")}
            aria-hidden="true"
          />
          <span
            className={activityTextClass(
              "active",
              "min-w-0 flex-1 truncate text-left",
            )}
          >
            Goal
          </span>
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
        {onClearGoal ? (
          <button
            type="button"
            aria-label="Clear active Goal"
            onClick={onClearGoal}
            disabled={isClearPending}
            className={GOAL_CLEAR_BUTTON_CLASS}
          >
            <Icon
              name={isClearPending ? "Loading" : "X"}
              className={cn("size-3.5", isClearPending && "animate-spin")}
              aria-hidden="true"
            />
          </button>
        ) : null}
      </div>
      <section
        id={BODY_ID}
        role="region"
        aria-labelledby={TOGGLE_ID}
        aria-hidden={!isExpanded}
        className={cn(
          "grid overflow-hidden transition-[grid-template-rows,opacity,border-color] duration-200 ease-out",
          isExpanded
            ? "grid-rows-[1fr] border-t border-border opacity-100"
            : "pointer-events-none grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="overflow-hidden bg-popover">
          <div className="space-y-2 px-3 pb-2.5 pt-2">
            <p className="whitespace-pre-wrap text-xs leading-relaxed text-foreground/90">
              {objective.length > 0 ? objective : "No goal objective."}
            </p>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <Icon
                  name="Zap"
                  className="size-3.5 shrink-0"
                  aria-hidden="true"
                />
                {formatTokenUsage(goal)}
              </span>
              <span className="inline-flex items-center gap-1.5 tabular-nums">
                <Icon
                  name="Clock"
                  className="size-3.5 shrink-0"
                  aria-hidden="true"
                />
                {formatDuration(goal.timeUsedSeconds)}
              </span>
            </div>
          </div>
        </div>
      </section>
    </PromptStackCard>
  );
}
