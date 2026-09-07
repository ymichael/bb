import type {
  TimelineConversationAttachments,
  TimelineRow,
} from "@bb/server-contract";
import { ThreadTimelineSurface } from "@/components/thread/timeline/ThreadTimelineSurface";
import { ThreadTableOfContents } from "@/components/thread/toc/ThreadTableOfContents";
import { BottomAnchoredScrollBody } from "@/components/ui/bottom-anchored-scroll-body";

export default {
  title: "thread/Table of Contents",
};

const now = 1_800_000_000_000;

function conversationRow({
  attachments = null,
  id,
  role,
  text,
  index,
}: {
  attachments?: TimelineConversationAttachments | null;
  id: string;
  role: "user" | "assistant";
  text: string;
  index: number;
}): TimelineRow {
  const base = {
    id,
    threadId: "thr_toc_story",
    turnId: `turn_${Math.floor(index / 2)}`,
    sourceSeqStart: index + 1,
    sourceSeqEnd: index + 1,
    startedAt: now + index * 1_000,
    createdAt: now + index * 1_000,
    kind: "conversation" as const,
    text,
    attachments,
  };
  if (role === "user") {
    return {
      ...base,
      role: "user",
      initiator: "user",
      senderThreadId: null,
      systemMessageKind: "unlabeled",
      systemMessageSubject: null,
      turnRequest: {
        isGrouped: false,
        kind: "message",
        status: "accepted",
      },
      mentions: [],
    };
  }
  return {
    ...base,
    role: "assistant",
    turnRequest: null,
  };
}

const timelineRows: TimelineRow[] = Array.from(
  { length: 18 },
  (_, turnIndex) => [
    conversationRow({
      id: `row_user_${turnIndex + 1}`,
      role: "user",
      index: turnIndex * 2,
      text:
        turnIndex === 2
          ? ""
          : `User checkpoint ${turnIndex + 1}: audit the queued-message drawer, thread table of contents rail, scroll spy behavior, and click-to-jump target for this section. This preview should clamp inside the panel while the full message remains visible in the timeline.`,
      attachments:
        turnIndex === 2
          ? {
              webImages: 0,
              localImages: 1,
              localFiles: 0,
              imageUrls: [],
              localImagePaths: ["/workspace/design-reference.png"],
              localFilePaths: [],
            }
          : null,
    }),
    conversationRow({
      id: `row_agent_${turnIndex + 1}`,
      role: "assistant",
      index: turnIndex * 2 + 1,
      text: `Agent response ${turnIndex + 1}: keep the active item synced to the timeline viewport, preserve the locked segmented tabs, and leave enough repeated content in the story for the bottom-only fade to appear when the panel list overflows.`,
    }),
  ],
).flat();

export function Default() {
  return (
    <div className="flex h-[640px] min-h-0 overflow-hidden rounded-lg border border-border bg-background">
      <BottomAnchoredScrollBody
        footer={null}
        maxWidthClassName="max-w-3xl"
        contentClassName="gap-2 pt-4"
        scrollOverlay={
          <ThreadTableOfContents
            contextBoundarySeq={null}
            threadId="thr_toc_story"
            timelineRows={timelineRows}
            hasOlderTimelineRows={false}
            loadOlderTimelineRows={() => {}}
          />
        }
      >
        <ThreadTimelineSurface
          activeThinking={null}
          isThreadTimelinePending={false}
          timelineError={false}
          showOngoingIndicator={false}
          timelineRows={timelineRows}
          threadId="thr_toc_story"
          threadRuntimeDisplayStatus="idle"
          workspaceRootPath={undefined}
        />
      </BottomAnchoredScrollBody>
    </div>
  );
}
