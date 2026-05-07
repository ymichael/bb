import {
  approvalRow,
  commandRow,
  conversationRow,
  delegationRow,
  fileChangeRow,
  listFilesIntent,
  readIntent,
  searchIntent,
  systemRow,
  toolRow,
  turnRow,
  webFetchRow,
  webSearchRow,
} from "@/test/fixtures/thread-timeline-rows";
import {
  TimelineCaseGrid,
  type TimelineStoryCase,
} from "./timeline-story-fixtures.js";
import {
  permissionGrantStoryTitles,
  storyFileChange,
} from "./timeline-row-story-data.js";

export default {
  title: "Thread Timeline/Row State Sweeps",
};

const LOADING_TURN_IDS: ReadonlySet<string> = new Set<string>([
  "turn-summary-loading",
]);
const ERRORED_TURN_IDS: ReadonlySet<string> = new Set<string>([
  "turn-summary-error",
]);

function rendererUpdateChange() {
  return storyFileChange({
    path: "apps/app/src/components/thread-timeline/ConversationMessageContent.tsx",
    kind: "update",
    diff: [
      "diff --git a/apps/app/src/components/thread-timeline/ConversationMessageContent.tsx b/apps/app/src/components/thread-timeline/ConversationMessageContent.tsx",
      "--- a/apps/app/src/components/thread-timeline/ConversationMessageContent.tsx",
      "+++ b/apps/app/src/components/thread-timeline/ConversationMessageContent.tsx",
      "@@ -760,7 +760,7 @@ function UserConversationMessage({",
      '-          <div className="mt-1 flex justify-end">',
      '+          <div className="mt-1 flex items-center justify-end gap-2">',
    ].join("\n"),
    diffStats: {
      added: 1,
      removed: 1,
    },
  });
}

function createdStoryChange() {
  return storyFileChange({
    path: "apps/app/src/components/thread-timeline/row-state-sweeps.stories.tsx",
    kind: "add",
    diff: [
      'import { TimelineCaseGrid } from "./timeline-story-fixtures.js";',
      "",
      "export function CommandLeaves() {",
      "  return <TimelineCaseGrid cases={commandLeafCases} />;",
      "}",
    ].join("\n"),
    diffStats: {
      added: 5,
      removed: 0,
    },
  });
}

function deletedFixtureChange() {
  return storyFileChange({
    path: "apps/app/src/components/thread-timeline/legacy-user-message.fixture.tsx",
    kind: "delete",
    diff: [
      "-export const legacyUserMessage = {",
      '-  role: "user",',
      "-};",
    ].join("\n"),
    diffStats: {
      added: 0,
      removed: 3,
    },
  });
}

function renamedFixtureChange() {
  return storyFileChange({
    path: "apps/app/src/components/thread-timeline/user-message.stories.tsx",
    kind: "rename",
    movePath:
      "apps/app/src/components/thread-timeline/row-state-sweeps.stories.tsx",
    diff: null,
    diffStats: {
      added: 0,
      removed: 0,
    },
  });
}

function turnDetailRows() {
  return [
    conversationRow({
      id: "turn-detail-assistant",
      role: "assistant",
      seq: 401,
      text: "I found the row renderer and will add the missing state sweeps next.",
      turnId: "turn-summary-detail",
    }),
    commandRow({
      id: "turn-detail-command",
      command:
        "sed -n '720,790p' apps/app/src/components/thread-timeline/ConversationMessageContent.tsx",
      output: "function UserConversationMessage(...) { ... }",
      seq: 402,
      turnId: "turn-summary-detail",
    }),
    fileChangeRow({
      id: "turn-detail-file-change",
      seq: 403,
      turnId: "turn-summary-detail",
      change: rendererUpdateChange(),
    }),
  ];
}

