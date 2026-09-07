import type { TimelineRow } from "@bb/server-contract";
import { ThreadTimelineRows } from "@/components/thread/timeline";
import {
  commandRow,
  conversationRow,
  fileChangeRow,
  fileReadRow,
  searchRow,
} from "@/test/fixtures/thread-timeline-rows";
import { StoryCard, StoryRow } from "../../../../../.ladle/story-card";

export default {
  title: "thread/timeline/rows/Step Summary",
};

function TimelineStage({ children }: { children: React.ReactNode }) {
  return <div className="w-full max-w-[760px]">{children}</div>;
}

const baseProps = {
  threadRuntimeDisplayStatus: "idle" as const,
  workspaceRootPath: undefined,
};

function workSummaryId(children: readonly TimelineRow[]): string {
  const first = children[0];
  if (!first) {
    throw new Error("Cannot compute work-summary id for empty children");
  }
  return [
    first.threadId,
    first.turnId ?? "thread",
    "work-summary",
    first.id,
  ].join(":");
}

type ExplorationRowArgs = { callId: string; seq: number } & (
  | { kind: "read"; path: string }
  | { kind: "search"; query: string; path: string | null }
  | { kind: "list"; pattern: string; path: string | null }
);

const THREAD_ID = "thr_zeb7z9afmw";
const TURN_ID = "019dd185-ef12-7d50-aa48-47882e9c8aaf";

const closingAssistantMessage: TimelineRow = conversationRow({
  id: `${THREAD_ID}:assistant-text:35460`,
  threadId: THREAD_ID,
  turnId: TURN_ID,
  sourceSeqStart: 35460,
  sourceSeqEnd: 35460,
  startedAt: 1777337356000,
  createdAt: 1777337356000,
  role: "assistant",
  text: "—",
  attachments: null,
});

const commandTurboBuild: TimelineRow = commandRow({
  id: `${THREAD_ID}:command:call_buildDomainCoreUi`,
  threadId: THREAD_ID,
  turnId: TURN_ID,
  sourceSeqStart: 35700,
  sourceSeqEnd: 35700,
  startedAt: 1777337330000,
  createdAt: 1777337332100,
  status: "completed",
  callId: "call_buildDomainCoreUi",
  command:
    "pnpm exec turbo run build --filter=@bb/domain --filter=@bb/core-ui --filter=@bb/server-contract --concurrency=1",
  cwd: null,
  source: null,
  output: "",
  exitCode: 0,
  approvalStatus: null,
  activityIntents: [],
  durationMs: 2100,
});

const commandTurboTestServer: TimelineRow = commandRow({
  id: `${THREAD_ID}:command:call_testServer`,
  threadId: THREAD_ID,
  turnId: TURN_ID,
  sourceSeqStart: 35701,
  sourceSeqEnd: 35701,
  startedAt: 1777337332200,
  createdAt: 1777337339400,
  status: "completed",
  callId: "call_testServer",
  command:
    "pnpm exec turbo run test --filter=@bb/server --only --concurrency=1 -- --run test/threads/timeline-service.test.ts",
  cwd: null,
  source: null,
  output: "",
  exitCode: 0,
  approvalStatus: null,
  activityIntents: [],
  durationMs: 7200,
});

const commandTurboTestCoreUi: TimelineRow = commandRow({
  id: `${THREAD_ID}:command:call_testCoreUi`,
  threadId: THREAD_ID,
  turnId: TURN_ID,
  sourceSeqStart: 35702,
  sourceSeqEnd: 35702,
  startedAt: 1777337339500,
  createdAt: 1777337346700,
  status: "completed",
  callId: "call_testCoreUi",
  command:
    "pnpm exec turbo run test --filter=@bb/core-ui --concurrency=1 -- --run test/to-view-messages.assistant-streams.test.ts",
  cwd: null,
  source: null,
  output: "",
  exitCode: 0,
  approvalStatus: null,
  activityIntents: [],
  durationMs: 7200,
});

const commandTurboBuildForce: TimelineRow = commandRow({
  id: `${THREAD_ID}:command:call_buildForce`,
  threadId: THREAD_ID,
  turnId: TURN_ID,
  sourceSeqStart: 35733,
  sourceSeqEnd: 35733,
  startedAt: 1777337346800,
  createdAt: 1777337352900,
  status: "completed",
  callId: "call_buildForce",
  command:
    "pnpm exec turbo run build --filter=@bb/domain --filter=@bb/core-ui --force --concurrency=1",
  cwd: null,
  source: null,
  output: "",
  exitCode: 0,
  approvalStatus: null,
  activityIntents: [],
  durationMs: 6100,
});

