import type {
  TimelineRow,
  TimelineRowStatus,
  TimelineToolWorkRow,
} from "@bb/server-contract";
import type { ReactNode } from "react";
import { ThreadTimelineRows } from "@/components/thread/timeline";
import {
  StoryDraftPromptBox,
  useStoryPromptDraft,
} from "@/components/thread/timeline/StoryDraftPromptBox";
import {
  commandRow,
  conversationRow,
  delegationRow,
  fileChangeRow,
  fileReadRow,
  searchRow,
  toolRow,
  webFetchRow,
  webSearchRow,
} from "@/test/fixtures/thread-timeline-rows";
import { StoryCard, StoryRow } from "../../../../../.ladle/story-card";

export default {
  title: "thread/timeline/rows/Bundle Summary",
};

function TimelineStage({ children }: { children: ReactNode }) {
  return <div className="w-full max-w-[760px]">{children}</div>;
}

const baseProps = {
  threadRuntimeDisplayStatus: "idle" as const,
  workspaceRootPath: undefined,
};

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

type ExplorationRowArgs = { id: string; seq: number } & (
  | { kind: "read"; path: string }
  | { kind: "search"; query: string; path: string | null }
  | { kind: "list"; pattern: string; path: string | null }
);

interface PlainToolRowArgs {
  id: string;
  seq: number;
  toolName: string;
  toolArgs: TimelineToolWorkRow["toolArgs"];
  output: string;
  status?: TimelineRowStatus;
}

interface DelegationFixtureRowArgs {
  id: string;
  seq: number;
  description: string;
  subagentType: string;
  output: string;
}

const buildDomainCoreUiCommand: TimelineRow = commandRow({
  id: "thr_zeb7z9afmw:command:call_buildDomainCoreUi",
  threadId: "thr_zeb7z9afmw",
  turnId: "019dd185-ef12-7d50-aa48-47882e9c8aaf",
  sourceSeqStart: 35700,
  sourceSeqEnd: 35700,
  startedAt: 1777337330000,
  createdAt: 1777337332100,
  status: "completed",
  callId: "call_buildDomainCoreUi",
  command:
    "pnpm exec turbo run build --filter=@bb/domain --filter=@bb/core-ui --filter=@bb/server-contract --concurrency=1 > /tmp/bb-projection-refactor-build.log 2>&1",
  cwd: "/Users/michael/.bb-dev/worktrees/env_33i22gvcqe/bb",
  source: null,
  output: "",
  exitCode: 0,
  approvalStatus: null,
  activityIntents: [],
  durationMs: 2100,
});

const testServerCommand: TimelineRow = commandRow({
  id: "thr_zeb7z9afmw:command:call_testServer",
  threadId: "thr_zeb7z9afmw",
  turnId: "019dd185-ef12-7d50-aa48-47882e9c8aaf",
  sourceSeqStart: 35701,
  sourceSeqEnd: 35701,
  startedAt: 1777337332200,
  createdAt: 1777337339400,
  status: "completed",
  callId: "call_testServer",
  command:
    "pnpm exec turbo run test --filter=@bb/server --only --concurrency=1 -- --run test/threads/timeline-service.test.ts > /tmp/bb-projection-refactor-server.log 2>&1",
  cwd: "/Users/michael/.bb-dev/worktrees/env_33i22gvcqe/bb",
  source: null,
  output: "",
  exitCode: 0,
  approvalStatus: null,
  activityIntents: [],
  durationMs: 7200,
});

const testCoreUiCommand: TimelineRow = commandRow({
  id: "thr_zeb7z9afmw:command:call_testCoreUi",
  threadId: "thr_zeb7z9afmw",
  turnId: "019dd185-ef12-7d50-aa48-47882e9c8aaf",
  sourceSeqStart: 35702,
  sourceSeqEnd: 35702,
  startedAt: 1777337339500,
  createdAt: 1777337346700,
  status: "completed",
  callId: "call_testCoreUi",
  command:
    "pnpm exec turbo run test --filter=@bb/core-ui --concurrency=1 -- --run test/to-view-messages.assistant-streams.test.ts test/to-view-messages.turn-lifecycle.test.ts test/to-view-messages.client-input.test.ts > /tmp/bb-projection-refactor-coreui.log 2>&1",
  cwd: "/Users/michael/.bb-dev/worktrees/env_33i22gvcqe/bb",
  source: null,
  output: "",
  exitCode: 0,
  approvalStatus: null,
  activityIntents: [],
  durationMs: 7200,
});

