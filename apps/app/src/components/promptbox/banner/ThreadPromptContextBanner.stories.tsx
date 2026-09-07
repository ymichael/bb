import { useState, type ReactNode } from "react";
import type {
  ThreadPullRequest,
  WorkspaceFileStatus,
  WorkspaceStatus,
} from "@bb/domain";
import type { PullRequestMergeMethod } from "@bb/server-contract";
import {
  ThreadPromptContextBanner,
  type ContextBannerMergeBaseConfig,
  type ThreadPromptArchivedSection,
  type ThreadPromptContextBannerExpandedSection,
  type ThreadPromptEnvironmentGoneSection,
  type ThreadPromptParentThreadSection,
  type ThreadPromptChildThreadsSection,
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

type PromptStageSize = "desktop" | "mobile";

function PromptStage({
  children,
  size,
}: {
  children: ReactNode;
  size: PromptStageSize;
}) {
  return (
    <div
      data-promptbox-shell=""
      className={size === "desktop" ? "min-w-0 flex-1" : "w-[20rem] shrink-0"}
    >
      {children}
    </div>
  );
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
    lineStatsComplete: true,
  },
  branch: {
    currentBranch: "bb/promptbox-stories",
    defaultBranch: "main",
  },
  checkout: {
    kind: "branch",
    branchName: "bb/promptbox-stories",
    headSha: null,
  },
  mergeBase: null,
};

const dirtyUncommittedManyFiles: WorkspaceFileStatus[] = [
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
    path: "apps/app/src/components/promptbox/banner/ThreadPromptContextBanner.stories.tsx",
    status: "M",
    insertions: 21,
    deletions: 7,
  },
  {
    path: "apps/app/src/components/thread/WorkspaceChangesList.tsx",
    status: "M",
    insertions: 16,
    deletions: 4,
  },
  {
    path: "apps/app/src/components/workspace/workspace-change-summary.ts",
    status: "M",
    insertions: 8,
    deletions: 3,
  },
  {
    path: "apps/app/src/views/ThreadDetailPromptArea.tsx",
    status: "M",
    insertions: 12,
    deletions: 29,
  },
  {
    path: "apps/app/src/views/ThreadDetailSecondaryPanel.tsx",
    status: "M",
    insertions: 5,
    deletions: 5,
  },
  {
    path: "apps/app/src/hooks/useThreadPromptContext.ts",
    status: "M",
    insertions: 32,
    deletions: 14,
  },
  {
    path: "apps/app/src/lib/format-workspace-status.ts",
    status: "A",
    insertions: 24,
    deletions: 0,
  },
  {
    path: "apps/app/src/styles/promptbox.css",
    status: "M",
    insertions: 3,
    deletions: 1,
  },
  {
    path: "apps/app/.ladle/story-card.tsx",
    status: "M",
    insertions: 1,
    deletions: 1,
  },
  {
    path: "packages/domain/src/workspace.ts",
    status: "M",
    insertions: 10,
    deletions: 2,
  },
  {
    path: "packages/domain/src/thread.ts",
    status: "M",
    insertions: 6,
    deletions: 0,
  },
  {
    path: "apps/server/src/routes/threads.ts",
    status: "M",
    insertions: 18,
    deletions: 11,
  },
  {
    path: "apps/server/src/lifecycle/thread-prompt.ts",
    status: "M",
    insertions: 9,
    deletions: 4,
  },
  {
    path: "apps/host/src/workspace/status.ts",
    status: "M",
    insertions: 22,
    deletions: 8,
  },
  {
    path: "apps/app/src/components/promptbox/banner/__snapshots__/ThreadPromptContextBanner.test.tsx.snap",
    status: "D",
    insertions: 0,
    deletions: 187,
  },
];

