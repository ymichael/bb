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
  unknownIntent,
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
  title: "Thread Timeline/Isolated Rows",
};

const LOADING_TURN_IDS: ReadonlySet<string> = new Set<string>([
  "turn-loading-details",
]);

const COPY_AFFORDANCE_VISIBLE_CLASS_NAME = "timeline-story-copy-visible";
const COPY_AFFORDANCE_VISIBLE_STYLE = `.${COPY_AFFORDANCE_VISIBLE_CLASS_NAME} .md\\:opacity-0 { opacity: 1; }`;

function rendererUpdateChange() {
  return storyFileChange({
    path: "apps/app/src/components/thread-timeline/ThreadTimelineRows.tsx",
    kind: "update",
    diff: [
      "diff --git a/apps/app/src/components/thread-timeline/ThreadTimelineRows.tsx b/apps/app/src/components/thread-timeline/ThreadTimelineRows.tsx",
      "--- a/apps/app/src/components/thread-timeline/ThreadTimelineRows.tsx",
      "+++ b/apps/app/src/components/thread-timeline/ThreadTimelineRows.tsx",
      "@@ -953,7 +953,10 @@ function TimelineRowView({",
      "-  if (!isRowExpandable(row)) {",
      "+  if (!isRowExpandable(row)) {",
      "+    return (",
      "+      <TimelineStaticRow horizontalPadding={horizontalPadding}>",
      "+        <TimelineTitleView title={titleState.title} />",
      "     return null;",
    ].join("\n"),
    diffStats: {
      added: 5,
      removed: 1,
    },
  });
}

function createdPlanChange() {
  return storyFileChange({
    path: "plans/timeline-isolated-row-stories.md",
    kind: "add",
    diff: [
      "# Timeline row story audit",
      "- Add isolated row fixtures",
      "- Validate the Ladle surface",
    ].join("\n"),
    diffStats: {
      added: 3,
      removed: 0,
    },
  });
}

function deletedLegacyStoryChange() {
  return storyFileChange({
    path: "apps/app/src/components/thread-timeline/legacy-row-fixture.tsx",
    kind: "delete",
    diff: [
      "-export function LegacyTimelineRows() {",
      "-  return null;",
      "-}",
    ].join("\n"),
    diffStats: {
      added: 0,
      removed: 3,
    },
  });
}

function renamedStoryChange() {
  return storyFileChange({
    path: "apps/app/src/components/thread-timeline/full-rows.stories.tsx",
    kind: "rename",
    movePath: "apps/app/src/components/thread-timeline/rows.stories.tsx",
    diff: null,
    diffStats: {
      added: 0,
      removed: 0,
    },
  });
}

function pendingTitleChange() {
  return storyFileChange({
    path: "packages/thread-view/src/timeline-row-title.ts",
    kind: "update",
    diff: "@@ -268,7 +268,7 @@ function buildExecutionTitle(row) {\n-  const prefix = executionPrefix(row);\n+  const prefix = executionPrefix(row);",
    diffStats: {
      added: 1,
      removed: 1,
    },
  });
}

function nestedTurnRows() {
  return [
    conversationRow({
      id: "nested-assistant-1",
      role: "assistant",
      seq: 31,
      text: "I found the row renderer and will add isolated story fixtures next.",
      turnId: "turn-nested",
    }),
    commandRow({
      id: "nested-read-1",
      command:
        "sed -n '1,220p' apps/app/src/components/thread-timeline/rows.stories.tsx",
      activityIntents: [
        readIntent({
          path: "apps/app/src/components/thread-timeline/rows.stories.tsx",
        }),
      ],
      output: 'export default { title: "Thread Timeline/Rows" };',
      seq: 32,
      turnId: "turn-nested",
    }),
    commandRow({
      id: "nested-test-1",
      command: "pnpm exec turbo run test --filter=@bb/app",
      output: "cache hit\n36 tests passed",
      seq: 33,
      turnId: "turn-nested",
    }),
    fileChangeRow({
      id: "nested-file-change-1",
      seq: 34,
      turnId: "turn-nested",
      change: rendererUpdateChange(),
    }),
  ];
}