const commandGitStatus: TimelineRow = commandRow({
  id: `${THREAD_ID}:command:call_gitStatus`,
  threadId: THREAD_ID,
  turnId: TURN_ID,
  sourceSeqStart: 35831,
  sourceSeqEnd: 35831,
  startedAt: 1777337353000,
  createdAt: 1777337353800,
  status: "completed",
  callId: "call_gitStatus",
  command: "git status --short",
  cwd: null,
  source: null,
  output: "",
  exitCode: 0,
  approvalStatus: null,
  activityIntents: [],
  durationMs: 800,
});

const commandGitDiffStat: TimelineRow = commandRow({
  id: `${THREAD_ID}:command:call_gitDiffStat`,
  threadId: THREAD_ID,
  turnId: TURN_ID,
  sourceSeqStart: 36155,
  sourceSeqEnd: 36155,
  startedAt: 1777337353900,
  createdAt: 1777337354400,
  status: "completed",
  callId: "call_gitDiffStat",
  command:
    "git diff --stat -- packages/core-ui/src/to-view-messages.ts packages/core-ui/src/index.ts",
  cwd: null,
  source: null,
  output: "",
  exitCode: 0,
  approvalStatus: null,
  activityIntents: [],
  durationMs: 500,
});

const fileChangeAssistantStream: TimelineRow = fileChangeRow({
  id: `${THREAD_ID}:fileChange:35564`,
  threadId: THREAD_ID,
  turnId: TURN_ID,
  sourceSeqStart: 35564,
  sourceSeqEnd: 35564,
  startedAt: 1777337123000,
  createdAt: 1777337123900,
  status: "completed",
  callId: "call_fjGvl1fFJU7cAcw46FcSnbjJ",
  change: {
    path: "packages/core-ui/src/assistant-stream-projection.ts",
    kind: "update",
    movePath: null,
    diff: `@@ -24,3 +24,3 @@
   visibleReasoningMessageKeys: Set<string>;
-  finalizedReasoningMessageKeys: Set<string>;
+  finalizedReasoningKeys: Set<string>;
 }`,
    diffStats: { added: 1, removed: 1 },
  },
  stdout: null,
  stderr: null,
  approvalStatus: null,
});

const fileChangeIndex: TimelineRow = fileChangeRow({
  id: `${THREAD_ID}:fileChange:35573`,
  threadId: THREAD_ID,
  turnId: TURN_ID,
  sourceSeqStart: 35573,
  sourceSeqEnd: 35573,
  startedAt: 1777337124200,
  createdAt: 1777337125300,
  status: "completed",
  callId: "call_BXK77XTyviYmWUVNOpPG5nwJ",
  change: {
    path: "packages/core-ui/src/index.ts",
    kind: "update",
    movePath: null,
    diff: `@@ -126,3 +125,7 @@
-export { toViewMessages, toViewProjection } from "./to-view-messages.js";
+export {
+  toViewMessages,
+  toViewProjection,
+  toViewProjectionEntries,
+} from "./to-view-messages.js";`,
    diffStats: { added: 5, removed: 1 },
  },
  stdout: null,
  stderr: null,
  approvalStatus: null,
});

const fileChangeActiveThinkingDelete: TimelineRow = fileChangeRow({
  id: `${THREAD_ID}:fileChange:35611`,
  threadId: THREAD_ID,
  turnId: TURN_ID,
  sourceSeqStart: 35611,
  sourceSeqEnd: 35611,
  startedAt: 1777337127200,
  createdAt: 1777337127900,
  status: "completed",
  callId: "call_1JWzaNZyTpVIrB8reX73YYUN",
  change: {
    path: "packages/core-ui/src/active-thinking.ts",
    kind: "delete",
    movePath: null,
    diff: null,
    diffStats: { added: 0, removed: 0 },
  },
  stdout: null,
  stderr: null,
  approvalStatus: null,
});

const fileChangeToViewMessages: TimelineRow = fileChangeRow({
  id: `${THREAD_ID}:fileChange:35671`,
  threadId: THREAD_ID,
  turnId: TURN_ID,
  sourceSeqStart: 35671,
  sourceSeqEnd: 35671,
  startedAt: 1777337128000,
  createdAt: 1777337129500,
  status: "completed",
  callId: "call_3qZxJB5I3kVdSM4pPiBCTm92",
  change: {
    path: "packages/core-ui/src/to-view-messages.ts",
    kind: "update",
    movePath: null,
    diff: `@@ -497,2 +497,12 @@

+function trackReasoningTurn(
+  state: ProjectionState,
+  identity: BufferedTextInstanceIdentity | null,
+): void {
+  if (!identity || state.closedTurnIds.has(identity.turnId)) {
+    return;
+  }
+  state.openTurnIds.add(identity.turnId);
+}
+`,
    diffStats: { added: 10, removed: 0 },
  },
  stdout: null,
  stderr: null,
  approvalStatus: null,
});

