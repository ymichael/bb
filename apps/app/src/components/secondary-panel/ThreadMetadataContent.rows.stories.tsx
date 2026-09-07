import type { ReactNode } from "react";
import type { EnvironmentDisplayHostContext } from "@bb/core-ui";
import {
  ParentSelectorRow,
  EnvironmentRow,
  WorkspacePathRow,
  BranchRow,
  MergeBaseRow,
  PullRequestRow,
  GitStatusRow,
  ArchivedRow,
  ThreadCommitsRow,
  ChangedFilesRow,
  ThreadMetadataCard,
} from "./ThreadMetadataContent";
import {
  PanelStage,
  baseProps,
  localEnvironmentDisplayHost,
  parentThreads,
  makeEnvironment,
  makePullRequest,
  makeThread,
  makeWorkspaceStatus,
} from "./ThreadMetadataContent.fixtures";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";

export default {
  title: "right-panel/Info/Row",
};

const noop = () => {};

const remoteEnvironmentDisplayHost: EnvironmentDisplayHostContext = {
  locality: "remote",
  identity: null,
};

function RowStage({ children }: { children: ReactNode }) {
  return (
    <PanelStage>
      <ThreadMetadataCard>{children}</ThreadMetadataCard>
    </PanelStage>
  );
}

export function ParentSelector() {
  return (
    <StoryCard>
      <StoryRow label="unassigned">
        <RowStage>
          <ParentSelectorRow
            thread={makeThread()}
            projectId={baseProps.projectId}
            parentThreadProjectId={null}
            parentThreadDisplayName={null}
            parentThreads={parentThreads}
            canAssignToParent
            canTakeOverThread={false}
            isLoadingParentThreads={false}
            isParentThreadsError={false}
            updateThreadPending={false}
            onAssignParent={noop}
            onParentSelectorOpenChange={noop}
            onRetryParentThreads={noop}
          />
        </RowStage>
      </StoryRow>
      <StoryRow label="unassigned, no candidates">
        <RowStage>
          <ParentSelectorRow
            thread={makeThread()}
            projectId={baseProps.projectId}
            parentThreadProjectId={null}
            parentThreadDisplayName={null}
            parentThreads={[]}
            canAssignToParent={false}
            canTakeOverThread={false}
            isLoadingParentThreads={false}
            isParentThreadsError={false}
            updateThreadPending={false}
            onAssignParent={noop}
            onParentSelectorOpenChange={noop}
            onRetryParentThreads={noop}
          />
        </RowStage>
      </StoryRow>
      <StoryRow label="assigned">
        <RowStage>
          <ParentSelectorRow
            thread={makeThread({ parentThreadId: "thr_codex_parent" })}
            projectId={baseProps.projectId}
            parentThreadProjectId={null}
            parentThreadDisplayName="Codex Parent"
            parentThreads={parentThreads}
            canAssignToParent={false}
            canTakeOverThread
            isLoadingParentThreads={false}
            isParentThreadsError={false}
            updateThreadPending={false}
            onAssignParent={noop}
            onParentSelectorOpenChange={noop}
            onRetryParentThreads={noop}
          />
        </RowStage>
      </StoryRow>
      <StoryRow label="dropdown open">
        <RowStage>
          <ParentSelectorRow
            thread={makeThread()}
            projectId={baseProps.projectId}
            parentThreadProjectId={null}
            parentThreadDisplayName={null}
            parentThreads={parentThreads}
            canAssignToParent
            canTakeOverThread={false}
            isLoadingParentThreads={false}
            isParentThreadsError={false}
            updateThreadPending={false}
            onAssignParent={noop}
            onParentSelectorOpenChange={noop}
            onRetryParentThreads={noop}
            defaultOpen
          />
        </RowStage>
      </StoryRow>
    </StoryCard>
  );
}