function delegationChildRows() {
  return [
    conversationRow({
      id: "delegation-child-message-1",
      role: "assistant",
      seq: 41,
      text: "I will inspect the timeline view grouping and report concrete edge cases.",
      turnId: "turn-delegation-child",
    }),
    commandRow({
      id: "delegation-child-search-1",
      command:
        'rg -n "activity-summary|shouldSummarizeRun" packages/thread-view/src',
      activityIntents: [
        searchIntent({
          query: "activity-summary|shouldSummarizeRun",
          path: "packages/thread-view/src",
        }),
      ],
      output:
        "packages/thread-view/src/timeline-view.ts:596:function isSummarizableWorkRow",
      seq: 42,
      turnId: "turn-delegation-child",
    }),
    commandRow({
      id: "delegation-child-typecheck-1",
      command: "pnpm exec turbo run typecheck --filter=@bb/thread-view",
      output: "typecheck passed",
      seq: 43,
      turnId: "turn-delegation-child",
      status: "pending",
      exitCode: null,
    }),
  ];
}

const expansionStateCases: TimelineStoryCase[] = [
  {
    id: "completed-command-collapsed",
    title: "Completed command collapsed",
    rows: [
      commandRow({
        id: "command-completed-collapsed",
        command: "pnpm exec turbo run test --filter=@bb/app",
        output: "36 tests passed",
        seq: 1,
      }),
    ],
  },
  {
    id: "completed-command-expanded",
    title: "Completed command expanded",
    autoExpand: true,
    rows: [
      commandRow({
        id: "command-completed-expanded",
        command: "pnpm exec turbo run test --filter=@bb/app",
        output: "36 tests passed",
        seq: 2,
      }),
    ],
  },
  {
    id: "completed-single-work-muted-leaf-title",
    title: "Completed single work muted leaf title",
    autoExpand: true,
    rows: [
      fileChangeRow({
        id: "single-file-hybrid-title",
        seq: 3,
        change: rendererUpdateChange(),
      }),
    ],
  },
  {
    id: "completed-bundle-collapsed",
    title: "Completed bundle collapsed",
    rows: [
      commandRow({
        id: "bundle-command-1",
        command: "git status --short",
        output: "M apps/app/src/components/thread-timeline/rows.stories.tsx",
        seq: 4,
      }),
      commandRow({
        id: "bundle-command-2",
        command: "git diff --stat",
        output: "2 files changed, 320 insertions(+)",
        seq: 5,
      }),
    ],
  },
  {
    id: "completed-bundle-expanded",
    title: "Completed bundle expanded",
    autoExpand: true,
    rows: [
      commandRow({
        id: "bundle-expanded-command-1",
        command: "git status --short",
        output: "M apps/app/src/components/thread-timeline/rows.stories.tsx",
        seq: 6,
      }),
      commandRow({
        id: "bundle-expanded-command-2",
        command: "git diff --stat",
        output: "2 files changed, 320 insertions(+)",
        seq: 7,
      }),
    ],
  },
  {
    id: "lazy-turn-loading-expanded",
    title: "Lazy turn loading expanded",
    autoExpand: true,
    loadingTurnSummaryIds: LOADING_TURN_IDS,
    rows: [
      turnRow({
        id: "turn-loading-details",
        seq: 8,
        summaryCount: 4,
        durationMs: 42_000,
      }),
    ],
  },
];

const activeLeafCases: TimelineStoryCase[] = [
  {
    id: "running-command-leaf",
    title: "Running command leaf",
    threadRuntimeDisplayStatus: "active",
    rows: [
      commandRow({
        id: "active-command-leaf",
        command: "pnpm --filter @bb/app ladle:build",
        output: "building client...\nrendering chunks...",
        seq: 10,
        sourceSeqEnd: 12,
        status: "pending",
        exitCode: null,
        durationMs: 19_000,
      }),
    ],
  },
  {
    id: "running-tool-leaf",
    title: "Running tool leaf",
    threadRuntimeDisplayStatus: "active",
    rows: [
      toolRow({
        id: "active-tool-leaf",
        toolName: "Read",
        label:
          "Read apps/app/src/components/thread-timeline/ThreadTimelineRows.tsx",
        toolArgs: {
          file_path:
            "apps/app/src/components/thread-timeline/ThreadTimelineRows.tsx",
          offset: 900,
          limit: 160,
        },
        output: "function TimelineRowView({ compactActivityIntents, row }) {",
        activityIntents: [
          readIntent({
            path: "apps/app/src/components/thread-timeline/ThreadTimelineRows.tsx",
          }),
        ],
        seq: 11,
        status: "pending",
        durationMs: 8_000,
      }),
    ],
  },
  {
    id: "editing-file-leaf",
    title: "Editing file leaf",
    threadRuntimeDisplayStatus: "active",
    rows: [
      fileChangeRow({
        id: "active-file-leaf",
        seq: 12,
        status: "pending",
        change: pendingTitleChange(),
      }),
    ],
  },
  {
    id: "pending-web-search-leaf",
    title: "Pending web search leaf",
    threadRuntimeDisplayStatus: "active",
    rows: [
      webSearchRow({
        id: "active-web-search-leaf",
        seq: 13,
        status: "pending",
        queries: ["Ladle React stories isolated component state"],
      }),
    ],
  },
];

