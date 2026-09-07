import type {
  PromptTextMention,
  SystemMessageKind,
  SystemMessageSubject,
} from "@bb/domain";
import type { TimelineTitleLink } from "@bb/thread-view";
import type { TimelineRow } from "@bb/server-contract";
import type { ReactNode } from "react";
import { ConversationMessageContent } from "@/components/thread/timeline/ConversationMessageContent";
import { ThreadTimelineRows } from "@/components/thread/timeline";
import { conversationRow } from "@/test/fixtures/thread-timeline-rows";
import { StoryCard, StoryRow } from "../../../../.ladle/story-card";

export default {
  title: "thread/timeline/Generated Conversation Message",
};

function TimelineStage({ children }: { children: ReactNode }) {
  return <div className="w-full max-w-[760px]">{children}</div>;
}

function resolveThreadLink(link: TimelineTitleLink): string | null {
  switch (link.kind) {
    case "thread":
      return `/projects/proj_demo/threads/${link.threadId}`;
    default:
      return null;
  }
}

const acceptedMessage = {
  isGrouped: false,
  kind: "message" as const,
  status: "accepted" as const,
};

interface SystemRowFixture {
  label: string;
  hint: string;
  systemMessageKind: SystemMessageKind;
  systemMessageSubject: SystemMessageSubject | null;
  text: string;
  mentions?: readonly PromptTextMention[];
}

const CHILD_COMPLETED_BODY = [
  "# Rebuild threaded comments — final report",
  "",
  "All work **complete and committed**. Handed the follow-up to @thread:thr_child2.",
  "",
  "- Branch: `bb/rebuild-threaded-comments`",
  "- Ladle stories built and verified",
  "- PR ready to open on your go",
].join("\n");

const CHILD_COMPLETED_TOKEN = "@thread:thr_child2";
const CHILD_COMPLETED_TOKEN_START = CHILD_COMPLETED_BODY.indexOf(
  CHILD_COMPLETED_TOKEN,
);
const CHILD_COMPLETED_MENTIONS: readonly PromptTextMention[] = [
  {
    start: CHILD_COMPLETED_TOKEN_START,
    end: CHILD_COMPLETED_TOKEN_START + CHILD_COMPLETED_TOKEN.length,
    resource: {
      kind: "thread",
      threadId: "thr_child2",
      projectId: "proj_demo",
      label: "Rebuild threaded comments from main",
    },
  },
];

const SYSTEM_ROWS: readonly SystemRowFixture[] = [
  {
    label: "ownership-assigned (title-only)",
    hint: "child assigned to this manager — body collapses into the title",
    systemMessageKind: "ownership-assigned",
    systemMessageSubject: {
      kind: "thread",
      threadId: "thr_child1",
      threadName: "Migrate sessions table",
    },
    text: "Migrate sessions table was assigned to you.",
  },
  {
    label: "ownership-removed (title-only)",
    hint: "child unassigned — body collapses into the title",
    systemMessageKind: "ownership-removed",
    systemMessageSubject: {
      kind: "thread",
      threadId: "thr_child1",
      threadName: "Migrate sessions table",
    },
    text: "Migrate sessions table was unassigned from you.",
  },
  {
    label: "child-needs-attention",
    hint: "child blocked on a pending interaction",
    systemMessageKind: "child-needs-attention",
    systemMessageSubject: {
      kind: "thread",
      threadId: "thr_child2",
      threadName: "Rebuild threaded comments from main",
    },
    text: "It is blocked on a pending interaction. Inspect the thread and decide if you can answer or resolve the question from existing context.",
  },
  {
    label: "child-completed (markdown body)",
    hint: "single child outcome — markdown report with a heading, bold, list, code, and an @thread mention pill",
    systemMessageKind: "child-completed",
    systemMessageSubject: {
      kind: "thread",
      threadId: "thr_child2",
      threadName: "Rebuild threaded comments from main",
    },
    text: CHILD_COMPLETED_BODY,
    mentions: CHILD_COMPLETED_MENTIONS,
  },
  {
    label: "child-failed",
    hint: "single child outcome, turnStatus failed",
    systemMessageKind: "child-failed",
    systemMessageSubject: {
      kind: "thread",
      threadId: "thr_child3",
      threadName: "Codex worker",
    },
    text: "Provider error: there's an issue with the selected model (gpt-5.5). It may not exist or you may not have access to it.",
  },
  {
    label: "child-interrupted",
    hint: "single child outcome, turnStatus interrupted",
    systemMessageKind: "child-interrupted",
    systemMessageSubject: {
      kind: "thread",
      threadId: "thr_child3",
      threadName: "Codex worker",
    },
    text: "Stopped manually before the review step.",
  },
  {
    label: "child-outcome-batch",
    hint: "multiple children, mixed statuses — count in the title, detail in the body",
    systemMessageKind: "child-outcome-batch",
    systemMessageSubject: { kind: "thread-batch", count: 3 },
    text: "Worker 1 completed: migration landed.\nWorker 2 was interrupted: stopped before review.\nWorker 3 completed: docs updated.",
  },
];

