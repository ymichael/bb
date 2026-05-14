import { useState } from "react";
import type {
  ThreadTimelinePendingTodos,
  WorkspaceFileStatus,
  WorkspaceStatus,
} from "@bb/domain";
import {
  ThreadPromptContextBanner,
  type ContextBannerMergeBaseConfig,
  type ThreadPromptArchivedSection,
  type ThreadPromptContextBannerExpandedSection,
  type ThreadPromptManagedBySection,
  type ThreadPromptManagerChildrenSection,
} from "@/components/promptbox/banner/ThreadPromptContextBanner";
import {
  selectWorkspaceChangedFilesSection,
  type WorkspaceChangedFilesSection,
} from "@/components/workspace/workspace-change-summary";
import { StoryCard, StoryRow } from "../../../../.ladle/story-card";

export default {
  title: "promptbox/banner/Context Banner",
};

const noop = () => {};

// Production max width matches PageShell's footer cap (760px). Without it the
// banner stretches the full row width and the merge-base picker drifts far
// right of the summary, which doesn't reflect production layout.
function PromptStage({ children }: { children: React.ReactNode }) {
  return <div className="w-full max-w-[760px]">{children}</div>;
}

const promptboxBannerFiles: WorkspaceFileStatus[] = [
  {
    path: "apps/app/src/components/promptbox/FollowUpPromptBox.tsx",
    status: "M",
    insertions: 42,
    deletions: 18,
  },
  {
    path: "apps/app/src/components/promptbox/banner/PromptStackCard.tsx",
    status: "A",
    insertions: 96,
    deletions: 0,
  },
  {
    path: "apps/app/src/components/promptbox/banner/QueuedMessagesList.tsx",
    status: "A",
    insertions: 74,
    deletions: 0,
  },
  {
    path: "apps/app/src/components/promptbox/banner/ThreadPromptContextBanner.tsx",
    status: "A",
    insertions: 88,
    deletions: 0,
  },
  {
    path: "apps/app/src/views/ThreadDetailPromptArea.tsx",
    status: "M",
    insertions: 12,
    deletions: 29,
  },
];

const dirtyUncommittedStatus: WorkspaceStatus = {
  workingTree: {
    state: "dirty_uncommitted",
    hasUncommittedChanges: true,
    files: promptboxBannerFiles,
    insertions: 312,
    deletions: 47,
  },
  branch: {
    currentBranch: "bb/promptbox-stories",
    defaultBranch: "main",
  },
  mergeBase: null,
};

const dirtyUncommittedManyFiles: WorkspaceFileStatus[] = [
  { path: "apps/app/src/components/promptbox/FollowUpPromptBox.tsx", status: "M", insertions: 42, deletions: 18 },
  { path: "apps/app/src/components/promptbox/banner/PromptStackCard.tsx", status: "A", insertions: 96, deletions: 0 },
  { path: "apps/app/src/components/promptbox/banner/QueuedMessagesList.tsx", status: "A", insertions: 74, deletions: 0 },
  { path: "apps/app/src/components/promptbox/banner/ThreadPromptContextBanner.tsx", status: "A", insertions: 88, deletions: 0 },
  { path: "apps/app/src/components/promptbox/banner/ThreadPromptContextBanner.stories.tsx", status: "M", insertions: 21, deletions: 7 },
  { path: "apps/app/src/components/thread/WorkspaceChangesList.tsx", status: "M", insertions: 16, deletions: 4 },
  { path: "apps/app/src/components/workspace/workspace-change-summary.ts", status: "M", insertions: 8, deletions: 3 },
  { path: "apps/app/src/views/ThreadDetailPromptArea.tsx", status: "M", insertions: 12, deletions: 29 },
  { path: "apps/app/src/views/ThreadDetailSecondaryPanel.tsx", status: "M", insertions: 5, deletions: 5 },
  { path: "apps/app/src/hooks/useThreadPromptContext.ts", status: "M", insertions: 32, deletions: 14 },
  { path: "apps/app/src/lib/format-workspace-status.ts", status: "A", insertions: 24, deletions: 0 },
  { path: "apps/app/src/styles/promptbox.css", status: "M", insertions: 3, deletions: 1 },
  { path: "apps/app/.ladle/story-card.tsx", status: "M", insertions: 1, deletions: 1 },
  { path: "packages/domain/src/workspace.ts", status: "M", insertions: 10, deletions: 2 },
  { path: "packages/domain/src/thread.ts", status: "M", insertions: 6, deletions: 0 },
  { path: "apps/server/src/routes/threads.ts", status: "M", insertions: 18, deletions: 11 },
  { path: "apps/server/src/lifecycle/thread-prompt.ts", status: "M", insertions: 9, deletions: 4 },
  { path: "apps/host/src/workspace/status.ts", status: "M", insertions: 22, deletions: 8 },
  { path: "apps/app/src/components/promptbox/banner/__snapshots__/ThreadPromptContextBanner.test.tsx.snap", status: "D", insertions: 0, deletions: 187 },
];