const mutedSummaryCases: TimelineStoryCase[] = [
  {
    id: "muted-exploration-summary",
    title: "Muted exploration summary",
    rows: [
      commandRow({
        id: "summary-exploration",
        command:
          "cat apps/app/src/components/thread-timeline/ThreadTimelineRows.tsx && rg TimelineTitle packages/thread-view/src",
        activityIntents: [
          readIntent({
            path: "apps/app/src/components/thread-timeline/ThreadTimelineRows.tsx",
          }),
          searchIntent({
            query: "TimelineTitle",
            path: "packages/thread-view/src",
          }),
        ],
        output: "large renderer output omitted",
        seq: 20,
      }),
    ],
  },
  {
    id: "muted-file-change-summary",
    title: "Muted file-change summary",
    rows: [
      fileChangeRow({
        id: "summary-file-1",
        seq: 21,
        change: rendererUpdateChange(),
      }),
      fileChangeRow({
        id: "summary-file-2",
        seq: 22,
        change: createdPlanChange(),
      }),
    ],
  },
  {
    id: "muted-web-research-summary",
    title: "Muted web research summary",
    rows: [
      webSearchRow({
        id: "summary-web-search",
        seq: 23,
        queries: ["React activity timeline disclosure rows"],
      }),
      webFetchRow({
        id: "summary-web-fetch",
        seq: 24,
        url: "https://ladle.dev/docs/setup",
      }),
    ],
  },
  {
    id: "muted-delegation-summary",
    title: "Muted delegation summary",
    rows: [
      delegationRow({
        id: "summary-delegation",
        seq: 25,
        description: "Audit renderer edge cases",
        output:
          "No blocking findings. The fixture should cover nested bundles.",
        childRows: delegationChildRows(),
      }),
    ],
  },
];

const commandRowCases: TimelineStoryCase[] = [
  {
    id: "completed-command-ansi-output",
    title: "Completed command with ANSI output",
    autoExpand: true,
    rows: [
      commandRow({
        id: "command-ansi",
        command: "printf '\\u001b[32mtypecheck passed\\u001b[0m'",
        output: "\u001b[32mtypecheck passed\u001b[0m",
        seq: 50,
      }),
    ],
  },
  {
    id: "errored-command",
    title: "Errored command",
    autoExpand: true,
    rows: [
      commandRow({
        id: "command-error",
        command: "pnpm exec turbo run typecheck --filter=@bb/app",
        output:
          "src/views/ThreadTimelinePane.tsx(101,15): error TS2322: Type mismatch",
        seq: 51,
        status: "error",
        exitCode: 1,
        durationMs: 16_000,
      }),
    ],
  },
  {
    id: "interrupted-command",
    title: "Interrupted command",
    autoExpand: true,
    rows: [
      commandRow({
        id: "command-interrupted",
        command: "pnpm exec turbo run test --filter=@bb/integration-tests",
        output: "received stop request while tests were still running",
        seq: 52,
        status: "interrupted",
        exitCode: null,
        durationMs: 31_000,
      }),
    ],
  },
  {
    id: "command-waiting-for-approval",
    title: "Command waiting for approval",
    rows: [
      commandRow({
        id: "command-approval-waiting",
        command:
          "git push origin bb/timeline-ui-behavior-consistency-follow-ups-thr_c2wjru47fm",
        approvalStatus: "waiting_for_approval",
        status: "pending",
        output: "",
        exitCode: null,
        seq: 53,
      }),
    ],
  },
  {
    id: "command-permission-denied",
    title: "Command permission denied",
    autoExpand: true,
    rows: [
      commandRow({
        id: "command-approval-denied",
        command: "rm -rf dist",
        approvalStatus: "denied",
        output: "",
        seq: 54,
      }),
    ],
  },
  {
    id: "permission-grant-lifecycle-row",
    title: "Permission grant lifecycle row",
    rows: [
      approvalRow({
        id: "permission-grant-row",
        interactionId: "pi_perm_123",
        itemId: "call_write_fixture",
        toolName: "Bash",
        title: permissionGrantStoryTitles.pending,
        seq: 55,
      }),
    ],
  },
  {
    id: "permission-grant-completed-row",
    title: "Permission grant completed row",
    rows: [
      approvalRow({
        id: "permission-grant-completed-row",
        interactionId: "pi_perm_accepted",
        itemId: "call_write_fixture_accepted",
        toolName: "Bash",
        title: permissionGrantStoryTitles.completed,
        status: "completed",
        seq: 56,
      }),
    ],
  },
  {
    id: "permission-grant-error-row",
    title: "Permission grant error row",
    rows: [
      approvalRow({
        id: "permission-grant-error-row",
        interactionId: "pi_perm_error",
        itemId: "call_write_fixture_error",
        toolName: "Bash",
        title: permissionGrantStoryTitles.error,
        status: "error",
        seq: 57,
      }),
    ],
  },
  {
    id: "permission-grant-interrupted-row",
    title: "Permission grant interrupted row",
    rows: [
      approvalRow({
        id: "permission-grant-interrupted-row",
        interactionId: "pi_perm_interrupted",
        itemId: "call_write_fixture_interrupted",
        toolName: "Bash",
        title: permissionGrantStoryTitles.interrupted,
        status: "interrupted",
        seq: 58,
      }),
    ],
  },
];

