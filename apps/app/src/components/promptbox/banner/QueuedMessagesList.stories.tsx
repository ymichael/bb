import type { ThreadQueuedMessage } from "@bb/domain";
import { QueuedMessagesList } from "@/components/promptbox/banner/QueuedMessagesList";
import { StoryCard, StoryRow } from "../../../../.ladle/story-card";

export default {
  title: "promptbox/banner/Queued Messages",
};

const noop = () => {};

// Production max width matches PageShell's footer cap (760px). Without it the
// queued list stretches the full row width, which doesn't reflect prod.
function PromptStage({ children }: { children: React.ReactNode }) {
  return <div className="w-full max-w-[760px]">{children}</div>;
}

// ---------------------------------------------------------------------------
// Realistic bb-flavored fixtures
// ---------------------------------------------------------------------------

function makeQueuedMessage({
  id,
  text,
  attachments = 0,
}: {
  id: string;
  text: string;
  attachments?: number;
}): ThreadQueuedMessage {
  const attachmentChunks = Array.from({ length: attachments }, (_, index) => ({
    type: "localImage" as const,
    path: `https://placecats.com/${300 + index * 20}/${200 + index * 10}`,
    name: `screenshot-${index + 1}.png`,
    mimeType: "image/png",
    sizeBytes: 100_000 + index * 10_000,
  }));
  return {
    id,
    content: [{ type: "text", text }, ...attachmentChunks],
    model: "gpt-5.5",
    reasoningLevel: "medium",
    permissionMode: "workspace-write",
    serviceTier: "default",
    createdAt: 0,
    updatedAt: 0,
  };
}

const oneMessage: readonly ThreadQueuedMessage[] = [
  makeQueuedMessage({
    id: "q_1",
    text: "Also check the timeline error overlay before sending.",
  }),
];

const multipleMessages: readonly ThreadQueuedMessage[] = [
  makeQueuedMessage({
    id: "q_a",
    text: "Also check the timeline error overlay before sending.",
  }),
  makeQueuedMessage({
    id: "q_b",
    text: "Confirm the env summary renders without the branch button on sandbox hosts.",
  }),
  makeQueuedMessage({
    id: "q_c",
    text: "And run the tests for @bb/thread-view.",
  }),
];

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

export function Overview() {
  return (
    <StoryCard>
      <StoryRow label="single message" hint="one queued message">
        <PromptStage>
          <QueuedMessagesList
            queuedMessages={oneMessage}
            sendDisabled={false}
            actionDisabled={false}
            processingMessageId={null}
            onSendImmediately={noop}
            onEdit={noop}
            onDelete={noop}
          />
        </PromptStage>
      </StoryRow>
      <StoryRow
        label="multiple messages"
        hint="three queued messages behind the active turn"
      >
        <PromptStage>
          <QueuedMessagesList
            queuedMessages={multipleMessages}
            sendDisabled={false}
            actionDisabled={false}
            processingMessageId={null}
            onSendImmediately={noop}
            onEdit={noop}
            onDelete={noop}
          />
        </PromptStage>
      </StoryRow>
      <StoryRow
        label="with attachments"
        hint="attachment counts shown alongside text"
      >
        <PromptStage>
          <QueuedMessagesList
            queuedMessages={withAttachments}
            sendDisabled={false}
            actionDisabled={false}
            processingMessageId={null}
            onSendImmediately={noop}
            onEdit={noop}
            onDelete={noop}
          />
        </PromptStage>
      </StoryRow>
      <StoryRow
        label="long message"
        hint="single line truncates with ellipsis; title attribute carries full text"
      >
        <PromptStage>
          <QueuedMessagesList
            queuedMessages={longMessage}
            sendDisabled={false}
            actionDisabled={false}
            processingMessageId={null}
            onSendImmediately={noop}
            onEdit={noop}
            onDelete={noop}
          />
        </PromptStage>
      </StoryRow>
      <StoryRow
        label="processing one"
        hint="middle row is being sent immediately; its actions disable"
      >
        <PromptStage>
          <QueuedMessagesList
            queuedMessages={multipleMessages}
            sendDisabled={false}
            actionDisabled={false}
            processingMessageId="q_b"
            onSendImmediately={noop}
            onEdit={noop}
            onDelete={noop}
          />
        </PromptStage>
      </StoryRow>
      <StoryRow
        label="send disabled"
        hint='runtime busy — cannot "Send now" but edit/delete still work'
      >
        <PromptStage>
          <QueuedMessagesList
            queuedMessages={multipleMessages}
            sendDisabled
            actionDisabled={false}
            processingMessageId={null}
            onSendImmediately={noop}
            onEdit={noop}
            onDelete={noop}
          />
        </PromptStage>
      </StoryRow>
    </StoryCard>
  );
}