const assistantMessageCases: TimelineStoryCase[] = [
  {
    id: "assistant-message-normal",
    title: "Assistant message normal",
    rows: [
      conversationRow({
        id: "assistant-message-normal",
        role: "assistant",
        seq: 1,
        text: "I will inspect the timeline fixtures and add focused state sweeps.",
      }),
    ],
  },
  {
    id: "assistant-message-markdown",
    title: "Assistant message multiline markdown",
    rows: [
      conversationRow({
        id: "assistant-message-markdown",
        role: "assistant",
        seq: 2,
        text: [
          "Coverage plan:",
          "",
          "- keep user rows content-first",
          "- show pending work in active bundles",
          "- isolate system and delegation row states",
        ].join("\n"),
      }),
    ],
  },
  {
    id: "assistant-message-partial-text",
    title: "Assistant partial text",
    rows: [
      conversationRow({
        id: "assistant-message-partial-text",
        role: "assistant",
        seq: 3,
        text: "Partial findings before interruption: command and file rows already have most leaf states, but turn load errors need an isolated story.",
      }),
    ],
  },
];

const turnSummaryCases: TimelineStoryCase[] = [
  {
    id: "turn-summary-collapsed",
    title: "Turn summary collapsed",
    rows: [
      turnRow({
        id: "turn-summary-collapsed",
        seq: 10,
        summaryCount: 3,
        durationMs: 18_000,
      }),
    ],
  },
  {
    id: "turn-summary-expanded-loaded-details",
    title: "Turn summary expanded with loaded details",
    autoExpand: true,
    turnSummaryRowsById: {
      "turn-summary-loaded": turnDetailRows(),
    },
    rows: [
      turnRow({
        id: "turn-summary-loaded",
        seq: 11,
        summaryCount: 3,
        durationMs: 21_000,
        turnId: "turn-summary-detail",
      }),
    ],
  },
  {
    id: "turn-summary-loading-details",
    title: "Turn summary loading details",
    autoExpand: true,
    loadingTurnSummaryIds: LOADING_TURN_IDS,
    rows: [
      turnRow({
        id: "turn-summary-loading",
        seq: 12,
        summaryCount: 4,
        durationMs: 25_000,
      }),
    ],
  },
  {
    id: "turn-summary-load-error-retry",
    title: "Turn summary load error retry",
    autoExpand: true,
    erroredTurnSummaryIds: ERRORED_TURN_IDS,
    rows: [
      turnRow({
        id: "turn-summary-error",
        seq: 13,
        summaryCount: 4,
        durationMs: 25_000,
      }),
    ],
  },
];

const stepSummaryCases: TimelineStoryCase[] = [
  {
    id: "completed-exploration-summary",
    title: "Muted completed exploration aggregate",
    autoExpand: true,
    rows: [
      commandRow({
        id: "step-summary-read",
        command:
          "sed -n '1,220p' apps/app/src/components/thread-timeline/isolated-rows.stories.tsx",
        activityIntents: [
          readIntent({
            path: "apps/app/src/components/thread-timeline/isolated-rows.stories.tsx",
          }),
        ],
        seq: 20,
      }),
      commandRow({
        id: "step-summary-search",
        command: 'rg -n "UserMessageStates" apps/app/src/components',
        activityIntents: [
          searchIntent({
            query: "UserMessageStates",
            path: "apps/app/src/components",
          }),
        ],
        seq: 21,
      }),
    ],
  },
  {
    id: "completed-mixed-summary",
    title: "Completed mixed step summary",
    autoExpand: true,
    rows: [
      commandRow({
        id: "step-summary-command",
        command: "git status --short",
        output:
          "M apps/app/src/components/thread-timeline/row-state-sweeps.stories.tsx",
        seq: 22,
      }),
      fileChangeRow({
        id: "step-summary-file",
        seq: 23,
        change: rendererUpdateChange(),
      }),
      webSearchRow({
        id: "step-summary-web",
        queries: ["Ladle timeline row states"],
        seq: 24,
      }),
    ],
  },
  {
    id: "summary-with-failed-child",
    title: "Summary with failed child surfaced",
    autoExpand: true,
    rows: [
      commandRow({
        id: "step-summary-ok-command",
        command: "pnpm exec turbo run typecheck --filter=@bb/app",
        output: "typecheck passed",
        seq: 25,
      }),
      commandRow({
        id: "step-summary-error-command",
        command: "pnpm exec turbo run test --filter=@bb/app",
        output:
          "thread-timeline-rows.test.tsx > expected pending steer label to render",
        status: "error",
        exitCode: 1,
        seq: 26,
      }),
    ],
  },
];