const fileChangeCases: TimelineStoryCase[] = [
  {
    id: "unified-diff-update",
    title: "Unified diff update",
    autoExpand: true,
    rows: [
      fileChangeRow({
        id: "file-update",
        seq: 60,
        change: rendererUpdateChange(),
      }),
    ],
  },
  {
    id: "created-file-from-raw-content",
    title: "Created file from raw content",
    autoExpand: true,
    rows: [
      fileChangeRow({
        id: "file-create",
        seq: 61,
        change: createdPlanChange(),
      }),
    ],
  },
  {
    id: "deleted-file",
    title: "Deleted file",
    autoExpand: true,
    rows: [
      fileChangeRow({
        id: "file-delete",
        seq: 62,
        change: deletedLegacyStoryChange(),
      }),
    ],
  },
  {
    id: "renamed-file",
    title: "Renamed file",
    autoExpand: true,
    rows: [
      fileChangeRow({
        id: "file-rename",
        seq: 63,
        change: renamedStoryChange(),
      }),
    ],
  },
  {
    id: "file-edit-failed-with-stderr",
    title: "File edit failed with stderr",
    autoExpand: true,
    rows: [
      fileChangeRow({
        id: "file-error",
        seq: 64,
        status: "error",
        stderr:
          "patch failed: packages/thread-view/src/timeline-row-title.ts:268",
        change: pendingTitleChange(),
      }),
    ],
  },
  {
    id: "file-edit-waiting-for-approval",
    title: "File edit waiting for approval",
    rows: [
      fileChangeRow({
        id: "file-waiting",
        seq: 65,
        status: "pending",
        approvalStatus: "waiting_for_approval",
        change: rendererUpdateChange(),
      }),
    ],
  },
];

