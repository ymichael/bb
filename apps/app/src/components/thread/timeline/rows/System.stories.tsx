import type { TimelineRow } from "@bb/server-contract";
import { ThreadTimelineRows } from "@/components/thread/timeline";
import { systemRow } from "@/test/fixtures/thread-timeline-rows";
import { StoryCard, StoryRow } from "../../../../../.ladle/story-card";

export default {
  title: "thread/timeline/rows/System",
};

function TimelineStage({ children }: { children: React.ReactNode }) {
  return <div className="w-full max-w-[760px]">{children}</div>;
}

const baseProps = {
  projectId: "proj_gyz9przugq",
  threadRuntimeDisplayStatus: "idle" as const,
  workspaceRootPath: undefined,
};

const provisioningPending: TimelineRow = systemRow({
  id: "thr_sjgc9pafri:op:thread-provisioning:tpv_4if68xgg7d",
  threadId: "thr_sjgc9pafri",
  turnId: null,
  sourceSeqStart: 12,
  sourceSeqEnd: 28,
  startedAt: Date.now() - 9_000,
  createdAt: Date.now(),
  systemKind: "operation",
  operationKind: "thread-provisioning",
  title: "Provisioning thread",
  detail:
    "Creating worktree (305ms)\n" +
    "HEAD is now at 37eeec85 Refactor timeline row titles\n" +
    "Preparing worktree (new branch 'bb/investigate-thread-timeline-load-thr_sjgc9pafri')\n" +
    "Created worktree (305ms)\n" +
    "Using workspace: /Users/michael/.bb-dev/worktrees/env_etyr7f84cg/bb\n" +
    "Running .bb-env-setup.sh\n" +
    "[bb-env-setup] Running: pnpm install\n" +
    "Scope: all 35 workspace projects\n" +
    "Lockfile is up to date, resolution step is skipped\n" +
    "Progress: resolved 1094, reused 1093, downloaded 0, added 877",
  status: "pending",
  completedAt: null,
});

const provisioningCompleted: TimelineRow = systemRow({
  id: "thr_sjgc9pafri:op:thread-provisioning:tpv_4if68xgg7d:completed",
  threadId: "thr_sjgc9pafri",
  turnId: null,
  sourceSeqStart: 12,
  sourceSeqEnd: 47,
  startedAt: 1778027661741,
  createdAt: 1778027670469,
  systemKind: "operation",
  operationKind: "thread-provisioning",
  title: "Provisioned thread",
  detail:
    "Created worktree (305ms)\n" +
    "Using workspace: /Users/michael/.bb-dev/worktrees/env_etyr7f84cg/bb\n" +
    ".bb-env-setup.sh finished (8.2s)\n" +
    "Using branch: bb/investigate-thread-timeline-load-thr_sjgc9pafri (37eeec8)\n" +
    "Provisioned thread (8.7s)",
  status: "completed",
  completedAt: 1778027670469,
});

const compactionCompleted: TimelineRow = systemRow({
  id: "thr_iqcz6et4rd:op:compaction:turn-019dab12",
  threadId: "thr_iqcz6et4rd",
  turnId: "019dab12-44f1-7c10-9af3-7a85c3f2b1d2",
  sourceSeqStart: 4218,
  sourceSeqEnd: 4231,
  startedAt: 1777890113200,
  createdAt: 1777890119840,
  systemKind: "operation",
  operationKind: "compaction",
  title: "Context compacted",
  detail: null,
  status: "completed",
  completedAt: 1777890119840,
});

const compactionPending: TimelineRow = systemRow({
  id: "thr_iqcz6et4rd:op:compaction:turn-019dab15",
  threadId: "thr_iqcz6et4rd",
  turnId: "019dab15-44f1-7c10-9af3-7a85c3f2b1d2",
  sourceSeqStart: 4350,
  sourceSeqEnd: 4350,
  startedAt: Date.now(),
  createdAt: Date.now(),
  systemKind: "operation",
  operationKind: "compaction",
  title: "Compacting context",
  detail: null,
  status: "pending",
  completedAt: null,
});

const contextCleared: TimelineRow = systemRow({
  id: "thr_iqcz6et4rd:op:context-clear:4372",
  threadId: "thr_iqcz6et4rd",
  turnId: "019dab16-44f1-7c10-9af3-7a85c3f2b1d2",
  sourceSeqStart: 4372,
  sourceSeqEnd: 4372,
  startedAt: 1777890173200,
  createdAt: 1777890173200,
  systemKind: "operation",
  operationKind: "context-clear",
  title: "Context cleared",
  detail: null,
  status: "completed",
  completedAt: 1777890173200,
});

