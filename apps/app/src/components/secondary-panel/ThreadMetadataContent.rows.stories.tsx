import type { ReactNode } from "react";
import {
  ManagerSelectorRow,
  HostRow,
  EnvironmentRow,
  BranchRow,
  MergeBaseRow,
  GitStatusRow,
  ArchivedRow,
  ChangedFilesRow,
  ThreadMetadataCard,
} from "./ThreadMetadataContent";
import {
  PanelStage,
  baseProps,
  managerThreads,
  makeEnvironment,
  makeHost,
  makeThread,
  makeWorkspaceStatus,
} from "./ThreadMetadataContent.fixtures";
import { HOST_IDS, HOST_NAMES } from "../../../.ladle/story-fixtures";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";

export default {
  title: "secondary-panel/Info/Row",
};

const noop = () => {};

function RowStage({ children }: { children: ReactNode }) {
  return (
    <PanelStage>
      <ThreadMetadataCard hasFlexibleHeight={false}>
        {children}
      </ThreadMetadataCard>
    </PanelStage>
  );
}

// ---------------------------------------------------------------------------
// Manager selector — the "Manager" row.
// ---------------------------------------------------------------------------

export function ManagerSelector() {
  return (
    <StoryCard>
      <StoryRow label="unassigned">
        <RowStage>
          <ManagerSelectorRow
            thread={makeThread()}
            projectId={baseProps.projectId}
            parentThreadDisplayName={null}
            managerThreads={managerThreads}
            canAssignToManager
            canTakeOverThread={false}
            updateThreadPending={false}
            onAssignManager={noop}
          />
        </RowStage>
      </StoryRow>
      <StoryRow label="unassigned, no candidates">
        <RowStage>
          <ManagerSelectorRow
            thread={makeThread()}
            projectId={baseProps.projectId}
            parentThreadDisplayName={null}
            managerThreads={[]}
            canAssignToManager={false}
            canTakeOverThread={false}
            updateThreadPending={false}
            onAssignManager={noop}
          />
        </RowStage>
      </StoryRow>
      <StoryRow label="assigned">
        <RowStage>
          <ManagerSelectorRow
            thread={makeThread({ parentThreadId: "thr_codex_manager" })}
            projectId={baseProps.projectId}
            parentThreadDisplayName="Codex Manager"
            managerThreads={managerThreads}
            canAssignToManager={false}
            canTakeOverThread
            updateThreadPending={false}
            onAssignManager={noop}
          />
        </RowStage>
      </StoryRow>
      <StoryRow label="dropdown open">
        <RowStage>
          <ManagerSelectorRow
            thread={makeThread()}
            projectId={baseProps.projectId}
            parentThreadDisplayName={null}
            managerThreads={managerThreads}
            canAssignToManager
            canTakeOverThread={false}
            updateThreadPending={false}
            onAssignManager={noop}
            defaultOpen
          />
        </RowStage>
      </StoryRow>
    </StoryCard>
  );
}

// ---------------------------------------------------------------------------
// Host — the "Host" row.
// ---------------------------------------------------------------------------

export function Host() {
  return (
    <StoryCard>
      <StoryRow label="local">
        <RowStage>
          <HostRow
            environmentHost={makeHost()}
            environment={makeEnvironment()}
            environmentIsLocal
          />
        </RowStage>
      </StoryRow>
      <StoryRow label="remote, connected">
        <RowStage>
          <HostRow
            environmentHost={makeHost({
              id: HOST_IDS.remote,
              name: HOST_NAMES.remote,
              status: "connected",
            })}
            environment={makeEnvironment({ hostId: HOST_IDS.remote })}
            environmentIsLocal={false}
          />
        </RowStage>
      </StoryRow>
      <StoryRow label="remote, disconnected">
        <RowStage>
          <HostRow
            environmentHost={makeHost({
              id: HOST_IDS.remote,
              name: HOST_NAMES.remote,
              status: "disconnected",
            })}
            environment={makeEnvironment({ hostId: HOST_IDS.remote })}
            environmentIsLocal={false}
          />
        </RowStage>
      </StoryRow>
      <StoryRow label="ephemeral sandbox">
        <RowStage>
          <HostRow
            environmentHost={makeHost({
              id: HOST_IDS.sandbox,
              name: HOST_NAMES.sandbox,
              type: "ephemeral",
              provider: "e2b",
            })}
            environment={makeEnvironment({ hostId: HOST_IDS.sandbox })}
            environmentIsLocal={false}
          />
        </RowStage>
      </StoryRow>
    </StoryCard>
  );
}

// ---------------------------------------------------------------------------
// Environment — the "Environment" row.
// ---------------------------------------------------------------------------

