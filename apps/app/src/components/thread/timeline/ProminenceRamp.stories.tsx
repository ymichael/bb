import type { TimelineRow, TimelineRowStatus } from "@bb/server-contract";
import { ThreadTimelineRows } from "@/components/thread/timeline";
import {
  commandRow,
  conversationRow,
  fileChangeRow,
  fileReadRow,
  systemRow,
  toolRow,
} from "@/test/fixtures/thread-timeline-rows";
import { StoryCard, StoryRow } from "../../../../.ladle/story-card";

export default {
  title: "thread/timeline/Prominence Ramp",
};

const THREAD_ID = "thr_ramp";
const TURN_ID = "turn_ramp_1";

function TimelineStage({ children }: { children: React.ReactNode }) {
  return <div className="w-full max-w-[760px]">{children}</div>;
}

const baseProps = {
  threadRuntimeDisplayStatus: "idle" as const,
  workspaceRootPath: undefined,
};

const proseRow: TimelineRow = conversationRow({
  id: `${THREAD_ID}:assistant:1`,
  threadId: THREAD_ID,
  turnId: TURN_ID,
  role: "assistant",
  sourceSeqStart: 1,
  startedAt: 1777944000000,
  createdAt: 1777944000000,
  text: "The workspace watcher outlives the provider process, so it lingers for the daemon's lifetime. I'll confirm the two call sites, then tighten the idle TTL.",
});

const runningTool: TimelineRow = toolRow({
  id: `${THREAD_ID}:tool:active`,
  threadId: THREAD_ID,
  turnId: TURN_ID,
  sourceSeqStart: 10,
  startedAt: Date.now(),
  createdAt: Date.now(),
  status: "pending",
  callId: "toolu_ramp_active",
  toolName: "ToolSearch",
  toolArgs: { query: "select:Edit,Write", max_results: 2 },
  output: "",
  durationMs: null,
});

const doneTool: TimelineRow = toolRow({
  id: `${THREAD_ID}:tool:done`,
  threadId: THREAD_ID,
  turnId: TURN_ID,
  sourceSeqStart: 11,
  startedAt: 1777944001000,
  createdAt: 1777944001100,
  status: "completed",
  callId: "toolu_ramp_done",
  toolName: "ToolSearch",
  toolArgs: { query: "select:Read", max_results: 1 },
  output: "Matched tools: Read",
  durationMs: 90,
});

const doneCommand: TimelineRow = commandRow({
  id: `${THREAD_ID}:command:done`,
  threadId: THREAD_ID,
  turnId: TURN_ID,
  sourceSeqStart: 12,
  startedAt: 1777944002000,
  createdAt: 1777944004000,
  status: "completed",
  callId: "call_ramp_done_cmd",
  command: "pnpm exec turbo run typecheck --filter=@bb/host-daemon",
  source: null,
  output: "",
  exitCode: 0,
  approvalStatus: null,
  activityIntents: [],
  durationMs: 2100,
});

const doneFileChange: TimelineRow = fileChangeRow({
  id: `${THREAD_ID}:fileChange:done`,
  threadId: THREAD_ID,
  turnId: TURN_ID,
  sourceSeqStart: 13,
  startedAt: 1777944005000,
  createdAt: 1777944005600,
  status: "completed",
  callId: "call_ramp_done_edit",
  change: {
    path: "packages/host-daemon/src/workspace/watcher.ts",
    kind: "update",
    movePath: null,
    diff: "@@ -42,3 +42,4 @@\n-  startWatcher(workspace);\n+  const lease = startWatcher(workspace);\n+  scheduleIdleRelease(lease);",
    diffStats: { added: 2, removed: 1 },
  },
  stdout: null,
  stderr: null,
  approvalStatus: null,
});

const leafRampRows: TimelineRow[] = [
  runningTool,
  doneTool,
  doneCommand,
  doneFileChange,
];

function bundleCommand(
  seq: number,
  command: string,
  status: TimelineRowStatus = "completed",
): TimelineRow {
  const pending = status === "pending";
  return commandRow({
    id: `${THREAD_ID}:command:bundle_${seq}`,
    threadId: THREAD_ID,
    turnId: TURN_ID,
    sourceSeqStart: seq,
    startedAt: pending ? Date.now() : 1777944010000 + seq,
    createdAt: pending ? Date.now() : 1777944012000 + seq,
    status,
    callId: `call_ramp_bundle_${seq}`,
    command,
    source: null,
    output: "",
    exitCode: pending ? null : 0,
    approvalStatus: null,
    activityIntents: [],
    durationMs: pending ? null : 2300,
  });
}

const commandBundleRows: TimelineRow[] = [
  bundleCommand(20, "pnpm exec turbo run build --filter=@bb/host-daemon"),
  bundleCommand(21, "pnpm exec turbo run test --filter=@bb/host-daemon"),
  bundleCommand(22, "pnpm exec turbo run typecheck --filter=@bb/host-daemon"),
];

