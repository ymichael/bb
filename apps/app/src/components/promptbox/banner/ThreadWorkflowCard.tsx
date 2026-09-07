import { isSettledWorkflowAgentState } from "@bb/domain";
import type { TimelineWorkflowWorkRow } from "@bb/server-contract";
import { durationToCompactString } from "@bb/thread-view";
import { AnimatedBody } from "@/components/promptbox/banner/AnimatedBody";
import {
  PROMPT_STACK_CARD_ROW_HEIGHT,
  PromptStackCard,
} from "@/components/promptbox/banner/PromptStackCard";
import { useSecondTick } from "@/hooks/useSecondTick";
import { WorkflowWorkRowBody } from "@/components/thread/timeline/WorkflowWorkRowBody";
import {
  activityIconClass,
  activityMetaClass,
  activityRowClass,
  activityTextClass,
} from "@bb/shared-ui/activity-row-styles";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { WorkflowPhaseStrip } from "@bb/shared-ui/workflow-progress";

const BODY_ID = "thread-workflow-card-body";
const TOGGLE_ID = "thread-workflow-card-toggle";
const WORKFLOW_HEADER_BUTTON_CLASS = activityRowClass(
  "active",
  "flex min-h-8 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-none px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-background/80",
);

function WorkflowDuration({ startedAt }: { startedAt: number }) {
  const elapsed = useSecondTick() - startedAt;
  if (elapsed <= 1_000) {
    return null;
  }
  return <>{durationToCompactString(elapsed)}</>;
}

function agentProgressLabel(workflow: TimelineWorkflowWorkRow): string | null {
  const agents = workflow.workflow?.agents ?? [];
  if (agents.length === 0) {
    return null;
  }
  const settled = agents.filter((agent) =>
    isSettledWorkflowAgentState(agent.state),
  ).length;
  return `${settled}/${agents.length} agents`;
}

interface ThreadWorkflowCardProps {
  workflow: TimelineWorkflowWorkRow;
  isExpanded: boolean;
  onToggle: () => void;
}

export function ThreadWorkflowCard({
  workflow,
  isExpanded,
  onToggle,
}: ThreadWorkflowCardProps) {
  if (workflow.status !== "pending") {
    return null;
  }
  const name = workflow.workflowName ?? workflow.description;
  const progress = agentProgressLabel(workflow);
  return (
    <PromptStackCard
      ariaLabel="Workflow"
      className="overflow-hidden"
      style={{ minHeight: PROMPT_STACK_CARD_ROW_HEIGHT }}
    >
      <div className="flex items-center">
        <button
          type="button"
          id={TOGGLE_ID}
          aria-expanded={isExpanded}
          aria-controls={BODY_ID}
          aria-label={`Workflow: ${name}`}
          onClick={onToggle}
          className={WORKFLOW_HEADER_BUTTON_CLASS}
        >
          <Icon
            name="Workflow"
            className={activityIconClass("active", "size-3.5 shrink-0")}
            aria-hidden="true"
          />
          <span className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
            <span
              className={activityTextClass("active", "min-w-0 truncate")}
              title={name}
            >
              {name}
            </span>
            {progress ? (
              <span
                className={activityMetaClass(
                  "active",
                  "shrink-0 text-2xs tabular-nums",
                )}
              >
                {progress}
              </span>
            ) : null}
            <span
              className={activityMetaClass(
                "active",
                "shrink-0 text-2xs tabular-nums",
              )}
            >
              <WorkflowDuration startedAt={workflow.startedAt} />
            </span>
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
      </div>
      {workflow.workflow ? (
        <WorkflowPhaseStrip
          progress={workflow.workflow}
          settled={false}
          className="px-3 pb-2"
        />
      ) : null}
      <AnimatedBody
        id={BODY_ID}
        labelledBy={TOGGLE_ID}
        isExpanded={isExpanded}
        collapsedBorder="none"
      >
        <WorkflowWorkRowBody row={workflow} size="base" collapsiblePhases />
      </AnimatedBody>
    </PromptStackCard>
  );
}