export function Environment() {
  return (
    <StoryCard>
      <StoryRow label="worktree, local">
        <RowStage>
          <EnvironmentRow
            thread={makeThread()}
            environment={makeEnvironment()}
            environmentHost={makeHost()}
            environmentIsLocal
          />
        </RowStage>
      </StoryRow>
      <StoryRow label="worktree, remote">
        <RowStage>
          <EnvironmentRow
            thread={makeThread()}
            environment={makeEnvironment({ hostId: HOST_IDS.remote })}
            environmentHost={makeHost({
              id: HOST_IDS.remote,
              name: HOST_NAMES.remote,
            })}
            environmentIsLocal={false}
          />
        </RowStage>
      </StoryRow>
      <StoryRow label="direct, local">
        <RowStage>
          <EnvironmentRow
            thread={makeThread()}
            environment={makeEnvironment({
              isWorktree: false,
              workspaceProvisionType: "unmanaged",
            })}
            environmentHost={makeHost()}
            environmentIsLocal
          />
        </RowStage>
      </StoryRow>
      <StoryRow label="direct, remote">
        <RowStage>
          <EnvironmentRow
            thread={makeThread()}
            environment={makeEnvironment({
              hostId: HOST_IDS.remote,
              isWorktree: false,
              workspaceProvisionType: "unmanaged",
            })}
            environmentHost={makeHost({
              id: HOST_IDS.remote,
              name: HOST_NAMES.remote,
            })}
            environmentIsLocal={false}
          />
        </RowStage>
      </StoryRow>
      <StoryRow label="ephemeral sandbox">
        <RowStage>
          <EnvironmentRow
            thread={makeThread()}
            environment={makeEnvironment({
              hostId: HOST_IDS.sandbox,
              isWorktree: false,
              workspaceProvisionType: "unmanaged",
            })}
            environmentHost={makeHost({
              id: HOST_IDS.sandbox,
              name: HOST_NAMES.sandbox,
              type: "ephemeral",
              provider: "e2b",
            })}
            environmentIsLocal={false}
          />
        </RowStage>
      </StoryRow>
    </StoryCard>
  );
}

// ---------------------------------------------------------------------------
// Branch + merge base.
// ---------------------------------------------------------------------------

export function Branch() {
  return (
    <StoryCard>
      <StoryRow label="feature branch">
        <RowStage>
          <BranchRow
            thread={makeThread()}
            workspaceStatus={makeWorkspaceStatus()}
          />
        </RowStage>
      </StoryRow>
      <StoryRow label="long branch">
        <RowStage>
          <BranchRow
            thread={makeThread()}
            workspaceStatus={makeWorkspaceStatus({
              branch: {
                currentBranch:
                  "feat/sidebar-rail/extract-row-components-and-add-info-row-stories",
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
            thread={makeThread()}
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
            thread={makeThread()}
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
            thread={makeThread()}
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

// ---------------------------------------------------------------------------
// Git status — permutations of the "Git status" row.
// ---------------------------------------------------------------------------

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
                files: [
                  { path: "apps/app/src/components/sidebar/ProjectRow.tsx", status: "M", insertions: 18, deletions: 9 },
                  { path: "apps/app/src/components/sidebar/ThreadRow.tsx", status: "M", insertions: 5, deletions: 12 },
                  { path: "apps/app/src/components/sidebar/ProjectRow.stories.tsx", status: "A", insertions: 24, deletions: 0 },
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
                files: [
                  { path: "scratch.md", status: "??", insertions: null, deletions: null },
                  { path: "notes/scratch.md", status: "??", insertions: null, deletions: null },
                  { path: "tmp/output.json", status: "??", insertions: null, deletions: null },
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

// ---------------------------------------------------------------------------
// Archived + Changed files — small lifecycle/diff rows.
// ---------------------------------------------------------------------------

export function Archived() {
  return (
    <StoryCard>
      <StoryRow label="archived">
        <RowStage>
          <ArchivedRow
            thread={makeThread({ archivedAt: 1_700_000_000_000 })}
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
            thread={makeThread()}
            workspaceStatus={makeWorkspaceStatus({
              workingTree: {
                hasUncommittedChanges: true,
                state: "dirty_uncommitted",
                insertions: 47,
                deletions: 21,
                files: [
                  { path: "apps/app/src/components/sidebar/ProjectRow.tsx", status: "M", insertions: 18, deletions: 9 },
                  { path: "apps/app/src/components/sidebar/ThreadRow.tsx", status: "M", insertions: 5, deletions: 12 },
                  { path: "apps/app/src/components/sidebar/ProjectRow.stories.tsx", status: "A", insertions: 24, deletions: 0 },
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
            thread={makeThread()}
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
                files: [
                  { path: "apps/app/src/components/secondary-panel/ThreadMetadataContent.tsx", status: "M", insertions: 38, deletions: 12 },
                  { path: "apps/app/src/components/secondary-panel/ThreadMetadataContent.fixtures.tsx", status: "A", insertions: 72, deletions: 0 },
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
