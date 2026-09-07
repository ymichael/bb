import type { TimelineRow } from "@bb/server-contract";
import { ConversationMessageContent } from "@/components/thread/timeline/ConversationMessageContent";
import { ThreadTimelineRows } from "@/components/thread/timeline/ThreadTimelineRows";
import { PAGE_SHELL_CONTENT_STYLE } from "@/components/ui/page-shell-content-style";
import { conversationRow } from "@/test/fixtures/thread-timeline-rows";
import { StoryCard, StoryRow } from "../../../../../.ladle/story-card";

export default {
  title: "thread/timeline/rows/Assistant Message",
};

function TimelineStage({ children }: { children: React.ReactNode }) {
  return (
    <div className="@container/page w-full">
      <div
        className="mx-auto w-full max-w-[760px]"
        style={PAGE_SHELL_CONTENT_STYLE}
      >
        {children}
      </div>
    </div>
  );
}

const shortMessage = `Yes. As patched, it keeps the environment runtime entry and workspace watcher around until one of these happens:

- explicit environment destroy
- daemon shutdown
- explicit environment cleanup after the watcher is no longer needed

There is no regular idle sweep in the host daemon, so "forever for the daemon lifetime" is a fair concern.

I would not keep this patch as-is. The safer shape is to decouple this from provider process exit, but still bound it, for example with an idle watcher TTL or a frontend-driven watch lease. A simpler fallback is to refetch direct environment workspace status on window focus, but that would not be a real push notification.`;

const longMessage = `# Merge-readiness report

## Branch / main / merge base

- **Branch:** \`bb/investigate-file-list-inconsistency-thr_3vw9r8igrb\`
- **Branch HEAD:** \`d61c0cf8\` — \`chore: drop dead onOpenFileDiff prop in ThreadDetailView after rebase\`
- **Local main:** \`f49ae132\` — \`Classify provider status noise events\`
- **Merge-base of branch and main:** \`f49ae132\` (branch is now linear on top of current main)
- **Commits ahead of main:** 8

## Diff summary (\`git diff main...HEAD\`)

\`\`\`
 9 files changed, 456 insertions(+), 71 deletions(-)

 apps/app/src/components/shared/WorkspaceChangesList.tsx       38 +---
 apps/app/src/views/ThreadDetailSecondaryContent.tsx           10 +-
 apps/app/src/views/ThreadDetailView.tsx                       26 ++-
 apps/app/src/views/ThreadSecondaryPanel.tsx                   84 +++++---
 packages/ui-core/src/primitives/file-path-link.tsx            49 +++++
 packages/ui-core/src/thread-timeline/TimelineRowDetails.tsx   18 +-
 packages/ui-core/test/file-path-link.test.tsx                 62 ++++++
\`\`\`

## What the branch changes

| Area | Change |
|---|---|
| **\`@bb/ui-core\` primitive (new)** | \`FilePathLink\` — clickable filename with hover-underline, optional \`external-link\` icon variant, integrates \`TruncateStart\` for path text. |
| **\`apps/app\` Info tab** | \`WorkspaceChangesList\` files open the diff panel via \`onChangedFileClick\`, gated on \`canUseGitUi\`. |
| **\`apps/app\` diff banner header** | \`GitDiffFileCard\` renders \`FilePathLink\` with \`variant="external"\` and a \`MoreHorizontal\` kebab → "Copy path". |
| **Docs** | \`plans/tab-split-layout.md\` — Phase 2a (this branch) + Phase 2b (file tabs, blocked). |

The new primitive's contract:

\`\`\`ts
export interface FilePathLinkProps {
  path: string;
  variant?: "default" | "external";
  onClick?: (path: string) => void;
  className?: string;
}

export function FilePathLink({
  path,
  variant = "default",
  onClick,
  className,
}: FilePathLinkProps) {
  const isClickable = onClick !== undefined;
  const Tag = isClickable ? "button" : "span";
  return (
    <Tag
      type={isClickable ? "button" : undefined}
      onClick={isClickable ? () => onClick(path) : undefined}
      className={cn(
        "inline-flex items-center gap-1 hover:underline",
        className,
      )}
    >
      <TruncateStart>{path}</TruncateStart>
      {variant === "external" && isClickable ? (
        <ExternalLink className="size-3" />
      ) : null}
    </Tag>
  );
}
\`\`\`

## Branch intent: where each piece landed

| Original intent | Outcome |
|---|---|
| \`FilePathLink\` primitive | ✅ Preserved. Uses \`TruncateStart\`. |
| \`WorkspaceChangesList\` migration | ✅ Preserved. Single \`onFileClick\` API. |
| Info tab \`onChangedFileClick\` → opens diff panel | ✅ Preserved, gated on \`canUseGitUi\`. |
| **DelegationRow "Working…" empty-state** | ✅ **Reimplemented** in \`WorkRowBody\`'s \`delegation\` case. Same trigger, same shimmer. |
| **Click filename → open diff** | ❌ Dropped — needs a \`TimelineTitle\` contract change in \`@bb/thread-view\`. Outside scope. |

## Validation

| Check | Result |
|---|---|
| Typecheck | ✅ 60 packages pass |
| Build | ✅ 33 packages pass |
| Tests | ✅ 60 packages pass |
| \`git diff --check\` | ✅ clean |

## Blockers / risks

**No blockers.** Branch is rebased linearly on top of \`f49ae132\` and all targeted validation passes.

**Risks documented:**
- The "click filename in timeline file-edit row → open diff panel" UX is **gone** as of this branch landing. It was implicitly deleted by \`595c4f21 Replace timeline rendering pipeline\` and not re-introduced here. Flagged in \`plans/tab-split-layout.md\` as Phase 2b open work.

## Final state

\`\`\`
\$ git log --oneline main..HEAD
d61c0cf8 chore: drop dead onOpenFileDiff prop in ThreadDetailView after rebase
e0a3d934 test: switch FilePathLink tests to getByTitle after TruncateStart adoption
9c876bd2 fix: tighten DelegationRow placeholder gate and dedupe FileEditRow link
1bfcc38a feat: unify file-link UX behind a shared FilePathLink
a9a0838a feat: enhance workspace changes functionality with new hooks and props
\`\`\`

Branch is merge-ready on top of \`f49ae132\`.`;

