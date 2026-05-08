import type { TimelineRow } from "@bb/server-contract";
import { ThreadTimelineRows } from "@/components/thread/timeline";
import { StoryCard, StoryRow } from "../../../../../.ladle/story-card";

export default {
  title: "thread/timeline/rows/System",
};

function TimelineStage({ children }: { children: React.ReactNode }) {
  return <div className="w-full max-w-[760px]">{children}</div>;
}

const baseProps = {
  loadingTurnSummaryIds: new Set<string>(),
  erroredTurnSummaryIds: new Set<string>(),
  onLoadTurnSummaryRows: () => {},
  // projectId enables the thread-link resolver in `ThreadTimelineRows`, so
  // manager-assignment titles render as `<a>` links to the manager thread.
  projectId: "proj_gyz9przugq",
  threadRuntimeDisplayStatus: "idle" as const,
  turnSummaryRowsIdentity: "story",
  turnSummaryRowsById: {},
};

// ---------------------------------------------------------------------------
// System rows. Real titles, details and lifecycle shapes drawn from
// ~/.bb-dev/bb.db events. Each row is the projected shape that the timeline
// renderer consumes — see thread-view/src/build-thread-timeline.ts and
// parse-operation-message.ts for the upstream construction.
// ---------------------------------------------------------------------------

// thr_sjgc9pafri (env_etyr7f84cg) — provisioning still active. The detail is
// the formatted transcript (steps with elapsed durations) the agent renders
// while the worktree is being prepared.
const provisioningPending: TimelineRow = {
  "id": "thr_sjgc9pafri:op:thread-provisioning:tpv_4if68xgg7d",
  "threadId": "thr_sjgc9pafri",
  "turnId": null,
  "sourceSeqStart": 12,
  "sourceSeqEnd": 28,
  "startedAt": Date.now() - 9_000,
  "createdAt": Date.now(),
  "kind": "system",
  "systemKind": "operation",
  "operationKind": "thread-provisioning",
  "title": "Provisioning thread",
  "detail":
    "Creating worktree (305ms)\n" +
    "git worktree add -B bb/investigate-thread-timeline-load-thr_sjgc9pafri /Users/michael/.bb-dev/worktrees/env_etyr7f84cg/bb\n" +
    "HEAD is now at 37eeec85 Refactor timeline row titles\n" +
    "Preparing worktree (new branch 'bb/investigate-thread-timeline-load-thr_sjgc9pafri')\n" +
    "Created worktree (305ms)\n" +
    "Using workspace: /Users/michael/.bb-dev/worktrees/env_etyr7f84cg/bb\n" +
    "Running .bb-env-setup.sh\n" +
    "env bash .bb-env-setup.sh\n" +
    "[bb-env-setup] Running: pnpm install\n" +
    "Scope: all 35 workspace projects\n" +
    "Lockfile is up to date, resolution step is skipped\n" +
    "Progress: resolved 1094, reused 1093, downloaded 0, added 877",
  "status": "pending",
};

// thr_sjgc9pafri provisioning — completed shape. Title flips to "Provisioned
// thread", detail keeps the transcript and gains the terminal duration line.
const provisioningCompleted: TimelineRow = {
  "id": "thr_sjgc9pafri:op:thread-provisioning:tpv_4if68xgg7d:completed",
  "threadId": "thr_sjgc9pafri",
  "turnId": null,
  "sourceSeqStart": 12,
  "sourceSeqEnd": 47,
  "startedAt": 1778027661741,
  "createdAt": 1778027670469,
  "kind": "system",
  "systemKind": "operation",
  "operationKind": "thread-provisioning",
  "title": "Provisioned thread",
  "detail":
    "Created worktree (305ms)\n" +
    "Using workspace: /Users/michael/.bb-dev/worktrees/env_etyr7f84cg/bb\n" +
    ".bb-env-setup.sh finished (8.2s)\n" +
    "Using branch: bb/investigate-thread-timeline-load-thr_sjgc9pafri (37eeec8)\n" +
    "Provisioned thread (8.7s)",
  "status": "completed",
};

// thr_iqcz6et4rd — `thread/compacted` event. The projector inserts a
// "Compacting context" row at compaction-begin and rewrites the title to
// "Context compacted" once the lifecycle ends. Real `thread/compacted`
// events carry no detail — the parser only sets a title and status. The row
// is therefore not expandable in production.
const compactionCompleted: TimelineRow = {
  "id": "thr_iqcz6et4rd:op:compaction:turn-019dab12",
  "threadId": "thr_iqcz6et4rd",
  "turnId": "019dab12-44f1-7c10-9af3-7a85c3f2b1d2",
  "sourceSeqStart": 4218,
  "sourceSeqEnd": 4231,
  "startedAt": 1777890113200,
  "createdAt": 1777890119840,
  "kind": "system",
  "systemKind": "operation",
  "operationKind": "compaction",
  "title": "Context compacted",
  "detail": null,
  "status": "completed",
};

