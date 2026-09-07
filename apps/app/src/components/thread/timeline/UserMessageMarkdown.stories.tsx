import type { PromptMentionResource, PromptTextMention } from "@bb/domain";
import type { TimelineConversationTurnRequest } from "@bb/server-contract";
import type { TimelineTitleLink } from "@bb/thread-view";
import type { ReactNode } from "react";
import { ConversationMessageContent } from "@/components/thread/timeline/ConversationMessageContent";
import {
  StoryDraftPromptBox,
  useStoryPromptDraft,
} from "@/components/thread/timeline/StoryDraftPromptBox";
import { StoryCard, StoryRow } from "../../../../.ladle/story-card";

export default {
  title: "thread/timeline/User Message Markdown",
};

function TimelineStage({
  children,
  revealMessageActions = false,
}: {
  children: ReactNode;
  revealMessageActions?: boolean;
}) {
  return (
    <div
      className={`w-full max-w-[760px] ${
        revealMessageActions ? "[&_button]:opacity-100" : ""
      }`}
    >
      {children}
    </div>
  );
}

function resolveThreadLink(link: TimelineTitleLink): string | null {
  return link.kind === "thread"
    ? `/projects/proj_demo/threads/${link.threadId}`
    : null;
}

const resolveMentionLink = () => () => {};

const acceptedMessage: TimelineConversationTurnRequest = {
  isGrouped: false,
  kind: "message",
  status: "accepted",
};

function mentionAt(
  text: string,
  token: string,
  resource: PromptMentionResource,
): PromptTextMention {
  const start = text.indexOf(token);
  return { start, end: start + token.length, resource };
}

function UserMessage({
  text,
  mentions = [],
  onAddToChat,
  revealMessageActions = false,
}: {
  text: string;
  mentions?: readonly PromptTextMention[];
  onAddToChat?: (text: string) => void;
  revealMessageActions?: boolean;
}) {
  return (
    <TimelineStage revealMessageActions={revealMessageActions}>
      <ConversationMessageContent
        role="user"
        initiator="user"
        originKind={null}
        senderThreadId={null}
        senderThreadTitle={null}
        senderIsPluginSideChat={false}
        resolveSegmentLinkHref={resolveThreadLink}
        resolveMentionLink={resolveMentionLink}
        onAddToChat={onAddToChat}
        systemMessageKind="unlabeled"
        systemMessageSubject={null}
        text={text}
        attachments={null}
        mentions={mentions}
        projectId="proj_demo"
        turnRequest={acceptedMessage}
      />
    </TimelineStage>
  );
}

const FORMATTING_BODY = [
  "# Plan for the markdown work",
  "",
  "Render user bubbles as **markdown** with _emphasis_ and `inline code`.",
  "",
  "## Steps",
  "",
  "1. Generalize the mention pipeline",
  "2. Wire the `promptMentions` prop",
  "3. Render the bubble",
  "",
  "- keep the char cap",
  "- keep collapse / expand",
].join("\n");

const MENTIONS_BODY =
  "Ask @thread:thr_child to update @src/promptbox/PromptBoxInternal.tsx, then run /deploy.";
const MENTIONS: readonly PromptTextMention[] = [
  mentionAt(MENTIONS_BODY, "@thread:thr_child", {
    kind: "thread",
    threadId: "thr_child",
    projectId: "proj_demo",
    label: "Prompt markdown",
  }),
  mentionAt(MENTIONS_BODY, "@src/promptbox/PromptBoxInternal.tsx", {
    kind: "path",
    source: "workspace",
    entryKind: "file",
    path: "src/promptbox/PromptBoxInternal.tsx",
    label: "PromptBoxInternal.tsx",
  }),
  mentionAt(MENTIONS_BODY, "/deploy", {
    kind: "command",
    trigger: "/",
    name: "deploy",
    source: "command",
    origin: "user",
    label: "deploy",
    argumentHint: null,
  }),
];

const QUOTE_BODY = [
  "> First we backfill the new column at the server boundary,",
  "> then flip reads once every row is populated.",
  "",
  "Which phase is safe to deploy on a Friday?",
].join("\n");

const LONG_BODY = [
  "# Migration rollout",
  "",
  ...Array.from(
    { length: 20 },
    (_unused, index) =>
      `${index + 1}. Step ${index + 1}: verify the batch, then advance the cursor and re-check invariants.`,
  ),
].join("\n");

export function Overview() {
  const promptDraft = useStoryPromptDraft();
  const handleAddToChat = promptDraft.addQuote;

  return (
    <StoryCard>
      <StoryRow
        label="formatting (hover)"
        hint="production behavior — hover or focus the message to reveal actions"
      >
        <UserMessage text={FORMATTING_BODY} onAddToChat={handleAddToChat} />
      </StoryRow>
      <StoryRow
        label="mentions"
        hint="thread (linked), file (interactive), and slash-command pills inside markdown"
      >
        <UserMessage
          text={MENTIONS_BODY}
          mentions={MENTIONS}
          onAddToChat={handleAddToChat}
          revealMessageActions
        />
      </StoryRow>
      <StoryRow
        label="blockquote"
        hint="`> ` lines render as a native markdown blockquote + reply paragraph"
      >
        <UserMessage
          text={QUOTE_BODY}
          onAddToChat={handleAddToChat}
          revealMessageActions
        />
      </StoryRow>
      <StoryRow
        label="long (collapsible)"
        hint="clamped to ~15 lines with a Show more / Show less toggle"
      >
        <UserMessage
          text={LONG_BODY}
          onAddToChat={handleAddToChat}
          revealMessageActions
        />
      </StoryRow>
      <StoryRow
        label="add to chat result"
        hint="click Add to chat under any markdown user message, then type below the quote"
      >
        <StoryDraftPromptBox draft={promptDraft} />
      </StoryRow>
    </StoryCard>
  );
}