const threadInterruptedManualStop: TimelineRow = systemRow({
  id: "thr_m8dsv5hjpi:op:thread-interrupted:1776810312",
  threadId: "thr_m8dsv5hjpi",
  turnId: null,
  sourceSeqStart: 318,
  sourceSeqEnd: 318,
  startedAt: 1776810312000,
  createdAt: 1776810312000,
  systemKind: "operation",
  operationKind: "thread-interrupted",
  title: "Stopped manually",
  detail: null,
  status: "interrupted",
  completedAt: 1776810312000,
});

const providerUnhandled: TimelineRow = systemRow({
  id: "thr_m22cr9ggq7:op:provider-unhandled:1776898870",
  threadId: "thr_m22cr9ggq7",
  turnId: null,
  sourceSeqStart: 5612,
  sourceSeqEnd: 5612,
  startedAt: 1776898870858,
  createdAt: 1776898870858,
  systemKind: "operation",
  operationKind: "provider-unhandled",
  title: "Unhandled Claude Code event",
  detail:
    "SDK System\n" +
    "Raw event: sdk/system\n" +
    "Payload:\n" +
    JSON.stringify(
      {
        jsonrpc: "2.0",
        method: "sdk/message",
        params: {
          message: {
            type: "system",
            subtype: "task_updated",
            task_id: "b1baum89q",
            patch: { status: "killed", end_time: 1776898870858 },
            uuid: "c4237925-699d-4124-8322-169fac35a763",
            session_id: "f9d6e937-d5da-4a0c-9bdd-ec88e0a7b0c1",
          },
          threadId: "thr_m22cr9ggq7",
        },
      },
      null,
      2,
    ),
  status: "completed",
  completedAt: 1776898870858,
});

const providerWarning: TimelineRow = systemRow({
  id: "thr_tjgey58466:op:warning:1777884800",
  threadId: "thr_tjgey58466",
  turnId: null,
  sourceSeqStart: 2104,
  sourceSeqEnd: 2104,
  startedAt: 1777884800000,
  createdAt: 1777884800000,
  systemKind: "operation",
  operationKind: "warning",
  title: "Approaching rate limit",
  detail:
    "You are within 10% of your weekly usage limit. The provider will throttle requests once the limit is reached.",
  status: "completed",
  completedAt: 1777884800000,
});

const deprecationNotice: TimelineRow = systemRow({
  id: "thr_tjgey58466:op:deprecation:1777885200",
  threadId: "thr_tjgey58466",
  turnId: null,
  sourceSeqStart: 2156,
  sourceSeqEnd: 2156,
  startedAt: 1777885200000,
  createdAt: 1777885200000,
  systemKind: "operation",
  operationKind: "deprecation",
  title: "Deprecation notice",
  detail:
    "The `text_editor_20241022` tool name is deprecated.\n" +
    "Switch to `text_editor_20250124`. The old name will stop being accepted in a future API version.",
  status: "completed",
  completedAt: 1777885200000,
});

const parentChangeAssign: TimelineRow = systemRow({
  id: "thr_wxmxksux4w:op:parent-change:evt_vvidja2pjg",
  threadId: "thr_wxmxksux4w",
  turnId: null,
  sourceSeqStart: 14,
  sourceSeqEnd: 14,
  startedAt: 1777680600000,
  createdAt: 1777680600000,
  systemKind: "operation",
  operationKind: "parent-change",
  title: "Worker 3 assigned to Parent",
  detail: null,
  status: "completed",
  completedAt: 1777680600000,
  parentChange: {
    action: "assign",
    previousParentThreadId: null,
    previousParentThreadTitle: null,
    nextParentThreadId: "thr_bj3p5vk9py",
    nextParentThreadTitle: "Parent",
  },
});

const parentChangeRelease: TimelineRow = systemRow({
  id: "thr_wxmxksux4w:op:parent-change:release",
  threadId: "thr_wxmxksux4w",
  turnId: null,
  sourceSeqStart: 9_412,
  sourceSeqEnd: 9_412,
  startedAt: 1777724900000,
  createdAt: 1777724900000,
  systemKind: "operation",
  operationKind: "parent-change",
  title: "Worker 3 released from Parent",
  detail: null,
  status: "completed",
  completedAt: 1777724900000,
  parentChange: {
    action: "release",
    previousParentThreadId: "thr_bj3p5vk9py",
    previousParentThreadTitle: "Parent",
    nextParentThreadId: null,
    nextParentThreadTitle: null,
  },
});

const parentChangeTransfer: TimelineRow = systemRow({
  id: "thr_wxmxksux4w:op:parent-change:transfer",
  threadId: "thr_wxmxksux4w",
  turnId: null,
  sourceSeqStart: 11_004,
  sourceSeqEnd: 11_004,
  startedAt: 1777800100000,
  createdAt: 1777800100000,
  systemKind: "operation",
  operationKind: "parent-change",
  title: "Worker 3 transferred to Frontend Parent",
  detail: null,
  status: "completed",
  completedAt: 1777800100000,
  parentChange: {
    action: "transfer",
    previousParentThreadId: "thr_bj3p5vk9py",
    previousParentThreadTitle: "Parent",
    nextParentThreadId: "thr_mdg94kvcz8",
    nextParentThreadTitle: "Frontend Parent",
  },
});

