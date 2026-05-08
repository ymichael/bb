import { ConversationMessageContent } from "@/components/thread/timeline/ConversationMessageContent";
import { StoryCard, StoryRow } from "../../../../../.ladle/story-card";

export default {
  title: "thread/timeline/rows/Assistant Message",
};

// Match production: ThreadTimelinePane caps content at 760px AND lives
// inside PageShell's @container/page scope. The container scope matters
// because MarkdownPreview tables use a 100cqw breakout that resolves
// against the nearest container-query ancestor — without it, narrow
// windows make tables overflow against the viewport instead of the
// 760px content area.
function TimelineStage({ children }: { children: React.ReactNode }) {
  return (
    <div className="@container/page mx-auto w-full max-w-[760px]">
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Real assistant messages pulled from live threads in ~/.bb-dev/bb.db.
// ---------------------------------------------------------------------------

// thr_zzvsfyn7rm — "Investigate User Manual Issue"
const shortMessage = `Yes. As patched, it keeps the environment runtime entry and workspace watcher around until one of these happens:

- explicit environment destroy
- daemon shutdown
- \`host.sync_runtime_material\`, which calls \`evictIdleEnvironments()\`

There is no regular idle sweep in the host daemon, so "forever for the daemon lifetime" is a fair concern.

I would not keep this patch as-is. The safer shape is to decouple this from provider process exit, but still bound it, for example with an idle watcher TTL or a frontend-driven watch lease. A simpler fallback is to refetch direct environment workspace status on window focus, but that would not be a real push notification.`;

// thr_3vw9r8igrb — "Investigate File List Inconsistency". Real provider
// merge-readiness report: H1/H2 headers, multiple tables, fenced code blocks
// (shell, diff, ts), bold, inline code, em-dash separators, emoji markers.
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

export function Overview() {
  return (
    <StoryCard>
      <StoryRow label="short" hint="bullets + inline code spans">
        <TimelineStage>
          <ConversationMessageContent
            role="assistant"
            text={shortMessage}
            attachments={null}
            userRequest={null}
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
            text={longMessage}
            attachments={null}
            userRequest={null}
          />
        </TimelineStage>
      </StoryRow>
    </StoryCard>
  );
}