const dirtyUncommittedManyStatus: WorkspaceStatus = {
  workingTree: {
    state: "dirty_uncommitted",
    hasUncommittedChanges: true,
    files: dirtyUncommittedManyFiles,
    insertions: 1284,
    deletions: 312,
  },
  branch: {
    currentBranch: "bb/promptbox-stories",
    defaultBranch: "main",
  },
  mergeBase: null,
};

const untrackedOnlyStatus: WorkspaceStatus = {
  workingTree: {
    state: "untracked",
    hasUncommittedChanges: false,
    files: [
      {
        path: "apps/app/notes/triage.md",
        status: "??",
        insertions: null,
        deletions: null,
      },
      {
        path: "apps/app/scripts/dev-bb-sandbox.sh",
        status: "??",
        insertions: null,
        deletions: null,
      },
    ],
    insertions: 0,
    deletions: 0,
  },
  branch: {
    currentBranch: "bb/promptbox-stories",
    defaultBranch: "main",
  },
  mergeBase: null,
};

const committedUnmergedStatus: WorkspaceStatus = {
  workingTree: {
    state: "clean",
    hasUncommittedChanges: false,
    files: [],
    insertions: 0,
    deletions: 0,
  },
  branch: {
    currentBranch: "bb/promptbox-stories",
    defaultBranch: "main",
  },
  mergeBase: {
    mergeBaseBranch: "main",
    baseRef: "abc123",
    aheadCount: 4,
    behindCount: 0,
    hasCommittedUnmergedChanges: true,
    commits: [],
    files: promptboxBannerFiles.slice(0, 3),
    insertions: 128,
    deletions: 24,
  },
};

function sectionFor(status: WorkspaceStatus): WorkspaceChangedFilesSection {
  const section = selectWorkspaceChangedFilesSection(status);
  if (!section) throw new Error("fixture should produce a section");
  return section;
}

const uncommittedSection = sectionFor(dirtyUncommittedStatus);
const uncommittedManySection = sectionFor(dirtyUncommittedManyStatus);
const untrackedSection = sectionFor(untrackedOnlyStatus);
const committedSection = sectionFor(committedUnmergedStatus);

const featureBranchMergeBase: ContextBannerMergeBaseConfig = {
  branch: "main",
  options: ["main", "develop", "release/2026-05"] as const,
  onChange: noop,
};

const pendingTodosFixture: ThreadTimelinePendingTodos = {
  sourceSeq: 0,
  updatedAt: 0,
  items: [
    {
      id: "todo:1",
      text: "Read the planning doc",
      status: "completed",
    },
    {
      id: "todo:2",
      text: "Build initial banner shell",
      status: "completed",
    },
    {
      id: "todo:3",
      text: "Wire pendingTodos from the timeline projection",
      status: "in_progress",
    },
    {
      id: "todo:4",
      text: "Surface pendingTodos in `bb thread show` and `bb status`",
      status: "pending",
    },
    {
      id: "todo:5",
      text: "Tighten GET /threads/:id with requirePublicProject",
      status: "pending",
    },
  ],
};

const managedByFixture: ThreadPromptManagedBySection = {
  managerName: "Manager",
  href: "/projects/proj-1/threads/thr_mgr_demo",
};

const managerChildrenFixture: ThreadPromptManagerChildrenSection = {
  items: [
    {
      id: "thr_a",
      title: "Investigate Safari auth flake on staging",
      href: "/projects/proj-1/threads/thr_a",
    },
    {
      id: "thr_b",
      title: "Review PR #4521 reviewer comments",
      href: "/projects/proj-1/threads/thr_b",
    },
    {
      id: "thr_c",
      title: "Refactor email pipeline retry logic",
      href: "/projects/proj-1/threads/thr_c",
    },
    {
      id: "thr_d",
      title: "Backfill workspace-status invalidation cache",
      href: "/projects/proj-1/threads/thr_d",
    },
  ],
};

const managerChildrenLargeFixture: ThreadPromptManagerChildrenSection = {
  items: Array.from({ length: 12 }, (_, i) => ({
    id: `thr_large_${i}`,
    title: `Managed work item ${i + 1} that is busy doing thing-${i}`,
    href: `/projects/proj-1/threads/thr_large_${i}`,
  })),
};

interface RowConfig {
  section?: WorkspaceChangedFilesSection;
  mergeBase?: ContextBannerMergeBaseConfig | null;
  pendingTodos?: ThreadTimelinePendingTodos | null;
  archived?: ThreadPromptArchivedSection | null;
  managedBy?: ThreadPromptManagedBySection | null;
  managerChildren?: ThreadPromptManagerChildrenSection | null;
  initiallyExpandedSection?: ThreadPromptContextBannerExpandedSection | null;
}