const activeBundleCases: TimelineStoryCase[] = [
  {
    id: "active-exploration-bundle",
    title: "Active exploration bundle",
    threadRuntimeDisplayStatus: "active",
    rows: [
      commandRow({
        id: "active-exploration-read",
        command: "sed -n '1,140p' apps/app/fixtures/thread-timeline-rows.ts",
        activityIntents: [
          readIntent({
            path: "apps/app/fixtures/thread-timeline-rows.ts",
          }),
        ],
        output: "streaming fixture definitions",
        status: "pending",
        exitCode: null,
        seq: 30,
      }),
      commandRow({
        id: "active-exploration-list",
        command: "ls apps/app/src/components/thread-timeline",
        activityIntents: [
          listFilesIntent({
            path: "apps/app/src/components/thread-timeline",
          }),
        ],
        output: "isolated-rows.stories.tsx\nrow-state-sweeps.stories.tsx",
        status: "pending",
        exitCode: null,
        seq: 31,
      }),
    ],
  },
  {
    id: "active-command-bundle",
    title: "Active command bundle",
    threadRuntimeDisplayStatus: "active",
    rows: [
      commandRow({
        id: "active-command-test",
        command: "pnpm exec turbo run test --filter=@bb/app",
        output: "running thread-timeline-rows.test.tsx",
        status: "pending",
        exitCode: null,
        seq: 32,
      }),
      commandRow({
        id: "active-command-ladle",
        command: "pnpm --filter @bb/app ladle:build",
        output: "vite building for production",
        status: "pending",
        exitCode: null,
        seq: 33,
      }),
    ],
  },
  {
    id: "active-mixed-bundle",
    title: "Active mixed bundle",
    threadRuntimeDisplayStatus: "active",
    rows: [
      commandRow({
        id: "active-mixed-command",
        command: "git diff -- apps/app/src/components/thread-timeline",
        output: "diff still streaming",
        status: "pending",
        exitCode: null,
        seq: 34,
      }),
      fileChangeRow({
        id: "active-mixed-file",
        status: "pending",
        seq: 35,
        change: rendererUpdateChange(),
      }),
      webSearchRow({
        id: "active-mixed-web",
        status: "pending",
        queries: ["timeline row visual audit"],
        seq: 36,
      }),
    ],
  },
  {
    id: "active-live-leaf-expanded",
    title: "Active live leaf expanded",
    threadRuntimeDisplayStatus: "active",
    rows: [
      commandRow({
        id: "active-live-command-leaf",
        command: "pnpm exec turbo run typecheck --filter=@bb/app",
        output: "checking story and fixture types",
        status: "pending",
        exitCode: null,
        seq: 37,
      }),
    ],
  },
];

