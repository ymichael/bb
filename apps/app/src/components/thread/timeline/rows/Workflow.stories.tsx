import type { TimelineRow } from "@bb/server-contract";
import type { WorkflowProgressSnapshot } from "@bb/domain";
import { ThreadTimelineRows } from "@/components/thread/timeline";
import { workflowRow } from "@/test/fixtures/thread-timeline-rows";
import { StoryCard, StoryRow } from "../../../../../.ladle/story-card";

export default {
  title: "thread/timeline/rows/Workflow",
};

function TimelineStage({ children }: { children: React.ReactNode }) {
  return <div className="w-full max-w-[760px]">{children}</div>;
}

const baseProps = {
  threadRuntimeDisplayStatus: "idle" as const,
  workspaceRootPath: undefined,
};

const runningSnapshot: WorkflowProgressSnapshot = {
  phases: [
    { index: 1, title: "Scan" },
    { index: 2, title: "Summarize" },
  ],
  agents: [
    {
      index: 1,
      label: "alpha",
      state: "done",
      model: "claude-haiku-4-5-20251001",
      attempt: 1,
      cached: false,
      lastProgressAt: 1780540129098,
      phaseIndex: 1,
      phaseTitle: "Scan",
      queuedAt: 1780540127739,
      startedAt: 1780540127740,
      promptPreview: "Reply with exactly the word alpha. Do not use any tools.",
      tokens: 8886,
      toolCalls: 0,
      durationMs: 1358,
    },
    {
      index: 2,
      label: "bravo",
      state: "running",
      model: "claude-haiku-4-5-20251001",
      attempt: 1,
      cached: false,
      lastProgressAt: 1780540129378,
      phaseIndex: 1,
      phaseTitle: "Scan",
      queuedAt: 1780540127739,
      startedAt: 1780540127740,
      promptPreview: "Reply with exactly the word bravo. Do not use any tools.",
      tokens: 8887,
      toolCalls: 0,
    },
    {
      index: 3,
      label: "combine",
      state: "queued",
      model: "haiku",
      attempt: 1,
      cached: false,
      lastProgressAt: 1780540129488,
      phaseIndex: 2,
      phaseTitle: "Summarize",
      queuedAt: 1780540129488,
      promptPreview:
        'Combine the words "alpha bravo" into one hyphenated token.',
    },
  ],
};

const completedSnapshot: WorkflowProgressSnapshot = {
  phases: runningSnapshot.phases,
  agents: runningSnapshot.agents.map((agent) => ({
    ...agent,
    state: "done" as const,
    startedAt: agent.startedAt ?? agent.queuedAt,
    tokens: agent.tokens ?? 8901,
    toolCalls: 0,
    durationMs: agent.durationMs ?? 1700,
  })),
};

const failedSnapshot: WorkflowProgressSnapshot = {
  phases: runningSnapshot.phases,
  agents: [
    runningSnapshot.agents[0]!,
    {
      ...runningSnapshot.agents[1]!,
      state: "failed",
      error: "agent abandoned: user requested retry on all 3 attempts",
      attempt: 3,
    },
    { ...runningSnapshot.agents[2]!, state: "skipped" },
  ],
};

const workflowRowBaseArgs = {
  threadId: "thr_fixture",
  turnId: "turn-1",
  sourceSeqStart: 2,
  sourceSeqEnd: 9,
  startedAt: 1780540127710,
  createdAt: 1780540131011,
  itemId: "task:wu7ol9ras",
  workflowName: "fixture-mini",
  description: "Tiny fixture workflow for BB capture",
  summary: null,
  error: null,
};

const runningWorkflow: TimelineRow = workflowRow({
  ...workflowRowBaseArgs,
  id: "thr_fixture:workflow:task:wu7ol9ras:running",
  status: "pending",
  taskStatus: "running",
  workflow: runningSnapshot,
  usage: { totalTokens: 17773, toolUses: 0, durationMs: 1772 },
  durationMs: null,
});

const completedWorkflow: TimelineRow = workflowRow({
  ...workflowRowBaseArgs,
  id: "thr_fixture:workflow:task:wu7ol9ras:completed",
  status: "completed",
  taskStatus: "completed",
  workflow: completedSnapshot,
  usage: { totalTokens: 26674, toolUses: 0, durationMs: 3277 },
  summary: 'Dynamic workflow "Tiny fixture workflow for BB capture" completed',
  durationMs: 3_301,
});

const failedWorkflow: TimelineRow = workflowRow({
  ...workflowRowBaseArgs,
  id: "thr_fixture:workflow:task:wu7ol9ras:failed",
  status: "error",
  taskStatus: "failed",
  workflow: failedSnapshot,
  usage: { totalTokens: 21340, toolUses: 0, durationMs: 2810 },
  error: "agent abandoned: user requested retry on all 3 attempts",
  durationMs: 3_301,
});

const interruptedWorkflow: TimelineRow = workflowRow({
  ...workflowRowBaseArgs,
  id: "thr_fixture:workflow:task:wu7ol9ras:interrupted",
  status: "interrupted",
  taskStatus: "stopped",
  workflow: runningSnapshot,
  usage: { totalTokens: 17773, toolUses: 0, durationMs: 1772 },
  durationMs: 3_301,
});

const degradedWorkflow: TimelineRow = workflowRow({
  ...workflowRowBaseArgs,
  id: "thr_fixture:workflow:task:wu7ol9ras:degraded",
  status: "completed",
  taskStatus: "completed",
  workflow: null,
  usage: { totalTokens: 26674, toolUses: 0, durationMs: 3277 },
  summary: 'Dynamic workflow "Tiny fixture workflow for BB capture" completed',
  durationMs: 3_301,
});

const noPhasesWorkflow: TimelineRow = workflowRow({
  ...workflowRowBaseArgs,
  id: "thr_fixture:workflow:task:wu7ol9ras:no-phases",
  status: "pending",
  taskStatus: "running",
  workflow: {
    phases: [],
    agents: runningSnapshot.agents.map((agent) => {
      const { phaseIndex, phaseTitle, ...rest } = agent;
      return rest;
    }),
  },
  usage: { totalTokens: 17773, toolUses: 0, durationMs: 1772 },
  durationMs: null,
});

export function Overview() {
  return (
    <StoryCard>
      <StoryRow
        label="running"
        hint="live run: phase groups with done/running/queued agents (auto-expands while pending)"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            threadRuntimeDisplayStatus="active"
            initialExpanded={new Set([runningWorkflow.id])}
            timelineRows={[runningWorkflow]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="completed"
        hint="real fixture-mini capture: all agents done with token/duration stats"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            initialExpanded={new Set([completedWorkflow.id])}
            timelineRows={[completedWorkflow]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="failed"
        hint="agent 2 exhausted retries; agent 3 user-skipped"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            initialExpanded={new Set([failedWorkflow.id])}
            timelineRows={[failedWorkflow]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="interrupted"
        hint="session died mid-run; non-terminal agents render as stopped"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            initialExpanded={new Set([interruptedWorkflow.id])}
            timelineRows={[interruptedWorkflow]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="degraded"
        hint="no workflow_progress payloads (older CLI): title + summary only"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            initialExpanded={new Set([degradedWorkflow.id])}
            timelineRows={[degradedWorkflow]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="no phases"
        hint="flat agent list when the script declares no phases"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            threadRuntimeDisplayStatus="active"
            initialExpanded={new Set([noPhasesWorkflow.id])}
            timelineRows={[noPhasesWorkflow]}
          />
        </TimelineStage>
      </StoryRow>
    </StoryCard>
  );
}