const debugSystemRow: TimelineRow = systemRow({
  id: "thr_m22cr9ggq7:debug:1776898812",
  threadId: "thr_m22cr9ggq7",
  turnId: null,
  sourceSeqStart: 5400,
  sourceSeqEnd: 5400,
  startedAt: 1776898812000,
  createdAt: 1776898812000,
  systemKind: "debug",
  title: "sdk/system",
  detail: JSON.stringify(
    {
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        message: {
          type: "system",
          subtype: "task_updated",
          task_id: "brxrgs1yi",
          patch: { is_backgrounded: true },
          uuid: "9ddc5336-e69b-4d12-a962-a6e190473202",
          session_id: "f9d6e937-d5da-4a0c-9bdd-ec88e0a7b0c1",
        },
      },
    },
    null,
    2,
  ),
  status: null,
});

const errorSystemRow: TimelineRow = systemRow({
  id: "thr_u3r2maxtsx:error:provider:1777640200",
  threadId: "thr_u3r2maxtsx",
  turnId: null,
  sourceSeqStart: 188,
  sourceSeqEnd: 188,
  startedAt: 1777640200000,
  createdAt: 1777640200000,
  systemKind: "error",
  title: "Provider error",
  detail:
    "There's an issue with the selected model (opus-4.7). It may not exist or you may not have access to it. Run --model to pick a different model.",
  status: "error",
});

const reconnectSystemRow: TimelineRow = systemRow({
  id: "thr_zeb7z9afmw:reconnect:current",
  threadId: "thr_zeb7z9afmw",
  turnId: null,
  sourceSeqStart: 36_810,
  sourceSeqEnd: 36_810,
  startedAt: Date.now(),
  createdAt: Date.now(),
  systemKind: "reconnect",
  title: "Reconnecting to thread stream",
  detail: null,
  status: null,
});

export function Operations() {
  return (
    <StoryCard>
      <StoryRow
        label="thread-provisioning — pending, cleaned"
        hint="status=pending; no git/env command echo lines in the transcript"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            initialExpanded={new Set([provisioningPending.id])}
            timelineRows={[provisioningPending]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="thread-provisioning — completed"
        hint="status=completed; already matched the cleaned transcript shape"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            timelineRows={[provisioningCompleted]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="compaction — pending"
        hint="status=pending, title 'Compacting context' while the lifecycle is mid-flight"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            timelineRows={[compactionPending]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="compaction"
        hint="status=completed, title flips to 'Context compacted'"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            timelineRows={[compactionCompleted]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="context-clear"
        hint="thread/context/cleared → standalone completed operation"
      >
        <TimelineStage>
          <ThreadTimelineRows {...baseProps} timelineRows={[contextCleared]} />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="thread-interrupted"
        hint="reason=manual-stop → 'Stopped manually', status=interrupted"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            timelineRows={[threadInterruptedManualStop]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="provider-unhandled"
        hint="raw payload preserved in detail; humanized title"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            timelineRows={[providerUnhandled]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="warning"
        hint="provider/warning, category=general, status=completed"
      >
        <TimelineStage>
          <ThreadTimelineRows {...baseProps} timelineRows={[providerWarning]} />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="deprecation"
        hint="provider/warning, category=deprecation"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            timelineRows={[deprecationNotice]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="parent-change — assign"
        hint="ownership_change, action=assign, status=completed"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            timelineRows={[parentChangeAssign]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="parent-change — release"
        hint="ownership_change, action=release"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            timelineRows={[parentChangeRelease]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="parent-change — transfer"
        hint="ownership_change, action=transfer"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            timelineRows={[parentChangeTransfer]}
          />
        </TimelineStage>
      </StoryRow>
    </StoryCard>
  );
}

export function NonOperations() {
  return (
    <StoryCard>
      <StoryRow
        label="debug"
        hint="systemKind=debug, status=null — raw event title + JSON detail"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            initialExpanded={new Set([debugSystemRow.id])}
            timelineRows={[debugSystemRow]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="error"
        hint="systemKind=error, real provider error message"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            initialExpanded={new Set([errorSystemRow.id])}
            timelineRows={[errorSystemRow]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="reconnect"
        hint="systemKind=reconnect, status=null — a transient informational marker"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            timelineRows={[reconnectSystemRow]}
          />
        </TimelineStage>
      </StoryRow>
    </StoryCard>
  );
}
