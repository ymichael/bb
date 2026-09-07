import type { TimelineViewWorkflowWorkRow } from "@bb/thread-view";
import { WorkflowProgress } from "@bb/shared-ui/workflow-progress";
import type { DetailScrollSize } from "../../ui/detail-scroll-size.js";
import { TimelineDetailScroll } from "./TimelineDetailScroll.js";

export function WorkflowWorkRowBody({
  row,
  size = "delegation",
  collapsiblePhases = false,
}: {
  row: TimelineViewWorkflowWorkRow;
  size?: DetailScrollSize;
  collapsiblePhases?: boolean;
}) {
  if (!row.workflow) {
    if (!row.summary && !row.error) return null;
    return (
      <div className="px-2 py-1 text-xs text-muted-foreground">
        {row.summary ?? row.error}
      </div>
    );
  }

  const contentKey = row.workflow.agents
    .map((agent) => `${agent.index}:${agent.state}:${agent.lastProgressAt}`)
    .join("|");
  return (
    <TimelineDetailScroll
      size={size}
      streaming={collapsiblePhases ? false : row.status === "pending"}
      contentKey={contentKey}
      scrollClassName={collapsiblePhases ? "px-2.5 py-2" : undefined}
    >
      <WorkflowProgress
        progress={row.workflow}
        settled={row.status !== "pending"}
        error={row.error}
        collapsiblePhases={collapsiblePhases}
      />
    </TimelineDetailScroll>
  );
}