function explorationRow(args: ExplorationRowArgs): TimelineRow {
  const base = {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    sourceSeqStart: args.seq,
    sourceSeqEnd: args.seq,
    startedAt: 1777337100000 + args.seq,
    createdAt: 1777337100000 + args.seq + 50,
    status: "completed" as const,
    callId: args.callId,
    durationMs: 50,
  };
  switch (args.kind) {
    case "read":
      return fileReadRow({
        ...base,
        id: `${THREAD_ID}:file-read:${args.callId}`,
        path: args.path,
      });
    case "search":
      return searchRow({
        ...base,
        id: `${THREAD_ID}:search:${args.callId}`,
        mode: "content",
        query: args.query,
        path: args.path,
      });
    case "list":
      return searchRow({
        ...base,
        id: `${THREAD_ID}:search:${args.callId}`,
        mode: "path",
        query: args.pattern,
        path: args.path,
      });
  }
}

const readAssistantStream = explorationRow({
  callId: "call_read_assist_stream",
  seq: 35100,
  kind: "read",
  path: "packages/core-ui/src/assistant-stream-projection.ts",
});

const readIndex = explorationRow({
  callId: "call_read_index",
  seq: 35110,
  kind: "read",
  path: "packages/core-ui/src/index.ts",
});

const grepFinalized = explorationRow({
  callId: "call_grep_finalized",
  seq: 35120,
  kind: "search",
  query: "finalizedReasoningMessageKeys",
  path: "packages/core-ui/src",
});

const globTests = explorationRow({
  callId: "call_glob_tests",
  seq: 35130,
  kind: "list",
  pattern: "packages/core-ui/test/*.test.ts",
  path: "packages/core-ui/test",
});

const mixedThreeBundlesRows: TimelineRow[] = [
  commandTurboBuild,
  commandTurboTestServer,
  commandTurboTestCoreUi,
  commandTurboBuildForce,
  fileChangeAssistantStream,
  fileChangeIndex,
  fileChangeActiveThinkingDelete,
  commandGitStatus,
  commandGitDiffStat,
  closingAssistantMessage,
];

const exploreThenEditRows: TimelineRow[] = [
  readAssistantStream,
  readIndex,
  fileChangeAssistantStream,
  fileChangeToViewMessages,
  closingAssistantMessage,
];

const explorationOnlyRows: TimelineRow[] = [
  readAssistantStream,
  readIndex,
  grepFinalized,
  globTests,
  closingAssistantMessage,
];

const commandsThenFilesRows: TimelineRow[] = [
  commandTurboBuild,
  commandTurboTestServer,
  fileChangeAssistantStream,
  fileChangeIndex,
  fileChangeActiveThinkingDelete,
  fileChangeToViewMessages,
  closingAssistantMessage,
];

const allCommandsRows: TimelineRow[] = [
  commandTurboBuild,
  commandTurboTestServer,
  commandTurboTestCoreUi,
  commandTurboBuildForce,
  closingAssistantMessage,
];

export function Overview() {
  return (
    <StoryCard>
      <StoryRow
        label="commands → file-changes → commands"
        hint="three bundles inside the step (mixed-concept transitions)"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            initialExpanded={
              new Set([workSummaryId(mixedThreeBundlesRows.slice(0, -1))])
            }
            timelineRows={mixedThreeBundlesRows}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="commands → file-changes"
        hint="two bundles — the common 'verify, then edit' shape"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            initialExpanded={
              new Set([workSummaryId(commandsThenFilesRows.slice(0, -1))])
            }
            timelineRows={commandsThenFilesRows}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="exploration → file-changes"
        hint="two bundles — 'read the code, then edit it'"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            initialExpanded={
              new Set([workSummaryId(exploreThenEditRows.slice(0, -1))])
            }
            timelineRows={exploreThenEditRows}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="exploration only"
        hint="single exploration bundle (Read + Grep + Glob) inside the step"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            initialExpanded={
              new Set([workSummaryId(explorationOnlyRows.slice(0, -1))])
            }
            timelineRows={explorationOnlyRows}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="single bundle (commands only)"
        hint="step holds one bundle of same-concept rows"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            initialExpanded={
              new Set([workSummaryId(allCommandsRows.slice(0, -1))])
            }
            timelineRows={allCommandsRows}
          />
        </TimelineStage>
      </StoryRow>
    </StoryCard>
  );
}
