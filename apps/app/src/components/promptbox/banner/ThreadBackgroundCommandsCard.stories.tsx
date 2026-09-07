import { useState } from "react";
import type { TimelineWorkflowWorkRow } from "@bb/server-contract";
import { ThreadBackgroundCommandsCard } from "./ThreadBackgroundCommandsCard";
import { backgroundCommandRow } from "@/test/fixtures/thread-timeline-rows";
import { StoryCard, StoryRow } from "../../../../.ladle/story-card";

export default {
  title: "promptbox/banner/Background Commands Card",
};

type StageSize = "desktop" | "mobile";

function Stage({
  children,
  size,
}: {
  children: React.ReactNode;
  size: StageSize;
}) {
  return (
    <div
      data-promptbox-shell=""
      className={size === "desktop" ? "min-w-0 flex-1" : "w-[20rem] shrink-0"}
    >
      {children}
    </div>
  );
}

function ResponsiveStage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex w-full min-w-0 items-start gap-3 overflow-x-auto">
      <Stage size="desktop">{children}</Stage>
      <Stage size="mobile">{children}</Stage>
    </div>
  );
}

function FauxComposer() {
  return (
    <div className="rounded-lg border border-border bg-popover p-3">
      <div className="pb-3 text-sm text-subtle-foreground">
        Reply to the agent…
      </div>
      <div className="flex items-center gap-2">
        <span className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground">
          opus
        </span>
      </div>
    </div>
  );
}

const runningCommand = (
  args: Parameters<typeof backgroundCommandRow>[0],
): TimelineWorkflowWorkRow =>
  backgroundCommandRow({
    status: "pending",
    taskStatus: "running",
    summary: null,
    ...args,
  });

const single: TimelineWorkflowWorkRow[] = [
  runningCommand({
    id: "thr_fixture:bg:tail-dev-log",
    description: "Poll all CI runs for batching head until completion",
    startedAt: Date.now() - 8_000,
  }),
];

const many: TimelineWorkflowWorkRow[] = [
  runningCommand({
    id: "thr_fixture:bg:dev-server",
    description: "Run the dev server",
    startedAt: Date.now() - 26_000,
  }),
  runningCommand({
    id: "thr_fixture:bg:watch-tests",
    description: "Watch and re-run tests",
    startedAt: Date.now() - 12_000,
  }),
  runningCommand({
    id: "thr_fixture:bg:tail-log",
    description: "Tail the dev server log",
    startedAt: Date.now() - 4_000,
  }),
];

function ExpandableCard({
  commands,
  startExpanded = false,
}: {
  commands: TimelineWorkflowWorkRow[];
  startExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(startExpanded);
  return (
    <div className="flex flex-col gap-2">
      <ThreadBackgroundCommandsCard
        commands={commands}
        isExpanded={expanded}
        onToggle={() => setExpanded((value) => !value)}
      />
      <FauxComposer />
    </div>
  );
}

export function Overview() {
  return (
    <StoryCard>
      <StoryRow
        label="single"
        hint="compact: summarized and expandable; wide: detailed single line"
      >
        <ResponsiveStage>
          <ExpandableCard commands={single} />
        </ResponsiveStage>
      </StoryRow>
      <StoryRow
        label="multiple (collapsed)"
        hint='most recent command + "+N more"; click to expand'
      >
        <ResponsiveStage>
          <ExpandableCard commands={many} />
        </ResponsiveStage>
      </StoryRow>
      <StoryRow
        label="multiple (expanded)"
        hint="expanded: the other running commands listed below the primary"
      >
        <ResponsiveStage>
          <ExpandableCard commands={many} startExpanded />
        </ResponsiveStage>
      </StoryRow>
    </StoryCard>
  );
}