function Row({
  section,
  mergeBase = featureBranchMergeBase,
  pendingTodos = null,
  archived = null,
  managedBy = null,
  managerChildren = null,
  initiallyExpandedSection = null,
}: RowConfig) {
  const [expandedSection, setExpandedSection] = useState<
    ThreadPromptContextBannerExpandedSection | null
  >(initiallyExpandedSection);
  return (
    <PromptStage>
      <ThreadPromptContextBanner
        todoSection={pendingTodos ? { pendingTodos } : null}
        gitSection={
          section
            ? {
                changedFiles: section,
                mergeBase,
                onPromptBannerFileClick: noop,
              }
            : null
        }
        gitSectionPending={false}
        archivedSection={archived}
        managedBySection={managedBy}
        managerChildrenSection={managerChildren}
        expandedSection={expandedSection}
        onToggleSection={(next) =>
          setExpandedSection((previous) =>
            previous === next ? null : next,
          )
        }
      />
    </PromptStage>
  );
}

const archivedFixture: ThreadPromptArchivedSection = {
  archivedAt: 1_731_456_000_000,
};

export function Overview() {
  return (
    <StoryCard>
      <StoryRow
        label="archived thread"
        hint="archive icon + 'Thread is archived'; suppresses todos/git/managerChildren"
      >
        <Row archived={archivedFixture} mergeBase={null} />
      </StoryRow>
      <StoryRow
        label="archived + managed thread"
        hint="archived row plus 'Managed by <name>' — manager context still relevant on a frozen thread"
      >
        <Row
          archived={archivedFixture}
          managedBy={managedByFixture}
          mergeBase={null}
        />
      </StoryRow>
      <StoryRow
        label="archived thread (with other context, all suppressed)"
        hint="archived takes precedence — todos/git/managerChildren are hidden"
      >
        <Row
          archived={archivedFixture}
          section={uncommittedSection}
          pendingTodos={pendingTodosFixture}
          managerChildren={managerChildrenFixture}
          mergeBase={null}
        />
      </StoryRow>
      <StoryRow
        label="managed thread (alone)"
        hint="inline 'Managed by <name>' with the manager name as a link"
      >
        <Row managedBy={managedByFixture} mergeBase={null} />
      </StoryRow>
      <StoryRow
        label="manager thread with active children (collapsed)"
        hint="spinning icon signals active work; click to expand the child list"
      >
        <Row managerChildren={managerChildrenFixture} mergeBase={null} />
      </StoryRow>
      <StoryRow
        label="manager thread with active children (expanded)"
        hint="list of children with status + pending-approval marker on item 2"
      >
        <Row
          managerChildren={managerChildrenFixture}
          mergeBase={null}
          initiallyExpandedSection="managerChildren"
        />
      </StoryRow>
      <StoryRow
        label="manager thread with many children (scrollable)"
        hint="max-h-40 caps the list; rest scrolls"
      >
        <Row
          managerChildren={managerChildrenLargeFixture}
          mergeBase={null}
          initiallyExpandedSection="managerChildren"
        />
      </StoryRow>
      <StoryRow
        label="managed thread + todos + uncommitted"
        hint="with other context, the managed-by segment collapses to an icon-only toggle"
      >
        <Row
          section={uncommittedSection}
          pendingTodos={pendingTodosFixture}
          managedBy={managedByFixture}
        />
      </StoryRow>
      <StoryRow
        label="todos + uncommitted"
        hint="both sections share one row; click either summary to expand its body"
      >
        <Row section={uncommittedSection} pendingTodos={pendingTodosFixture} />
      </StoryRow>
      <StoryRow
        label="todos only (all 3 states, expanded)"
        hint="completed / in-progress / pending shown checked, dotted, and outline"
      >
        <Row
          pendingTodos={pendingTodosFixture}
          mergeBase={null}
          initiallyExpandedSection="todos"
        />
      </StoryRow>
      <StoryRow
        label="todos + uncommitted (todos expanded)"
        hint="only one section can be expanded at a time"
      >
        <Row
          section={uncommittedSection}
          pendingTodos={pendingTodosFixture}
          initiallyExpandedSection="todos"
        />
      </StoryRow>
      <StoryRow
        label="todos + uncommitted (git expanded)"
        hint="clicking the git summary closes todos and opens the file list"
      >
        <Row
          section={uncommittedSection}
          pendingTodos={pendingTodosFixture}
          initiallyExpandedSection="git"
        />
      </StoryRow>
      <StoryRow
        label="uncommitted (collapsed)"
        hint="working tree has 5 modified/added files; chevron toggles WorkspaceChangesList"
      >
        <Row section={uncommittedSection} />
      </StoryRow>
      <StoryRow
        label="uncommitted (expanded)"
        hint="expanded change list visible inside the same card; long lists scroll within max-h-32"
      >
        <Row section={uncommittedManySection} initiallyExpandedSection="git" />
      </StoryRow>
      <StoryRow
        label="untracked only"
        hint='workingTree.state = "untracked" — no insertions/deletions tally'
      >
        <Row section={untrackedSection} initiallyExpandedSection="git" />
      </StoryRow>
      <StoryRow
        label="committed unmerged"
        hint="working tree clean; mergeBase has committed files"
      >
        <Row section={committedSection} />
      </StoryRow>
      <StoryRow
        label="on default branch"
        hint="mergeBase=null hides the picker (no comparison to make)"
      >
        <Row section={uncommittedSection} mergeBase={null} />
      </StoryRow>
    </StoryCard>
  );
}