const commandLeafCases: TimelineStoryCase[] = [
  {
    id: "command-running",
    title: "Command running",
    threadRuntimeDisplayStatus: "active",
    rows: [
      commandRow({
        id: "command-running",
        command: "pnpm exec turbo run test --filter=@bb/app",
        output: "running focused tests",
        status: "pending",
        exitCode: null,
        seq: 40,
      }),
    ],
  },
  {
    id: "command-completed",
    title: "Command completed",
    autoExpand: true,
    rows: [
      commandRow({
        id: "command-completed",
        command: "pnpm exec turbo run typecheck --filter=@bb/app",
        output: "typecheck passed",
        seq: 41,
      }),
    ],
  },
  {
    id: "command-failed-non-red-title",
    title: "Command failed non-red title",
    autoExpand: true,
    rows: [
      commandRow({
        id: "command-failed",
        command: "pnpm exec turbo run test --filter=@bb/app",
        output: "1 failed, 105 passed",
        status: "error",
        exitCode: 1,
        seq: 42,
      }),
    ],
  },
  {
    id: "command-interrupted",
    title: "Command interrupted",
    autoExpand: true,
    rows: [
      commandRow({
        id: "command-interrupted",
        command: "pnpm exec turbo run test --filter=@bb/integration-tests",
        output: "stop requested while integration tests were running",
        status: "interrupted",
        exitCode: null,
        durationMs: 34_000,
        seq: 43,
      }),
    ],
  },
  {
    id: "command-waiting-for-approval",
    title: "Command waiting for approval",
    rows: [
      commandRow({
        id: "command-waiting",
        command:
          "git push origin bb/timeline-ui-behavior-consistency-follow-ups-thr_c2wjru47fm",
        approvalStatus: "waiting_for_approval",
        status: "pending",
        output: "",
        exitCode: null,
        seq: 44,
      }),
    ],
  },
];

const toolLeafCases: TimelineStoryCase[] = [
  {
    id: "tool-running",
    title: "Tool running",
    threadRuntimeDisplayStatus: "active",
    rows: [
      toolRow({
        id: "tool-running",
        toolName: "Read",
        label:
          "Read apps/app/src/components/thread-timeline/ThreadTimelineRows.tsx",
        output: "streaming file contents",
        status: "pending",
        seq: 50,
      }),
    ],
  },
  {
    id: "tool-completed",
    title: "Tool completed",
    autoExpand: true,
    rows: [
      toolRow({
        id: "tool-completed",
        toolName: "LookupTool",
        label: "LookupTool select:TodoWrite",
        toolArgs: { query: "select:TodoWrite" },
        output: "Matched tools: TodoWrite",
        seq: 51,
      }),
    ],
  },
  {
    id: "tool-error",
    title: "Tool error",
    autoExpand: true,
    rows: [
      toolRow({
        id: "tool-error",
        toolName: "Read",
        label: "Read /workspace/bb/missing-file.ts",
        output: "ENOENT: no such file or directory",
        status: "error",
        seq: 52,
      }),
    ],
  },
  {
    id: "tool-interrupted",
    title: "Tool interrupted",
    autoExpand: true,
    rows: [
      toolRow({
        id: "tool-interrupted",
        toolName: "Grep",
        label: "Grep timeline renderer",
        output: "search interrupted by stop request",
        status: "interrupted",
        seq: 53,
      }),
    ],
  },
  {
    id: "tool-waiting-for-approval",
    title: "Tool waiting for approval",
    rows: [
      toolRow({
        id: "tool-waiting",
        toolName: "Write",
        label:
          "Write apps/app/src/components/thread-timeline/row-state-sweeps.stories.tsx",
        approvalStatus: "waiting_for_approval",
        status: "pending",
        output: "",
        seq: 54,
      }),
    ],
  },
];

const fileLeafCases: TimelineStoryCase[] = [
  {
    id: "file-edit",
    title: "File edit with stats",
    autoExpand: true,
    rows: [
      fileChangeRow({
        id: "file-edit",
        seq: 60,
        change: rendererUpdateChange(),
      }),
    ],
  },
  {
    id: "file-create",
    title: "File create with stats",
    autoExpand: true,
    rows: [
      fileChangeRow({
        id: "file-create",
        seq: 61,
        change: createdStoryChange(),
      }),
    ],
  },
  {
    id: "file-delete",
    title: "File delete with stats",
    autoExpand: true,
    rows: [
      fileChangeRow({
        id: "file-delete",
        seq: 62,
        change: deletedFixtureChange(),
      }),
    ],
  },
  {
    id: "file-rename",
    title: "File rename",
    rows: [
      fileChangeRow({
        id: "file-rename",
        seq: 63,
        change: renamedFixtureChange(),
      }),
    ],
  },
  {
    id: "file-active",
    title: "File active edit",
    threadRuntimeDisplayStatus: "active",
    rows: [
      fileChangeRow({
        id: "file-active",
        status: "pending",
        seq: 64,
        change: rendererUpdateChange(),
      }),
    ],
  },
  {
    id: "file-failed",
    title: "File failed edit",
    autoExpand: true,
    rows: [
      fileChangeRow({
        id: "file-failed",
        status: "error",
        stderr:
          "patch failed: apps/app/src/components/thread-timeline/ConversationMessageContent.tsx:760",
        seq: 65,
        change: rendererUpdateChange(),
      }),
    ],
  },
  {
    id: "file-interrupted",
    title: "File interrupted edit",
    autoExpand: true,
    rows: [
      fileChangeRow({
        id: "file-interrupted",
        status: "interrupted",
        stderr: "edit interrupted before patch output was finalized",
        seq: 66,
        change: rendererUpdateChange(),
      }),
    ],
  },
];

