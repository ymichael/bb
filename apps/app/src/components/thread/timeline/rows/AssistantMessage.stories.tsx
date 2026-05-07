import { ConversationMessageContent } from "@/components/thread/timeline/ConversationMessageContent";
import { StoryCard, StoryRow } from "../../../../../.ladle/story-card";

export default {
  title: "thread/timeline/rows/Assistant Message",
};

// Match production: ThreadTimelinePane caps content at 760px.
function TimelineStage({ children }: { children: React.ReactNode }) {
  return <div className="w-full max-w-[760px]">{children}</div>;
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
// (shell + diff), bold, inline code, em-dash horizontal-style separators,
// emoji result markers.
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
 packages/ui-core/src/index.ts                                  1 +
 packages/ui-core/src/primitives/file-path-link.tsx            49 +++++
 packages/ui-core/src/thread-timeline/TimelineRowDetails.tsx   18 +-
 packages/ui-core/test/file-path-link.test.tsx                 62 ++++++
 plans/tab-split-layout.md                                    239 +++++++++++++++++++++
\`\`\`

## What the branch changes

| Area | Change |
|---|---|
| **\`@bb/ui-core\` primitive (new)** | \`FilePathLink\` — clickable filename with hover-underline, optional \`external-link\` icon variant, integrates \`TruncateStart\` (start-truncating) for path text. Co-located with other primitives at \`primitives/file-path-link.tsx\`. |
| **\`@bb/ui-core\` reuse** | \`WorkspaceChangesList\` migrated to \`FilePathLink\`; export added to package index. |
| **\`@bb/ui-core\` test** | \`file-path-link.test.tsx\` (8 tests) covers span/button modes, click invocation, \`variant="external"\` icon presence/absence including the contract case where the icon is dropped when no action is available. |
| **\`@bb/ui-core\` timeline (delegation empty-state, reimplemented at new owner)** | \`WorkRowBody\`'s \`delegation\` case in \`TimelineRowDetails.tsx\` now renders a shimmering \`Working…\` placeholder when \`output\` is empty *and* \`status === "pending"\`. Replaces the deleted \`DelegationRow.tsx\` "Working…" branch from the previous architecture, landing the behavior in the new pipeline's owner. |
| **\`apps/app\` Info tab** | \`WorkspaceChangesList\` files in the Info tab open the diff panel via \`onChangedFileClick\`, gated on \`canUseGitUi\` (manager threads degrade to plain spans, no clickable-but-no-op). |
| **\`apps/app\` diff banner per-file header** | \`GitDiffFileCard\` renders \`FilePathLink\` with \`variant="external"\` when the file is openable in editor, and a \`MoreHorizontal\` kebab → "Copy path" using the shared \`copyToClipboardWithToast\` helper. Renames prop to \`onOpenFileInEditor\`; tooltip uses \`openablePath ?? fileDiff.name\` to avoid showing \`prev → new\` arrow strings. |
| **\`apps/app\` \`WorkspaceChangedFile\` type export** | Replaces inline \`ComponentProps<...>["files"][number]\` indirection in metadata props. |
| **Docs** | \`plans/tab-split-layout.md\` — design doc capturing the file-link click vocabulary + Phase 2a (this branch's scope) + Phase 2b (file tabs, blocked on Phase 1). |

## Touched packages and responsibilities

| Package | Responsibility on this branch |
|---|---|
| \`@bb/app\` | Info tab + diff banner + \`WorkspaceChangedFile\` type plumbing |
| \`@bb/ui-core\` | \`FilePathLink\` primitive + delegation empty-state placeholder + test infrastructure (\`@testing-library/react\`, \`jsdom\` dev deps were already on main; the test file lives here) |

## Branch intent: where each piece landed

| Original intent | Outcome |
|---|---|
| \`FilePathLink\` primitive | ✅ Preserved. Relocated to \`primitives/\` per main's convention; uses \`TruncateStart\`. |
| \`WorkspaceChangesList\` migration | ✅ Preserved. Single \`onFileClick\` callback API. |
| Diff banner header migration + kebab "Copy path" + \`variant="external"\` | ✅ Preserved. |
| Info tab \`onChangedFileClick\` → opens diff panel | ✅ Preserved, gated on \`canUseGitUi\`. |
| Tooltip uses \`openablePath ?? fileDiff.name\`, never the rename arrow | ✅ Preserved. |
| \`onOpenFile\` → \`onOpenFileInEditor\` rename | ✅ Preserved. |
| Use shared \`copyToClipboardWithToast\` helper | ✅ Preserved. |
| Drop redundant \`text-xs\` on diff banner FilePathLink | ✅ Preserved. |
| \`plans/tab-split-layout.md\` | ✅ Preserved. |
| **DelegationRow "Working…" empty-state** | ✅ **Reimplemented at new owner.** Lives in \`WorkRowBody\`'s \`delegation\` case in \`TimelineRowDetails.tsx\`. Same trigger condition (\`output empty + status === "pending"\`), same shimmer treatment (\`animate-shine\` class), same copy. |
| **\`onOpenFileDiff\` plumbing through \`ConversationEntry\`/\`FileEditRow\` → click filenames in timeline to open diff** | ❌ **Dropped with documentation.** The new pipeline renders titles via flat \`TimelineTitleView\` with no slot for clickable content. Re-introducing this would require a contract change to \`@bb/thread-view\`'s \`TimelineTitle\` (adding an optional click target on title content) — a cross-package architectural change that should be a separate PR coordinated with the timeline-rewrite owner. **Not satisfied by current main; explicitly outside this branch's scope after the rewrite.** |
| **\`ThreadTimelineFileDiffHandler\` type** | ❌ Dropped — was only used by the timeline-side plumbing above. |
| **\`OngoingEventLabel\` export** | ❌ Dropped — \`shared.tsx\` deleted on main; the equivalent shimmer for the placeholder now uses \`animate-shine\` directly inline. |
| **Delegation/FileEdit/FilePathLink-with-FileEditRow render tests** | ❌ Dropped — rendered components (\`DelegationRow\`, \`FileEditRow\`, \`ConversationEntry\`) no longer exist. The \`FilePathLink\` test file remains and covers the primitive directly. |

## Validation

| Check | Command | Result |
|---|---|---|
| Typecheck | \`pnpm exec turbo run typecheck --filter='!@bb/agent-provider-audit'\` | ✅ 60 packages pass |
| Lint | \`pnpm exec turbo run lint --filter='!@bb/agent-provider-audit'\` | ✅ pass (only \`@bb/app\` has a lint script) |
| Build | \`pnpm exec turbo run build --filter='!@bb/agent-provider-audit'\` | ✅ 33 packages pass |
| Tests (excl. integration-tests) | \`pnpm exec turbo run test --filter='!@bb/agent-provider-audit' --filter='!@bb/integration-tests'\` | ✅ 60 packages pass |
| Branch-relevant test counts | \`@bb/ui-core\` 10 files / 89 tests · \`@bb/app\` 55 files / 280 tests · \`@bb/server\` 66 files / 605 tests | all pass |
| \`git diff --check\` | clean | ✅ |
| \`git show --check\` per commit | 8/8 clean | ✅ |

\`@bb/agent-provider-audit\` excluded — pre-existing main breakage at \`stories/excalidraw-timeline.stories.tsx:47\` (uses removed \`threadStatus\` prop). \`@bb/integration-tests\` excluded per CLAUDE.md guidance (separate pipeline).

## Blockers / risks

**No blockers.** Branch is rebased linearly on top of \`f49ae132\` and all targeted validation passes.

**Risks documented:**
- The "click filename in timeline file-edit row → open diff panel" UX is **gone** as of this branch landing. It was implicitly deleted by \`595c4f21 Replace timeline rendering pipeline\` and not re-introduced here. If that interaction matters to product, it needs a separate PR that adds a click target to \`TimelineTitle\` in \`@bb/thread-view\` and threads a handler through the new \`ThreadTimelineRows\`. Flagged in \`plans/tab-split-layout.md\` as Phase 2b open work.

## Final state

\`\`\`
\$ git status --short --branch
## bb/investigate-file-list-inconsistency-thr_3vw9r8igrb

\$ git log --oneline main..HEAD
d61c0cf8 chore: drop dead onOpenFileDiff prop in ThreadDetailView after rebase
e0a3d934 test: switch FilePathLink tests to getByTitle after TruncateStart adoption
f9efa91a docs: align tab+split plan with shipped Phase 2a decisions
9c876bd2 fix: tighten DelegationRow placeholder gate and dedupe FileEditRow link
8bfd329b fix: address remaining FilePathLink review issues
0eae179c fix: review follow-ups for FilePathLink unification
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