const activeCommandBundleRows: TimelineRow[] = [
  bundleCommand(23, "pnpm exec turbo run build --filter=@bb/host-daemon"),
  bundleCommand(24, "pnpm exec turbo run test --filter=@bb/host-daemon"),
  bundleCommand(
    25,
    "pnpm exec turbo run typecheck --filter=@bb/host-daemon",
    "pending",
  ),
];

function explorationRead(
  seq: number,
  path: string,
  status: TimelineRowStatus = "completed",
): TimelineRow {
  const pending = status === "pending";
  return fileReadRow({
    id: `${THREAD_ID}:file-read:explore_${seq}`,
    threadId: THREAD_ID,
    turnId: TURN_ID,
    sourceSeqStart: seq,
    startedAt: pending ? Date.now() : 1777944020000 + seq,
    createdAt: pending ? Date.now() : 1777944020100 + seq,
    status,
    callId: `call_ramp_explore_${seq}`,
    path,
    durationMs: pending ? null : 60,
  });
}

const stepExplorationRows: TimelineRow[] = [
  explorationRead(30, "packages/host-daemon/src/workspace/watcher.ts"),
  explorationRead(31, "packages/host-daemon/src/workspace/index.ts"),
  explorationRead(32, "packages/host-daemon/src/runtime/session.ts"),
];

const activeExplorationRows: TimelineRow[] = [
  explorationRead(34, "packages/host-daemon/src/workspace/watcher.ts"),
  explorationRead(35, "packages/host-daemon/src/runtime/session.ts"),
  explorationRead(36, "packages/host-daemon/src/workspace/index.ts", "pending"),
];

const stepClosingMessage: TimelineRow = conversationRow({
  id: `${THREAD_ID}:assistant:step-close`,
  threadId: THREAD_ID,
  turnId: TURN_ID,
  role: "assistant",
  sourceSeqStart: 33,
  startedAt: 1777944021000,
  createdAt: 1777944021000,
  text: "—",
});

const stepSummaryRows: TimelineRow[] = [
  ...stepExplorationRows,
  stepClosingMessage,
];

const activeSystemRow: TimelineRow = systemRow({
  id: `${THREAD_ID}:system:active`,
  threadId: THREAD_ID,
  turnId: TURN_ID,
  sourceSeqStart: 40,
  startedAt: Date.now(),
  createdAt: Date.now(),
  status: "pending",
  title: "Provisioning thread",
  detail: "Running setup",
});

const doneSystemRow: TimelineRow = systemRow({
  id: `${THREAD_ID}:system:done`,
  threadId: THREAD_ID,
  turnId: TURN_ID,
  sourceSeqStart: 41,
  startedAt: 1777944030000,
  createdAt: 1777944030000,
  status: "completed",
  title: "Provisioned thread",
  detail: "Running setup\nProvisioned thread (2s)",
});

const systemRampRows: TimelineRow[] = [activeSystemRow, doneSystemRow];

const fullStackRows: TimelineRow[] = [
  proseRow,
  ...commandBundleRows,
  ...activeExplorationRows,
];

export function Overview() {
  return (
    <StoryCard labelWidth="260px">
      <StoryRow
        label="tier 1 · agent prose"
        hint="full foreground — most prominent"
      >
        <TimelineStage>
          <ThreadTimelineRows {...baseProps} timelineRows={[proseRow]} />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="tool calls · active vs done"
        hint="running tool stays full strength; finished tool / command / file-change recede"
      >
        <TimelineStage>
          <ThreadTimelineRows {...baseProps} timelineRows={leafRampRows} />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="bundle summary · finished"
        hint="idle scope — the rolled-up bundle recedes with the rest of the past layer"
      >
        <TimelineStage>
          <ThreadTimelineRows {...baseProps} timelineRows={commandBundleRows} />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="bundle summary · active-latest"
        hint="active scope, last command still running — the live frontier bundle stays full strength (shimmering verb), not receded"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            threadRuntimeDisplayStatus="active"
            timelineRows={activeCommandBundleRows}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="step summary · finished"
        hint="an assistant boundary collapses the step into a receded recap"
      >
        <TimelineStage>
          <ThreadTimelineRows {...baseProps} timelineRows={stepSummaryRows} />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="system · active vs done"
        hint="a pending operation stays prominent; the completed one recedes"
      >
        <TimelineStage>
          <ThreadTimelineRows {...baseProps} timelineRows={systemRampRows} />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="full stack · live turn"
        hint="prose on top, the finished commands bundle receded, the trailing exploration bundle as the active-latest frontier"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            threadRuntimeDisplayStatus="active"
            timelineRows={fullStackRows}
          />
        </TimelineStage>
      </StoryRow>
    </StoryCard>
  );
}