const explorationLeafCases: TimelineStoryCase[] = [
  {
    id: "completed-read-list-search-summary",
    title: "Completed read/list/search summary",
    autoExpand: true,
    rows: [
      commandRow({
        id: "exploration-read",
        command:
          "sed -n '1,220p' apps/app/src/components/thread-timeline/row-state-sweeps.stories.tsx",
        activityIntents: [
          readIntent({
            path: "apps/app/src/components/thread-timeline/row-state-sweeps.stories.tsx",
          }),
        ],
        seq: 70,
      }),
      commandRow({
        id: "exploration-list",
        command: "ls apps/app/src/components/thread-timeline",
        activityIntents: [
          listFilesIntent({
            path: "apps/app/src/components/thread-timeline",
          }),
        ],
        seq: 71,
      }),
      commandRow({
        id: "exploration-search",
        command: 'rg -n "TimelineCaseGrid" apps/app/src/components',
        activityIntents: [
          searchIntent({
            query: "TimelineCaseGrid",
            path: "apps/app/src/components",
          }),
        ],
        seq: 72,
      }),
    ],
  },
  {
    id: "active-read-list-search-summary",
    title: "Active read/list/search summary",
    threadRuntimeDisplayStatus: "active",
    rows: [
      commandRow({
        id: "active-exploration-summary-read",
        command:
          "sed -n '1,220p' apps/app/src/components/thread-timeline/ThreadTimelineRows.tsx",
        activityIntents: [
          readIntent({
            path: "apps/app/src/components/thread-timeline/ThreadTimelineRows.tsx",
          }),
        ],
        output: "reading renderer",
        status: "pending",
        exitCode: null,
        seq: 73,
      }),
      commandRow({
        id: "active-exploration-summary-search",
        command: 'rg -n "compactActivityIntents" apps/app/src',
        activityIntents: [
          searchIntent({
            query: "compactActivityIntents",
            path: "apps/app/src",
          }),
        ],
        output: "searching renderer",
        status: "pending",
        exitCode: null,
        seq: 74,
      }),
    ],
  },
];

