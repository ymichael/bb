import { useCallback, useState, type ReactNode } from "react";
import type { ThreadQueuedMessage } from "@bb/domain";
import { makeThreadQueuedMessage } from "@bb/test-helpers/domain-fixtures";
import {
  applyQueuedMessageReorder,
  type QueuedMessageReorderRequest,
} from "@/lib/queued-message-reorder";
import {
  QueuedMessagesList,
  type QueuedMessageGroupBoundaryRequest,
} from "@/components/promptbox/banner/QueuedMessagesList";
import { StoryCard, StoryRow } from "../../../../.ladle/story-card";

export default {
  title: "promptbox/banner/Queued Messages",
};

const noop = () => {};

type StageSize = "desktop" | "mobile";

interface PromptStageProps {
  children: ReactNode;
  size: StageSize;
}

function PromptStage({ children, size }: PromptStageProps) {
  return (
    <div
      data-promptbox-shell=""
      className={
        size === "desktop" ? "min-w-0 flex-1 pb-5" : "w-[20rem] shrink-0 pb-5"
      }
    >
      {children}
    </div>
  );
}

function ResponsivePromptStage({ children }: { children: ReactNode }) {
  return (
    <div className="flex w-full min-w-0 items-start gap-3 overflow-x-auto">
      <PromptStage size="desktop">{children}</PromptStage>
      <PromptStage size="mobile">{children}</PromptStage>
    </div>
  );
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

const STORY_NOW = Date.now();

type QueuedMessageFixture = Partial<ThreadQueuedMessage> & {
  id: string;
  text?: string;
  attachments?: number;
};

function makeQueuedMessage({
  id,
  text = "Queued follow-up.",
  attachments = 0,
  ...overrides
}: QueuedMessageFixture): ThreadQueuedMessage {
  const attachmentChunks = Array.from({ length: attachments }, (_, index) => ({
    type: "localImage" as const,
    path: `https://placecats.com/${300 + index * 20}/${200 + index * 10}`,
    name: `screenshot-${index + 1}.png`,
    mimeType: "image/png",
    sizeBytes: 100_000 + index * 10_000,
  }));
  return makeThreadQueuedMessage({
    id,
    threadId: "thr_queue",
    content: [{ type: "text", text, mentions: [] }, ...attachmentChunks],
    createdAt: STORY_NOW - 4 * MINUTE_MS,
    updatedAt: STORY_NOW - 4 * MINUTE_MS,
    ...overrides,
  });
}

const threadBusy = { kind: "thread-busy" } as const;

const oneMessage: readonly ThreadQueuedMessage[] = [
  makeQueuedMessage({
    id: "q_1",
    text: "Also check the timeline error overlay before sending.",
    waitingOn: threadBusy,
  }),
];

const multipleMessages: readonly ThreadQueuedMessage[] = [
  makeQueuedMessage({
    id: "q_a",
    text: "Also check the timeline error overlay before sending.",
    waitingOn: threadBusy,
  }),
  makeQueuedMessage({
    id: "q_b",
    text: "Confirm the env summary renders without the branch button on unmanaged environments.",
    waitingOn: threadBusy,
  }),
  makeQueuedMessage({
    id: "q_c",
    text: "And run the tests for @bb/thread-view.",
    waitingOn: threadBusy,
  }),
];

const manyMessages: readonly ThreadQueuedMessage[] = Array.from(
  { length: 9 },
  (_, index) =>
    makeQueuedMessage({
      id: `q_many_${index + 1}`,
      text: `Queued follow-up ${index + 1}: check the compact one-line row, ellipsis truncation, and vertical scroll fade in the queue drawer.`,
      waitingOn: threadBusy,
    }),
);

const withAttachments: readonly ThreadQueuedMessage[] = [
  makeQueuedMessage({
    id: "q_att_1",
    text: "Repro of the layout regression.",
    attachments: 1,
  }),
  makeQueuedMessage({
    id: "q_att_3",
    text: "Three screenshots from the design review.",
    attachments: 3,
  }),
];

const longMessage: readonly ThreadQueuedMessage[] = [
  makeQueuedMessage({
    id: "q_long",
    text: "Walk through the entire follow-up composer file by file: PromptBoxInternal, FollowUpPromptBox, NewThreadPromptBox, ContextBanner, QueuedMessagesList, PromptStackCard. For each, audit prop names, identify dead fields, and propose a trim. Skip files we already cleaned up earlier this session.",
  }),
];

const quoteSingle: readonly ThreadQueuedMessage[] = [
  makeQueuedMessage({
    id: "q_quote_single",
    text: "> The migration runs in three phases.\nWhich phase is safe to deploy on a Friday?",
  }),
];

const quoteMultiline: readonly ThreadQueuedMessage[] = [
  makeQueuedMessage({
    id: "q_quote_multiline",
    text: "> First we backfill the new column with a default value.\n> Then flip reads once every row is populated.\nMakes sense — what about in-flight writes?",
  }),
];

const quoteTwoBlocks: readonly ThreadQueuedMessage[] = [
  makeQueuedMessage({
    id: "q_quote_two",
    text: "> Backfill the new column first.\nmakes sense\n\n> Then drop the legacy column.\nin the same deploy?",
  }),
];

const quoteOnly: readonly ThreadQueuedMessage[] = [
  makeQueuedMessage({
    id: "q_quote_only",
    text: "> Just the quoted selection, no reply typed yet.",
  }),
];

const quoteTruncated: readonly ThreadQueuedMessage[] = [
  makeQueuedMessage({
    id: "q_quote_truncated",
    text: "> phase one — add the column\n> phase two — start dual-writing\n> phase three — backfill old rows\n> phase four — flip reads\n> phase five — stop writing the old column\n> phase six — drop the old column\nwhich of these is reversible?",
  }),
];

const quoteWithAttachment: readonly ThreadQueuedMessage[] = [
  makeQueuedMessage({
    id: "q_quote_att",
    text: "> The error fires on the second render.\nrepro attached",
    attachments: 1,
  }),
];

const mixedMessages: readonly ThreadQueuedMessage[] = [
  makeQueuedMessage({
    id: "mix_plain_1",
    text: "Also check the timeline error overlay before sending.",
  }),
  makeQueuedMessage({
    id: "mix_quote_1",
    text: "> First we backfill the new column.\n> Then flip reads once every row is populated.\nWhich phase is safe to deploy on a Friday?",
  }),
  makeQueuedMessage({
    id: "mix_plain_2",
    text: "And run the tests for @bb/thread-view.",
  }),
  makeQueuedMessage({
    id: "mix_quote_2",
    text: "> Only after that do we drop the legacy column.\nin the same deploy?",
  }),
];

const oneGroupedStoryMessage: readonly ThreadQueuedMessage[] = [
  makeQueuedMessage({
    id: "g_one",
    text: "Refactor the queued-message reorder helper",
  }),
];

const groupedMessages: readonly ThreadQueuedMessage[] = multipleMessages.map(
  (message, index) => ({
    ...message,
    groupWithNext: index === 0,
  }),
);

const waitingForWorkspace: readonly ThreadQueuedMessage[] = [
  makeQueuedMessage({
    id: "q_provisioning",
    text: "Re-run the setup checks after the workspace is ready.",
    waitingOn: { kind: "provisioning" },
  }),
];

const waitingForReply: readonly ThreadQueuedMessage[] = [
  makeQueuedMessage({
    id: "q_interaction",
    text: "Use the selected release region in the deployment plan.",
    waitingOn: { kind: "interaction" },
  }),
];

const waitingForHost: readonly ThreadQueuedMessage[] = [
  makeQueuedMessage({
    id: "q_host_offline",
    text: "Capture the Safari trace on M4.",
    waitingOn: { kind: "host-offline", hostName: "M4" },
  }),
];

const scheduled: readonly ThreadQueuedMessage[] = [
  makeQueuedMessage({
    id: "q_scheduled",
    text: "Run the release checks and post the summary.",
    waitingOn: { kind: "time" },
    sendAt: STORY_NOW + 3 * HOUR_MS + 12 * MINUTE_MS,
  }),
];

const scheduledSoon: readonly ThreadQueuedMessage[] = [
  makeQueuedMessage({
    id: "q_scheduled_soon",
    text: "Kick off the nightly benchmark sweep.",
    waitingOn: { kind: "time" },
    sendAt: STORY_NOW + 45 * 1000,
  }),
];

const pluginWait: readonly ThreadQueuedMessage[] = [
  makeQueuedMessage({
    id: "q_plugin_held",
    text: "Run the browser matrix against the candidate build.",
    waitingOn: {
      kind: "plugin",
      pluginId: "concurrency-limit",
      reason: "4 of 4 running",
    },
  }),
];

const pluginWaitStale: readonly ThreadQueuedMessage[] = [
  makeQueuedMessage({
    id: "q_plugin_stale",
    text: "Build the simulator bundle and capture the drawer trace.",
    waitingOn: {
      kind: "plugin",
      pluginId: "mobile-lab",
      reason: "no update for 12m",
    },
  }),
];

const retry: readonly ThreadQueuedMessage[] = [
  makeQueuedMessage({
    id: "q_retry",
    content: [
      {
        type: "text",
        text: "Deploy the release candidate to staging.",
        mentions: [],
        visibility: "agent-only",
      },
    ],
    payload: {
      kind: "retry",
      retryOfTurnRequestId: "creq_2m4kq7bxvn",
      attempt: 2,
      reason: "Rate limited",
    },
    waitingOn: {
      kind: "plugin",
      pluginId: "provider-retry",
      reason: "Rate limited",
    },
    sendAt: STORY_NOW + 18 * MINUTE_MS,
    editable: false,
    createdAt: STORY_NOW - 22 * MINUTE_MS,
  }),
];

const inFlightMessage = makeQueuedMessage({
  id: "q_in_flight",
  text: "Also audit the empty queue handoff before wrapping up.",
  waitingOn: threadBusy,
});
const inFlight: readonly ThreadQueuedMessage[] = [inFlightMessage];

const failed: readonly ThreadQueuedMessage[] = [
  makeQueuedMessage({
    id: "q_failed",
    text: "Post a concise summary when the checks finish.",
    waitingOn: threadBusy,
    failureReason: "Thread stopped before the message could dispatch",
  }),
];

interface StaticQueuedMessagesListProps {
  queuedMessages: readonly ThreadQueuedMessage[];
  sendDisabled?: boolean;
  actionDisabled?: boolean;
  processingMessageId?: string;
  processingAction?: "send" | "edit" | "delete";
}

function StaticQueuedMessagesList({
  queuedMessages,
  sendDisabled = false,
  actionDisabled = false,
  processingMessageId,
  processingAction,
}: StaticQueuedMessagesListProps) {
  return (
    <QueuedMessagesList
      attachedToComposer={true}
      queuedMessages={queuedMessages}
      sendAction="send-now"
      sendDisabled={sendDisabled}
      actionDisabled={actionDisabled}
      processingMessageId={processingMessageId ?? null}
      processingAction={processingAction ?? null}
      onSend={noop}
      onReorder={noop}
      onSetGroupBoundary={noop}
      onEdit={noop}
      onDelete={noop}
    />
  );
}

function ReorderableQueuedMessagesList() {
  const [queuedMessages, setQueuedMessages] =
    useState<readonly ThreadQueuedMessage[]>(multipleMessages);
  const handleReorder = useCallback((request: QueuedMessageReorderRequest) => {
    setQueuedMessages((currentQueuedMessages) =>
      applyStoryReorder(currentQueuedMessages, request),
    );
  }, []);
  const handleSetGroupBoundary = useCallback(
    (request: QueuedMessageGroupBoundaryRequest) => {
      setQueuedMessages((currentQueuedMessages) =>
        applyStoryGroupBoundary(
          currentQueuedMessages,
          request.groupBoundaryQueuedMessageId,
        ),
      );
    },
    [],
  );

  return (
    <QueuedMessagesList
      attachedToComposer={true}
      queuedMessages={queuedMessages}
      sendAction="send-now"
      sendDisabled={false}
      actionDisabled={false}
      processingMessageId={null}
      processingAction={null}
      onSend={noop}
      onReorder={handleReorder}
      onSetGroupBoundary={handleSetGroupBoundary}
      onEdit={noop}
      onDelete={noop}
    />
  );
}

function collectStoryLeadGroupIds(
  queuedMessages: readonly ThreadQueuedMessage[],
): string[] {
  const ids: string[] = [];
  for (const queuedMessage of queuedMessages) {
    ids.push(queuedMessage.id);
    if (!queuedMessage.groupWithNext) break;
  }
  return ids;
}

function preserveStoryLeadGroupAfterReorder({
  originalLeadGroupIds,
  queuedMessages,
}: {
  originalLeadGroupIds: readonly string[];
  queuedMessages: readonly ThreadQueuedMessage[];
}): ThreadQueuedMessage[] {
  if (originalLeadGroupIds.length <= 1) {
    return queuedMessages.map((queuedMessage) => ({
      ...queuedMessage,
      groupWithNext: false,
    }));
  }

  const originalLeadGroupIdSet = new Set(originalLeadGroupIds);
  const preservesLeadGroup = queuedMessages
    .slice(0, originalLeadGroupIds.length)
    .every((queuedMessage) => originalLeadGroupIdSet.has(queuedMessage.id));

  return queuedMessages.map((queuedMessage, index) => ({
    ...queuedMessage,
    groupWithNext:
      preservesLeadGroup && index < originalLeadGroupIds.length - 1,
  }));
}

function applyStoryReorder(
  queuedMessages: readonly ThreadQueuedMessage[],
  request: QueuedMessageReorderRequest,
): ThreadQueuedMessage[] {
  const reorderedMessages = applyQueuedMessageReorder({
    queuedMessages,
    request,
  });

  if (request.groupBoundaryQueuedMessageId !== undefined) {
    return applyStoryGroupBoundary(
      reorderedMessages,
      request.groupBoundaryQueuedMessageId,
    );
  }

  return preserveStoryLeadGroupAfterReorder({
    originalLeadGroupIds: collectStoryLeadGroupIds(queuedMessages),
    queuedMessages: reorderedMessages,
  });
}

function applyStoryGroupBoundary(
  queuedMessages: readonly ThreadQueuedMessage[],
  boundaryId: string,
): ThreadQueuedMessage[] {
  const boundaryIndex = queuedMessages.findIndex(
    (queuedMessage) => queuedMessage.id === boundaryId,
  );
  if (boundaryIndex === -1) return [...queuedMessages];
  return queuedMessages.map((queuedMessage, index) => ({
    ...queuedMessage,
    groupWithNext: index < boundaryIndex,
  }));
}

export function Overview() {
  return (
    <StoryCard>
      <StoryRow label="single message" hint="one queued message">
        <ResponsivePromptStage>
          <StaticQueuedMessagesList queuedMessages={oneMessage} />
        </ResponsivePromptStage>
      </StoryRow>
      <StoryRow
        label="multiple messages"
        hint="a few messages fit the drawer; the caret collapses it. Drag a row's grip to reorder, and the divider to move the send-together boundary"
      >
        <ResponsivePromptStage>
          <ReorderableQueuedMessagesList />
        </ResponsivePromptStage>
      </StoryRow>
      <StoryRow
        label="overflowing queue"
        hint="the caret expands an overflowing drawer into the pull-up workspace"
      >
        <ResponsivePromptStage>
          <StaticQueuedMessagesList queuedMessages={manyMessages} />
        </ResponsivePromptStage>
      </StoryRow>
      <StoryRow
        label="with attachments"
        hint="attachment count stays flush right, then crossfades into actions over a short edge fade"
      >
        <ResponsivePromptStage>
          <StaticQueuedMessagesList queuedMessages={withAttachments} />
        </ResponsivePromptStage>
      </StoryRow>
      <StoryRow
        label="long message"
        hint="single line truncates with an ellipsis; title attribute carries full text"
      >
        <ResponsivePromptStage>
          <StaticQueuedMessagesList queuedMessages={longMessage} />
        </ResponsivePromptStage>
      </StoryRow>
    </StoryCard>
  );
}

export function Blockquotes() {
  return (
    <StoryCard>
      <StoryRow
        label="mixed: quoted + plain"
        hint="rows stay one line in both drawer and workspace modes"
      >
        <ResponsivePromptStage>
          <StaticQueuedMessagesList queuedMessages={mixedMessages} />
        </ResponsivePromptStage>
      </StoryRow>
      <StoryRow
        label="plain messages (no quotes)"
        hint="single-line preview, leading icon centered — for comparison"
      >
        <ResponsivePromptStage>
          <StaticQueuedMessagesList queuedMessages={multipleMessages} />
        </ResponsivePromptStage>
      </StoryRow>
      <StoryRow
        label="quote + reply"
        hint="a single `> ` block above the typed reply"
      >
        <ResponsivePromptStage>
          <StaticQueuedMessagesList queuedMessages={quoteSingle} />
        </ResponsivePromptStage>
      </StoryRow>
      <StoryRow
        label="multi-line quote"
        hint="every quoted line is prefixed and styled as one blockquote"
      >
        <ResponsivePromptStage>
          <StaticQueuedMessagesList queuedMessages={quoteMultiline} />
        </ResponsivePromptStage>
      </StoryRow>
      <StoryRow
        label="two quote→reply blocks"
        hint="stacked quote/reply sections in one queued message"
      >
        <ResponsivePromptStage>
          <StaticQueuedMessagesList queuedMessages={quoteTwoBlocks} />
        </ResponsivePromptStage>
      </StoryRow>
      <StoryRow label="quote only" hint="quoted selection with no reply yet">
        <ResponsivePromptStage>
          <StaticQueuedMessagesList queuedMessages={quoteOnly} />
        </ResponsivePromptStage>
      </StoryRow>
      <StoryRow
        label="long quote (truncated)"
        hint="single-line preview truncates with an ellipsis"
      >
        <ResponsivePromptStage>
          <StaticQueuedMessagesList queuedMessages={quoteTruncated} />
        </ResponsivePromptStage>
      </StoryRow>
      <StoryRow
        label="quote + attachment"
        hint="the attachment icon remains visible beside the quoted preview"
      >
        <ResponsivePromptStage>
          <StaticQueuedMessagesList queuedMessages={quoteWithAttachment} />
        </ResponsivePromptStage>
      </StoryRow>
    </StoryCard>
  );
}

export function GroupedSendDivider() {
  return (
    <StoryCard>
      <StoryRow
        label="one message"
        hint="no divider — grouping needs at least two queued messages"
      >
        <ResponsivePromptStage>
          <StaticQueuedMessagesList queuedMessages={oneGroupedStoryMessage} />
        </ResponsivePromptStage>
      </StoryRow>
      <StoryRow
        label="multiple messages"
        hint="hover the divider and drag its simple grip to move the grouping boundary"
      >
        <ResponsivePromptStage>
          <StaticQueuedMessagesList queuedMessages={groupedMessages} />
        </ResponsivePromptStage>
      </StoryRow>
    </StoryCard>
  );
}

export function SteerWaitStates() {
  return (
    <StoryCard>
      <StoryRow
        label="behind a running turn"
        hint="`thread-busy` is the only wait that renders no line — the one-line row stays intact until a wait needs explaining"
      >
        <ResponsivePromptStage>
          <StaticQueuedMessagesList queuedMessages={multipleMessages} />
        </ResponsivePromptStage>
      </StoryRow>
      <StoryRow
        label="workspace provisioning"
        hint="the workspace is being recreated; Send now is withheld because it cannot clear this wait"
      >
        <ResponsivePromptStage>
          <StaticQueuedMessagesList queuedMessages={waitingForWorkspace} />
        </ResponsivePromptStage>
      </StoryRow>
      <StoryRow
        label="pending interaction"
        hint="the active turn needs the user's answer; no Send now"
      >
        <ResponsivePromptStage>
          <StaticQueuedMessagesList queuedMessages={waitingForReply} />
        </ResponsivePromptStage>
      </StoryRow>
      <StoryRow
        label="host offline"
        hint="the active turn cannot reach its enrolled host; no Send now"
      >
        <ResponsivePromptStage>
          <StaticQueuedMessagesList queuedMessages={waitingForHost} />
        </ResponsivePromptStage>
      </StoryRow>
    </StoryCard>
  );
}

export function ScheduledAndWaitingDispatch() {
  return (
    <StoryCard>
      <StoryRow
        label="scheduled · hours out"
        hint="coarse countdown beside the scheduled instant; Send now stays available because skipping the schedule genuinely clears the wait"
      >
        <ResponsivePromptStage>
          <StaticQueuedMessagesList queuedMessages={scheduled} />
        </ResponsivePromptStage>
      </StoryRow>
      <StoryRow
        label="scheduled · due shortly"
        hint="the countdown ticks per second under a minute"
      >
        <ResponsivePromptStage>
          <StaticQueuedMessagesList queuedMessages={scheduledSoon} />
        </ResponsivePromptStage>
      </StoryRow>
      <StoryRow
        label="plugin wait"
        hint="a plugin names why the dispatch is waiting"
      >
        <ResponsivePromptStage>
          <StaticQueuedMessagesList queuedMessages={pluginWait} />
        </ResponsivePromptStage>
      </StoryRow>
      <StoryRow
        label="plugin wait · stale"
        hint="the plugin has stopped reporting progress"
      >
        <ResponsivePromptStage>
          <StaticQueuedMessagesList queuedMessages={pluginWaitStale} />
        </ResponsivePromptStage>
      </StoryRow>
      <StoryRow
        label="retry"
        hint="a failed turn queued by reference; no message to quote, not editable"
      >
        <ResponsivePromptStage>
          <StaticQueuedMessagesList queuedMessages={retry} />
        </ResponsivePromptStage>
      </StoryRow>
    </StoryCard>
  );
}

export function InFlightStates() {
  return (
    <StoryCard>
      <StoryRow
        label="at rest"
        hint="actions stay hidden until hover or focus — hover is CSS-only and cannot be pinned from props"
      >
        <ResponsivePromptStage>
          <StaticQueuedMessagesList queuedMessages={scheduled} />
        </ResponsivePromptStage>
      </StoryRow>
      <StoryRow
        label="sending"
        hint="the row's own dispatch is in flight; actions withdraw"
      >
        <ResponsivePromptStage>
          <StaticQueuedMessagesList
            queuedMessages={inFlight}
            processingMessageId={inFlightMessage.id}
            processingAction="send"
          />
        </ResponsivePromptStage>
      </StoryRow>
      <StoryRow
        label="deleting"
        hint="the same line, labelled for the action in flight"
      >
        <ResponsivePromptStage>
          <StaticQueuedMessagesList
            queuedMessages={inFlight}
            processingMessageId={inFlightMessage.id}
            processingAction="delete"
          />
        </ResponsivePromptStage>
      </StoryRow>
      <StoryRow
        label="processing one of many"
        hint="only the middle row's actions disable; its neighbors stay interactive"
      >
        <ResponsivePromptStage>
          <StaticQueuedMessagesList
            queuedMessages={multipleMessages}
            processingMessageId="q_b"
            processingAction="send"
          />
        </ResponsivePromptStage>
      </StoryRow>
      <StoryRow
        label="failed"
        hint="the failure replaces the wait line and turns it destructive"
      >
        <ResponsivePromptStage>
          <StaticQueuedMessagesList queuedMessages={failed} />
        </ResponsivePromptStage>
      </StoryRow>
      <StoryRow
        label="send disabled"
        hint='runtime busy — cannot "Send now" but edit/delete still work'
      >
        <ResponsivePromptStage>
          <StaticQueuedMessagesList
            queuedMessages={multipleMessages}
            sendDisabled
          />
        </ResponsivePromptStage>
      </StoryRow>
      <StoryRow
        label="all actions disabled"
        hint="a queue-wide mutation is in flight"
      >
        <ResponsivePromptStage>
          <StaticQueuedMessagesList
            queuedMessages={multipleMessages}
            actionDisabled
          />
        </ResponsivePromptStage>
      </StoryRow>
      {}
    </StoryCard>
  );
}

export function NarrowSurface() {
  return (
    <StoryCard>
      <StoryRow
        label="queue"
        hint="inline actions collapse into the overflow menu below md; the compact row typography is what the drawer always uses"
      >
        <PromptStage size="mobile">
          <StaticQueuedMessagesList queuedMessages={multipleMessages} />
        </PromptStage>
      </StoryRow>
      <StoryRow
        label="queued"
        hint="the wait line truncates rather than wrapping"
      >
        <PromptStage size="mobile">
          <StaticQueuedMessagesList queuedMessages={pluginWaitStale} />
        </PromptStage>
      </StoryRow>
      <StoryRow
        label="retry"
        hint="no Edit entry in the overflow menu for a retry"
      >
        <PromptStage size="mobile">
          <StaticQueuedMessagesList queuedMessages={retry} />
        </PromptStage>
      </StoryRow>
      <StoryRow label="failed" hint="the failure reason truncates on one line">
        <PromptStage size="mobile">
          <StaticQueuedMessagesList queuedMessages={failed} />
        </PromptStage>
      </StoryRow>
    </StoryCard>
  );
}
