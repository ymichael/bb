import type { TimelineRow } from "@bb/server-contract";
import { ThreadTimelineRows } from "@/components/thread/timeline";
import { approvalRow } from "@/test/fixtures/thread-timeline-rows";
import { StoryCard, StoryRow } from "../../../../../.ladle/story-card";

export default {
  title: "thread/timeline/rows/Approval",
};

function TimelineStage({ children }: { children: React.ReactNode }) {
  return <div className="w-full max-w-[760px]">{children}</div>;
}

const baseProps = {
  threadRuntimeDisplayStatus: "idle" as const,
  workspaceRootPath: undefined,
};

const fileEditWaiting: TimelineRow = approvalRow({
  id: "thr_j6783aj3qb:approval:call_yQY9t94mwzZaswKUZVxAOEqQ",
  threadId: "thr_j6783aj3qb",
  turnId: "019dd3c0-1a2b-7e44-9c11-fd0a1b2c3d4e",
  sourceSeqStart: 4210,
  sourceSeqEnd: 4210,
  startedAt: Date.now(),
  createdAt: Date.now(),
  status: "pending",
  interactionId: "pi_4r1k9c8q",
  approvalKind: "file-edit",
  lifecycle: "waiting",
  itemId: "call_yQY9t94mwzZaswKUZVxAOEqQ",
  toolName: null,
});

const fileEditDenied: TimelineRow = approvalRow({
  id: "thr_j6783aj3qb:approval:call_denied_file_edit",
  threadId: "thr_j6783aj3qb",
  turnId: "019dd3c0-1a2b-7e44-9c11-fd0a1b2c3d4e",
  sourceSeqStart: 4232,
  sourceSeqEnd: 4232,
  startedAt: 1777340000000,
  createdAt: 1777340002500,
  status: "completed",
  interactionId: "pi_4r1k9c8q",
  approvalKind: "file-edit",
  lifecycle: "denied",
  itemId: "call_denied_file_edit",
  toolName: null,
});

const permissionGrantPending: TimelineRow = approvalRow({
  id: "thr_86exnrrjpq:approval:toolu_015GS2aek3sXDpDQFKt8aL4x",
  threadId: "thr_86exnrrjpq",
  turnId: "019dd2af-7c63-7a91-bb1f-3e8d2f1a4b5c",
  sourceSeqStart: 1812,
  sourceSeqEnd: 1812,
  startedAt: Date.now(),
  createdAt: Date.now(),
  status: "pending",
  interactionId: "pi_8h3v2x9d",
  approvalKind: "permission-grant",
  lifecycle: "pending",
  grantScope: null,
  statusReason: null,
  itemId: "toolu_015GS2aek3sXDpDQFKt8aL4x",
  toolName: "bash",
});

const permissionGrantResolving: TimelineRow = approvalRow({
  id: "thr_86exnrrjpq:approval:toolu_resolving",
  threadId: "thr_86exnrrjpq",
  turnId: "019dd2af-7c63-7a91-bb1f-3e8d2f1a4b5c",
  sourceSeqStart: 1813,
  sourceSeqEnd: 1813,
  startedAt: Date.now(),
  createdAt: Date.now(),
  status: "pending",
  interactionId: "pi_8h3v2x9d",
  approvalKind: "permission-grant",
  lifecycle: "resolving",
  grantScope: "turn",
  statusReason: null,
  itemId: "toolu_015GS2aek3sXDpDQFKt8aL4x",
  toolName: "bash",
});

const permissionGrantGrantedTurn: TimelineRow = approvalRow({
  id: "thr_yn2i6jeaca:approval:toolu_01EoPNLPpnjDWJvvVChb8cc9",
  threadId: "thr_yn2i6jeaca",
  turnId: "019dd501-9af2-7c10-b6e3-21bd9c3e7e80",
  sourceSeqStart: 902,
  sourceSeqEnd: 902,
  startedAt: 1777341500000,
  createdAt: 1777341502800,
  status: "completed",
  interactionId: "pi_2k7m4p1n",
  approvalKind: "permission-grant",
  lifecycle: "granted",
  grantScope: "turn",
  statusReason: null,
  itemId: "toolu_01EoPNLPpnjDWJvvVChb8cc9",
  toolName: "TodoWrite",
});

const permissionGrantGrantedSession: TimelineRow = approvalRow({
  id: "thr_8fziwbu655:approval:toolu_01PmsrQXiBWMmdU5Ub2HmZUt",
  threadId: "thr_8fziwbu655",
  turnId: "019dd610-3b7a-7d22-9e4f-58a09b1c2d3e",
  sourceSeqStart: 5104,
  sourceSeqEnd: 5104,
  startedAt: 1777343200000,
  createdAt: 1777343204150,
  status: "completed",
  interactionId: "pi_9p5q6r2s",
  approvalKind: "permission-grant",
  lifecycle: "granted",
  grantScope: "session",
  statusReason: null,
  itemId: "toolu_01PmsrQXiBWMmdU5Ub2HmZUt",
  toolName: "Agent",
});