const toolAndWebCases: TimelineStoryCase[] = [
  {
    id: "read-search-list-activity-intents",
    title: "Read/search/list activity intents",
    autoExpand: true,
    rows: [
      commandRow({
        id: "exploration-intents",
        command:
          "cat apps/app/src/components/thread-timeline/ThreadTimelineRows.tsx && rg buildTimelineRowTitle packages/thread-view/src && ls apps/app/src/components",
        activityIntents: [
          readIntent({
            path: "apps/app/src/components/thread-timeline/ThreadTimelineRows.tsx",
          }),
          searchIntent({
            query: "buildTimelineRowTitle",
            path: "packages/thread-view/src",
          }),
          listFilesIntent({
            path: "apps/app/src/components/thread-timeline",
          }),
        ],
        output: "large exploration output omitted from compact detail rows",
        seq: 70,
      }),
    ],
  },
  {
    id: "generic-tool-detail",
    title: "Generic tool detail",
    autoExpand: true,
    rows: [
      toolRow({
        id: "generic-tool",
        toolName: "LookupTool",
        label: "LookupTool select:TodoWrite",
        toolArgs: {
          query: "select:TodoWrite",
        },
        output: "Matched tools: TodoWrite, Read, Grep",
        seq: 71,
      }),
    ],
  },
  {
    id: "tool-with-unknown-parsed-intent",
    title: "Tool with unknown parsed intent",
    autoExpand: true,
    rows: [
      toolRow({
        id: "unknown-tool-intent",
        toolName: "Shell",
        label: "Shell git rev-parse --show-toplevel",
        toolArgs: {
          command: "git rev-parse --show-toplevel",
        },
        activityIntents: [
          unknownIntent({ command: "git rev-parse --show-toplevel" }),
        ],
        output: "/workspace/bb",
        seq: 72,
      }),
    ],
  },
  {
    id: "errored-tool-detail",
    title: "Errored tool detail",
    autoExpand: true,
    rows: [
      toolRow({
        id: "errored-tool",
        toolName: "Read",
        label: "Read apps/app/src/components/thread-timeline/Missing.tsx",
        toolArgs: {
          file_path: "apps/app/src/components/thread-timeline/Missing.tsx",
        },
        activityIntents: [
          readIntent({
            path: "apps/app/src/components/thread-timeline/Missing.tsx",
          }),
        ],
        output: "ENOENT: no such file or directory",
        status: "error",
        seq: 73,
      }),
    ],
  },
  {
    id: "interrupted-tool-detail",
    title: "Interrupted tool detail",
    autoExpand: true,
    rows: [
      toolRow({
        id: "interrupted-tool",
        toolName: "Shell",
        label: "Shell pnpm exec turbo run test --filter=@bb/app",
        toolArgs: {
          command: "pnpm exec turbo run test --filter=@bb/app",
        },
        output: "tool call interrupted before the command completed",
        status: "interrupted",
        seq: 74,
      }),
    ],
  },
  {
    id: "completed-web-search-and-fetch",
    title: "Completed web search and fetch",
    rows: [
      webSearchRow({
        id: "web-search-completed",
        seq: 75,
        queries: ["Ladle React isolated stories"],
      }),
      webFetchRow({
        id: "web-fetch-completed",
        seq: 76,
        url: "https://ladle.dev/docs/stories",
        prompt: "Find story export conventions",
      }),
    ],
  },
  {
    id: "pending-web-fetch",
    title: "Pending web fetch",
    threadRuntimeDisplayStatus: "active",
    rows: [
      webFetchRow({
        id: "web-fetch-pending",
        seq: 77,
        status: "pending",
        url: "https://github.com/tajo/ladle",
        pattern: "stories",
      }),
    ],
  },
  {
    id: "errored-web-search",
    title: "Errored web search",
    rows: [
      webSearchRow({
        id: "web-search-error",
        seq: 78,
        status: "error",
        queries: ["Ladle story build failing import"],
      }),
    ],
  },
  {
    id: "interrupted-web-search",
    title: "Interrupted web search",
    rows: [
      webSearchRow({
        id: "web-search-interrupted",
        seq: 79,
        status: "interrupted",
        queries: ["timeline renderer pending state"],
      }),
    ],
  },
  {
    id: "errored-web-fetch",
    title: "Errored web fetch",
    rows: [
      webFetchRow({
        id: "web-fetch-error",
        seq: 80,
        status: "error",
        url: "https://example.invalid/timeline-docs",
        prompt: "Read timeline docs",
      }),
    ],
  },
  {
    id: "interrupted-web-fetch",
    title: "Interrupted web fetch",
    rows: [
      webFetchRow({
        id: "web-fetch-interrupted",
        seq: 81,
        status: "interrupted",
        url: "https://github.com/tajo/ladle",
        pattern: "stories",
      }),
    ],
  },
];