const buildForceCommand: TimelineRow = commandRow({
  id: "thr_zeb7z9afmw:command:call_buildForce",
  threadId: "thr_zeb7z9afmw",
  turnId: "019dd185-ef12-7d50-aa48-47882e9c8aaf",
  sourceSeqStart: 35733,
  sourceSeqEnd: 35733,
  startedAt: 1777337346800,
  createdAt: 1777337352900,
  status: "completed",
  callId: "call_buildForce",
  command:
    "pnpm exec turbo run build --filter=@bb/domain --filter=@bb/core-ui --force --concurrency=1 > /tmp/bb-projection-refactor-force-build.log 2>&1",
  cwd: "/Users/michael/.bb-dev/worktrees/env_33i22gvcqe/bb",
  source: null,
  output: "",
  exitCode: 0,
  approvalStatus: null,
  activityIntents: [],
  durationMs: 6100,
});

const testCoreUiForceCommand: TimelineRow = commandRow({
  id: "thr_zeb7z9afmw:command:call_testCoreUiForce",
  threadId: "thr_zeb7z9afmw",
  turnId: "019dd185-ef12-7d50-aa48-47882e9c8aaf",
  sourceSeqStart: 35734,
  sourceSeqEnd: 35734,
  startedAt: 1777337353000,
  createdAt: 1777337361500,
  status: "completed",
  callId: "call_testCoreUiForce",
  command:
    "pnpm exec turbo run test --filter=@bb/core-ui --force --concurrency=1 -- --run test/to-view-messages.assistant-streams.test.ts test/to-view-messages.turn-lifecycle.test.ts test/to-view-messages.client-input.test.ts > /tmp/bb-projection-refactor-force-coreui.log 2>&1",
  cwd: "/Users/michael/.bb-dev/worktrees/env_33i22gvcqe/bb",
  source: null,
  output: "",
  exitCode: 0,
  approvalStatus: null,
  activityIntents: [],
  durationMs: 8500,
});

const testServerErrorCommand: TimelineRow = commandRow({
  id: "thr_zeb7z9afmw:command:call_testServerError",
  threadId: "thr_zeb7z9afmw",
  turnId: "019dd185-ef12-7d50-aa48-47882e9c8aaf",
  sourceSeqStart: 35913,
  sourceSeqEnd: 35913,
  startedAt: 1777337361600,
  createdAt: 1777337372100,
  status: "error",
  callId: "call_testServerError",
  command:
    "pnpm exec turbo run test --filter=@bb/server --only --force --concurrency=1 -- --run test/threads/timeline-service.test.ts > /tmp/bb-projection-refactor-server.log 2>&1",
  cwd: "/Users/michael/.bb-dev/worktrees/env_33i22gvcqe/bb",
  source: null,
  output: "",
  exitCode: 1,
  approvalStatus: null,
  activityIntents: [],
  durationMs: 10500,
});

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

const fileChangeAssistantStream: TimelineRow = fileChangeRow({
  id: "thr_zeb7z9afmw:fileChange:35564",
  threadId: "thr_zeb7z9afmw",
  turnId: "019dd185-ef12-7d50-aa48-47882e9c8aaf",
  sourceSeqStart: 35564,
  sourceSeqEnd: 35564,
  startedAt: 1777337123000,
  createdAt: 1777337123900,
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
});

const fileChangeIndex: TimelineRow = fileChangeRow({
  id: "thr_zeb7z9afmw:fileChange:35573",
  threadId: "thr_zeb7z9afmw",
  turnId: "019dd185-ef12-7d50-aa48-47882e9c8aaf",
  sourceSeqStart: 35573,
  sourceSeqEnd: 35573,
  startedAt: 1777337124200,
  createdAt: 1777337125300,
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
});