const webLeafCases: TimelineStoryCase[] = [
  {
    id: "web-search-completed",
    title: "Web search completed",
    rows: [
      webSearchRow({
        id: "web-search-completed",
        queries: ["timeline renderer row state stories"],
        seq: 80,
      }),
    ],
  },
  {
    id: "web-fetch-completed",
    title: "Web fetch completed",
    rows: [
      webFetchRow({
        id: "web-fetch-completed",
        url: "https://example.com/thread-timeline",
        prompt: "Summarize the row rendering guidance.",
        seq: 81,
      }),
    ],
  },
  {
    id: "web-search-running",
    title: "Web search running",
    threadRuntimeDisplayStatus: "active",
    rows: [
      webSearchRow({
        id: "web-search-running",
        queries: ["pending timeline row shimmer"],
        status: "pending",
        seq: 82,
      }),
    ],
  },
  {
    id: "web-fetch-running",
    title: "Web fetch running",
    threadRuntimeDisplayStatus: "active",
    rows: [
      webFetchRow({
        id: "web-fetch-running",
        url: "https://example.com/thread-timeline-live",
        status: "pending",
        seq: 83,
      }),
    ],
  },
  {
    id: "web-search-error",
    title: "Web search error",
    rows: [
      webSearchRow({
        id: "web-search-error",
        queries: ["missing timeline row state"],
        status: "error",
        seq: 84,
      }),
    ],
  },
  {
    id: "web-search-interrupted",
    title: "Web search interrupted",
    rows: [
      webSearchRow({
        id: "web-search-interrupted",
        queries: ["slow timeline row state search"],
        status: "interrupted",
        seq: 85,
      }),
    ],
  },
  {
    id: "web-fetch-error",
    title: "Web fetch error",
    rows: [
      webFetchRow({
        id: "web-fetch-error",
        url: "https://example.com/missing-thread-timeline",
        status: "error",
        seq: 86,
      }),
    ],
  },
  {
    id: "web-fetch-interrupted",
    title: "Web fetch interrupted",
    rows: [
      webFetchRow({
        id: "web-fetch-interrupted",
        url: "https://example.com/slow-thread-timeline",
        status: "interrupted",
        seq: 87,
      }),
    ],
  },
];

const delegationCases: TimelineStoryCase[] = [
  {
    id: "delegation-active",
    title: "Delegation active",
    autoExpand: true,
    threadRuntimeDisplayStatus: "active",
    rows: [
      delegationRow({
        id: "delegation-active",
        status: "pending",
        subagentType: "explorer",
        description: "Audit remaining row state gaps",
        output: "",
        seq: 90,
        childRows: [
          commandRow({
            id: "delegation-active-search",
            command:
              'rg -n "TimelineRowsStory" apps/app/src/components/thread-timeline',
            output: "searching story entry points",
            status: "pending",
            exitCode: null,
            seq: 91,
            turnId: "turn-delegation-active",
          }),
        ],
      }),
    ],
  },
  {
    id: "delegation-completed",
    title: "Delegation completed",
    autoExpand: true,
    rows: [
      delegationRow({
        id: "delegation-completed",
        status: "completed",
        subagentType: "explorer",
        description: "Audit timeline row fixtures",
        output:
          "The isolated stories now cover user messages, work leaves, summaries, turns, and system rows.",
        seq: 92,
        childRows: [
          commandRow({
            id: "delegation-completed-command",
            command: "pnpm exec turbo run typecheck --filter=@bb/app",
            output: "typecheck passed",
            seq: 93,
            turnId: "turn-delegation-completed",
          }),
        ],
      }),
    ],
  },
  {
    id: "delegation-error",
    title: "Delegation error",
    autoExpand: true,
    rows: [
      delegationRow({
        id: "delegation-error",
        status: "error",
        subagentType: "worker",
        description: "Implement row state sweep stories",
        output: "The worker hit a story typecheck failure before finishing.",
        seq: 94,
        childRows: [
          commandRow({
            id: "delegation-error-command",
            command: "pnpm exec turbo run typecheck --filter=@bb/app",
            output:
              "row-state-sweeps.stories.tsx(1,1): error TS2307: Cannot find module",
            status: "error",
            exitCode: 1,
            seq: 95,
            turnId: "turn-delegation-error",
          }),
        ],
      }),
    ],
  },
];