// "Compacting context" while the lifecycle is mid-flight. Triggered by an
// `item/started` event with `item.type: "contextCompaction"` (see
// `compaction-lifecycle.ts`). status=pending, detail=null in production.
const compactionPending: TimelineRow = {
  "id": "thr_iqcz6et4rd:op:compaction:turn-019dab15",
  "threadId": "thr_iqcz6et4rd",
  "turnId": "019dab15-44f1-7c10-9af3-7a85c3f2b1d2",
  "sourceSeqStart": 4350,
  "sourceSeqEnd": 4350,
  "startedAt": Date.now(),
  "createdAt": Date.now(),
  "kind": "system",
  "systemKind": "operation",
  "operationKind": "compaction",
  "title": "Compacting context",
  "detail": null,
  "status": "pending",
};

// thr_m8dsv5hjpi — `system/thread/interrupted` event with reason
// "manual-stop". `parseOperationMessage` maps the reason to a title via
// threadInterruptedTitle() and sets status="interrupted". Detail is null:
// the interrupted projector emits no body text.
const threadInterruptedManualStop: TimelineRow = {
  "id": "thr_m8dsv5hjpi:op:thread-interrupted:1776810312",
  "threadId": "thr_m8dsv5hjpi",
  "turnId": null,
  "sourceSeqStart": 318,
  "sourceSeqEnd": 318,
  "startedAt": 1776810312000,
  "createdAt": 1776810312000,
  "kind": "system",
  "systemKind": "operation",
  "operationKind": "thread-interrupted",
  "title": "Stopped manually",
  "detail": null,
  "status": "interrupted",
};

// thr_m22cr9ggq7 — provider/unhandled SDK system event from claude-code.
// Title comes from humanizeRawType("sdk/system") + provider name; detail
// is built by buildProviderUnhandledDetail() and includes the raw payload.
const providerUnhandled: TimelineRow = {
  "id": "thr_m22cr9ggq7:op:provider-unhandled:1776898870",
  "threadId": "thr_m22cr9ggq7",
  "turnId": null,
  "sourceSeqStart": 5612,
  "sourceSeqEnd": 5612,
  "startedAt": 1776898870858,
  "createdAt": 1776898870858,
  "kind": "system",
  "systemKind": "operation",
  "operationKind": "provider-unhandled",
  "title": "Unhandled Claude Code event",
  "detail":
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
  "status": "completed",
};

// provider/warning, category=general — the projector emits a generic
// "warning" operation. We lift the human title from a real model
// rate-limit notice the runtime surfaces alongside provider/error events.
const providerWarning: TimelineRow = {
  "id": "thr_tjgey58466:op:warning:1777884800",
  "threadId": "thr_tjgey58466",
  "turnId": null,
  "sourceSeqStart": 2104,
  "sourceSeqEnd": 2104,
  "startedAt": 1777884800000,
  "createdAt": 1777884800000,
  "kind": "system",
  "systemKind": "operation",
  "operationKind": "warning",
  "title": "Approaching rate limit",
  "detail":
    "You are within 10% of your weekly usage limit. The provider will throttle requests once the limit is reached.",
  "status": "completed",
};

// provider/warning with category=deprecation — title becomes
// "Deprecation notice" and detail joins the summary + details lines.
const deprecationNotice: TimelineRow = {
  "id": "thr_tjgey58466:op:deprecation:1777885200",
  "threadId": "thr_tjgey58466",
  "turnId": null,
  "sourceSeqStart": 2156,
  "sourceSeqEnd": 2156,
  "startedAt": 1777885200000,
  "createdAt": 1777885200000,
  "kind": "system",
  "systemKind": "operation",
  "operationKind": "deprecation",
  "title": "Deprecation notice",
  "detail":
    "The `text_editor_20241022` tool name is deprecated.\n" +
    "Switch to `text_editor_20250124`. The old name will stop being accepted in a future API version.",
  "status": "completed",
};

// system/operation with operation="ownership_change", action="assign". The
// projector routes this to the manager-assignment row variant, which
// requires `status` and a `managerAssignment` object. Real event from
// thr_wxmxksux4w (assigned to manager thr_bj3p5vk9py "Manager").
const managerAssignmentAssign: TimelineRow = {
  "id": "thr_wxmxksux4w:op:manager-assignment:evt_vvidja2pjg",
  "threadId": "thr_wxmxksux4w",
  "turnId": null,
  "sourceSeqStart": 14,
  "sourceSeqEnd": 14,
  "startedAt": 1777680600000,
  "createdAt": 1777680600000,
  "kind": "system",
  "systemKind": "operation",
  "operationKind": "manager-assignment",
  "title": "Thread assigned to manager",
  "detail": null,
  "status": "completed",
  "managerAssignment": {
    "action": "assign",
    "previousManagerThreadId": null,
    "previousManagerThreadTitle": null,
    "nextManagerThreadId": "thr_bj3p5vk9py",
    "nextManagerThreadTitle": "Manager",
  },
};

