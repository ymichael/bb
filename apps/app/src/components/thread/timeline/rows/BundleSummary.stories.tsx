import type { TimelineRow } from "@bb/server-contract";
import { ThreadTimelineRows } from "@/components/thread/timeline";
import { StoryCard, StoryRow } from "../../../../../.ladle/story-card";

export default {
  title: "thread/timeline/rows/Bundle Summary",
};

function TimelineStage({ children }: { children: React.ReactNode }) {
  return <div className="w-full max-w-[760px]">{children}</div>;
}

const baseProps = {
  loadingTurnSummaryIds: new Set<string>(),
  erroredTurnSummaryIds: new Set<string>(),
  onLoadTurnSummaryRows: () => {},
  // Idle scope — keeps the non-active-latest bundle rendering visible so
  // a regression in the muted-bundle path stays catchable. The story rows
  // expand bodies via `initialExpanded` instead of claiming active state.
  threadRuntimeDisplayStatus: "idle" as const,
  turnSummaryRowsIdentity: "story",
  turnSummaryRowsById: {},
};

// The projection composes a bundle's id from its first child row. Mirrored
// here so stories can target the bundle with `initialExpanded` without
// flipping the scope to active. If the projection's id formula changes,
// thread-view's tests will catch it before this helper does.
function bundleId(children: readonly TimelineRow[]): string {
  const first = children[0];
  if (!first) {
    throw new Error("Cannot compute bundle id for empty children");
  }
  return [
    first.threadId,
    first.turnId ?? "thread",
    "work-summary",
    first.id,
  ].join(":");
}

// ---------------------------------------------------------------------------
// Bundle summaries are NOT raw rows — they're produced by the @bb/thread-view
// `buildTimelineViewRows` projection when consecutive same-workKind work rows
// appear inside an open step. We feed real raw rows from
// thr_zeb7z9afmw / turn 019dd185-ef12-7d50-aa48-47882e9c8aaf and let the
// projection group them. Raw command outputs and file diffs are pulled from
// ~/.bb-dev/bb.db sequence ranges 35700..35702 (turbo command run) and
// 35564..35595 (file-change run during the same turn). Long outputs are
// trimmed to keep the fixture readable.
// ---------------------------------------------------------------------------

// ---- Real consecutive build/test commands (sequences 35700-35702) ---------
const buildDomainCoreUiCommand: TimelineRow = {
  id: "thr_zeb7z9afmw:command:call_buildDomainCoreUi",
  threadId: "thr_zeb7z9afmw",
  turnId: "019dd185-ef12-7d50-aa48-47882e9c8aaf",
  sourceSeqStart: 35700,
  sourceSeqEnd: 35700,
  startedAt: 1777337330000,
  createdAt: 1777337332100,
  kind: "work",
  workKind: "command",
  status: "completed",
  callId: "call_buildDomainCoreUi",
  command:
    "pnpm exec turbo run build --filter=@bb/domain --filter=@bb/core-ui --filter=@bb/server-contract --concurrency=1 > /tmp/bb-projection-refactor-build.log 2>&1",
  cwd: "/Users/michael/.bb-dev/worktrees/env_33i22gvcqe/bb",
  source: null,
  output: "",
  exitCode: 0,
  completedAt: 1777337332100,
  approvalStatus: null,
  activityIntents: [],
};

const testServerCommand: TimelineRow = {
  id: "thr_zeb7z9afmw:command:call_testServer",
  threadId: "thr_zeb7z9afmw",
  turnId: "019dd185-ef12-7d50-aa48-47882e9c8aaf",
  sourceSeqStart: 35701,
  sourceSeqEnd: 35701,
  startedAt: 1777337332200,
  createdAt: 1777337339400,
  kind: "work",
  workKind: "command",
  status: "completed",
  callId: "call_testServer",
  command:
    "pnpm exec turbo run test --filter=@bb/server --only --concurrency=1 -- --run test/threads/timeline-service.test.ts > /tmp/bb-projection-refactor-server.log 2>&1",
  cwd: "/Users/michael/.bb-dev/worktrees/env_33i22gvcqe/bb",
  source: null,
  output: "",
  exitCode: 0,
  completedAt: 1777337339400,
  approvalStatus: null,
  activityIntents: [],
};