const systemAndManagerCases: TimelineStoryCase[] = [
  {
    id: "manager-assignment-operation",
    title: "Manager assignment operation",
    autoExpand: true,
    rows: [
      systemRow({
        id: "manager-assignment-system",
        seq: 80,
        title: "Thread assigned to manager",
        detail:
          "Assigned to Core Product Manager\nBranch: bb/timeline-ui-behavior-consistency-follow-ups-thr_c2wjru47fm",
      }),
    ],
  },
  {
    id: "provisioning-operation-pending",
    title: "Provisioning operation pending",
    autoExpand: true,
    threadRuntimeDisplayStatus: "active",
    rows: [
      systemRow({
        id: "provisioning-pending-system",
        seq: 81,
        title: "Provisioning thread",
        status: "pending",
        detail:
          "Creating worktree\nPreparing worktree (new branch 'bb/timeline-isolated-ladle-row-stories')\nRunning .bb-env-setup.sh",
      }),
    ],
  },
  {
    id: "host-reconnect-status",
    title: "Host reconnect status",
    threadRuntimeDisplayStatus: "host-reconnecting",
    rows: [
      systemRow({
        id: "host-reconnect-system",
        seq: 82,
        title: "Host daemon reconnecting",
        systemKind: "reconnect",
        status: "pending",
        detail: null,
      }),
    ],
  },
  {
    id: "ownership-change-failed",
    title: "Ownership change failed",
    autoExpand: true,
    rows: [
      systemRow({
        id: "manager-release-error",
        seq: 83,
        title: "Ownership change failed",
        systemKind: "error",
        status: "error",
        detail:
          "Release command failed\nThe selected manager thread is archived.",
      }),
    ],
  },
  {
    id: "debug-system-row",
    title: "Debug system row",
    autoExpand: true,
    rows: [
      systemRow({
        id: "debug-system-row",
        seq: 84,
        title: "Raw provider event",
        systemKind: "debug",
        detail:
          '{"type":"debug/raw-event","provider":"codex","itemId":"item_123"}',
      }),
    ],
  },
  {
    id: "manager-message-user-output",
    title: "Manager message_user output",
    rows: [
      conversationRow({
        id: "manager-user-message",
        role: "assistant",
        seq: 84,
        text: "Batch 1 is implemented in the main worktree in two commits:\n\n- b2d36a2b fixes synthetic diff handling.\n- 903ef33a clears failed lazy-turn ids so details can retry.",
      }),
    ],
  },
];

const conversationCases: TimelineStoryCase[] = [
  {
    id: "user-message-with-attachments",
    title: "User message with attachments",
    projectId: "project-1",
    rows: [
      conversationRow({
        id: "user-attachments",
        role: "user",
        seq: 86,
        text: "Use these files while checking the timeline renderer.",
        attachments: {
          webImages: 0,
          localImages: 0,
          localFiles: 2,
          imageUrls: [],
          localImagePaths: [],
          localFilePaths: [
            "/workspace/bb/apps/app/src/components/thread-timeline/ThreadTimelineRows.tsx",
            "/workspace/bb/apps/app/src/components/thread-timeline/rows.stories.tsx",
          ],
        },
      }),
    ],
  },
];

const userMessageStateCases: TimelineStoryCase[] = [
  {
    id: "regular-user-message",
    title: "Regular user message",
    rows: [
      conversationRow({
        id: "user-message-regular",
        role: "user",
        seq: 86,
        text: "Please tighten the isolated timeline row stories before changing renderer behavior.",
      }),
    ],
  },
  {
    id: "accepted-steer-message",
    title: "Accepted steer message",
    rows: [
      conversationRow({
        id: "user-message-accepted-steer",
        role: "user",
        seq: 87,
        text: "Use the existing renderer primitives and keep this story-only.",
        userRequest: {
          kind: "steer",
          status: "accepted",
        },
      }),
    ],
  },
  {
    id: "pending-steer-requested",
    title: "Pending steer requested",
    rows: [
      conversationRow({
        id: "user-message-pending-steer",
        role: "user",
        seq: 88,
        text: "While that runs, also include the pending steer state.",
        userRequest: {
          kind: "steer",
          status: "pending",
        },
      }),
    ],
  },
  {
    id: "long-multiline-user-message",
    title: "Long multiline user message",
    rows: [
      conversationRow({
        id: "user-message-long-multiline",
        role: "user",
        seq: 89,
        text: [
          "Please audit the timeline row behavior in isolation.",
          "",
          "Focus on user-authored messages first:",
          "- regular messages should stay content-first",
          "- steers should keep their metadata separate from the message text",
          "- long messages should preserve line breaks without adding a role title",
          "",
          "After that, validate the story bundle and report any current renderer gaps.",
        ].join("\n"),
      }),
    ],
  },
  {
    id: "user-message-with-file-attachments",
    title: "User message with file attachments",
    projectId: "project-1",
    rows: [
      conversationRow({
        id: "user-message-file-attachments",
        role: "user",
        seq: 90,
        text: "Use these files while checking the timeline renderer.",
        attachments: {
          webImages: 0,
          localImages: 0,
          localFiles: 2,
          imageUrls: [],
          localImagePaths: [],
          localFilePaths: [
            "/workspace/bb/apps/app/src/components/thread-timeline/ConversationMessageContent.tsx",
            "/workspace/bb/apps/app/src/components/thread-timeline/isolated-rows.stories.tsx",
          ],
        },
      }),
    ],
  },
  {
    id: "copy-affordance-visible",
    title: "Copy affordance visible",
    className: COPY_AFFORDANCE_VISIBLE_CLASS_NAME,
    rows: [
      conversationRow({
        id: "user-message-copy-visible",
        role: "user",
        seq: 91,
        text: "Show the copy affordance without requiring hover during visual audit.",
      }),
    ],
  },
  {
    id: "steer-label-with-copy-toolbar",
    title: "Steer label with copy toolbar",
    className: COPY_AFFORDANCE_VISIBLE_CLASS_NAME,
    rows: [
      conversationRow({
        id: "user-message-steer-toolbar",
        role: "user",
        seq: 92,
        text: "Keep the renderer changes scoped to the isolated user message stories.",
        userRequest: {
          kind: "steer",
          status: "accepted",
        },
      }),
    ],
  },
  {
    id: "pending-steer-active-motion-context",
    title: "Pending steer active motion context",
    threadRuntimeDisplayStatus: "active",
    rows: [
      commandRow({
        id: "user-message-pending-context-command",
        command: "pnpm exec turbo run test --filter=@bb/app",
        output: "running focused timeline row tests",
        seq: 93,
        status: "pending",
        exitCode: null,
      }),
      conversationRow({
        id: "user-message-pending-motion",
        role: "user",
        seq: 94,
        text: "Keep this steer visible while the active work continues.",
        userRequest: {
          kind: "steer",
          status: "pending",
        },
      }),
    ],
  },
];