export function Environment() {
  return (
    <StoryCard>
      <StoryRow label="worktree">
        <RowStage>
          <EnvironmentRow
            thread={makeThread()}
            environment={makeEnvironment()}
            environmentDisplayHost={localEnvironmentDisplayHost}
          />
        </RowStage>
      </StoryRow>
      <StoryRow label="direct">
        <RowStage>
          <EnvironmentRow
            thread={makeThread()}
            environment={makeEnvironment({
              isWorktree: false,
              workspaceProvisionType: "unmanaged",
            })}
            environmentDisplayHost={localEnvironmentDisplayHost}
          />
        </RowStage>
      </StoryRow>
      <StoryRow label="remote direct">
        <RowStage>
          <EnvironmentRow
            thread={makeThread()}
            environment={makeEnvironment({
              isWorktree: false,
              workspaceProvisionType: "unmanaged",
            })}
            environmentDisplayHost={remoteEnvironmentDisplayHost}
          />
        </RowStage>
      </StoryRow>
      <StoryRow label="provisioning">
        <RowStage>
          <EnvironmentRow
            thread={makeThread()}
            environment={makeEnvironment({
              status: "provisioning",
              isWorktree: false,
              workspaceProvisionType: "managed-worktree",
            })}
            environmentDisplayHost={localEnvironmentDisplayHost}
          />
        </RowStage>
      </StoryRow>
    </StoryCard>
  );
}

export function WorkspacePath() {
  return (
    <StoryCard>
      <StoryRow label="managed worktree">
        <RowStage>
          <WorkspacePathRow
            environment={makeEnvironment({
              path: "/Users/michael/.bb-dev/worktrees/env_demo/bb",
            })}
          />
        </RowStage>
      </StoryRow>
      <StoryRow label="long path">
        <RowStage>
          <WorkspacePathRow
            environment={makeEnvironment({
              path: "/Users/michael/.bb-dev/worktrees/env_7m3cieyz6q/bb/apps/app/src/components/right-panel",
            })}
          />
        </RowStage>
      </StoryRow>
      <StoryRow label="unmanaged worktree">
        <RowStage>
          <WorkspacePathRow
            environment={makeEnvironment({
              path: "/srv/repos/bb-linked-worktree",
              managed: false,
              workspaceProvisionType: "unmanaged",
            })}
          />
        </RowStage>
      </StoryRow>
      <StoryRow label="projectless workspace">
        <RowStage>
          <WorkspacePathRow
            environment={makeEnvironment({
              path: "/Users/michael/Projects/bb",
              isWorktree: false,
              workspaceProvisionType: "personal",
            })}
          />
        </RowStage>
      </StoryRow>
    </StoryCard>
  );
}

export function Branch() {
  return (
    <StoryCard>
      <StoryRow label="feature branch">
        <RowStage>
          <BranchRow workspaceStatus={makeWorkspaceStatus()} />
        </RowStage>
      </StoryRow>
      <StoryRow label="long branch">
        <RowStage>
          <BranchRow
            workspaceStatus={makeWorkspaceStatus({
              checkout: {
                kind: "branch",
                branchName:
                  "feat/sidebar-rail/extract-row-components-and-add-info-row-stories",
                headSha: null,
              },
              branch: {
                currentBranch:
                  "feat/sidebar-rail/extract-row-components-and-add-info-row-stories",
                defaultBranch: "main",
              },
            })}
          />
        </RowStage>
      </StoryRow>
      <StoryRow label="detached checkout">
        <RowStage>
          <BranchRow
            workspaceStatus={makeWorkspaceStatus({
              checkout: {
                kind: "detached",
                headSha: "abcdef1234567890",
              },
              branch: {
                currentBranch: null,
                defaultBranch: "main",
              },
            })}
          />
        </RowStage>
      </StoryRow>
    </StoryCard>
  );
}

export function MergeBase() {
  return (
    <StoryCard>
      <StoryRow label="feature branch">
        <RowStage>
          <MergeBaseRow
            workspaceStatus={makeWorkspaceStatus()}
            selectedMergeBaseBranch={undefined}
            mergeBaseBranchOptions={["main", "develop", "release/2026-04"]}
            isLoadingMergeBaseBranchOptions={false}
            onMergeBaseBranchChange={noop}
          />
        </RowStage>
      </StoryRow>
      <StoryRow label="loading candidates">
        <RowStage>
          <MergeBaseRow
            workspaceStatus={makeWorkspaceStatus()}
            selectedMergeBaseBranch={undefined}
            mergeBaseBranchOptions={undefined}
            isLoadingMergeBaseBranchOptions
            onMergeBaseBranchChange={noop}
          />
        </RowStage>
      </StoryRow>
      <StoryRow label="picker open">
        <RowStage>
          <MergeBaseRow
            workspaceStatus={makeWorkspaceStatus()}
            selectedMergeBaseBranch={undefined}
            mergeBaseBranchOptions={["main", "develop", "release/2026-04"]}
            isLoadingMergeBaseBranchOptions={false}
            onMergeBaseBranchChange={noop}
            defaultOpen
          />
        </RowStage>
      </StoryRow>
    </StoryCard>
  );
}

