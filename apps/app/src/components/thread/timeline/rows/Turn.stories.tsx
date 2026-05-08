import type { TimelineRow, TimelineTurnRow } from "@bb/server-contract";
import { ThreadTimelineRows } from "@/components/thread/timeline";
import { StoryCard, StoryRow } from "../../../../../.ladle/story-card";

export default {
  title: "thread/timeline/rows/Turn",
};

// PageShell caps content at 760px and provides @container/page so any markdown
// tables in the wrapped assistant message (when expanded) resolve their
// container queries against the 760px content area.
function TimelineStage({ children }: { children: React.ReactNode }) {
  return (
    <div className="@container/page mx-auto w-full max-w-[760px]">
      {children}
    </div>
  );
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
// Turn rows are emitted by `buildCompletedTurnSummaryRows` in
// `packages/thread-view/src/build-thread-timeline.ts` and rendered by the
// projection as expandable wrappers around the turn's source rows. We feed a
// real `TimelineTurnRow` whose `children` reproduce the actual turn from
// thr_zeb7z9afmw / 019dd185-ef12-7d50-aa48-47882e9c8aaf:
//
//   user message ("please address them")
//   assistant text (sequence 35343)
//   command bundle  (35347..35353 — exploration sed runs, kept brief)
//   assistant text (sequence 35381)
//   file-change bundle (35564, 35573, 35595, 35611, 35671)
//   assistant text (sequence 35460 — closing summary)
//
// The variants below reuse this same children list and only flip `status` /
// `completedAt` to demonstrate running, error, and interrupted turn states.
// ---------------------------------------------------------------------------

const assistantOpener: TimelineRow = {
  id: "thr_zeb7z9afmw:assistant-text:35343",
  threadId: "thr_zeb7z9afmw",
  turnId: "019dd185-ef12-7d50-aa48-47882e9c8aaf",
  sourceSeqStart: 35343,
  sourceSeqEnd: 35343,
  startedAt: 1777337120500,
  createdAt: 1777337121200,
  kind: "conversation",
  role: "assistant",
  text: "I’m moving the active-thinking state into the main projection pass so we stop reconstructing it from events afterward. After that I’ll short-circuit the manager path and stop recomputing active-thinking inside the turn-summary-details loop.",
  attachments: null,
  userRequest: null,
};

const commandSedAssistantStream: TimelineRow = {
  id: "thr_zeb7z9afmw:command:call_YrdwFQNVKDsaBvwc98oQ9qP4",
  threadId: "thr_zeb7z9afmw",
  turnId: "019dd185-ef12-7d50-aa48-47882e9c8aaf",
  sourceSeqStart: 35347,
  sourceSeqEnd: 35347,
  startedAt: 1777337121300,
  createdAt: 1777337121800,
  kind: "work",
  workKind: "command",
  status: "completed",
  callId: "call_YrdwFQNVKDsaBvwc98oQ9qP4",
  command:
    "/bin/zsh -lc \"sed -n '1,260p' packages/core-ui/src/assistant-stream-projection.ts\"",
  cwd: "/Users/michael/.bb-dev/worktrees/env_33i22gvcqe/bb",
  source: null,
  output: "",
  exitCode: 0,
  completedAt: 1777337121800,
  approvalStatus: null,
  activityIntents: [
    {
      type: "read",
      command: "sed",
      name: "assistant-stream-projection.ts",
      path: "packages/core-ui/src/assistant-stream-projection.ts",
    },
  ],
};

const commandSedTimelineHelpers: TimelineRow = {
  id: "thr_zeb7z9afmw:command:call_XF7ZEgp9XUvdErfdDi9zKDX6",
  threadId: "thr_zeb7z9afmw",
  turnId: "019dd185-ef12-7d50-aa48-47882e9c8aaf",
  sourceSeqStart: 35349,
  sourceSeqEnd: 35349,
  startedAt: 1777337121900,
  createdAt: 1777337122300,
  kind: "work",
  workKind: "command",
  status: "completed",
  callId: "call_XF7ZEgp9XUvdErfdDi9zKDX6",
  command:
    "/bin/zsh -lc \"sed -n '1,200p' packages/core-ui/src/timeline-message-helpers.ts\"",
  cwd: "/Users/michael/.bb-dev/worktrees/env_33i22gvcqe/bb",
  source: null,
  output: "",
  exitCode: 0,
  completedAt: 1777337122300,
  approvalStatus: null,
  activityIntents: [
    {
      type: "read",
      command: "sed",
      name: "timeline-message-helpers.ts",
      path: "packages/core-ui/src/timeline-message-helpers.ts",
    },
  ],
};

const commandSedVisibleText: TimelineRow = {
  id: "thr_zeb7z9afmw:command:call_AcUMKIrd6rllJWdPYubsSTjL",
  threadId: "thr_zeb7z9afmw",
  turnId: "019dd185-ef12-7d50-aa48-47882e9c8aaf",
  sourceSeqStart: 35351,
  sourceSeqEnd: 35351,
  startedAt: 1777337122400,
  createdAt: 1777337122800,
  kind: "work",
  workKind: "command",
  status: "completed",
  callId: "call_AcUMKIrd6rllJWdPYubsSTjL",
  command:
    "/bin/zsh -lc \"sed -n '1,220p' packages/core-ui/src/visible-text-buffer.ts\"",
  cwd: "/Users/michael/.bb-dev/worktrees/env_33i22gvcqe/bb",
  source: null,
  output: "",
  exitCode: 0,
  completedAt: 1777337122800,
  approvalStatus: null,
  activityIntents: [
    {
      type: "read",
      command: "sed",
      name: "visible-text-buffer.ts",
      path: "packages/core-ui/src/visible-text-buffer.ts",
    },
  ],
};

const assistantPlanning: TimelineRow = {
  id: "thr_zeb7z9afmw:assistant-text:35381",
  threadId: "thr_zeb7z9afmw",
  turnId: "019dd185-ef12-7d50-aa48-47882e9c8aaf",
  sourceSeqStart: 35381,
  sourceSeqEnd: 35381,
  startedAt: 1777337122900,
  createdAt: 1777337123000,
  kind: "conversation",
  role: "assistant",
  text: "I’ve got the shape of the refactor now. The key is to make the flat projection pass return both durable messages and ephemeral `activeThinking`, then use that one result everywhere instead of rebuilding lifecycle from raw events afterward.",
  attachments: null,
  userRequest: null,
};

const fileChangeAssistantStream: TimelineRow = {
  id: "thr_zeb7z9afmw:fileChange:35564",
  threadId: "thr_zeb7z9afmw",
  turnId: "019dd185-ef12-7d50-aa48-47882e9c8aaf",
  sourceSeqStart: 35564,
  sourceSeqEnd: 35564,
  startedAt: 1777337123100,
  createdAt: 1777337123900,
  kind: "work",
  workKind: "file-change",
  status: "completed",
  callId: "call_fjGvl1fFJU7cAcw46FcSnbjJ",
  change: {
    path: "/Users/michael/.bb-dev/worktrees/env_33i22gvcqe/bb/packages/core-ui/src/assistant-stream-projection.ts",
    kind: "update",
    movePath: null,
    diff: `@@ -24,3 +24,3 @@
   visibleReasoningMessageKeys: Set<string>;
-  finalizedReasoningMessageKeys: Set<string>;
+  finalizedReasoningKeys: Set<string>;
 }
@@ -131,3 +131,3 @@
     buffers: state.reasoningTextBuffersByKey,
-    finalizedKeys: state.finalizedReasoningMessageKeys,
+    finalizedKeys: state.finalizedReasoningKeys,
     openMessages: state.openReasoningMessagesByKey,`,
    diffStats: { added: 2, removed: 2 },
  },
  stdout: null,
  stderr: null,
  approvalStatus: null,
};

const fileChangeIndex: TimelineRow = {
  id: "thr_zeb7z9afmw:fileChange:35573",
  threadId: "thr_zeb7z9afmw",
  turnId: "019dd185-ef12-7d50-aa48-47882e9c8aaf",
  sourceSeqStart: 35573,
  sourceSeqEnd: 35573,
  startedAt: 1777337124000,
  createdAt: 1777337125300,
  kind: "work",
  workKind: "file-change",
  status: "completed",
  callId: "call_BXK77XTyviYmWUVNOpPG5nwJ",
  change: {
    path: "/Users/michael/.bb-dev/worktrees/env_33i22gvcqe/bb/packages/core-ui/src/index.ts",
    kind: "update",
    movePath: null,
    diff: `@@ -110,3 +110,2 @@
 export { extractThreadContextWindowUsage } from "./thread-context-window-usage.js";
-export { extractActiveThinking } from "./active-thinking.js";

@@ -126,3 +125,7 @@

-export { toViewMessages, toViewProjection } from "./to-view-messages.js";
+export {
+  toViewMessages,
+  toViewProjection,
+  toViewProjectionEntries,
+} from "./to-view-messages.js";
 export type { ThreadEventWithMeta } from "./to-view-messages.js";`,
    diffStats: { added: 5, removed: 2 },
  },
  stdout: null,
  stderr: null,
  approvalStatus: null,
};

const fileChangeTimelineService: TimelineRow = {
  id: "thr_zeb7z9afmw:fileChange:35595",
  threadId: "thr_zeb7z9afmw",
  turnId: "019dd185-ef12-7d50-aa48-47882e9c8aaf",
  sourceSeqStart: 35595,
  sourceSeqEnd: 35595,
  startedAt: 1777337125400,
  createdAt: 1777337127100,
  kind: "work",
  workKind: "file-change",
  status: "completed",
  callId: "call_v3QQJnCbGh2ErXIJdCf4hX4N",
  change: {
    path: "/Users/michael/.bb-dev/worktrees/env_33i22gvcqe/bb/apps/server/src/services/threads/timeline.ts",
    kind: "update",
    movePath: null,
    diff: `@@ -6,2 +6,3 @@
   toViewMessages,
+  toViewProjectionEntries,
   toViewProjection,
@@ -256,2 +257,23 @@
     thread.type === "manager" && !options.showAllManagerEvents;
+  const contextWindowUsageRows = listContextWindowUsageRows(db, {
+    threadId: thread.id,
+  });
+
+  if (isDefaultManagerView) {
+    return {
+      rows: buildManagerConversationRows(
+        toViewMessages(decodedEvents, {
+          includeInternalSystemMessages: options.showAllManagerEvents,
+          threadStatus: thread.status,
+          threadType: thread.type,
+        }),
+      ),
+      activeThinking: null,
+      contextWindowUsage:
+        extractThreadContextWindowUsage(
+          contextWindowUsageRows.map((row) => parseStoredEventRow(row)),
+        ) ?? undefined,
+    };
+  }`,
    diffStats: { added: 22, removed: 0 },
  },
  stdout: null,
  stderr: null,
  approvalStatus: null,
};

const fileChangeActiveThinkingDelete: TimelineRow = {
  id: "thr_zeb7z9afmw:fileChange:35611",
  threadId: "thr_zeb7z9afmw",
  turnId: "019dd185-ef12-7d50-aa48-47882e9c8aaf",
  sourceSeqStart: 35611,
  sourceSeqEnd: 35611,
  startedAt: 1777337127200,
  createdAt: 1777337127900,
  kind: "work",
  workKind: "file-change",
  status: "completed",
  callId: "call_1JWzaNZyTpVIrB8reX73YYUN",
  change: {
    path: "/Users/michael/.bb-dev/worktrees/env_33i22gvcqe/bb/packages/core-ui/src/active-thinking.ts",
    kind: "delete",
    movePath: null,
    diff: null,
    diffStats: { added: 0, removed: 0 },
  },
  stdout: null,
  stderr: null,
  approvalStatus: null,
};

const fileChangeToViewMessages: TimelineRow = {
  id: "thr_zeb7z9afmw:fileChange:35671",
  threadId: "thr_zeb7z9afmw",
  turnId: "019dd185-ef12-7d50-aa48-47882e9c8aaf",
  sourceSeqStart: 35671,
  sourceSeqEnd: 35671,
  startedAt: 1777337128000,
  createdAt: 1777337129500,
  kind: "work",
  workKind: "file-change",
  status: "completed",
  callId: "call_3qZxJB5I3kVdSM4pPiBCTm92",
  change: {
    path: "/Users/michael/.bb-dev/worktrees/env_33i22gvcqe/bb/packages/core-ui/src/to-view-messages.ts",
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
+
 function finalizeReasoningLifecycle(`,
    diffStats: { added: 10, removed: 0 },
  },
  stdout: null,
  stderr: null,
  approvalStatus: null,
};

// Children that live INSIDE the turn body. Per the projection, completed
// turns strip user messages (ungroupable) and the terminal assistant message
// (rendered as the turn's outer reply) — see
// `packages/thread-view/src/timeline-message-helpers.ts:14`. So neither the
// user prompt that opened the turn nor the closing assistant text appears in
// `children`; only the in-turn work + intermediate assistant texts.
const turnChildren: TimelineRow[] = [
  assistantOpener,
  commandSedAssistantStream,
  commandSedTimelineHelpers,
  commandSedVisibleText,
  assistantPlanning,
  fileChangeAssistantStream,
  fileChangeIndex,
  fileChangeTimelineService,
  fileChangeActiveThinkingDelete,
  fileChangeToViewMessages,
];

interface BuildTurnRowArgs {
  status: TimelineTurnRow["status"];
  completedAt: number | null;
  startedAt: number;
  createdAt: number;
}

function buildTurnRow({
  status,
  completedAt,
  startedAt,
  createdAt,
}: BuildTurnRowArgs): TimelineTurnRow {
  return {
    id: "thr_zeb7z9afmw:019dd185-ef12-7d50-aa48-47882e9c8aaf:turn",
    threadId: "thr_zeb7z9afmw",
    turnId: "019dd185-ef12-7d50-aa48-47882e9c8aaf",
    sourceSeqStart: 35289,
    sourceSeqEnd: 35671,
    startedAt,
    createdAt,
    kind: "turn",
    status,
    summaryCount: turnChildren.length,
    completedAt,
    children: turnChildren,
  };
}

const completedTurnRow = buildTurnRow({
  status: "completed",
  completedAt: 1777337131200,
  startedAt: 1777337120000,
  createdAt: 1777337131200,
});

export function Overview() {
  return (
    <StoryCard>
      <StoryRow
        label="collapsed"
        hint="completed turn — header only, click to expand"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            timelineRows={[completedTurnRow]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow label="expanded" hint="turn body open to its child rows">
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            initialExpanded={new Set([completedTurnRow.id])}
            timelineRows={[completedTurnRow]}
          />
        </TimelineStage>
      </StoryRow>
    </StoryCard>
  );
}