const MOBILE_REVIEW_THREAD_ID = "thr_mobile_actions_review";
const mobileReviewRows: TimelineRow[] = [
  conversationRow({
    id: "mobile_actions_earlier_user_message",
    threadId: MOBILE_REVIEW_THREAD_ID,
    turnId: "turn_mobile_actions_earlier_user",
    sourceSeqStart: 5,
    sourceSeqEnd: 5,
    role: "user",
    text: "Please tighten the message actions on mobile.",
  }),
  conversationRow({
    id: "mobile_actions_earlier_agent_message",
    threadId: MOBILE_REVIEW_THREAD_ID,
    turnId: "turn_mobile_actions_earlier",
    sourceSeqStart: 10,
    sourceSeqEnd: 10,
    role: "assistant",
    text: "I found the layout branch. I’m checking the responsive action rules before changing the message footer.",
  }),
  conversationRow({
    id: "mobile_actions_latest_user_message",
    threadId: MOBILE_REVIEW_THREAD_ID,
    turnId: "turn_mobile_actions_latest_user",
    sourceSeqStart: 15,
    sourceSeqEnd: 15,
    role: "user",
    text: "Use the same compact rule for my latest message too.",
  }),
  conversationRow({
    id: "mobile_actions_latest_agent_message",
    threadId: MOBILE_REVIEW_THREAD_ID,
    turnId: "turn_mobile_actions_latest",
    sourceSeqStart: 20,
    sourceSeqEnd: 20,
    role: "assistant",
    text: "The mobile footer is ready. Earlier agent messages keep their actions in the overflow menu, while this final response exposes Copy and Fork inline.",
  }),
];

const noop = () => undefined;

export function Overview() {
  return (
    <StoryCard>
      <StoryRow label="short" hint="bullets + inline code spans">
        <TimelineStage>
          <ConversationMessageContent
            role="assistant"
            id="row_story_short"
            threadId="thr_story"
            turnId="turn_story_short"
            text={shortMessage}
            attachments={null}
            showActions={true}
            mobileActionDisplay="inline"
            streaming={false}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="long"
        hint="H1/H2 headers, tables, fenced code, bold, inline code, emoji markers"
      >
        <TimelineStage>
          <ConversationMessageContent
            role="assistant"
            id="row_story_long"
            threadId="thr_story"
            turnId="turn_story_long"
            text={longMessage}
            attachments={null}
            showActions={true}
            mobileActionDisplay="inline"
            streaming={false}
          />
        </TimelineStage>
      </StoryRow>
    </StoryCard>
  );
}

const overflowStoryPluginActions = [
  {
    key: "story/summarize",
    pluginId: null,
    icon: "Sparkles",
    label: "Summarize",
    onSelect: noop,
  },
  {
    key: "story/translate",
    pluginId: null,
    icon: "Globe",
    label: "Translate",
    onSelect: noop,
  },
  {
    key: "story/save",
    pluginId: null,
    icon: "Bookmark",
    label: "Save to notes",
    onSelect: noop,
  },
  {
    key: "story/pin",
    pluginId: null,
    icon: "Pin",
    label: "Pin message",
    onSelect: noop,
  },
  {
    key: "story/share",
    pluginId: null,
    icon: "Share",
    label: "Share",
    onSelect: noop,
  },
];