export function PullRequest() {
  const readyPullRequest = makePullRequest();
  const passingPullRequest = makePullRequest({
    mergeability: {
      state: "unknown",
      mergeStateStatus: "UNKNOWN",
      mergeable: "UNKNOWN",
    },
    attention: "none",
  });
  const noChecksPullRequest = makePullRequest({
    checks: {
      state: "no_checks",
      totalCount: 0,
      passedCount: 0,
      failedCount: 0,
      pendingCount: 0,
    },
    review: {
      state: "none",
      reviewRequestCount: 0,
    },
    attention: "none",
  });
  const unknownChecksPullRequest = makePullRequest({
    checks: {
      state: "unknown",
      totalCount: 1,
      passedCount: 0,
      failedCount: 0,
      pendingCount: 0,
    },
    review: {
      state: "none",
      reviewRequestCount: 0,
    },
    mergeability: {
      state: "unknown",
      mergeStateStatus: "UNKNOWN",
      mergeable: "UNKNOWN",
    },
    attention: "none",
  });
  const failingPullRequest = makePullRequest({
    checks: {
      state: "failing",
      totalCount: 3,
      passedCount: 2,
      failedCount: 1,
      pendingCount: 0,
    },
    attention: "checks_failed",
  });
  const pendingPullRequest = makePullRequest({
    checks: {
      state: "pending",
      totalCount: 3,
      passedCount: 2,
      failedCount: 0,
      pendingCount: 1,
    },
    attention: "checks_pending",
  });
  const changesRequestedPullRequest = makePullRequest({
    review: {
      state: "changes_requested",
      reviewRequestCount: 0,
    },
    attention: "changes_requested",
  });
  const reviewRequestedPullRequest = makePullRequest({
    review: {
      state: "review_requested",
      reviewRequestCount: 2,
    },
    attention: "review_requested",
  });
  const conflictsPullRequest = makePullRequest({
    mergeability: {
      state: "conflicts",
      mergeStateStatus: "DIRTY",
      mergeable: "CONFLICTING",
    },
    attention: "conflicts",
  });
  const blockedPullRequest = makePullRequest({
    mergeability: {
      state: "blocked",
      mergeStateStatus: "BLOCKED",
      mergeable: "UNKNOWN",
    },
    attention: "blocked",
  });
  const draftMergeability = {
    state: "draft",
    mergeStateStatus: "DRAFT",
    mergeable: "UNKNOWN",
  } as const;
  const draftPassingPullRequest = makePullRequest({
    state: "draft",
    mergeability: draftMergeability,
    attention: "draft",
  });
  const draftFailingPullRequest = makePullRequest({
    state: "draft",
    checks: {
      state: "failing",
      totalCount: 3,
      passedCount: 2,
      failedCount: 1,
      pendingCount: 0,
    },
    mergeability: draftMergeability,
    attention: "checks_failed",
  });
  const draftNoChecksPullRequest = makePullRequest({
    state: "draft",
    checks: {
      state: "no_checks",
      totalCount: 0,
      passedCount: 0,
      failedCount: 0,
      pendingCount: 0,
    },
    mergeability: draftMergeability,
    attention: "draft",
  });
  const draftUnknownChecksPullRequest = makePullRequest({
    state: "draft",
    checks: {
      state: "unknown",
      totalCount: 1,
      passedCount: 0,
      failedCount: 0,
      pendingCount: 0,
    },
    mergeability: draftMergeability,
    attention: "draft",
  });
  const draftPullRequest = makePullRequest({
    state: "draft",
    checks: {
      state: "pending",
      totalCount: 3,
      passedCount: 2,
      failedCount: 0,
      pendingCount: 1,
    },
    mergeability: draftMergeability,
    attention: "draft",
  });
  const draftChangesRequestedPullRequest = makePullRequest({
    state: "draft",
    review: {
      state: "changes_requested",
      reviewRequestCount: 0,
    },
    mergeability: draftMergeability,
    attention: "changes_requested",
  });
  const mergedPullRequest = makePullRequest({
    state: "merged",
    attention: "merged",
  });
  const closedPullRequest = makePullRequest({
    state: "closed",
    attention: "closed",
  });
  return (
    <StoryCard>
      <StoryRow label="open, ready to merge">
        <RowStage>
          <PullRequestRow pullRequest={readyPullRequest} />
        </RowStage>
      </StoryRow>
      <StoryRow label="open, checks passing">
        <RowStage>
          <PullRequestRow pullRequest={passingPullRequest} />
        </RowStage>
      </StoryRow>
      <StoryRow label="open, no checks">
        <RowStage>
          <PullRequestRow pullRequest={noChecksPullRequest} />
        </RowStage>
      </StoryRow>
      <StoryRow label="open, checks unknown">
        <RowStage>
          <PullRequestRow pullRequest={unknownChecksPullRequest} />
        </RowStage>
      </StoryRow>
      <StoryRow label="open, checks failing">
        <RowStage>
          <PullRequestRow pullRequest={failingPullRequest} />
        </RowStage>
      </StoryRow>
      <StoryRow label="open, checks pending">
        <RowStage>
          <PullRequestRow pullRequest={pendingPullRequest} />
        </RowStage>
      </StoryRow>
      <StoryRow label="open, changes requested">
        <RowStage>
          <PullRequestRow pullRequest={changesRequestedPullRequest} />
        </RowStage>
      </StoryRow>
      <StoryRow label="open, review requested">
        <RowStage>
          <PullRequestRow pullRequest={reviewRequestedPullRequest} />
        </RowStage>
      </StoryRow>
      <StoryRow label="open, conflicts">
        <RowStage>
          <PullRequestRow pullRequest={conflictsPullRequest} />
        </RowStage>
      </StoryRow>
      <StoryRow label="open, blocked">
        <RowStage>
          <PullRequestRow pullRequest={blockedPullRequest} />
        </RowStage>
      </StoryRow>
      <StoryRow label="draft, checks passing">
        <RowStage>
          <PullRequestRow pullRequest={draftPassingPullRequest} />
        </RowStage>
      </StoryRow>
      <StoryRow label="draft, checks failing">
        <RowStage>
          <PullRequestRow pullRequest={draftFailingPullRequest} />
        </RowStage>
      </StoryRow>
      <StoryRow label="draft, no checks">
        <RowStage>
          <PullRequestRow pullRequest={draftNoChecksPullRequest} />
        </RowStage>
      </StoryRow>
      <StoryRow label="draft, checks unknown">
        <RowStage>
          <PullRequestRow pullRequest={draftUnknownChecksPullRequest} />
        </RowStage>
      </StoryRow>
      <StoryRow label="draft, checks pending">
        <RowStage>
          <PullRequestRow pullRequest={draftPullRequest} />
        </RowStage>
      </StoryRow>
      <StoryRow label="draft, changes requested">
        <RowStage>
          <PullRequestRow pullRequest={draftChangesRequestedPullRequest} />
        </RowStage>
      </StoryRow>
      <StoryRow label="merged">
        <RowStage>
          <PullRequestRow pullRequest={mergedPullRequest} />
        </RowStage>
      </StoryRow>
      <StoryRow label="closed">
        <RowStage>
          <PullRequestRow pullRequest={closedPullRequest} />
        </RowStage>
      </StoryRow>
    </StoryCard>
  );
}

