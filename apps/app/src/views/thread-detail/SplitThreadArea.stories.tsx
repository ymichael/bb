import { useMemo } from "react";
import type {
  ThreadResponse,
  ThreadTimelineResponse,
} from "@bb/server-contract";
import type { ThreadTimelineGoal } from "@bb/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createStore, Provider as JotaiProvider } from "jotai";
import { makeThread } from "../../../.ladle/story-fixtures";
import { conversationRow } from "@/test/fixtures/thread-timeline-rows";
import {
  makeThreadResponse,
  makeThreadTimelineResponse,
} from "@/test/fixtures/thread-responses";
import {
  threadDetailBootstrapQueryKey,
  threadQueryKey,
  threadTimelineQueryKey,
} from "@/hooks/queries/query-keys";
import { maximizedPaneIdAtom, splitLayoutAtom } from "@/lib/split-layout/atoms";
import type { SplitLayout } from "@/lib/split-layout";
import { SidebarProvider } from "@/components/ui/sidebar";
import { ThreadActionsProvider } from "@/components/thread/ThreadActionsProvider";
import { SplitThreadArea } from "./SplitThreadArea";

export default {
  title: "thread/splits/Split Workspace",
};

const PROJECT_ID = "proj_bb";
const IDLE_THREAD_ID = "thr_split_idle";
const ACTIVE_THREAD_ID = "thr_split_active";
const MENTIONED_THREAD_ID = "thr_dcwivn5n8w";

function storyThread(id: string, title: string): ThreadResponse {
  return makeThreadResponse({
    ...makeThread({
      id,
      projectId: PROJECT_ID,
      environmentId: null,
      title,
      titleFallback: title,
    }),
    canSpawnChild: false,
  });
}

const idleThread = storyThread(IDLE_THREAD_ID, "Fix Thread Drag Sync");
const activeThread = storyThread(
  ACTIVE_THREAD_ID,
  `Continue from ${MENTIONED_THREAD_ID}`,
);
const mentionedThread = storyThread(
  MENTIONED_THREAD_ID,
  "Raw thread ID mention target",
);

function storyTimeline(
  threadId: string,
  userMessage: string,
  assistantMessages: readonly string[],
  goalObjective: string,
): ThreadTimelineResponse {
  const goal: ThreadTimelineGoal = {
    sourceSeq: assistantMessages.length + 2,
    updatedAt: 1,
    objective: goalObjective,
    status: "active",
    tokenBudget: null,
    tokensUsed: 1_240,
    timeUsedSeconds: 185,
  };

  return makeThreadTimelineResponse({
    rows: [
      conversationRow({
        id: `${threadId}:user:1`,
        role: "user",
        sourceSeqStart: 1,
        text: userMessage,
        threadId,
        turnId: `${threadId}:turn:1`,
      }),
      ...assistantMessages.map((text, index) =>
        conversationRow({
          id: `${threadId}:assistant:${index + 1}`,
          role: "assistant",
          sourceSeqStart: index + 2,
          text,
          threadId,
          turnId: `${threadId}:turn:1`,
        }),
      ),
    ],
    goal,
    maxSeq: goal.sourceSeq,
    timelinePage: {
      kind: "latest",
      segmentLimit: 20,
      returnedSegmentCount: 1,
      hasOlderRows: false,
      olderCursor: null,
    },
  });
}

const idleTimeline = storyTimeline(
  IDLE_THREAD_ID,
  "When I drag threads between sections, the source row sometimes stays faded after the drop.",
  [
    "I found a race between the drag library's finish callback and React cleanup. The late callback restores the stale inline opacity.",
    "The regression now covers the real drop timing, and the row returns to full opacity without a refresh.",
    "I also checked the sidebar projection and the canonical thread state independently, so the visual cleanup no longer depends on a refresh or another render.",
    "The minimal change keeps the existing drag behavior intact and only prevents the stale finish callback from repainting the source row.",
    "The focused regression now exercises the delayed callback ordering that reproduced the issue in production.",
    "Type checking and the thread drag tests both pass with the fix applied.",
    "A subtle, non-interactive pane scrim marks this split as inactive without blocking it.",
  ],
  "Keep the inactive pane readable while a single light scrim marks it as idle.",
);