export function ActionOverflow() {
  return (
    <StoryCard>
      <StoryRow
        label="wide column"
        hint="native + five plugin actions all fit inline"
      >
        <TimelineStage>
          <div className="[&_button]:opacity-100">
            <ConversationMessageContent
              role="assistant"
              id="row_story_overflow_wide"
              threadId="thr_story"
              turnId="turn_story_overflow_wide"
              text="Done — the migration ran cleanly on all three environments."
              attachments={null}
              showActions={true}
              mobileActionDisplay="inline"
              streaming={false}
              onAddToChat={noop}
              onFork={noop}
              pluginActions={overflowStoryPluginActions}
            />
          </div>
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="narrow column"
        hint="a 160px column collapses trailing actions into the overflow menu"
      >
        <div className="w-[160px] [&_button]:opacity-100">
          <ConversationMessageContent
            role="assistant"
            id="row_story_overflow_narrow"
            threadId="thr_story"
            turnId="turn_story_overflow_narrow"
            text="Done — migration complete."
            attachments={null}
            showActions={true}
            mobileActionDisplay="inline"
            streaming={false}
            onAddToChat={noop}
            onFork={noop}
            pluginActions={overflowStoryPluginActions}
          />
        </div>
      </StoryRow>
    </StoryCard>
  );
}

export function MobileActionsAndSelection() {
  return (
    <div className="mobile-agent-actions-review mx-auto w-full max-w-[390px] rounded-lg border border-border bg-background p-4">
      <style>{`
      /* Force the coarse-pointer presentation for desktop story review. The
         production component still owns the real mobile media queries. */
      .mobile-agent-actions-review
        :is(
          [data-timeline-row-id="mobile_actions_earlier_agent_message"],
          [data-timeline-row-id="mobile_actions_earlier_user_message"]
        )
        [aria-label="Copy message"],
      .mobile-agent-actions-review
        [data-timeline-row-id="mobile_actions_earlier_agent_message"]
        [aria-label="Fork into new thread"],
      .mobile-agent-actions-review
        [data-timeline-row-id="mobile_actions_earlier_agent_message"]
      .mobile-agent-actions-review
        [data-timeline-row-id="mobile_actions_earlier_user_message"]
        [aria-label="Add to chat"] {
        display: none;
      }

      .mobile-agent-actions-review
        :is(
          [data-timeline-row-id="mobile_actions_earlier_agent_message"],
          [data-timeline-row-id="mobile_actions_earlier_user_message"]
        )
        [aria-label="Message actions"] {
        display: inline-flex;
      }

      .mobile-agent-actions-review
        :is(
          [data-timeline-row-id="mobile_actions_latest_agent_message"],
          [data-timeline-row-id="mobile_actions_latest_user_message"]
        )
        [aria-label="Copy message"],
      .mobile-agent-actions-review
        [data-timeline-row-id="mobile_actions_latest_agent_message"]
        [aria-label="Fork into new thread"],
      .mobile-agent-actions-review
        [data-timeline-row-id="mobile_actions_latest_agent_message"]
      .mobile-agent-actions-review
        [data-timeline-row-id="mobile_actions_latest_user_message"]
        [aria-label="Add to chat"] {
        width: 1.75rem;
        height: 1.75rem;
        opacity: 1;
      }

      .mobile-agent-actions-review
        :is(
          [data-timeline-row-id="mobile_actions_latest_agent_message"],
          [data-timeline-row-id="mobile_actions_latest_user_message"]
        )
        [aria-label="Copy message"] svg,
      .mobile-agent-actions-review
        [data-timeline-row-id="mobile_actions_latest_agent_message"]
        [aria-label="Fork into new thread"] svg,
      .mobile-agent-actions-review
        [data-timeline-row-id="mobile_actions_latest_agent_message"]
      .mobile-agent-actions-review
        [data-timeline-row-id="mobile_actions_latest_user_message"]
        [aria-label="Add to chat"] svg {
        width: 1rem;
        height: 1rem;
      }
    `}</style>
      <p className="mb-4 text-xs leading-relaxed text-muted-foreground">
        Earlier user and agent messages: overflow menu. Latest user and agent
        messages: compact inline actions. Drag-select with a mouse or long-press
        agent text on touch to exercise the floating selection menu.
      </p>
      <ThreadTimelineRows
        canSpawnChild
        onForkMessage={noop}
        onSelectionAddToChat={noop}
        threadId={MOBILE_REVIEW_THREAD_ID}
        threadRuntimeDisplayStatus="idle"
        timelineRows={mobileReviewRows}
        workspaceRootPath={undefined}
      />
    </div>
  );
}

MobileActionsAndSelection.meta = { width: "xsmall" };