export function GitStatus() {
  return (
    <StoryCard>
      <StoryRow label="clean">
        <RowStage>
          <GitStatusRow
            thread={makeThread()}
            environment={makeEnvironment()}
            workspaceStatus={makeWorkspaceStatus()}
            workspaceStatusError={null}
            selectedMergeBaseBranch={undefined}
          />
        </RowStage>
      </StoryRow>
      <StoryRow label="dirty (uncommitted)">
        <RowStage>
          <GitStatusRow
            thread={makeThread()}
            environment={makeEnvironment()}
            workspaceStatus={makeWorkspaceStatus({
              workingTree: {
                hasUncommittedChanges: true,
                state: "dirty_uncommitted",
                insertions: 47,
                deletions: 21,
                lineStatsComplete: true,
                files: [
                  {
                    path: "apps/app/src/components/sidebar/ProjectRow.tsx",
                    status: "M",
                    insertions: 18,
                    deletions: 9,
                  },
                  {
                    path: "apps/app/src/components/sidebar/ThreadRow.tsx",
                    status: "M",
                    insertions: 5,
                    deletions: 12,
                  },
                  {
                    path: "apps/app/src/components/sidebar/ProjectRow.stories.tsx",
                    status: "A",
                    insertions: 24,
                    deletions: 0,
                  },
                ],
              },
            })}
            workspaceStatusError={null}
            selectedMergeBaseBranch={undefined}
          />
        </RowStage>
      </StoryRow>
      <StoryRow label="ahead">
        <RowStage>
          <GitStatusRow
            thread={makeThread()}
            environment={makeEnvironment()}
            workspaceStatus={makeWorkspaceStatus({
              mergeBase: {
                mergeBaseBranch: "main",
                baseRef: "main",
                aheadCount: 5,
                behindCount: 0,
                hasCommittedUnmergedChanges: true,
                commits: [],
                insertions: 0,
                deletions: 0,
                lineStatsComplete: true,
                files: [],
              },
            })}
            workspaceStatusError={null}
            selectedMergeBaseBranch={undefined}
          />
        </RowStage>
      </StoryRow>
      <StoryRow label="behind">
        <RowStage>
          <GitStatusRow
            thread={makeThread()}
            environment={makeEnvironment()}
            workspaceStatus={makeWorkspaceStatus({
              mergeBase: {
                mergeBaseBranch: "main",
                baseRef: "main",
                aheadCount: 0,
                behindCount: 3,
                hasCommittedUnmergedChanges: false,
                commits: [],
                insertions: 0,
                deletions: 0,
                lineStatsComplete: true,
                files: [],
              },
            })}
            workspaceStatusError={null}
            selectedMergeBaseBranch={undefined}
          />
        </RowStage>
      </StoryRow>
      <StoryRow label="diverged">
        <RowStage>
          <GitStatusRow
            thread={makeThread()}
            environment={makeEnvironment()}
            workspaceStatus={makeWorkspaceStatus({
              mergeBase: {
                mergeBaseBranch: "main",
                baseRef: "main",
                aheadCount: 4,
                behindCount: 2,
                hasCommittedUnmergedChanges: true,
                commits: [],
                insertions: 0,
                deletions: 0,
                lineStatsComplete: true,
                files: [],
              },
            })}
            workspaceStatusError={null}
            selectedMergeBaseBranch={undefined}
          />
        </RowStage>
      </StoryRow>
      <StoryRow label="untracked">
        <RowStage>
          <GitStatusRow
            thread={makeThread()}
            environment={makeEnvironment()}
            workspaceStatus={makeWorkspaceStatus({
              workingTree: {
                hasUncommittedChanges: false,
                state: "untracked",
                insertions: 0,
                deletions: 0,
                lineStatsComplete: false,
                files: [
                  {
                    path: "scratch.md",
                    status: "??",
                    insertions: null,
                    deletions: null,
                  },
                  {
                    path: "notes/scratch.md",
                    status: "??",
                    insertions: null,
                    deletions: null,
                  },
                  {
                    path: "tmp/output.json",
                    status: "??",
                    insertions: null,
                    deletions: null,
                  },
                ],
              },
            })}
            workspaceStatusError={null}
            selectedMergeBaseBranch={undefined}
          />
        </RowStage>
      </StoryRow>
      <StoryRow label="workspace not found">
        <RowStage>
          <GitStatusRow
            thread={makeThread()}
            environment={makeEnvironment({ status: "destroyed" })}
            workspaceStatus={undefined}
            workspaceStatusError={null}
            selectedMergeBaseBranch={undefined}
          />
        </RowStage>
      </StoryRow>
      <StoryRow label="error">
        <RowStage>
          <GitStatusRow
            thread={makeThread()}
            environment={makeEnvironment()}
            workspaceStatus={undefined}
            workspaceStatusError={new Error("git status failed: ENOENT")}
            selectedMergeBaseBranch={undefined}
          />
        </RowStage>
      </StoryRow>
    </StoryCard>
  );
}

