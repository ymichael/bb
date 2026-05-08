import type { TimelineRow } from "@bb/server-contract";
import { ThreadTimelineRows } from "@/components/thread/timeline";
import { StoryCard, StoryRow } from "../../../../../.ladle/story-card";

export default {
  title: "thread/timeline/rows/Web Fetch",
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
// Real web-fetch rows pulled from live threads in ~/.bb-dev/bb.db.
// webFetch events emit only `item/completed`, so startedAt == createdAt
// unless an explicit `item/started` exists (e.g. the Anthropic toolu_ row).
// ---------------------------------------------------------------------------

// thr_yr83zs2m7f — sequence 7470. URL only (Codex provider — prompt/pattern null).
const urlOnlyFetch: TimelineRow = {
  "id": "thr_yr83zs2m7f:web-fetch:ws_0e85bcec855f8f510169eff1846b0c81989bfa5e67bb99a484",
  "threadId": "thr_yr83zs2m7f",
  "turnId": "019dd144-eb1e-7bd1-b4a0-a966e1fb56e0",
  "sourceSeqStart": 7470,
  "sourceSeqEnd": 7470,
  "startedAt": 1777332618113,
  "createdAt": 1777332618113,
  "kind": "work",
  "workKind": "web-fetch",
  "status": "completed",
  "callId": "ws_0e85bcec855f8f510169eff1846b0c81989bfa5e67bb99a484",
  "url": "https://zed.dev/docs/reference/cli.html",
  "prompt": null,
  "pattern": null,
  "completedAt": 1777332618113,
};

// thr_p93awt656h — TanStack docs URL only.
const tanstackFetch: TimelineRow = {
  "id": "thr_p93awt656h:web-fetch:ws_034f339785f02f2b0169f23ac4f1d8819085d6c92cbdb71e5e",
  "threadId": "thr_p93awt656h",
  "turnId": "019dda34-6439-7bf0-b35c-371f3d8c4946",
  "sourceSeqStart": 3742,
  "sourceSeqEnd": 3742,
  "startedAt": 1777482437867,
  "createdAt": 1777482437867,
  "kind": "work",
  "workKind": "web-fetch",
  "status": "completed",
  "callId": "ws_034f339785f02f2b0169f23ac4f1d8819085d6c92cbdb71e5e",
  "url": "https://tanstack.dev/query/v5/docs/framework/react/reference/useQuery",
  "prompt": null,
  "pattern": null,
  "completedAt": 1777482437867,
};

// thr_3vw9r8igrb — sequence 1202/1203. Anthropic web-fetch with a real prompt.
// item/started at 1777481783565, item/completed at 1777481786285.
const fetchWithPrompt: TimelineRow = {
  "id": "thr_3vw9r8igrb:web-fetch:toolu_01GVztZgXKMtefajWjMwANng",
  "threadId": "thr_3vw9r8igrb",
  "turnId": "turn_59e461a531904883_3",
  "sourceSeqStart": 1202,
  "sourceSeqEnd": 1203,
  "startedAt": 1777481783565,
  "createdAt": 1777481786285,
  "kind": "work",
  "workKind": "web-fetch",
  "status": "completed",
  "callId": "toolu_01GVztZgXKMtefajWjMwANng",
  "url": "https://trees.software/",
  "prompt":
    "What is this product/library? Who makes it? Is it open source or a hosted/commercial product? What is the license? Is there an npm package? Does it support React? Is it a JavaScript layout library, an IDE, a tree-data tool, or something else? Quote any relevant tagline. Look for pricing, install instructions, GitHub link.",
  "pattern": null,
  "completedAt": 1777481786285,
};

// thr_fjav9z98vu — sequence 1705. Real fetch with a `pattern` (grep-style hint).
const fetchWithPattern: TimelineRow = {
  "id": "thr_fjav9z98vu:web-fetch:ws_006e4116502b07000169f92e9c91748191820718192d32c819",
  "threadId": "thr_fjav9z98vu",
  "turnId": "019df55a-9d47-74c2-87ea-458fa28febf6",
  "sourceSeqStart": 1705,
  "sourceSeqEnd": 1705,
  "startedAt": 1777938079295,
  "createdAt": 1777938079295,
  "kind": "work",
  "workKind": "web-fetch",
  "status": "completed",
  "callId": "ws_006e4116502b07000169f92e9c91748191820718192d32c819",
  "url":
    "https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server/src/codex_message_processor.rs",
  "prompt": null,
  "pattern": "is archived",
  "completedAt": 1777938079295,
};

// Running — based on the same Cursor docs URL, but mid-flight: status=pending,
// completedAt null. startedAt/createdAt = Date.now() so the "running" timing reads live.
const runningFetch: TimelineRow = {
  "id": "thr_yr83zs2m7f:web-fetch:ws_running",
  "threadId": "thr_yr83zs2m7f",
  "turnId": "019dd144-eb1e-7bd1-b4a0-a966e1fb56e0",
  "sourceSeqStart": 7479,
  "sourceSeqEnd": 7479,
  "startedAt": Date.now(),
  "createdAt": Date.now(),
  "kind": "work",
  "workKind": "web-fetch",
  "status": "pending",
  "callId": "ws_running",
  "url": "https://docs.cursor.com/tools/cli",
  "prompt": null,
  "pattern": null,
  "completedAt": null,
};

// Error — same shape as urlOnlyFetch but flipped to status=error.
// No real "errored" web-fetch rows exist in ~/.bb-dev/bb.db; we reuse a real
// URL payload and surface the error state.
const erroredFetch: TimelineRow = {
  "id": "thr_yr83zs2m7f:web-fetch:ws_errored",
  "threadId": "thr_yr83zs2m7f",
  "turnId": "019dd144-eb1e-7bd1-b4a0-a966e1fb56e0",
  "sourceSeqStart": 7479,
  "sourceSeqEnd": 7479,
  "startedAt": 1777332653385,
  "createdAt": 1777332653385,
  "kind": "work",
  "workKind": "web-fetch",
  "status": "error",
  "callId": "ws_errored",
  "url": "https://docs.cursor.com/tools/cli",
  "prompt": null,
  "pattern": null,
  "completedAt": 1777332653385,
};

// Interrupted — agent cancelled mid-fetch.
const interruptedFetch: TimelineRow = {
  "id": "thr_fjav9z98vu:web-fetch:ws_interrupted",
  "threadId": "thr_fjav9z98vu",
  "turnId": "019df55a-9d47-74c2-87ea-458fa28febf6",
  "sourceSeqStart": 1699,
  "sourceSeqEnd": 1699,
  "startedAt": 1777938073680,
  "createdAt": 1777938073680,
  "kind": "work",
  "workKind": "web-fetch",
  "status": "interrupted",
  "callId": "ws_interrupted",
  "url":
    "https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md",
  "prompt": null,
  "pattern": null,
  "completedAt": null,
};

export function Overview() {
  return (
    <StoryCard>
      <StoryRow
        label="collapsed — completed"
        hint="url only, status=completed (default)"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            timelineRows={[urlOnlyFetch]}
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
            timelineRows={[runningFetch]}
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
            timelineRows={[erroredFetch]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="collapsed — interrupted"
        hint="status=interrupted, agent cancelled mid-fetch"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            timelineRows={[interruptedFetch]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="collapsed — url only"
        hint="no prompt, no pattern (Codex provider default)"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            timelineRows={[tanstackFetch]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="collapsed — with prompt"
        hint="Anthropic web_fetch with a long natural-language prompt"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            timelineRows={[fetchWithPrompt]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="collapsed — with pattern"
        hint="grep-style pattern (`is archived`) against a raw github URL"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            timelineRows={[fetchWithPattern]}
          />
        </TimelineStage>
      </StoryRow>
    </StoryCard>
  );
}