const dirtyUncommittedManyStatus: WorkspaceStatus = {
  workingTree: {
    state: "dirty_uncommitted",
    hasUncommittedChanges: true,
    files: dirtyUncommittedManyFiles,
    insertions: 1284,
    deletions: 312,
    lineStatsComplete: true,
  },
  branch: {
    currentBranch: "bb/promptbox-stories",
    defaultBranch: "main",
  },
  checkout: {
    kind: "branch",
    branchName: "bb/promptbox-stories",
    headSha: null,
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
        path: "apps/app/scripts/dev-bb-worktree.sh",
        status: "??",
        insertions: null,
        deletions: null,
      },
    ],
    insertions: 0,
    deletions: 0,
    lineStatsComplete: false,
  },
  branch: {
    currentBranch: "bb/promptbox-stories",
    defaultBranch: "main",
  },
  checkout: {
    kind: "branch",
    branchName: "bb/promptbox-stories",
    headSha: null,
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
    lineStatsComplete: true,
  },
  branch: {
    currentBranch: "bb/promptbox-stories",
    defaultBranch: "main",
  },
  checkout: {
    kind: "branch",
    branchName: "bb/promptbox-stories",
    headSha: null,
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
    lineStatsComplete: true,
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
const committedManyFiles: WorkspaceFileStatus[] = Array.from(
  { length: 72 },
  (_, index) => ({
    path: `apps/app/src/committed-fixture-${index + 1}.tsx`,
    status: "M",
    insertions: 10,
    deletions: 2,
  }),
);
const committedManySection: WorkspaceChangedFilesSection = {
  ...committedSection,
  files: committedManyFiles,
  stats: {
    ...committedSection.stats,
    files: committedManyFiles,
    insertions: 720,
    deletions: 144,
  },
};

const featureBranchMergeBase: ContextBannerMergeBaseConfig = {
  branch: "main",
  options: ["main", "develop", "release/2026-05"] as const,
  onChange: noop,
};

const parentThreadFixture: ThreadPromptParentThreadSection = {
  parentThreadTitle: "Parent thread",
  href: "/projects/proj-1/threads/thr_parent_demo",
  relationship: "parent",
};

const forkedFromFixture: ThreadPromptParentThreadSection = {
  parentThreadTitle: "Investigate flaky test",
  href: "/projects/proj-1/threads/thr_source_demo",
  relationship: "fork",
};

const sideChatFromFixture: ThreadPromptParentThreadSection = {
  parentThreadTitle: "Investigate flaky test",
  href: "/projects/proj-1/threads/thr_source_demo",
  relationship: "side-chat",
};

const childThreadsFixture: ThreadPromptChildThreadsSection = {
  items: [
    {
      id: "thr_a",
      title: "Investigate Safari auth flake on staging",
      href: "/projects/proj-1/threads/thr_a",
      hasPendingInteraction: false,
    },
    {
      id: "thr_b",
      title: "Review PR #4521 reviewer comments",
      href: "/projects/proj-1/threads/thr_b",
      hasPendingInteraction: false,
    },
    {
      id: "thr_c",
      title: "Refactor email pipeline retry logic",
      href: "/projects/proj-1/threads/thr_c",
      hasPendingInteraction: false,
    },
    {
      id: "thr_d",
      title: "Backfill workspace-status invalidation cache",
      href: "/projects/proj-1/threads/thr_d",
      hasPendingInteraction: false,
    },
  ],
};

const childThreadsPendingFixture: ThreadPromptChildThreadsSection = {
  items: [
    {
      id: "thr_blocked",
      title: "Install workspace tools",
      href: "/projects/proj-1/threads/thr_blocked",
      hasPendingInteraction: true,
    },
  ],
};

const childThreadsMixedFixture: ThreadPromptChildThreadsSection = {
  items: childThreadsFixture.items.map((item, index) =>
    index === 1 ? { ...item, hasPendingInteraction: true } : item,
  ),
};

const childThreadsLargeFixture: ThreadPromptChildThreadsSection = {
  items: Array.from({ length: 12 }, (_, i) => ({
    id: `thr_large_${i}`,
    title: `Child work item ${i + 1} that is busy doing thing-${i}`,
    href: `/projects/proj-1/threads/thr_large_${i}`,
    hasPendingInteraction: i === 1,
  })),
};

function buildPullRequestFixture(
  overrides: Partial<ThreadPullRequest> = {},
): ThreadPullRequest {
  const base: ThreadPullRequest = {
    number: 128,
    title: "Show pull request status in the prompt context banner",
    state: "open",
    url: "https://github.com/acme/bb/pull/128",
    baseRefName: "main",
    headRefName: "bb/pr-context-banner",
    updatedAt: "2026-06-16T12:30:00Z",
    checks: {
      state: "failing",
      totalCount: 3,
      passedCount: 1,
      failedCount: 1,
      pendingCount: 1,
    },
    review: {
      state: "review_requested",
      reviewRequestCount: 1,
    },
    mergeability: {
      state: "mergeable",
      mergeStateStatus: "CLEAN",
      mergeable: "MERGEABLE",
    },
    attention: "checks_failed",
  };

  return {
    ...base,
    ...overrides,
    checks: overrides.checks
      ? { ...base.checks, ...overrides.checks }
      : base.checks,
    review: overrides.review
      ? { ...base.review, ...overrides.review }
      : base.review,
    mergeability: overrides.mergeability
      ? { ...base.mergeability, ...overrides.mergeability }
      : base.mergeability,
  };
}

const pullRequestFixture = buildPullRequestFixture();
const pendingPullRequestFixture = buildPullRequestFixture({
  checks: {
    state: "pending",
    totalCount: 3,
    passedCount: 1,
    failedCount: 0,
    pendingCount: 2,
  },
  attention: "checks_pending",
});
const mergedPullRequestFixture = buildPullRequestFixture({
  number: 134,
  state: "merged",
  checks: {
    state: "passing",
    totalCount: 3,
    passedCount: 3,
    failedCount: 0,
    pendingCount: 0,
  },
  attention: "merged",
});

const pullRequestStateRows: readonly {
  label: string;
  hint: string;
  pullRequest: ThreadPullRequest;
}[] = [
  {
    label: "open · checks passing",
    hint: "happy path",
    pullRequest: buildPullRequestFixture({
      number: 128,
      checks: {
        state: "passing",
        totalCount: 3,
        passedCount: 3,
        failedCount: 0,
        pendingCount: 0,
      },
      attention: "ready_to_merge",
    }),
  },
  {
    label: "open · checks pending",
    hint: "running checks",
    pullRequest: buildPullRequestFixture({
      number: 129,
      checks: {
        state: "pending",
        totalCount: 3,
        passedCount: 1,
        failedCount: 0,
        pendingCount: 2,
      },
      attention: "checks_pending",
    }),
  },
  {
    label: "open · checks failing",
    hint: "failing checks",
    pullRequest: buildPullRequestFixture({
      number: 130,
      checks: {
        state: "failing",
        totalCount: 3,
        passedCount: 1,
        failedCount: 1,
        pendingCount: 1,
      },
      attention: "checks_failed",
    }),
  },
  {
    label: "draft · checks pending",
    hint: "draft PR",
    pullRequest: buildPullRequestFixture({
      number: 131,
      state: "draft",
      checks: {
        state: "pending",
        totalCount: 2,
        passedCount: 0,
        failedCount: 0,
        pendingCount: 2,
      },
      mergeability: {
        state: "draft",
        mergeStateStatus: "DRAFT",
        mergeable: "UNKNOWN",
      },
      attention: "draft",
    }),
  },
  {
    label: "open · review requested",
    hint: "human attention",
    pullRequest: buildPullRequestFixture({
      number: 132,
      checks: {
        state: "passing",
        totalCount: 3,
        passedCount: 3,
        failedCount: 0,
        pendingCount: 0,
      },
      review: {
        state: "review_requested",
        reviewRequestCount: 2,
      },
      attention: "review_requested",
    }),
  },
  {
    label: "open · blocked",
    hint: "merge blocked",
    pullRequest: buildPullRequestFixture({
      number: 133,
      checks: {
        state: "unknown",
        totalCount: 0,
        passedCount: 0,
        failedCount: 0,
        pendingCount: 0,
      },
      mergeability: {
        state: "blocked",
        mergeStateStatus: "BLOCKED",
        mergeable: "UNKNOWN",
      },
      attention: "blocked",
    }),
  },
  {
    label: "merged",
    hint: "terminal state",
    pullRequest: mergedPullRequestFixture,
  },
  {
    label: "closed",
    hint: "terminal state",
    pullRequest: buildPullRequestFixture({
      number: 135,
      state: "closed",
      checks: {
        state: "unknown",
        totalCount: 0,
        passedCount: 0,
        failedCount: 0,
        pendingCount: 0,
      },
      attention: "closed",
    }),
  },
];

interface RowConfig {
  section?: WorkspaceChangedFilesSection;
  mergeBase?: ContextBannerMergeBaseConfig | null;
  archived?: ThreadPromptArchivedSection | null;
  environmentGone?: ThreadPromptEnvironmentGoneSection | null;
  parentThread?: ThreadPromptParentThreadSection | null;
  childThreads?: ThreadPromptChildThreadsSection | null;
  pullRequest?: ThreadPullRequest | null;
  pullRequestActions?: boolean;
  pullRequestMergeMethod?: PullRequestMergeMethod;
  initiallyExpandedSection?: ThreadPromptContextBannerExpandedSection | null;
}

function ContextBannerPreview({
  section,
  mergeBase = featureBranchMergeBase,
  archived = null,
  environmentGone = null,
  parentThread = null,
  childThreads = null,
  pullRequest = null,
  pullRequestActions = false,
  pullRequestMergeMethod = "merge",
  initiallyExpandedSection = null,
  size,
}: RowConfig & { size: PromptStageSize }) {
  const [expandedSection, setExpandedSection] =
    useState<ThreadPromptContextBannerExpandedSection | null>(
      initiallyExpandedSection,
    );
  return (
    <PromptStage size={size}>
      <ThreadPromptContextBanner
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
        environmentGoneSection={environmentGone}
        parentThreadSection={parentThread}
        childThreadsSection={childThreads}
        pullRequestSection={
          pullRequest
            ? {
                pullRequest,
                ...(pullRequestActions
                  ? {
                      actions: {
                        onMarkReady: noop,
                        onMerge: noop,
                        selectedMergeMethod: pullRequestMergeMethod,
                      },
                    }
                  : {}),
              }
            : null
        }
        expandedSection={expandedSection}
        onToggleSection={(next) =>
          setExpandedSection((previous) => (previous === next ? null : next))
        }
      />
    </PromptStage>
  );
}

function Row(props: RowConfig) {
  return (
    <div className="flex w-full min-w-0 items-start gap-3 overflow-x-auto">
      <ContextBannerPreview {...props} size="desktop" />
      <ContextBannerPreview {...props} size="mobile" />
    </div>
  );
}

const archivedFixture: ThreadPromptArchivedSection = {
  archivedAt: 1_731_456_000_000,
  onUnarchive: noop,
};

const destroyedEnvironmentFixture: ThreadPromptEnvironmentGoneSection = {
  status: "destroyed",
};

const destroyingEnvironmentFixture: ThreadPromptEnvironmentGoneSection = {
  status: "destroying",
};

export function Overview() {
  return (
    <StoryCard>
      <StoryRow
        label="git — merge-base picker"
        hint="git is the only segment, so the merge-base action is pinned to the far right on wide rows and hidden at the compact breakpoint."
      >
        <Row section={committedSection} />
      </StoryRow>
      <StoryRow
        label="archived thread"
        hint="archive icon + 'Thread is archived' with a filled unarchive action pinned to the far right"
      >
        <Row archived={archivedFixture} mergeBase={null} />
      </StoryRow>
      <StoryRow
        label="archived + child thread"
        hint="archived row plus parent context; action is hidden because archived is not the only segment"
      >
        <Row
          archived={archivedFixture}
          parentThread={parentThreadFixture}
          mergeBase={null}
        />
      </StoryRow>
      <StoryRow
        label="archived thread (with other context, all suppressed)"
        hint="archived takes precedence — git/child work are hidden, so the unarchive action remains available"
      >
        <Row
          archived={archivedFixture}
          section={uncommittedSection}
          childThreads={childThreadsFixture}
          mergeBase={null}
        />
      </StoryRow>
      <StoryRow
        label="environment archived"
        hint="archived-environment row suppresses git/childThreads"
      >
        <Row environmentGone={destroyedEnvironmentFixture} mergeBase={null} />
      </StoryRow>
      <StoryRow
        label="environment archiving + child thread"
        hint="archiving-environment row plus parent context"
      >
        <Row
          environmentGone={destroyingEnvironmentFixture}
          parentThread={parentThreadFixture}
          mergeBase={null}
        />
      </StoryRow>
      <StoryRow
        label="environment archived (with other context, all suppressed)"
        hint="archived environment takes precedence — git/child work are hidden"
      >
        <Row
          environmentGone={destroyedEnvironmentFixture}
          section={uncommittedSection}
          childThreads={childThreadsFixture}
          mergeBase={null}
        />
      </StoryRow>
      <StoryRow label="child thread (alone)" hint="inline parent link">
        <Row parentThread={parentThreadFixture} mergeBase={null} />
      </StoryRow>
      <StoryRow
        label="forked thread (alone)"
        hint={'renders "Forked from …" instead of "Parent …"'}
      >
        <Row parentThread={forkedFromFixture} mergeBase={null} />
      </StoryRow>
      <StoryRow
        label="side-chat thread (alone)"
        hint={'renders "Side chat of …"'}
      >
        <Row parentThread={sideChatFromFixture} mergeBase={null} />
      </StoryRow>
      <StoryRow
        label="parent thread with a child waiting for approval"
        hint="the parent banner names the blocked child and drops the active shimmer"
      >
        <Row childThreads={childThreadsPendingFixture} mergeBase={null} />
      </StoryRow>
      <StoryRow
        label="parent thread with active children (collapsed)"
        hint="the primary child mirrors other background-work banners without an animated flash; click to expand the child list"
      >
        <Row childThreads={childThreadsFixture} mergeBase={null} />
      </StoryRow>
      <StoryRow
        label="active child + pull request + uncommitted"
        hint="long child titles stay within the shared stack; pull request actions remain available"
      >
        <Row
          childThreads={childThreadsFixture}
          pullRequest={pullRequestFixture}
          pullRequestActions
          section={uncommittedSection}
        />
      </StoryRow>
      <StoryRow
        label="parent thread with active children (expanded)"
        hint="list of children with status + pending-approval marker on item 2"
      >
        <Row
          childThreads={childThreadsMixedFixture}
          mergeBase={null}
          initiallyExpandedSection="childThreads"
        />
      </StoryRow>
      <StoryRow
        label="parent thread with many children (scrollable)"
        hint="max-h-40 caps the list; rest scrolls"
      >
        <Row
          childThreads={childThreadsLargeFixture}
          mergeBase={null}
          initiallyExpandedSection="childThreads"
        />
      </StoryRow>
      <StoryRow
        label="child thread + uncommitted"
        hint="with other context, the parent-thread segment collapses to an icon-only toggle"
      >
        <Row section={uncommittedSection} parentThread={parentThreadFixture} />
      </StoryRow>
      <StoryRow
        label="metadata + pull request + git"
        hint="relationship metadata renders first, then GitHub PR, then git status"
      >
        <Row
          parentThread={forkedFromFixture}
          pullRequest={pullRequestFixture}
          section={uncommittedSection}
        />
      </StoryRow>
      {pullRequestStateRows.map(({ label, hint, pullRequest }) => (
        <StoryRow key={label} label={`pull request — ${label}`} hint={hint}>
          <Row pullRequest={pullRequest} mergeBase={null} pullRequestActions />
        </StoryRow>
      ))}
      <StoryRow
        label="pull request + uncommitted"
        hint="PR number and the shared uncommitted diff label stay visible"
      >
        <Row pullRequest={pullRequestFixture} section={uncommittedSection} />
      </StoryRow>
      <StoryRow
        label="pull request + committed"
        hint="committed branch changes use the same label with or without PR context"
      >
        <Row pullRequest={pullRequestFixture} section={committedSection} />
      </StoryRow>
      <StoryRow
        label="merged pull request + committed"
        hint="terminal pull requests reserve space for only their single status glyph"
      >
        <Row
          pullRequest={mergedPullRequestFixture}
          section={committedSection}
        />
      </StoryRow>
      <StoryRow
        label="pull request + many committed + actions"
        hint="the GitHub status pill stays intact beside a long committed summary and merge action"
      >
        <Row
          pullRequest={pendingPullRequestFixture}
          pullRequestActions
          pullRequestMergeMethod="squash"
          section={committedManySection}
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
        hint='workingTree.state = "untracked" with intentionally unavailable line stats'
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