const permissionGrantDenied: TimelineRow = approvalRow({
  id: "thr_m8dsv5hjpi:approval:call_jv9vabbTnmbjcBXLfwaQRjjG",
  threadId: "thr_m8dsv5hjpi",
  turnId: "019dd711-0c4e-7e88-bb3c-7f2abc5d6e7f",
  sourceSeqStart: 311,
  sourceSeqEnd: 311,
  startedAt: 1777344400000,
  createdAt: 1777344404900,
  status: "completed",
  interactionId: "pi_3t8u4v5w",
  approvalKind: "permission-grant",
  lifecycle: "denied",
  grantScope: null,
  statusReason: "User rejected this command",
  itemId: "call_jv9vabbTnmbjcBXLfwaQRjjG",
  toolName: "bash",
});

const permissionGrantInterrupted: TimelineRow = approvalRow({
  id: "thr_86exnrrjpq:approval:toolu_interrupted",
  threadId: "thr_86exnrrjpq",
  turnId: "019dd2af-7c63-7a91-bb1f-3e8d2f1a4b5c",
  sourceSeqStart: 1820,
  sourceSeqEnd: 1820,
  startedAt: 1777345100000,
  createdAt: 1777345105000,
  status: "interrupted",
  interactionId: "pi_5x9y0z1a",
  approvalKind: "permission-grant",
  lifecycle: "interrupted",
  grantScope: null,
  statusReason: null,
  itemId: "toolu_015GS2aek3sXDpDQFKt8aL4x",
  toolName: "bash",
});

const permissionGrantInterruptedBySession: TimelineRow = approvalRow({
  id: "thr_yn2i6jeaca:approval:toolu_interrupted_session",
  threadId: "thr_yn2i6jeaca",
  turnId: "019dd501-9af2-7c10-b6e3-21bd9c3e7e80",
  sourceSeqStart: 950,
  sourceSeqEnd: 950,
  startedAt: 1777345600000,
  createdAt: 1777345630000,
  status: "interrupted",
  interactionId: "pi_6b7c8d9e",
  approvalKind: "permission-grant",
  lifecycle: "interrupted",
  grantScope: null,
  statusReason:
    "Host daemon session expired while awaiting user interaction; retry the thread to continue",
  itemId: "toolu_01EoPNLPpnjDWJvvVChb8cc9",
  toolName: "TodoWrite",
});

export function Overview() {
  return (
    <>
      <StoryCard>
        <StoryRow
          label="file-edit — waiting"
          hint="lifecycle=waiting, status=pending — gate before any file edits land"
        >
          <TimelineStage>
            <ThreadTimelineRows
              {...baseProps}
              timelineRows={[fileEditWaiting]}
            />
          </TimelineStage>
        </StoryRow>
        <StoryRow
          label="file-edit — denied"
          hint="lifecycle=denied, status=completed — user rejected the edit"
        >
          <TimelineStage>
            <ThreadTimelineRows
              {...baseProps}
              timelineRows={[fileEditDenied]}
            />
          </TimelineStage>
        </StoryRow>
      </StoryCard>
      <StoryCard>
        <StoryRow
          label="permission-grant — pending"
          hint="lifecycle=pending, grantScope=null — awaiting user choice"
        >
          <TimelineStage>
            <ThreadTimelineRows
              {...baseProps}
              timelineRows={[permissionGrantPending]}
            />
          </TimelineStage>
        </StoryRow>
        <StoryRow
          label="permission-grant — resolving"
          hint="lifecycle=resolving, status=pending — resolution in-flight to daemon"
        >
          <TimelineStage>
            <ThreadTimelineRows
              {...baseProps}
              timelineRows={[permissionGrantResolving]}
            />
          </TimelineStage>
        </StoryRow>
        <StoryRow
          label="permission-grant — granted (turn)"
          hint="lifecycle=granted, grantScope=turn"
        >
          <TimelineStage>
            <ThreadTimelineRows
              {...baseProps}
              timelineRows={[permissionGrantGrantedTurn]}
            />
          </TimelineStage>
        </StoryRow>
        <StoryRow
          label="permission-grant — granted (session)"
          hint="lifecycle=granted, grantScope=session"
        >
          <TimelineStage>
            <ThreadTimelineRows
              {...baseProps}
              timelineRows={[permissionGrantGrantedSession]}
            />
          </TimelineStage>
        </StoryRow>
        <StoryRow
          label="permission-grant — denied"
          hint="lifecycle=denied, statusReason set"
        >
          <TimelineStage>
            <ThreadTimelineRows
              {...baseProps}
              timelineRows={[permissionGrantDenied]}
            />
          </TimelineStage>
        </StoryRow>
        <StoryRow
          label="permission-grant — interrupted"
          hint="lifecycle=interrupted, status=interrupted — turn cancelled before resolve"
        >
          <TimelineStage>
            <ThreadTimelineRows
              {...baseProps}
              timelineRows={[permissionGrantInterrupted]}
            />
          </TimelineStage>
        </StoryRow>
        <StoryRow
          label="permission-grant — interrupted session"
          hint="lifecycle=interrupted, session expired while awaiting interaction"
        >
          <TimelineStage>
            <ThreadTimelineRows
              {...baseProps}
              timelineRows={[permissionGrantInterruptedBySession]}
            />
          </TimelineStage>
        </StoryRow>
      </StoryCard>
    </>
  );
}