const steerCases: TimelineStoryCase[] = [
  {
    id: "accepted-steer-row",
    title: "Accepted steer row",
    rows: [
      conversationRow({
        id: "accepted-steer",
        role: "user",
        seq: 90,
        text: "Use the existing renderer primitives and keep this story-only.",
        userRequest: {
          kind: "steer",
          status: "accepted",
        },
      }),
    ],
  },
  {
    id: "pending-steer-row",
    title: "Pending steer row",
    rows: [
      conversationRow({
        id: "pending-steer",
        role: "user",
        seq: 91,
        text: "While that runs, also include the pending steer badge.",
        userRequest: {
          kind: "steer",
          status: "pending",
        },
      }),
    ],
  },
  {
    id: "pending-steer-after-active-bundle",
    title: "Pending steer after active bundle",
    threadRuntimeDisplayStatus: "active",
    rows: [
      commandRow({
        id: "steer-active-command-1",
        command: "pnpm exec turbo run test --filter=@bb/app",
        output: "first chunk",
        seq: 92,
        status: "pending",
        exitCode: null,
      }),
      commandRow({
        id: "steer-active-command-2",
        command: "pnpm --filter @bb/app ladle:build",
        output: "building story bundle",
        seq: 93,
        status: "pending",
        exitCode: null,
      }),
      conversationRow({
        id: "steer-active-pending",
        role: "user",
        seq: 94,
        text: "Keep the active bundle expanded while this steer is pending.",
        userRequest: {
          kind: "steer",
          status: "pending",
        },
      }),
    ],
  },
];