// Manager-assignment release. Construct a plausible row using the same
// schema; ownership_change action="release" titles via the manager-assignment
// title builder. The manager link points back to the previous parent thread.
const managerAssignmentRelease: TimelineRow = {
  "id": "thr_wxmxksux4w:op:manager-assignment:release",
  "threadId": "thr_wxmxksux4w",
  "turnId": null,
  "sourceSeqStart": 9_412,
  "sourceSeqEnd": 9_412,
  "startedAt": 1777724900000,
  "createdAt": 1777724900000,
  "kind": "system",
  "systemKind": "operation",
  "operationKind": "manager-assignment",
  "title": "Thread released from manager",
  "detail": null,
  "status": "completed",
  "managerAssignment": {
    "action": "release",
    "previousManagerThreadId": "thr_bj3p5vk9py",
    "previousManagerThreadTitle": "Manager",
    "nextManagerThreadId": null,
    "nextManagerThreadTitle": null,
  },
};

// Manager-assignment transfer between two real manager threads.
const managerAssignmentTransfer: TimelineRow = {
  "id": "thr_wxmxksux4w:op:manager-assignment:transfer",
  "threadId": "thr_wxmxksux4w",
  "turnId": null,
  "sourceSeqStart": 11_004,
  "sourceSeqEnd": 11_004,
  "startedAt": 1777800100000,
  "createdAt": 1777800100000,
  "kind": "system",
  "systemKind": "operation",
  "operationKind": "manager-assignment",
  "title": "Thread transferred to new manager",
  "detail": null,
  "status": "completed",
  "managerAssignment": {
    "action": "transfer",
    "previousManagerThreadId": "thr_bj3p5vk9py",
    "previousManagerThreadTitle": "Manager",
    "nextManagerThreadId": "thr_mdg94kvcz8",
    "nextManagerThreadTitle": "Frontend Manager",
  },
};

// Non-operation system row, systemKind="debug". The projector emits these
// for raw provider events when debug routing is enabled — title is the
// rawType, detail is the JSON payload.
const debugSystemRow: TimelineRow = {
  "id": "thr_m22cr9ggq7:debug:1776898812",
  "threadId": "thr_m22cr9ggq7",
  "turnId": null,
  "sourceSeqStart": 5400,
  "sourceSeqEnd": 5400,
  "startedAt": 1776898812000,
  "createdAt": 1776898812000,
  "kind": "system",
  "systemKind": "debug",
  "title": "sdk/system",
  "detail": JSON.stringify(
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
  "status": null,
};

// Non-operation system row, systemKind="error". Real provider/error
// payload from thr_u3r2maxtsx — surfaced when the runtime emits a
// provider-level failure. Detail is the model-not-found message.
const errorSystemRow: TimelineRow = {
  "id": "thr_u3r2maxtsx:error:provider:1777640200",
  "threadId": "thr_u3r2maxtsx",
  "turnId": null,
  "sourceSeqStart": 188,
  "sourceSeqEnd": 188,
  "startedAt": 1777640200000,
  "createdAt": 1777640200000,
  "kind": "system",
  "systemKind": "error",
  "title": "Provider error",
  "detail":
    "There's an issue with the selected model (opus-4.7). It may not exist or you may not have access to it. Run --model to pick a different model.",
  "status": "error",
};

// Non-operation system row, systemKind="reconnect". Surfaced while the
// client reconnects to a thread after a transport drop — the row sits in
// pending until the stream reattaches. status is "pending"; use Date.now
// so the streaming styling shows.
const reconnectSystemRow: TimelineRow = {
  "id": "thr_zeb7z9afmw:reconnect:current",
  "threadId": "thr_zeb7z9afmw",
  "turnId": null,
  "sourceSeqStart": 36_810,
  "sourceSeqEnd": 36_810,
  "startedAt": Date.now(),
  "createdAt": Date.now(),
  "kind": "system",
  "systemKind": "reconnect",
  "title": "Reconnecting to thread stream",
  "detail": null,
  "status": "pending",
};

export function Operations() {
  return (
    <StoryCard>
      <StoryRow
        label="thread-provisioning — pending"
        hint="long initial setup, status=pending, transcript still streaming"
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
        hint="status=completed, transcript + terminal duration line"
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
          <ThreadTimelineRows
            {...baseProps}
            timelineRows={[providerWarning]}
          />
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
        label="manager-assignment — assign"
        hint="ownership_change, action=assign, status=completed"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            timelineRows={[managerAssignmentAssign]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="manager-assignment — release"
        hint="ownership_change, action=release"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            timelineRows={[managerAssignmentRelease]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="manager-assignment — transfer"
        hint="ownership_change, action=transfer"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            timelineRows={[managerAssignmentTransfer]}
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
        label="reconnect — pending"
        hint="systemKind=reconnect, status=pending while transport reattaches"
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