const activeTimeline = storyTimeline(
  ACTIVE_THREAD_ID,
  `Use ${MENTIONED_THREAD_ID} as context, make the divider thinner, and let the header carry focus. Resolve the exact inline-code reference \`${MENTIONED_THREAD_ID}\` too.`,
  [
    `The split seam now matches ${MENTIONED_THREAD_ID}: one pixel with a wider invisible resize target.`,
    "The same hairline treatment is applied where the secondary panel meets the split workspace, so the seams read as one system.",
    "Inactive panes receive a subtle background scrim while messages and status rows remain readable and interactive.",
    "The inactive scrim trades places as focus moves between panes while both composers remain fully legible.",
    "The timeline scrollbar now stays invisible at rest and returns briefly while the pane is actively scrolling.",
    "Its native scroll container and hit area remain intact, so wheel, trackpad, touch, and keyboard scrolling behave exactly as before.",
    "This story intentionally overflows both panes so the transient scrollbar behavior can be checked alongside the divider and focus states.",
  ],
  "Refine split focus with a restrained inactive scrim and reversible pane states.",
);

const splitLayout: SplitLayout = {
  root: {
    type: "split",
    dir: "row",
    sizes: [0.5, 0.5],
    children: [
      {
        type: "pane",
        paneId: "pane-idle",
        content: {
          kind: "thread",
          projectId: PROJECT_ID,
          threadId: IDLE_THREAD_ID,
        },
      },
      {
        type: "pane",
        paneId: "pane-active",
        content: {
          kind: "thread",
          projectId: PROJECT_ID,
          threadId: ACTIVE_THREAD_ID,
        },
      },
    ],
  },
  focusedPaneId: "pane-active",
};

function createStoryQueryClient(): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: {
        gcTime: Infinity,
        refetchOnWindowFocus: false,
        retry: false,
        staleTime: Infinity,
      },
    },
  });

  for (const [thread, timeline] of [
    [idleThread, idleTimeline],
    [activeThread, activeTimeline],
  ] as const) {
    queryClient.setQueryData(threadDetailBootstrapQueryKey(thread.id), thread);
    queryClient.setQueryData(threadQueryKey(thread.id), thread);
    queryClient.setQueryData(threadTimelineQueryKey(thread.id), timeline);
  }
  queryClient.setQueryData(threadQueryKey(mentionedThread.id), mentionedThread);

  return queryClient;
}

function SplitWorkspaceStory({ maximized = false }: { maximized?: boolean }) {
  const queryClient = useMemo(() => createStoryQueryClient(), []);
  const store = useMemo(() => {
    const nextStore = createStore();
    nextStore.set(splitLayoutAtom, splitLayout);
    nextStore.set(maximizedPaneIdAtom, maximized ? "pane-active" : null);
    return nextStore;
  }, [maximized]);

  return (
    <QueryClientProvider client={queryClient}>
      <JotaiProvider store={store}>
        <ThreadActionsProvider>
          <SidebarProvider>
            <div className="flex h-screen min-h-[640px] w-full flex-col bg-background p-4 md:p-5">
              <SplitThreadArea
                routeContent={{
                  kind: "thread",
                  projectId: PROJECT_ID,
                  threadId: ACTIVE_THREAD_ID,
                }}
              />
            </div>
          </SidebarProvider>
        </ThreadActionsProvider>
      </JotaiProvider>
    </QueryClientProvider>
  );
}

export function ActiveAndIdle() {
  return <SplitWorkspaceStory />;
}

export function MaximizedWithoutRail() {
  return <SplitWorkspaceStory maximized />;
}