export function Archived() {
  return (
    <StoryCard>
      <StoryRow label="archived">
        <RowStage>
          <ArchivedRow thread={makeThread({ archivedAt: 1_700_000_000_000 })} />
        </RowStage>
      </StoryRow>
    </StoryCard>
  );
}

const aheadCommits = Array.from({ length: 7 }, (_, index) => ({
  sha: `${index}`.padEnd(40, "0"),
  shortSha: `a1b2c3${index}`,
  subject:
    index === 0
      ? "Render system thread references as rich mentions in the composer and timeline"
      : `Commit subject number ${index}`,
  authorName: "Ada Lovelace",
  authoredAt: 1_700_000_000_000,
}));

export function Commits() {
  return (
    <StoryCard>
      <StoryRow label="ahead of merge base (clickable, truncates at 5)">
        <RowStage>
          <ThreadCommitsRow
            workspaceStatus={makeWorkspaceStatus({
              mergeBase: {
                mergeBaseBranch: "main",
                baseRef: "main",
                aheadCount: aheadCommits.length,
                behindCount: 0,
                hasCommittedUnmergedChanges: true,
                commits: aheadCommits,
                insertions: 0,
                deletions: 0,
                lineStatsComplete: true,
                files: [],
              },
            })}
            onCommitClick={noop}
          />
        </RowStage>
      </StoryRow>
      <StoryRow label="nothing ahead (hidden)">
        <RowStage>
          <ThreadCommitsRow
            workspaceStatus={makeWorkspaceStatus()}
            onCommitClick={noop}
          />
        </RowStage>
      </StoryRow>
    </StoryCard>
  );
}