const testCoreUiCommand: TimelineRow = {
  id: "thr_zeb7z9afmw:command:call_testCoreUi",
  threadId: "thr_zeb7z9afmw",
  turnId: "019dd185-ef12-7d50-aa48-47882e9c8aaf",
  sourceSeqStart: 35702,
  sourceSeqEnd: 35702,
  startedAt: 1777337339500,
  createdAt: 1777337346700,
  kind: "work",
  workKind: "command",
  status: "completed",
  callId: "call_testCoreUi",
  command:
    "pnpm exec turbo run test --filter=@bb/core-ui --concurrency=1 -- --run test/to-view-messages.assistant-streams.test.ts test/to-view-messages.turn-lifecycle.test.ts test/to-view-messages.client-input.test.ts > /tmp/bb-projection-refactor-coreui.log 2>&1",
  cwd: "/Users/michael/.bb-dev/worktrees/env_33i22gvcqe/bb",
  source: null,
  output: "",
  exitCode: 0,
  completedAt: 1777337346700,
  approvalStatus: null,
  activityIntents: [],
};

const buildForceCommand: TimelineRow = {
  id: "thr_zeb7z9afmw:command:call_buildForce",
  threadId: "thr_zeb7z9afmw",
  turnId: "019dd185-ef12-7d50-aa48-47882e9c8aaf",
  sourceSeqStart: 35733,
  sourceSeqEnd: 35733,
  startedAt: 1777337346800,
  createdAt: 1777337352900,
  kind: "work",
  workKind: "command",
  status: "completed",
  callId: "call_buildForce",
  command:
    "pnpm exec turbo run build --filter=@bb/domain --filter=@bb/core-ui --force --concurrency=1 > /tmp/bb-projection-refactor-force-build.log 2>&1",
  cwd: "/Users/michael/.bb-dev/worktrees/env_33i22gvcqe/bb",
  source: null,
  output: "",
  exitCode: 0,
  completedAt: 1777337352900,
  approvalStatus: null,
  activityIntents: [],
};

const testCoreUiForceCommand: TimelineRow = {
  id: "thr_zeb7z9afmw:command:call_testCoreUiForce",
  threadId: "thr_zeb7z9afmw",
  turnId: "019dd185-ef12-7d50-aa48-47882e9c8aaf",
  sourceSeqStart: 35734,
  sourceSeqEnd: 35734,
  startedAt: 1777337353000,
  createdAt: 1777337361500,
  kind: "work",
  workKind: "command",
  status: "completed",
  callId: "call_testCoreUiForce",
  command:
    "pnpm exec turbo run test --filter=@bb/core-ui --force --concurrency=1 -- --run test/to-view-messages.assistant-streams.test.ts test/to-view-messages.turn-lifecycle.test.ts test/to-view-messages.client-input.test.ts > /tmp/bb-projection-refactor-force-coreui.log 2>&1",
  cwd: "/Users/michael/.bb-dev/worktrees/env_33i22gvcqe/bb",
  source: null,
  output: "",
  exitCode: 0,
  completedAt: 1777337361500,
  approvalStatus: null,
  activityIntents: [],
};

// Real failing test command, used to give the mixed-status bundle one error
// child without inventing data.
const testServerErrorCommand: TimelineRow = {
  id: "thr_zeb7z9afmw:command:call_testServerError",
  threadId: "thr_zeb7z9afmw",
  turnId: "019dd185-ef12-7d50-aa48-47882e9c8aaf",
  sourceSeqStart: 35913,
  sourceSeqEnd: 35913,
  startedAt: 1777337361600,
  createdAt: 1777337372100,
  kind: "work",
  workKind: "command",
  status: "error",
  callId: "call_testServerError",
  command:
    "pnpm exec turbo run test --filter=@bb/server --only --force --concurrency=1 -- --run test/threads/timeline-service.test.ts > /tmp/bb-projection-refactor-server.log 2>&1",
  cwd: "/Users/michael/.bb-dev/worktrees/env_33i22gvcqe/bb",
  source: null,
  output: "",
  exitCode: 1,
  completedAt: 1777337372100,
  approvalStatus: null,
  activityIntents: [],
};

const commandBundleRows: TimelineRow[] = [
  buildDomainCoreUiCommand,
  testServerCommand,
  testCoreUiCommand,
  buildForceCommand,
  testCoreUiForceCommand,
];

const commandBundleMixedStatusRows: TimelineRow[] = [
  buildDomainCoreUiCommand,
  testServerCommand,
  testCoreUiCommand,
  testServerErrorCommand,
  testCoreUiForceCommand,
];

