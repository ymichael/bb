import type { TimelineRow } from "@bb/server-contract";
import { ThreadTimelineRows } from "@/components/thread/timeline";
import { StoryCard, StoryRow } from "../../../../../.ladle/story-card";

export default {
  title: "thread/timeline/rows/Web Search",
};

function TimelineStage({ children }: { children: React.ReactNode }) {
  return <div className="w-full max-w-[760px]">{children}</div>;
}

const baseProps = {
  loadingTurnSummaryIds: new Set<string>(),
  erroredTurnSummaryIds: new Set<string>(),
  onLoadTurnSummaryRows: () => {},
  threadRuntimeDisplayStatus: "idle" as const,
  turnSummaryRowsIdentity: "story",
  turnSummaryRowsById: {},
};

// ---------------------------------------------------------------------------
// Real web-search rows pulled from live threads in ~/.bb-dev/bb.db.
// webSearch events emit only `item/completed`, so startedAt == createdAt.
// ---------------------------------------------------------------------------

// thr_yr83zs2m7f — sequence 7467. Three editor-CLI doc queries.
const multiQuerySearch: TimelineRow = {
  "id": "thr_yr83zs2m7f:web-search:ws_0e85bcec855f8f510169eff17843408198a4a02ff7f35a29bb",
  "threadId": "thr_yr83zs2m7f",
  "turnId": "019dd144-eb1e-7bd1-b4a0-a966e1fb56e0",
  "sourceSeqStart": 7467,
  "sourceSeqEnd": 7467,
  "startedAt": 1777332611885,
  "createdAt": 1777332611885,
  "kind": "work",
  "workKind": "web-search",
  "status": "completed",
  "callId": "ws_0e85bcec855f8f510169eff17843408198a4a02ff7f35a29bb",
  "queries": [
    "VS Code --goto official docs",
    "Sublime Text command line line number official",
    "Zed editor command line line number docs",
  ],
  "completedAt": 1777332611885,
};

// thr_zeb7z9afmw — sequence 36100. Single short query with quoted symbol.
const singleQuerySearch: TimelineRow = {
  "id": "thr_zeb7z9afmw:web-search:ws_00cfb2afcbffe81a0169f0041d73e4819b8801cbc6cfc3ff66",
  "threadId": "thr_zeb7z9afmw",
  "turnId": "019dd185-ef12-7d50-aa48-47882e9c8aaf",
  "sourceSeqStart": 36100,
  "sourceSeqEnd": 36100,
  "startedAt": 1777337374741,
  "createdAt": 1777337374741,
  "kind": "work",
  "workKind": "web-search",
  "status": "completed",
  "callId": "ws_00cfb2afcbffe81a0169f0041d73e4819b8801cbc6cfc3ff66",
  "queries": ["\"resolveTimelineTurnSummaryDetailsRows\""],
  "completedAt": 1777337374741,
};

// thr_p93awt656h — sequence 3739. Single longer query about TanStack Query v5.
const tanstackSearch: TimelineRow = {
  "id": "thr_p93awt656h:web-search:ws_034f339785f02f2b0169f23ac02c9881908f9a6bc38167bcbc",
  "threadId": "thr_p93awt656h",
  "turnId": "019dda34-6439-7bf0-b35c-371f3d8c4946",
  "sourceSeqStart": 3739,
  "sourceSeqEnd": 3739,
  "startedAt": 1777482436862,
  "createdAt": 1777482436862,
  "kind": "work",
  "workKind": "web-search",
  "status": "completed",
  "callId": "ws_034f339785f02f2b0169f23ac02c9881908f9a6bc38167bcbc",
  "queries": [
    "TanStack Query v5 placeholderData isPlaceholderData error status isError isLoadingError official docs",
  ],
  "completedAt": 1777482436862,
};

// Running — based on the same thr_yr83zs2m7f search, but mid-flight: status=pending,
// completedAt null. startedAt/createdAt = Date.now() so the "running" timing reads live.
const runningSearch: TimelineRow = {
  "id": "thr_yr83zs2m7f:web-search:ws_running",
  "threadId": "thr_yr83zs2m7f",
  "turnId": "019dd144-eb1e-7bd1-b4a0-a966e1fb56e0",
  "sourceSeqStart": 7467,
  "sourceSeqEnd": 7467,
  "startedAt": Date.now(),
  "createdAt": Date.now(),
  "kind": "work",
  "workKind": "web-search",
  "status": "pending",
  "callId": "ws_running",
  "queries": [
    "VS Code --goto official docs",
    "Sublime Text command line line number official",
    "Zed editor command line line number docs",
  ],
  "completedAt": null,
};

// Error — same shape as the multi-query search but flipped to status=error.
// No real "errored" web-search rows exist in ~/.bb-dev/bb.db; we reuse a real
// queries payload and surface the error state.
const erroredSearch: TimelineRow = {
  "id": "thr_yr83zs2m7f:web-search:ws_errored",
  "threadId": "thr_yr83zs2m7f",
  "turnId": "019dd144-eb1e-7bd1-b4a0-a966e1fb56e0",
  "sourceSeqStart": 7473,
  "sourceSeqEnd": 7473,
  "startedAt": 1777332628546,
  "createdAt": 1777332628546,
  "kind": "work",
  "workKind": "web-search",
  "status": "error",
  "callId": "ws_errored",
  "queries": [
    "site:code.visualstudio.com command line interface --goto VS Code",
    "site:code.visualstudio.com vscode command line --goto",
  ],
  "completedAt": 1777332628546,
};

// Interrupted — agent cancelled mid-search.
const interruptedSearch: TimelineRow = {
  "id": "thr_fjav9z98vu:web-search:ws_interrupted",
  "threadId": "thr_fjav9z98vu",
  "turnId": "019df55a-9d47-74c2-87ea-458fa28febf6",
  "sourceSeqStart": 1693,
  "sourceSeqEnd": 1693,
  "startedAt": 1777938068368,
  "createdAt": 1777938068368,
  "kind": "work",
  "workKind": "web-search",
  "status": "interrupted",
  "callId": "ws_interrupted",
  "queries": [
    "openai codex github thread archived turn/start cannot resume archived thread",
    "github openai codex app-server turn/start archived thread archive_thread.rs",
  ],
  "completedAt": null,
};

export function Overview() {
  return (
    <StoryCard>
      <StoryRow
        label="collapsed — completed"
        hint="multiple queries, status=completed (default)"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            timelineRows={[multiQuerySearch]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="collapsed — running"
        hint="status=pending, completedAt null"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            timelineRows={[runningSearch]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="collapsed — error"
        hint="status=error"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            timelineRows={[erroredSearch]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="collapsed — interrupted"
        hint="status=interrupted, agent cancelled mid-search"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            timelineRows={[interruptedSearch]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="collapsed — single query"
        hint="one short query (quoted symbol)"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            timelineRows={[singleQuerySearch]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="collapsed — multiple queries"
        hint="three queries from a real example"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            timelineRows={[multiQuerySearch]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="collapsed — long single query"
        hint="one long natural-language query"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            timelineRows={[tanstackSearch]}
          />
        </TimelineStage>
      </StoryRow>
    </StoryCard>
  );
}
