import type { TimelineRow } from "@bb/server-contract";
import { ThreadTimelineRows } from "@/components/thread/timeline";
import { StoryCard, StoryRow } from "../../../../../.ladle/story-card";

export default {
  title: "thread/timeline/rows/Step Summary",
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

// The projection composes a step's id from its first child row, same shape as
// bundle ids. Mirroring the formula here lets stories target the projected
// step with `initialExpanded` without flipping the scope to active. If the
// projection's id formula changes, thread-view's tests will catch it before
// this helper does.
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

// ---------------------------------------------------------------------------
// Step summaries are produced by `buildTimelineViewRows` when an
// assistant-message boundary closes an open step that holds multiple
// summarizable work rows. Concept transitions inside the step (commands ->
// file-changes -> commands, exploration -> file-changes, etc.) become bundles
// inside the step-summary's children.
//
// Raw rows below are pulled from thr_zeb7z9afmw turn 019dd185 — sequences
// 35564..36155. The trailing assistant message is just an em-dash so the
// boundary is visible without dominating the story canvas.
// ---------------------------------------------------------------------------

const THREAD_ID = "thr_zeb7z9afmw";
const TURN_ID = "019dd185-ef12-7d50-aa48-47882e9c8aaf";

const closingAssistantMessage: TimelineRow = {
  id: `${THREAD_ID}:assistant-text:35460`,
  threadId: THREAD_ID,
  turnId: TURN_ID,
  sourceSeqStart: 35460,
  sourceSeqEnd: 35460,
  startedAt: 1777337356000,
  createdAt: 1777337356000,
  kind: "conversation",
  role: "assistant",
  text: "—",
  attachments: null,
  userRequest: null,
};

// ---- Commands: real turbo build/test commands from the same turn ----------
const commandTurboBuild: TimelineRow = {
  id: `${THREAD_ID}:command:call_buildDomainCoreUi`,
  threadId: THREAD_ID,
  turnId: TURN_ID,
  sourceSeqStart: 35700,
  sourceSeqEnd: 35700,
  startedAt: 1777337330000,
  createdAt: 1777337332100,
  kind: "work",
  workKind: "command",
  status: "completed",
  callId: "call_buildDomainCoreUi",
  command:
    "pnpm exec turbo run build --filter=@bb/domain --filter=@bb/core-ui --filter=@bb/server-contract --concurrency=1",
  cwd: null,
  source: null,
  output: "",
  exitCode: 0,
  completedAt: 1777337332100,
  approvalStatus: null,
  activityIntents: [],
};

const commandTurboTestServer: TimelineRow = {
  id: `${THREAD_ID}:command:call_testServer`,
  threadId: THREAD_ID,
  turnId: TURN_ID,
  sourceSeqStart: 35701,
  sourceSeqEnd: 35701,
  startedAt: 1777337332200,
  createdAt: 1777337339400,
  kind: "work",
  workKind: "command",
  status: "completed",
  callId: "call_testServer",
  command:
    "pnpm exec turbo run test --filter=@bb/server --only --concurrency=1 -- --run test/threads/timeline-service.test.ts",
  cwd: null,
  source: null,
  output: "",
  exitCode: 0,
  completedAt: 1777337339400,
  approvalStatus: null,
  activityIntents: [],
};

const commandTurboTestCoreUi: TimelineRow = {
  id: `${THREAD_ID}:command:call_testCoreUi`,
  threadId: THREAD_ID,
  turnId: TURN_ID,
  sourceSeqStart: 35702,
  sourceSeqEnd: 35702,
  startedAt: 1777337339500,
  createdAt: 1777337346700,
  kind: "work",
  workKind: "command",
  status: "completed",
  callId: "call_testCoreUi",
  command:
    "pnpm exec turbo run test --filter=@bb/core-ui --concurrency=1 -- --run test/to-view-messages.assistant-streams.test.ts",
  cwd: null,
  source: null,
  output: "",
  exitCode: 0,
  completedAt: 1777337346700,
  approvalStatus: null,
  activityIntents: [],
};

const commandTurboBuildForce: TimelineRow = {
  id: `${THREAD_ID}:command:call_buildForce`,
  threadId: THREAD_ID,
  turnId: TURN_ID,
  sourceSeqStart: 35733,
  sourceSeqEnd: 35733,
  startedAt: 1777337346800,
  createdAt: 1777337352900,
  kind: "work",
  workKind: "command",
  status: "completed",
  callId: "call_buildForce",
  command:
    "pnpm exec turbo run build --filter=@bb/domain --filter=@bb/core-ui --force --concurrency=1",
  cwd: null,
  source: null,
  output: "",
  exitCode: 0,
  completedAt: 1777337352900,
  approvalStatus: null,
  activityIntents: [],
};

const commandGitStatus: TimelineRow = {
  id: `${THREAD_ID}:command:call_gitStatus`,
  threadId: THREAD_ID,
  turnId: TURN_ID,
  sourceSeqStart: 35831,
  sourceSeqEnd: 35831,
  startedAt: 1777337353000,
  createdAt: 1777337353800,
  kind: "work",
  workKind: "command",
  status: "completed",
  callId: "call_gitStatus",
  command: "git status --short",
  cwd: null,
  source: null,
  output: "",
  exitCode: 0,
  completedAt: 1777337353800,
  approvalStatus: null,
  activityIntents: [],
};

const commandGitDiffStat: TimelineRow = {
  id: `${THREAD_ID}:command:call_gitDiffStat`,
  threadId: THREAD_ID,
  turnId: TURN_ID,
  sourceSeqStart: 36155,
  sourceSeqEnd: 36155,
  startedAt: 1777337353900,
  createdAt: 1777337354400,
  kind: "work",
  workKind: "command",
  status: "completed",
  callId: "call_gitDiffStat",
  command:
    "git diff --stat -- packages/core-ui/src/to-view-messages.ts packages/core-ui/src/index.ts",
  cwd: null,
  source: null,
  output: "",
  exitCode: 0,
  completedAt: 1777337354400,
  approvalStatus: null,
  activityIntents: [],
};

// ---- File changes: real diffs from the same turn --------------------------
const fileChangeAssistantStream: TimelineRow = {
  id: `${THREAD_ID}:fileChange:35564`,
  threadId: THREAD_ID,
  turnId: TURN_ID,
  sourceSeqStart: 35564,
  sourceSeqEnd: 35564,
  startedAt: 1777337123000,
  createdAt: 1777337123900,
  kind: "work",
  workKind: "file-change",
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
};

const fileChangeIndex: TimelineRow = {
  id: `${THREAD_ID}:fileChange:35573`,
  threadId: THREAD_ID,
  turnId: TURN_ID,
  sourceSeqStart: 35573,
  sourceSeqEnd: 35573,
  startedAt: 1777337124200,
  createdAt: 1777337125300,
  kind: "work",
  workKind: "file-change",
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
};

const fileChangeActiveThinkingDelete: TimelineRow = {
  id: `${THREAD_ID}:fileChange:35611`,
  threadId: THREAD_ID,
  turnId: TURN_ID,
  sourceSeqStart: 35611,
  sourceSeqEnd: 35611,
  startedAt: 1777337127200,
  createdAt: 1777337127900,
  kind: "work",
  workKind: "file-change",
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
};

const fileChangeToViewMessages: TimelineRow = {
  id: `${THREAD_ID}:fileChange:35671`,
  threadId: THREAD_ID,
  turnId: TURN_ID,
  sourceSeqStart: 35671,
  sourceSeqEnd: 35671,
  startedAt: 1777337128000,
  createdAt: 1777337129500,
  kind: "work",
  workKind: "file-change",
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
};

// ---- Exploration tools (Read / Grep / Glob with real intents) -------------
function explorationToolRow(args: {
  callId: string;
  seq: number;
  toolName: "Read" | "Grep" | "Glob";
  toolArgs: Record<string, string | number | boolean>;
  intentPath: string | null;
  intentType: "read" | "search" | "list_files";
  output: string;
}): TimelineRow {
  return {
    id: `${THREAD_ID}:tool:${args.callId}`,
    threadId: THREAD_ID,
    turnId: TURN_ID,
    sourceSeqStart: args.seq,
    sourceSeqEnd: args.seq,
    startedAt: 1777337100000 + args.seq,
    createdAt: 1777337100000 + args.seq + 50,
    kind: "work",
    workKind: "tool",
    status: "completed",
    callId: args.callId,
    toolName: args.toolName,
    toolArgs: args.toolArgs,
    output: args.output,
    completedAt: 1777337100000 + args.seq + 50,
    approvalStatus: null,
    activityIntents:
      args.intentType === "read"
        ? [
            {
              type: "read",
              command: args.toolName,
              name: args.intentPath?.split("/").pop() ?? args.toolName,
              path: args.intentPath,
            },
          ]
        : args.intentType === "search"
          ? [
              {
                type: "search",
                command: args.toolName,
                query:
                  typeof args.toolArgs.pattern === "string"
                    ? args.toolArgs.pattern
                    : null,
                path: args.intentPath,
              },
            ]
          : [
              {
                type: "list_files",
                command: args.toolName,
                path: args.intentPath,
              },
            ],
  };
}

const readAssistantStream = explorationToolRow({
  callId: "call_read_assist_stream",
  seq: 35100,
  toolName: "Read",
  toolArgs: {
    file_path: "packages/core-ui/src/assistant-stream-projection.ts",
  },
  intentPath: "packages/core-ui/src/assistant-stream-projection.ts",
  intentType: "read",
  output: "...file contents...",
});

const readIndex = explorationToolRow({
  callId: "call_read_index",
  seq: 35110,
  toolName: "Read",
  toolArgs: { file_path: "packages/core-ui/src/index.ts" },
  intentPath: "packages/core-ui/src/index.ts",
  intentType: "read",
  output: "...file contents...",
});

const grepFinalized = explorationToolRow({
  callId: "call_grep_finalized",
  seq: 35120,
  toolName: "Grep",
  toolArgs: {
    pattern: "finalizedReasoningMessageKeys",
    path: "packages/core-ui/src",
  },
  intentPath: "packages/core-ui/src",
  intentType: "search",
  output: "src/assistant-stream-projection.ts:24\nsrc/to-view-messages.ts:131",
});

const globTests = explorationToolRow({
  callId: "call_glob_tests",
  seq: 35130,
  toolName: "Glob",
  toolArgs: { pattern: "packages/core-ui/test/*.test.ts" },
  intentPath: "packages/core-ui/test",
  intentType: "list_files",
  output: "test/to-view-messages.assistant-streams.test.ts",
});

// ---- Step compositions ----------------------------------------------------
// Each array is "work rows that share an open step" + the closing assistant
// message that flushes them into a step-summary.

// 4 commands → 3 file-changes → 2 commands (3 bundles)
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

// 2 reads → 2 file-changes (2 bundles)
const exploreThenEditRows: TimelineRow[] = [
  readAssistantStream,
  readIndex,
  fileChangeAssistantStream,
  fileChangeToViewMessages,
  closingAssistantMessage,
];

// 2 reads → 1 grep → 1 glob (single exploration bundle, ~4 children)
const explorationOnlyRows: TimelineRow[] = [
  readAssistantStream,
  readIndex,
  grepFinalized,
  globTests,
  closingAssistantMessage,
];

// 2 commands → 4 file-changes (2 bundles) — typical "verify, then edit" shape
const commandsThenFilesRows: TimelineRow[] = [
  commandTurboBuild,
  commandTurboTestServer,
  fileChangeAssistantStream,
  fileChangeIndex,
  fileChangeActiveThinkingDelete,
  fileChangeToViewMessages,
  closingAssistantMessage,
];

// Single concept all the way (4 commands) — single bundle inside the step.
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