const fileChangeTimelineService: TimelineRow = fileChangeRow({
  id: "thr_zeb7z9afmw:fileChange:35595",
  threadId: "thr_zeb7z9afmw",
  turnId: "019dd185-ef12-7d50-aa48-47882e9c8aaf",
  sourceSeqStart: 35595,
  sourceSeqEnd: 35595,
  startedAt: 1777337125400,
  createdAt: 1777337127100,
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
     thread.parentThreadId !== null && !options.showAllParentEvents;
+  const contextWindowUsageRows = listContextWindowUsageRows(db, {
+    threadId: thread.id,
+  });
+
+  if (isDefaultParentView) {
+    return {
+      rows: buildParentConversationRows(
+        toViewMessages(decodedEvents, {
+          includeInternalSystemMessages: options.showAllParentEvents,
+          threadStatus: thread.status,
+          parentThreadId: thread.parentThreadId,
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
});

const fileChangeActiveThinkingDelete: TimelineRow = fileChangeRow({
  id: "thr_zeb7z9afmw:fileChange:35611",
  threadId: "thr_zeb7z9afmw",
  turnId: "019dd185-ef12-7d50-aa48-47882e9c8aaf",
  sourceSeqStart: 35611,
  sourceSeqEnd: 35611,
  startedAt: 1777337127200,
  createdAt: 1777337127900,
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
});

const fileChangeToViewMessages: TimelineRow = fileChangeRow({
  id: "thr_zeb7z9afmw:fileChange:35671",
  threadId: "thr_zeb7z9afmw",
  turnId: "019dd185-ef12-7d50-aa48-47882e9c8aaf",
  sourceSeqStart: 35671,
  sourceSeqEnd: 35671,
  startedAt: 1777337128000,
  createdAt: 1777337129500,
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
});

const fileChangeInterrupted: TimelineRow = fileChangeRow({
  id: "thr_zeb7z9afmw:fileChange:interrupted",
  threadId: "thr_zeb7z9afmw",
  turnId: "019dd185-ef12-7d50-aa48-47882e9c8aaf",
  sourceSeqStart: 35690,
  sourceSeqEnd: 35690,
  startedAt: 1777337129600,
  createdAt: 1777337130200,
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
});

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

function explorationRow(args: ExplorationRowArgs): TimelineRow {
  const base = {
    threadId: "thr_zeb7z9afmw",
    turnId: "019dd185-ef12-7d50-aa48-47882e9c8aaf",
    sourceSeqStart: args.seq,
    sourceSeqEnd: args.seq,
    startedAt: 1777337100000 + args.seq,
    createdAt: 1777337100000 + args.seq + 50,
    status: "completed" as const,
    callId: args.id,
    durationMs: 50,
  };
  switch (args.kind) {
    case "read":
      return fileReadRow({
        ...base,
        id: `thr_zeb7z9afmw:file-read:${args.id}`,
        path: args.path,
      });
    case "search":
      return searchRow({
        ...base,
        id: `thr_zeb7z9afmw:search:${args.id}`,
        mode: "content",
        query: args.query,
        path: args.path,
      });
    case "list":
      return searchRow({
        ...base,
        id: `thr_zeb7z9afmw:search:${args.id}`,
        mode: "path",
        query: args.pattern,
        path: args.path,
      });
  }
}

const explorationBundleRows: TimelineRow[] = [
  explorationRow({
    id: "call_explore_read_assist_stream",
    seq: 35100,
    kind: "read",
    path: "packages/core-ui/src/assistant-stream-projection.ts",
  }),
  explorationRow({
    id: "call_explore_read_index",
    seq: 35110,
    kind: "read",
    path: "packages/core-ui/src/index.ts",
  }),
  explorationRow({
    id: "call_explore_grep_finalized",
    seq: 35120,
    kind: "search",
    query: "finalizedReasoningMessageKeys",
    path: "packages/core-ui/src",
  }),
  explorationRow({
    id: "call_explore_glob_tests",
    seq: 35130,
    kind: "list",
    pattern: "packages/thread-view/test/*.test.ts",
    path: "packages/thread-view/test",
  }),
];

function plainToolRow(args: PlainToolRowArgs): TimelineRow {
  return toolRow({
    id: `thr_zeb7z9afmw:tool:${args.id}`,
    threadId: "thr_zeb7z9afmw",
    turnId: "019dd185-ef12-7d50-aa48-47882e9c8aaf",
    sourceSeqStart: args.seq,
    sourceSeqEnd: args.seq,
    startedAt: 1777337200000 + args.seq,
    createdAt: 1777337200000 + args.seq + 100,
    status: args.status ?? "completed",
    callId: args.id,
    toolName: args.toolName,
    toolArgs: args.toolArgs,
    output: args.output,
    approvalStatus: null,
    durationMs: 100,
  });
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
    toolName: "notify_user",
    toolArgs: {
      text: "Refactor in flight — moving the assistant stream projection into thread-view.",
    },
    output: "Notification delivered",
  }),
  plainToolRow({
    id: "call_toolsearch_1",
    seq: 35220,
    toolName: "ToolSearch",
    toolArgs: { query: "select:Read,Grep,Glob" },
    output: "Loaded schemas for: Read, Grep, Glob",
  }),
];

function delegationFixtureRow(args: DelegationFixtureRowArgs): TimelineRow {
  return delegationRow({
    id: `thr_y9q6n559fu:delegation:${args.id}`,
    threadId: "thr_y9q6n559fu",
    turnId: "019dd185-ef12-7d50-aa48-47882e9c8aaf",
    sourceSeqStart: args.seq,
    sourceSeqEnd: args.seq,
    startedAt: 1777338000000 + args.seq,
    createdAt: 1777338000000 + args.seq + 5000,
    status: "completed",
    callId: args.id,
    toolName: "Agent",
    subagentType: args.subagentType,
    description: args.description,
    output: args.output,
    childRows: [],
    durationMs: 5_000,
  });
}

const delegationsBundleRows: TimelineRow[] = [
  delegationFixtureRow({
    id: "call_explore_router",
    seq: 36000,
    description: "Map command-router file fan-out",
    subagentType: "Explore",
    output:
      "Found 4 callers of routeCommand, all in apps/host-daemon/src. See report attached.",
  }),
  delegationFixtureRow({
    id: "call_explore_lifecycle",
    seq: 36010,
    description: "Trace exec-lifecycle status mappings",
    subagentType: "Explore",
    output:
      "exec-lifecycle.ts maps item statuses to row statuses. Approval is independent of exec status.",
  }),
  delegationFixtureRow({
    id: "call_review_branch",
    seq: 36020,
    description: "Review the projection-refactor branch for merge readiness",
    subagentType: "general-purpose",
    output:
      "Branch is rebased on main; tests pass. Two minor suggestions inline. Ready to merge.",
  }),
];

const webSearchEditors: TimelineRow = webSearchRow({
  id: "thr_yr83zs2m7f:websearch:ws_editor_cli",
  threadId: "thr_yr83zs2m7f",
  turnId: "019dd185-ef12-7d50-aa48-47882e9c8aaf",
  sourceSeqStart: 7467,
  sourceSeqEnd: 7467,
  startedAt: 1777400000000,
  createdAt: 1777400000000,
  status: "completed",
  callId: "ws_0e85bcec855f8f510169eff17843408198a4a02ff7f35a29bb",
  queries: [
    "VS Code --goto official docs",
    "Sublime Text command line line number official",
    "Zed editor command line line number docs",
  ],
  durationMs: 0,
});

const webFetchZed: TimelineRow = webFetchRow({
  id: "thr_yr83zs2m7f:webfetch:ws_zed_docs",
  threadId: "thr_yr83zs2m7f",
  turnId: "019dd185-ef12-7d50-aa48-47882e9c8aaf",
  sourceSeqStart: 7470,
  sourceSeqEnd: 7470,
  startedAt: 1777400010000,
  createdAt: 1777400010000,
  status: "completed",
  callId: "ws_0e85bcec855f8f510169eff1846b0c81989bfa5e67bb99a484",
  url: "https://zed.dev/docs/reference/cli.html",
  prompt: null,
  pattern: null,
  durationMs: 0,
});

const webFetchTanstack: TimelineRow = webFetchRow({
  id: "thr_3vw9r8igrb:webfetch:tanstack",
  threadId: "thr_3vw9r8igrb",
  turnId: "019dd185-ef12-7d50-aa48-47882e9c8aaf",
  sourceSeqStart: 1202,
  sourceSeqEnd: 1203,
  startedAt: 1777481783565,
  createdAt: 1777481786285,
  status: "completed",
  callId: "toolu_01GVztZgXKMtefajWjMwANng",
  url: "https://tanstack.com/query/latest/docs/framework/react/reference/useQuery",
  prompt:
    "How do I keep the previous query data visible while refetching with a new query key?",
  pattern: null,
  durationMs: 2720,
});

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
        hint="non-exploration tool rows (TodoWrite, notify_user, ToolSearch)"
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

const CONV_THREAD_ID = "thr_zeb7z9afmw";
const CONV_TURN_ID = "conv-interleaved-turn";

function userMessage(seq: number, text: string): TimelineRow {
  return conversationRow({
    id: `${CONV_THREAD_ID}:user:${seq}`,
    threadId: CONV_THREAD_ID,
    turnId: CONV_TURN_ID,
    role: "user",
    sourceSeqStart: seq,
    startedAt: 1777337000000 + seq,
    createdAt: 1777337000000 + seq,
    text,
  });
}

function assistantMessage(seq: number, text: string): TimelineRow {
  return conversationRow({
    id: `${CONV_THREAD_ID}:assistant:${seq}`,
    threadId: CONV_THREAD_ID,
    turnId: CONV_TURN_ID,
    role: "assistant",
    sourceSeqStart: seq,
    startedAt: 1777337000000 + seq,
    createdAt: 1777337000000 + seq,
    text,
  });
}

function frontierRead(
  idSuffix: string,
  seq: number,
  path: string,
  status: TimelineRowStatus,
): TimelineRow {
  return fileReadRow({
    id: `${CONV_THREAD_ID}:file-read:frontier_${idSuffix}`,
    threadId: CONV_THREAD_ID,
    turnId: CONV_TURN_ID,
    sourceSeqStart: seq,
    startedAt: status === "pending" ? Date.now() : Date.now() - 4000,
    createdAt: status === "pending" ? Date.now() : Date.now() - 4000,
    status,
    callId: `frontier_${idSuffix}`,
    path,
    durationMs: status === "pending" ? null : 60,
  });
}

const frontierExplorationRows: TimelineRow[] = [
  frontierRead(
    "watcher",
    40001,
    "packages/host-daemon/src/workspace/watcher.ts",
    "completed",
  ),
  frontierRead(
    "session",
    40002,
    "packages/host-daemon/src/runtime/session.ts",
    "completed",
  ),
  frontierRead(
    "index",
    40003,
    "packages/host-daemon/src/workspace/index.ts",
    "pending",
  ),
];

const interleavedConversationRows: TimelineRow[] = [
  userMessage(40010, "Track down why the workspace watcher leaks and fix it."),
  assistantMessage(
    40011,
    "Starting with a read through the watcher and its callers.",
  ),
  ...explorationBundleRows,
  assistantMessage(
    40020,
    "Confirmed — the watcher outlives the provider process. Running the suite to verify.",
  ),
  ...commandBundleMixedStatusRows,
  assistantMessage(
    40030,
    "First pass hit a failing server test; it needs the fix to land before it goes green. Editing the call sites now.",
  ),
  ...fileChangeBundleMixedStatusRows,
  assistantMessage(
    40040,
    "Re-applied the interrupted edit and reran — clean. Tidying the todo list and reloading the tool schemas.",
  ),
  ...toolsBundleRows,
  userMessage(
    40050,
    "Also confirm the recommended idle-TTL default from the editor docs.",
  ),
  assistantMessage(40051, "Researching the editor CLI docs now."),
  ...webResearchBundleRows,
  assistantMessage(
    40060,
    "Docs point to a 30s idle lease. Delegating the cross-package check and a merge-readiness review.",
  ),
  ...delegationsBundleRows,
  assistantMessage(
    40070,
    "Subagents are back clean. Doing a final read-through of the changed files before I hand it off.",
  ),
  ...frontierExplorationRows,
];

export function Conversation() {
  const promptDraft = useStoryPromptDraft();
  const handleAddToChat = promptDraft.addQuote;

  return (
    <StoryCard>
      <StoryRow
        label="interleaved thread"
        hint="user + agent messages at full strength; finished work rolled up and receded; errored/interrupted clusters and the live frontier kept prominent"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            threadRuntimeDisplayStatus="active"
            onSelectionAddToChat={handleAddToChat}
            timelineRows={interleavedConversationRows}
          />
          <div className="mt-3">
            <StoryDraftPromptBox draft={promptDraft} />
          </div>
        </TimelineStage>
      </StoryRow>
    </StoryCard>
  );
}