// ---- Real consecutive file-change rows (sequences 35564..35595) -----------
// These are all updates from the same turn — the projection groups consecutive
// `file-change` rows into a single bundle regardless of which file they touch.
const fileChangeAssistantStream: TimelineRow = {
  id: "thr_zeb7z9afmw:fileChange:35564",
  threadId: "thr_zeb7z9afmw",
  turnId: "019dd185-ef12-7d50-aa48-47882e9c8aaf",
  sourceSeqStart: 35564,
  sourceSeqEnd: 35564,
  startedAt: 1777337123000,
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
  startedAt: 1777337124200,
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

// One interrupted file-change to give the mixed-status bundle a non-completed
// child without fabricating data.
const fileChangeInterrupted: TimelineRow = {
  id: "thr_zeb7z9afmw:fileChange:interrupted",
  threadId: "thr_zeb7z9afmw",
  turnId: "019dd185-ef12-7d50-aa48-47882e9c8aaf",
  sourceSeqStart: 35690,
  sourceSeqEnd: 35690,
  startedAt: 1777337129600,
  createdAt: 1777337130200,
  kind: "work",
  workKind: "file-change",
  status: "interrupted",
  callId: "call_fileChangeInterrupted",
  change: {
    path: "/Users/michael/.bb-dev/worktrees/env_33i22gvcqe/bb/packages/core-ui/src/to-view-messages.ts",
    kind: "update",
    movePath: null,
    diff: null,
    diffStats: { added: 0, removed: 0 },
  },
  stdout: null,
  stderr: null,
  approvalStatus: null,
};

const fileChangeBundleRows: TimelineRow[] = [
  fileChangeAssistantStream,
  fileChangeIndex,
  fileChangeTimelineService,
  fileChangeActiveThinkingDelete,
  fileChangeToViewMessages,
];

const fileChangeBundleMixedStatusRows: TimelineRow[] = [
  fileChangeAssistantStream,
  fileChangeIndex,
  fileChangeTimelineService,
  fileChangeInterrupted,
  fileChangeToViewMessages,
];

// ---- Exploration bundle ---------------------------------------------------
// `command` and `tool` rows that carry exploration `activityIntents` (Read,
// Grep, list_files, search) bundle under the "exploration" concept regardless
// of underlying workKind. Real intents pulled from thr_zeb7z9afmw / turn
// 019dd185-... — the agent reading the projection refactor.

function explorationToolRow(args: {
  id: string;
  seq: number;
  toolName: "Read" | "Grep" | "Glob";
  toolArgs: Record<string, string | number>;
  intentPath: string | null;
  intentType: "read" | "search" | "list_files";
  output: string;
}): TimelineRow {
  return {
    id: `thr_zeb7z9afmw:tool:${args.id}`,
    threadId: "thr_zeb7z9afmw",
    turnId: "019dd185-ef12-7d50-aa48-47882e9c8aaf",
    sourceSeqStart: args.seq,
    sourceSeqEnd: args.seq,
    startedAt: 1777337100000 + args.seq,
    createdAt: 1777337100000 + args.seq + 50,
    kind: "work",
    workKind: "tool",
    status: "completed",
    callId: args.id,
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
              name: args.intentPath?.split("/").pop() ?? "unknown",
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

const explorationBundleRows: TimelineRow[] = [
  explorationToolRow({
    id: "call_explore_read_assist_stream",
    seq: 35100,
    toolName: "Read",
    toolArgs: {
      file_path:
        "/Users/michael/.bb-dev/worktrees/env_33i22gvcqe/bb/packages/core-ui/src/assistant-stream-projection.ts",
    },
    intentPath: "packages/core-ui/src/assistant-stream-projection.ts",
    intentType: "read",
    output: "...file contents...",
  }),
  explorationToolRow({
    id: "call_explore_read_index",
    seq: 35110,
    toolName: "Read",
    toolArgs: {
      file_path:
        "/Users/michael/.bb-dev/worktrees/env_33i22gvcqe/bb/packages/core-ui/src/index.ts",
    },
    intentPath: "packages/core-ui/src/index.ts",
    intentType: "read",
    output: "...file contents...",
  }),
  explorationToolRow({
    id: "call_explore_grep_finalized",
    seq: 35120,
    toolName: "Grep",
    toolArgs: {
      pattern: "finalizedReasoningMessageKeys",
      path: "packages/core-ui/src",
    },
    intentPath: "packages/core-ui/src",
    intentType: "search",
    output: "src/assistant-stream-projection.ts:24\nsrc/to-view-messages.ts:131",
  }),
  explorationToolRow({
    id: "call_explore_glob_tests",
    seq: 35130,
    toolName: "Glob",
    toolArgs: { pattern: "packages/thread-view/test/*.test.ts" },
    intentPath: "packages/thread-view/test",
    intentType: "list_files",
    output:
      "packages/thread-view/test/timeline-view.test.ts\npackages/thread-view/test/timeline-progression.test.ts",
  }),
];

// ---- Tools bundle ---------------------------------------------------------
// Non-exploration `tool` rows (TodoWrite / message_user / ToolSearch) bundle
// under "tools". Real tool names + arg shapes pulled from threads in the DB.

function plainToolRow(args: {
  id: string;
  seq: number;
  toolName: string;
  toolArgs: Record<string, unknown>;
  output: string;
  status?: TimelineRow extends { status: infer S } ? S : never;
}): TimelineRow {
  return {
    id: `thr_zeb7z9afmw:tool:${args.id}`,
    threadId: "thr_zeb7z9afmw",
    turnId: "019dd185-ef12-7d50-aa48-47882e9c8aaf",
    sourceSeqStart: args.seq,
    sourceSeqEnd: args.seq,
    startedAt: 1777337200000 + args.seq,
    createdAt: 1777337200000 + args.seq + 100,
    kind: "work",
    workKind: "tool",
    status: args.status ?? "completed",
    callId: args.id,
    toolName: args.toolName,
    toolArgs: args.toolArgs as Record<string, never>,
    output: args.output,
    completedAt: 1777337200000 + args.seq + 100,
    approvalStatus: null,
    activityIntents: [],
  };
}

const toolsBundleRows: TimelineRow[] = [
  plainToolRow({
    id: "call_todo_1",
    seq: 35200,
    toolName: "TodoWrite",
    toolArgs: {
      todos: [
        { content: "Audit projection refactor", status: "in_progress" },
        { content: "Update timeline-service", status: "pending" },
        { content: "Drop legacy active-thinking", status: "completed" },
      ],
    },
    output: "Updated 3 todos",
  }),
  plainToolRow({
    id: "call_msg_user_1",
    seq: 35210,
    toolName: "message_user",
    toolArgs: {
      text: "Refactor in flight — moving the assistant stream projection into thread-view.",
    },
    output: "Message delivered",
  }),
  plainToolRow({
    id: "call_toolsearch_1",
    seq: 35220,
    toolName: "ToolSearch",
    toolArgs: { query: "select:Read,Grep,Glob" },
    output: "Loaded schemas for: Read, Grep, Glob",
  }),
];

// ---- Delegations bundle ---------------------------------------------------
// Consecutive `delegation` work rows bundle under "delegations". Real Agent
// dispatches from the DB.

function delegationRow(args: {
  id: string;
  seq: number;
  description: string;
  subagentType: string;
  output: string;
}): TimelineRow {
  return {
    id: `thr_y9q6n559fu:delegation:${args.id}`,
    threadId: "thr_y9q6n559fu",
    turnId: "019dd185-ef12-7d50-aa48-47882e9c8aaf",
    sourceSeqStart: args.seq,
    sourceSeqEnd: args.seq,
    startedAt: 1777338000000 + args.seq,
    createdAt: 1777338000000 + args.seq + 5000,
    kind: "work",
    workKind: "delegation",
    status: "completed",
    callId: args.id,
    toolName: "Agent",
    subagentType: args.subagentType,
    description: args.description,
    output: args.output,
    completedAt: 1777338000000 + args.seq + 5000,
    childRows: [],
  };
}

const delegationsBundleRows: TimelineRow[] = [
  delegationRow({
    id: "call_explore_router",
    seq: 36000,
    description: "Map command-router file fan-out",
    subagentType: "Explore",
    output:
      "Found 4 callers of routeCommand, all in apps/host-daemon/src. See report attached.",
  }),
  delegationRow({
    id: "call_explore_lifecycle",
    seq: 36010,
    description: "Trace exec-lifecycle status mappings",
    subagentType: "Explore",
    output:
      "exec-lifecycle.ts maps item statuses to row statuses. Approval is independent of exec status.",
  }),
  delegationRow({
    id: "call_review_branch",
    seq: 36020,
    description: "Review the projection-refactor branch for merge readiness",
    subagentType: "general-purpose",
    output:
      "Branch is rebased on main; tests pass. Two minor suggestions inline. Ready to merge.",
  }),
];

// ---- Web research bundle --------------------------------------------------
// `web-search` and `web-fetch` rows bundle together under "webResearch" — the
// concept switch puts them in the same bucket. Real queries/urls pulled from
// thr_yr83zs2m7f and thr_3vw9r8igrb.

const webSearchEditors: TimelineRow = {
  id: "thr_yr83zs2m7f:websearch:ws_editor_cli",
  threadId: "thr_yr83zs2m7f",
  turnId: "019dd185-ef12-7d50-aa48-47882e9c8aaf",
  sourceSeqStart: 7467,
  sourceSeqEnd: 7467,
  startedAt: 1777400000000,
  createdAt: 1777400000000,
  kind: "work",
  workKind: "web-search",
  status: "completed",
  callId: "ws_0e85bcec855f8f510169eff17843408198a4a02ff7f35a29bb",
  queries: [
    "VS Code --goto official docs",
    "Sublime Text command line line number official",
    "Zed editor command line line number docs",
  ],
  completedAt: 1777400000000,
};

const webFetchZed: TimelineRow = {
  id: "thr_yr83zs2m7f:webfetch:ws_zed_docs",
  threadId: "thr_yr83zs2m7f",
  turnId: "019dd185-ef12-7d50-aa48-47882e9c8aaf",
  sourceSeqStart: 7470,
  sourceSeqEnd: 7470,
  startedAt: 1777400010000,
  createdAt: 1777400010000,
  kind: "work",
  workKind: "web-fetch",
  status: "completed",
  callId: "ws_0e85bcec855f8f510169eff1846b0c81989bfa5e67bb99a484",
  url: "https://zed.dev/docs/reference/cli.html",
  prompt: null,
  pattern: null,
  completedAt: 1777400010000,
};

const webFetchTanstack: TimelineRow = {
  id: "thr_3vw9r8igrb:webfetch:tanstack",
  threadId: "thr_3vw9r8igrb",
  turnId: "019dd185-ef12-7d50-aa48-47882e9c8aaf",
  sourceSeqStart: 1202,
  sourceSeqEnd: 1203,
  startedAt: 1777481783565,
  createdAt: 1777481786285,
  kind: "work",
  workKind: "web-fetch",
  status: "completed",
  callId: "toolu_01GVztZgXKMtefajWjMwANng",
  url: "https://tanstack.com/query/latest/docs/framework/react/reference/useQuery",
  prompt:
    "How do I keep the previous query data visible while refetching with a new query key?",
  pattern: null,
  completedAt: 1777481786285,
};

const webResearchBundleRows: TimelineRow[] = [
  webSearchEditors,
  webFetchZed,
  webFetchTanstack,
];

export function Overview() {
  return (
    <StoryCard>
      <StoryRow
        label="commands"
        hint="five consecutive command rows project into one bundle-summary"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            initialExpanded={new Set([bundleId(commandBundleRows)])}
            timelineRows={commandBundleRows}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="file-changes"
        hint="five consecutive file-change rows project into one bundle-summary"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            initialExpanded={new Set([bundleId(fileChangeBundleRows)])}
            timelineRows={fileChangeBundleRows}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="exploration"
        hint="commands/tools with read/search/list_files intents bundle as exploration"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            initialExpanded={new Set([bundleId(explorationBundleRows)])}
            timelineRows={explorationBundleRows}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="tools"
        hint="non-exploration tool rows (TodoWrite, message_user, ToolSearch)"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            initialExpanded={new Set([bundleId(toolsBundleRows)])}
            timelineRows={toolsBundleRows}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="delegations"
        hint="consecutive Agent dispatches bundle as delegations"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            initialExpanded={new Set([bundleId(delegationsBundleRows)])}
            timelineRows={delegationsBundleRows}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="web research"
        hint="web-search and web-fetch share the webResearch concept and bundle together"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            initialExpanded={new Set([bundleId(webResearchBundleRows)])}
            timelineRows={webResearchBundleRows}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="mixed status (commands)"
        hint="bundle merges to status=error because one child errored"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            initialExpanded={new Set([bundleId(commandBundleMixedStatusRows)])}
            timelineRows={commandBundleMixedStatusRows}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="mixed status (file-changes)"
        hint="bundle merges to status=interrupted because one child was interrupted"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            initialExpanded={
              new Set([bundleId(fileChangeBundleMixedStatusRows)])
            }
            timelineRows={fileChangeBundleMixedStatusRows}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="active-latest — commands"
        hint="active scope: trailing bundle is the frontier, verb shimmers + rest is em"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            threadRuntimeDisplayStatus="active"
            timelineRows={commandBundleRows}
          />
        </TimelineStage>
      </StoryRow>
    </StoryCard>
  );
}
