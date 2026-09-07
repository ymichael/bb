import type { ReactNode } from "react";
import type { ThreadListEntry, ThreadPullRequest } from "@bb/domain";
import type { EnvironmentDisplayHostContext } from "@bb/core-ui";
import {
  makeEnvironment,
  makeThread,
  makeThreadListEntry,
  makeWorkspaceStatus,
} from "../../../.ladle/story-fixtures";
import type { ThreadMetadataContentProps } from "./ThreadMetadataContent";

export { makeEnvironment, makeThread, makeWorkspaceStatus };

const noop = () => {};

export const localEnvironmentDisplayHost: EnvironmentDisplayHostContext = {
  locality: "local",
  identity: null,
};

export function PanelStage({ children }: { children: ReactNode }) {
  return (
    <div className="w-full max-w-[480px] min-w-0 rounded-md border border-border bg-background px-4 py-3">
      {children}
    </div>
  );
}

export const parentThreads: ThreadListEntry[] = [
  makeThreadListEntry({
    id: "thr_codex_parent",
    title: "Codex Parent",
    titleFallback: "Codex Parent",
  }),
  makeThreadListEntry({
    id: "thr_frontend_parent",
    title: "Frontend Parent",
    titleFallback: "Frontend Parent",
  }),
];

export function makePullRequest(
  overrides: Partial<ThreadPullRequest> = {},
): ThreadPullRequest {
  return {
    number: 128,
    title: "Show the branch's GitHub pull request in the Info tab",
    state: "open",
    url: "https://github.com/acme/bb/pull/128",
    baseRefName: "main",
    headRefName: "bb/pr-info-panel",
    updatedAt: "2026-06-16T12:30:00Z",
    checks: {
      state: "passing",
      totalCount: 3,
      passedCount: 3,
      failedCount: 0,
      pendingCount: 0,
    },
    review: {
      state: "approved",
      reviewRequestCount: 0,
    },
    mergeability: {
      state: "mergeable",
      mergeStateStatus: "CLEAN",
      mergeable: "MERGEABLE",
    },
    attention: "ready_to_merge",
    ...overrides,
  };
}

export const baseProps: ThreadMetadataContentProps = {
  thread: makeThread(),
  projectId: "proj_bb",
  parentThreadProjectId: null,
  parentThreadDisplayName: null,
  parentThreads,
  canAssignToParent: true,
  canTakeOverThread: false,
  isLoadingParentThreads: false,
  isParentThreadsError: false,
  environment: makeEnvironment(),
  environmentDisplayHost: localEnvironmentDisplayHost,
  workspaceStatus: makeWorkspaceStatus(),
  workspaceStatusError: null,
  pullRequest: null,
  selectedMergeBaseBranch: undefined,
  mergeBaseBranchOptions: ["main", "develop", "release/2026-04"],
  isLoadingMergeBaseBranchOptions: false,
  updateThreadPending: false,
  onAssignParent: noop,
  onParentSelectorOpenChange: noop,
  onRetryParentThreads: noop,
  onMergeBaseBranchChange: noop,
  onChangedFileClick: noop,
};
