import {
  commandRow,
  conversationRow,
  delegationRow,
  fileChangeRow,
  readIntent,
  searchIntent,
  systemRow,
  turnRow,
  webFetchRow,
  webSearchRow,
} from "@/test/fixtures/thread-timeline-rows";
import {
  TimelineRowsStory,
  TimelineStoryShell,
} from "./timeline-story-fixtures.js";

export default {
  title: "Thread Timeline/Rows",
};

function lazyTurnRow() {
  return turnRow({
    id: "turn-summary-1",
    seq: 9,
    status: "completed",
    summaryCount: 4,
    durationMs: 18_000,
  });
}

function nestedDelegationRow() {
  return delegationRow({
    id: "delegation-1",
    seq: 2,
    status: "pending",
    subagentType: "general-purpose",
    description: "Review renderer edge cases",
    childRows: [
      conversationRow({
        id: "delegation-child-message-1",
        role: "assistant",
        seq: 3,
        text: "Checking expansion and scroll behavior.",
      }),
      commandRow({
        id: "delegation-child-command-1",
        command: "pnpm exec turbo run test --filter=@bb/app",
        output: "RUN  v4.1.1\n10 tests passed\nwatching for more output...",
        seq: 4,
        status: "pending",
        durationMs: 11_000,
        exitCode: null,
      }),
    ],
  });
}

export function MixedRows() {
  return (
    <TimelineStoryShell>
      <TimelineRowsStory
        rows={[
          conversationRow({
            id: "user-1",
            role: "user",
            seq: 1,
            text: "Please tighten the timeline renderer.",
          }),
          conversationRow({
            id: "assistant-1",
            role: "assistant",
            seq: 2,
            text: "I will audit the current timeline path first.",
          }),
          commandRow({
            id: "explore-1",
            command: "cat src/app.ts && rg Timeline src",
            activityIntents: [
              readIntent({ path: "src/app.ts" }),
              searchIntent({ query: "Timeline", path: "src" }),
            ],
            seq: 3,
            output: "large file contents omitted from compact exploration rows",
          }),
          commandRow({
            id: "command-1",
            command: "pnpm exec turbo run test --filter=@bb/app",
            output: "Tests passed",
            seq: 4,
          }),
          fileChangeRow({
            id: "file-change-1",
            seq: 5,
            change: {
              path: "apps/app/src/components/thread-timeline/ThreadTimelineRows.tsx",
              kind: "update",
              movePath: null,
              diff: "@@ -1 +1 @@\n-old\n+new",
              diffStats: {
                added: 12,
                removed: 3,
              },
            },
          }),
          webSearchRow({
            id: "web-search-1",
            seq: 6,
            queries: ["React timeline renderer"],
          }),
          webFetchRow({
            id: "web-fetch-1",
            seq: 7,
            url: "https://example.com/thread-view",
          }),
          systemRow({
            id: "system-1",
            seq: 8,
            title: "Provisioned workspace",
            detail: "Created branch codex/react-timeline-renderer",
          }),
          lazyTurnRow(),
        ]}
        turnSummaryRowsById={{
          "turn-summary-1": [
            commandRow({
              id: "lazy-command-1",
              command: "git status --short",
              output:
                "M apps/app/src/components/thread-timeline/ThreadTimelineRows.tsx",
              seq: 10,
            }),
          ],
        }}
      />
    </TimelineStoryShell>
  );
}

export function ActiveStreamingRows() {
  return (
    <TimelineStoryShell>
      <TimelineRowsStory
        threadRuntimeDisplayStatus="active"
        rows={[
          conversationRow({
            id: "user-active-1",
            role: "user",
            seq: 1,
            text: "Keep the active step visible while it streams.",
          }),
          commandRow({
            id: "active-read-1",
            command:
              "cat apps/app/src/components/thread-timeline/ThreadTimelineRows.tsx",
            activityIntents: [
              readIntent({
                path: "apps/app/src/components/thread-timeline/ThreadTimelineRows.tsx",
              }),
            ],
            output: "streaming file contents",
            seq: 2,
            status: "pending",
            durationMs: 8_000,
            exitCode: null,
          }),
          commandRow({
            id: "active-search-1",
            command: "rg ThreadTimelineRows apps/app/src",
            activityIntents: [
              searchIntent({
                query: "ThreadTimelineRows",
                path: "apps/app/src",
              }),
            ],
            output: "streaming search output",
            seq: 3,
            status: "pending",
            durationMs: 6_000,
            exitCode: null,
          }),
        ]}
      />
    </TimelineStoryShell>
  );
}

export function NestedDelegationRows() {
  return (
    <TimelineStoryShell>
      <TimelineRowsStory
        threadRuntimeDisplayStatus="active"
        rows={[
          conversationRow({
            id: "user-delegation-1",
            role: "user",
            seq: 1,
            text: "Use a subagent to review the renderer.",
          }),
          nestedDelegationRow(),
        ]}
      />
    </TimelineStoryShell>
  );
}

export function FileDiffAndTerminalRows() {
  return (
    <TimelineStoryShell>
      <TimelineRowsStory
        threadRuntimeDisplayStatus="active"
        rows={[
          commandRow({
            id: "terminal-1",
            command: "pnpm exec turbo run typecheck --filter=@bb/app",
            output:
              "\u001b[32mtypecheck passed\u001b[0m\nwaiting for next chunk...",
            seq: 1,
            status: "pending",
            durationMs: 12_000,
            exitCode: null,
          }),
          fileChangeRow({
            id: "diff-1",
            seq: 2,
            status: "pending",
            change: {
              path: "apps/app/src/components/thread-timeline/TimelineTitleView.tsx",
              kind: "update",
              movePath: null,
              diff: "@@ -1 +1 @@\n-before\n+after",
              diffStats: {
                added: 1,
                removed: 1,
              },
            },
          }),
        ]}
      />
    </TimelineStoryShell>
  );
}
