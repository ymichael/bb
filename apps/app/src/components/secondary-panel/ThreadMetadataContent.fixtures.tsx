import type { ReactNode } from "react";
import type { ThreadListEntry } from "@bb/domain";
import {
  makeEnvironment,
  makeHost,
  makeThread,
  makeThreadListEntry,
  makeWorkspaceStatus,
} from "../../../.ladle/story-fixtures";
import type { ThreadMetadataContentProps } from "./ThreadMetadataContent";

// Re-export the shared builders so per-row stories in this folder can import
// from one place.
export {
  makeEnvironment,
  makeHost,
  makeThread,
  makeThreadListEntry,
  makeWorkspaceStatus,
};

const noop = () => {};

export function PanelStage({ children }: { children: ReactNode }) {
  return (
    <div className="w-full max-w-[480px] min-w-0 rounded-md border border-border/70 bg-background px-4 py-3">
      {children}
    </div>
  );
}

export const managerThreads: ThreadListEntry[] = [
  makeThreadListEntry({
    id: "thr_codex_manager",
    type: "manager",
    title: "Codex Manager",
    titleFallback: "Codex Manager",
  }),
  makeThreadListEntry({
    id: "thr_frontend_manager",
    type: "manager",
    title: "Frontend Manager",
    titleFallback: "Frontend Manager",
  }),
];

export const baseProps: ThreadMetadataContentProps = {
  thread: makeThread(),
  projectId: "proj_bb",
  parentThreadDisplayName: null,
  managerThreads,
  canAssignToManager: true,
  canTakeOverThread: false,
  environmentHost: makeHost(),
  environmentIsLocal: true,
  environment: makeEnvironment(),
  workspaceStatus: makeWorkspaceStatus(),
  workspaceStatusError: null,
  selectedMergeBaseBranch: undefined,
  mergeBaseBranchOptions: ["main", "develop", "release/2026-04"],
  isLoadingMergeBaseBranchOptions: false,
  updateThreadPending: false,
  onAssignManager: noop,
  onMergeBaseBranchChange: noop,
  onChangedFileClick: noop,
};
