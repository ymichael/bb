import type { ReactNode } from "react";
import { makeThreadListEntry } from "../../../.ladle/story-fixtures";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";
import { ThreadActionsProvider } from "./ThreadActionsProvider";
import { ThreadActionsMenu } from "./ThreadActionsMenu";

export default {
  title: "thread/Thread actions menu",
};

function Stage({ children }: { children: ReactNode }) {
  return (
    <ThreadActionsProvider>
      <div className="flex w-fit items-center rounded-md bg-sidebar p-2 text-sidebar-foreground">
        {children}
      </div>
    </ThreadActionsProvider>
  );
}

export function Overview() {
  const readThread = makeThreadListEntry({
    id: "thr_read",
    lastReadAt: 200,
    latestAttentionAt: 100,
  });
  const unreadPinnedThread = makeThreadListEntry({
    id: "thr_unread",
    lastReadAt: 100,
    latestAttentionAt: 200,
    pinnedAt: 150,
  });
  const archivedThread = makeThreadListEntry({
    id: "thr_archived",
    archivedAt: 150,
  });

  return (
    <StoryCard>
      <StoryRow
        label="read · unpinned"
        hint="Mark unread · Pin — Rename — Archive · Delete"
      >
        <Stage>
          <ThreadActionsMenu thread={readThread} />
        </Stage>
      </StoryRow>
      <StoryRow
        label="unread · pinned"
        hint="read toggle flips to Mark read; Pin flips to Unpin"
      >
        <Stage>
          <ThreadActionsMenu thread={unreadPinnedThread} />
        </Stage>
      </StoryRow>
      <StoryRow label="archived" hint="Archive flips to Unarchive">
        <Stage>
          <ThreadActionsMenu thread={archivedThread} />
        </Stage>
      </StoryRow>
    </StoryCard>
  );
}