export function ChangedFiles() {
  return (
    <StoryCard>
      <StoryRow label="uncommitted">
        <RowStage>
          <ChangedFilesRow
            workspaceStatus={makeWorkspaceStatus({
              workingTree: {
                hasUncommittedChanges: true,
                state: "dirty_uncommitted",
                insertions: 47,
                deletions: 21,
                lineStatsComplete: true,
                files: [
                  {
                    path: "apps/app/src/components/sidebar/ProjectRow.tsx",
                    status: "M",
                    insertions: 18,
                    deletions: 9,
                  },
                  {
                    path: "apps/app/src/components/sidebar/ThreadRow.tsx",
                    status: "M",
                    insertions: 5,
                    deletions: 12,
                  },
                  {
                    path: "apps/app/src/components/sidebar/ProjectRow.stories.tsx",
                    status: "A",
                    insertions: 24,
                    deletions: 0,
                  },
                ],
              },
            })}
            onChangedFileClick={noop}
          />
        </RowStage>
      </StoryRow>
      <StoryRow label="committed, not merged">
        <RowStage>
          <ChangedFilesRow
            workspaceStatus={makeWorkspaceStatus({
              mergeBase: {
                mergeBaseBranch: "main",
                baseRef: "main",
                aheadCount: 2,
                behindCount: 0,
                hasCommittedUnmergedChanges: true,
                commits: [],
                insertions: 110,
                deletions: 24,
                lineStatsComplete: true,
                files: [
                  {
                    path: "apps/app/src/components/right-panel/ThreadMetadataContent.stories.tsx",
                    status: "M",
                    insertions: 38,
                    deletions: 12,
                  },
                  {
                    path: "apps/app/src/components/right-panel/ThreadMetadataContent.rows.stories.tsx",
                    status: "A",
                    insertions: 72,
                    deletions: 0,
                  },
                ],
              },
            })}
            onChangedFileClick={noop}
          />
        </RowStage>
      </StoryRow>
      <StoryRow label="uncommitted + committed">
        <RowStage>
          <ChangedFilesRow
            workspaceStatus={makeWorkspaceStatus({
              workingTree: {
                hasUncommittedChanges: true,
                state: "dirty_and_committed_unmerged",
                insertions: 47,
                deletions: 21,
                lineStatsComplete: true,
                files: [
                  {
                    path: "apps/app/src/components/sidebar/ProjectRow.tsx",
                    status: "M",
                    insertions: 18,
                    deletions: 9,
                  },
                  {
                    path: "apps/app/src/components/sidebar/ThreadRow.tsx",
                    status: "M",
                    insertions: 5,
                    deletions: 12,
                  },
                  {
                    path: "apps/app/src/components/sidebar/ProjectRow.stories.tsx",
                    status: "A",
                    insertions: 24,
                    deletions: 0,
                  },
                ],
              },
              mergeBase: {
                mergeBaseBranch: "main",
                baseRef: "main",
                aheadCount: 2,
                behindCount: 0,
                hasCommittedUnmergedChanges: true,
                commits: [],
                insertions: 110,
                deletions: 24,
                lineStatsComplete: true,
                files: [
                  {
                    path: "apps/app/src/components/right-panel/ThreadMetadataContent.stories.tsx",
                    status: "M",
                    insertions: 38,
                    deletions: 12,
                  },
                  {
                    path: "apps/app/src/components/right-panel/ThreadMetadataContent.rows.stories.tsx",
                    status: "A",
                    insertions: 72,
                    deletions: 0,
                  },
                ],
              },
            })}
            onChangedFileClick={noop}
          />
        </RowStage>
      </StoryRow>
    </StoryCard>
  );
}
