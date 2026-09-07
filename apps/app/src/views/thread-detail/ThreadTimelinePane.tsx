import { useState, type ReactNode } from "react";
import type { ThreadTimelineUnreadDividerPlacement } from "@/components/thread/timeline";
import type { PromptMentionLinkResolver } from "@/components/promptbox/editor/prompt-mention-link";
import { EmbeddedThreadChat } from "@/components/thread/embedded-chat";
import type { ThreadTimelineSurfaceProps } from "@/components/thread/timeline/ThreadTimelineSurface";
import { ThreadTableOfContents } from "@/components/thread/toc/ThreadTableOfContents";

interface ThreadTimelinePaneProps extends ThreadTimelineSurfaceProps {
  canSpawnChild: boolean;
  contextBoundarySeq: number | null;
  footer: ReactNode;
  hasOlderTimelineRows: boolean;
  isLoadingOlderTimelineRows: boolean;
  isStopping: boolean;
  onLoadOlderRows: () => void;
  resolveMentionLink: PromptMentionLinkResolver;
  stoppingAnchorAt: number;
  unreadDividerAutoScroll: boolean;
  unreadDividerPlacement: ThreadTimelineUnreadDividerPlacement | null;
}

export function ThreadTimelinePane({
  footer,
  ...surface
}: ThreadTimelinePaneProps) {
  const [timelineNavigationTargetRowId, setTimelineNavigationTargetRowId] =
    useState<string | null>(null);
  return (
    <EmbeddedThreadChat
      variant="hosted-footer"
      footer={footer}
      scrollOverlay={
        <ThreadTableOfContents
          contextBoundarySeq={surface.contextBoundarySeq}
          threadId={surface.threadId}
          timelineRows={surface.timelineRows}
          hasOlderTimelineRows={surface.hasOlderTimelineRows}
          loadOlderTimelineRows={surface.onLoadOlderRows}
          onNavigateToRow={setTimelineNavigationTargetRowId}
        />
      }
      surface={{ ...surface, timelineNavigationTargetRowId }}
    />
  );
}