const nestedAndBundledCases: TimelineStoryCase[] = [
  {
    id: "lazy-turn-loaded-nested-details",
    title: "Lazy turn with loaded nested details",
    autoExpand: true,
    turnSummaryRowsById: {
      "turn-loaded-details": nestedTurnRows(),
    },
    rows: [
      turnRow({
        id: "turn-loaded-details",
        seq: 100,
        sourceSeqEnd: 110,
        turnId: "turn-nested",
        summaryCount: 4,
        durationMs: 58_000,
      }),
    ],
  },
  {
    id: "inline-turn-children",
    title: "Inline turn children",
    autoExpand: true,
    rows: [
      turnRow({
        id: "turn-inline-children",
        seq: 101,
        sourceSeqEnd: 104,
        turnId: "turn-inline",
        summaryCount: 3,
        durationMs: 22_000,
        children: [
          commandRow({
            id: "turn-inline-command-1",
            command: "git status --short",
            output:
              "M apps/app/src/components/thread-timeline/isolated-rows.stories.tsx",
            seq: 102,
            turnId: "turn-inline",
          }),
          fileChangeRow({
            id: "turn-inline-file-1",
            seq: 103,
            turnId: "turn-inline",
            change: createdPlanChange(),
          }),
          webSearchRow({
            id: "turn-inline-web-1",
            seq: 104,
            turnId: "turn-inline",
            queries: ["manual visual audit timeline rows"],
          }),
        ],
      }),
    ],
  },
  {
    id: "delegation-with-nested-child-timeline",
    title: "Delegation with nested child timeline",
    autoExpand: true,
    threadRuntimeDisplayStatus: "active",
    rows: [
      delegationRow({
        id: "nested-delegation",
        seq: 105,
        status: "pending",
        subagentType: "explorer",
        description: "Inspect timeline row grouping",
        output: "",
        childRows: delegationChildRows(),
      }),
    ],
  },
  {
    id: "failed-delegation-with-output",
    title: "Failed delegation with output",
    autoExpand: true,
    rows: [
      delegationRow({
        id: "failed-delegation",
        seq: 106,
        status: "error",
        subagentType: "worker",
        description: "Implement isolated row story fixtures",
        output:
          "The worker hit a type error while wiring the shared fixture module.",
        childRows: [
          commandRow({
            id: "failed-delegation-typecheck",
            command: "pnpm exec turbo run typecheck --filter=@bb/app",
            output:
              "apps/app/src/components/thread-timeline/isolated-rows.stories.tsx(1,1): error TS2307",
            seq: 107,
            status: "error",
            exitCode: 1,
            turnId: "turn-failed-delegation",
          }),
        ],
      }),
    ],
  },
  {
    id: "interrupted-delegation-with-partial-output",
    title: "Interrupted delegation with partial output",
    autoExpand: true,
    rows: [
      delegationRow({
        id: "interrupted-delegation",
        seq: 108,
        status: "interrupted",
        subagentType: "explorer",
        description: "Audit timeline fixtures for missing edge cases",
        output:
          "Partial findings: web fetch and delegation interrupted states still need isolated stories.",
        childRows: [
          commandRow({
            id: "interrupted-delegation-search",
            command: 'rg -n "web-fetch|delegation" apps/app/src/components',
            output:
              "apps/app/src/components/thread-timeline/isolated-rows.stories.tsx:640",
            seq: 109,
            status: "interrupted",
            exitCode: null,
            turnId: "turn-interrupted-delegation",
          }),
        ],
      }),
    ],
  },
  {
    id: "mixed-activity-bundle",
    title: "Mixed activity bundle",
    autoExpand: true,
    rows: [
      commandRow({
        id: "mixed-bundle-command",
        command: 'rg -n "TimelineRowsStory" apps/app/src/components',
        activityIntents: [
          searchIntent({
            query: "TimelineRowsStory",
            path: "apps/app/src/components",
          }),
        ],
        output: "apps/app/src/components/thread-timeline/rows.stories.tsx:54",
        seq: 110,
      }),
      fileChangeRow({
        id: "mixed-bundle-file",
        seq: 111,
        change: rendererUpdateChange(),
      }),
      webSearchRow({
        id: "mixed-bundle-web",
        seq: 112,
        queries: ["Ladle story card layout"],
      }),
    ],
  },
];

export function ExpansionStates() {
  return <TimelineCaseGrid cases={expansionStateCases} />;
}

export function ActiveLeafRows() {
  return <TimelineCaseGrid cases={activeLeafCases} />;
}

export function MutedSummaryRows() {
  return <TimelineCaseGrid cases={mutedSummaryCases} />;
}

export function CommandRows() {
  return <TimelineCaseGrid cases={commandRowCases} />;
}

export function FileEditAndDiffRows() {
  return <TimelineCaseGrid cases={fileChangeCases} />;
}

export function ToolAndWebRows() {
  return <TimelineCaseGrid cases={toolAndWebCases} />;
}

export function ManagerAndSystemRows() {
  return <TimelineCaseGrid cases={systemAndManagerCases} />;
}

export function ConversationRows() {
  return <TimelineCaseGrid cases={conversationCases} />;
}

export function UserMessageStates() {
  return (
    <>
      <style>{COPY_AFFORDANCE_VISIBLE_STYLE}</style>
      <TimelineCaseGrid cases={userMessageStateCases} />
    </>
  );
}

export function SteerRows() {
  return <TimelineCaseGrid cases={steerCases} />;
}

export function NestedAndBundledRows() {
  return <TimelineCaseGrid cases={nestedAndBundledCases} />;
}