export function Overview() {
  return (
    <StoryCard>
      {SYSTEM_ROWS.map((row) => (
        <StoryRow key={row.systemMessageKind} label={row.label} hint={row.hint}>
          <TimelineStage>
            <ConversationMessageContent
              role="user"
              initiator="system"
              originKind={null}
              senderThreadId={null}
              senderThreadTitle={null}
              senderIsPluginSideChat={false}
              resolveSegmentLinkHref={resolveThreadLink}
              systemMessageKind={row.systemMessageKind}
              systemMessageSubject={row.systemMessageSubject}
              text={row.text}
              attachments={null}
              mentions={row.mentions ?? []}
              projectId="proj_demo"
              turnRequest={acceptedMessage}
            />
          </TimelineStage>
        </StoryRow>
      ))}
      <StoryRow
        label="agent (reference pattern)"
        hint="agent-to-agent message — 'Message from [thread]', the pattern Family B extends"
      >
        <TimelineStage>
          <ConversationMessageContent
            role="user"
            initiator="agent"
            originKind={null}
            senderThreadId="thr_worker2"
            senderThreadTitle="Worker 2"
            senderIsPluginSideChat={false}
            resolveSegmentLinkHref={resolveThreadLink}
            systemMessageKind="unlabeled"
            systemMessageSubject={null}
            text="Can you take the migration step from here? I've finished the schema changes and pushed to the branch."
            attachments={null}
            mentions={[]}
            projectId="proj_demo"
            turnRequest={acceptedMessage}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="unlabeled (legacy fallback)"
        hint="pre-taxonomy system message — renders the generic 'System Message' title"
      >
        <TimelineStage>
          <ConversationMessageContent
            role="user"
            initiator="system"
            originKind={null}
            senderThreadId={null}
            senderThreadTitle={null}
            senderIsPluginSideChat={false}
            resolveSegmentLinkHref={resolveThreadLink}
            systemMessageKind="unlabeled"
            systemMessageSubject={null}
            text="A system message persisted before the taxonomy existed."
            attachments={null}
            mentions={[]}
            projectId="proj_demo"
            turnRequest={acceptedMessage}
          />
        </TimelineStage>
      </StoryRow>
    </StoryCard>
  );
}

export function ClippedAgentMessage() {
  return (
    <StoryCard>
      <StoryRow
        label="agent message"
        hint="long single-line handoff from another thread; expand to read the full text"
      >
        <div className="w-full max-w-[560px]">
          <ConversationMessageContent
            role="user"
            initiator="agent"
            originKind={null}
            senderThreadId="thr_host_hermes"
            senderThreadTitle="Host Hermes on Flue"
            senderIsPluginSideChat={false}
            resolveSegmentLinkHref={resolveThreadLink}
            systemMessageKind="unlabeled"
            systemMessageSubject={null}
            text="TEST RESULT refines the diagnosis — RULE OUT eviction. A fire-and-forget direct POST with no wait parameter and no client-held stream should still render the complete report after expansion, including the exact follow-up checks the other agent already ran."
            attachments={null}
            mentions={[]}
            projectId="proj_demo"
            turnRequest={acceptedMessage}
          />
        </div>
      </StoryRow>
    </StoryCard>
  );
}

const MARKDOWN_ROWS: readonly {
  label: string;
  hint: string;
  row: TimelineRow;
}[] = [
  {
    label: "child-completed — markdown report",
    hint: "heading, bold, list, inline + fenced code, and an @thread mention pill",
    row: conversationRow({
      id: "md_child_completed",
      role: "user",
      initiator: "system",
      systemMessageKind: "child-completed",
      systemMessageSubject: {
        kind: "thread",
        threadId: "thr_child2",
        threadName: "Rebuild threaded comments from main",
      },
      text: [
        "All work complete and committed. Here is the final report.",
        "",
        "## PR #467 — threaded comments",
        "",
        "**Branch:** `bb/rebuild-threaded-comments`",
        "",
        "- Ladle stories built and verified",
        "- `migrate(db)` passes on a fresh schema",
        "- Linked the source thread @thread:thr_child2",
        "",
        "```ts",
        "export const commentsRebuilt = true;",
        "```",
      ].join("\n"),
    }),
  },
  {
    label: "child-needs-attention — markdown body",
    hint: "bold + ordered list render; the title carries the icon and link",
    row: conversationRow({
      id: "md_needs_attention",
      role: "user",
      initiator: "system",
      systemMessageKind: "child-needs-attention",
      systemMessageSubject: {
        kind: "thread",
        threadId: "thr_child3",
        threadName: "Migrate sessions table",
      },
      text: [
        "It is **blocked on a pending interaction**. Decide one of:",
        "",
        "1. Answer the question from existing context.",
        "2. Ask the user for the missing decision.",
        "3. Send a clarifying instruction if it is on the wrong track.",
      ].join("\n"),
    }),
  },
];

export function MarkdownBody() {
  return (
    <StoryCard>
      {MARKDOWN_ROWS.map(({ label, hint, row }) => (
        <StoryRow key={row.id} label={label} hint={hint}>
          <TimelineStage>
            <ThreadTimelineRows
              projectId="proj_demo"
              threadRuntimeDisplayStatus="idle"
              workspaceRootPath={undefined}
              initialExpanded={new Set([row.id])}
              timelineRows={[row]}
            />
          </TimelineStage>
        </StoryRow>
      ))}
    </StoryCard>
  );
}