const approvalCases: TimelineStoryCase[] = [
  {
    id: "approval-pending",
    title: "Approval pending",
    rows: [
      approvalRow({
        id: "approval-pending",
        interactionId: "pi_perm_pending",
        itemId: "call_bash_pending",
        toolName: "Bash",
        title: permissionGrantStoryTitles.pending,
        seq: 100,
      }),
    ],
  },
  {
    id: "approval-completed",
    title: "Approval completed",
    rows: [
      approvalRow({
        id: "approval-completed",
        interactionId: "pi_perm_completed",
        itemId: "call_bash_completed",
        toolName: "Bash",
        title: permissionGrantStoryTitles.completed,
        status: "completed",
        seq: 101,
      }),
    ],
  },
  {
    id: "approval-error",
    title: "Approval error",
    rows: [
      approvalRow({
        id: "approval-error",
        interactionId: "pi_perm_error",
        itemId: "call_bash_error",
        toolName: "Bash",
        title: permissionGrantStoryTitles.error,
        status: "error",
        seq: 102,
      }),
    ],
  },
  {
    id: "approval-interrupted",
    title: "Approval interrupted",
    rows: [
      approvalRow({
        id: "approval-interrupted",
        interactionId: "pi_perm_interrupted",
        itemId: "call_bash_interrupted",
        toolName: "Bash",
        title: permissionGrantStoryTitles.interrupted,
        status: "interrupted",
        seq: 103,
      }),
    ],
  },
];

const systemCases: TimelineStoryCase[] = [
  {
    id: "system-context-compaction",
    title: "System context compaction",
    autoExpand: true,
    rows: [
      systemRow({
        id: "system-context-compaction",
        title: "Compacted conversation context",
        detail:
          "Archived 46 earlier events into a compact summary for the next turn.",
        seq: 110,
      }),
    ],
  },
  {
    id: "system-manager-assignment",
    title: "System manager assignment",
    autoExpand: true,
    rows: [
      systemRow({
        id: "system-manager-assignment",
        title: "Thread assigned to manager",
        detail:
          "Manager thread thr_c2wjru47fm is coordinating timeline shippability.",
        seq: 111,
      }),
    ],
  },
  {
    id: "system-loading-operation",
    title: "System loading operation",
    rows: [
      systemRow({
        id: "system-loading-operation",
        title: "Provisioning thread",
        detail: "Creating worktree and installing dependencies...",
        status: "pending",
        seq: 112,
      }),
    ],
  },
  {
    id: "system-reconnect",
    title: "System host reconnect",
    rows: [
      systemRow({
        id: "system-reconnect",
        systemKind: "reconnect",
        title: "Host daemon reconnecting",
        detail: null,
        status: "pending",
        seq: 113,
      }),
    ],
  },
  {
    id: "system-error",
    title: "System error",
    autoExpand: true,
    rows: [
      systemRow({
        id: "system-error",
        systemKind: "error",
        title: "Ownership change failed",
        detail:
          "Release command failed\nThe selected manager thread is archived.",
        status: "error",
        seq: 114,
      }),
    ],
  },
  {
    id: "system-debug",
    title: "System debug row",
    autoExpand: true,
    rows: [
      systemRow({
        id: "system-debug",
        systemKind: "debug",
        title: "debug/raw-event",
        detail:
          '{"type":"debug/raw-event","provider":"codex","itemId":"item_123"}',
        status: null,
        seq: 115,
      }),
    ],
  },
];

export function AssistantMessages() {
  return <TimelineCaseGrid cases={assistantMessageCases} />;
}

export function TurnSummaries() {
  return <TimelineCaseGrid cases={turnSummaryCases} />;
}

export function StepSummaries() {
  return <TimelineCaseGrid cases={stepSummaryCases} />;
}

export function ActiveBundleSummaries() {
  return <TimelineCaseGrid cases={activeBundleCases} />;
}

export function CommandLeaves() {
  return <TimelineCaseGrid cases={commandLeafCases} />;
}

export function ToolLeaves() {
  return <TimelineCaseGrid cases={toolLeafCases} />;
}

export function FileLeaves() {
  return <TimelineCaseGrid cases={fileLeafCases} />;
}

export function ReadListSearchLeaves() {
  return <TimelineCaseGrid cases={explorationLeafCases} />;
}

export function WebLeaves() {
  return <TimelineCaseGrid cases={webLeafCases} />;
}

export function DelegationRows() {
  return <TimelineCaseGrid cases={delegationCases} />;
}

export function ApprovalRows() {
  return <TimelineCaseGrid cases={approvalCases} />;
}

export function SystemRows() {
  return <TimelineCaseGrid cases={systemCases} />;
}
