import type { WorkspaceFileStatus } from "@bb/domain";
import { ThreadGitActionDialogContent } from "./ThreadGitActionDialog";
import type { ThreadGitStatusDisplay } from "@/components/workspace/workspace-status";
import type { WorkspaceChangedFilesSection } from "@/components/workspace/workspace-change-summary";
import { BRANCH_NAMES } from "../../../.ladle/story-fixtures";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";
import { DialogStage } from "../../../.ladle/story-dialog-stage";

export default {
  title: "dialogs/Thread Git Action",
};

const noop = () => {};
const asyncNoop = async () => {};

const stageClassName =
  "max-w-[34rem] gap-0 overflow-hidden border-border p-0 shadow-sm";

const changedFiles: WorkspaceFileStatus[] = [
  {
    path: "apps/app/src/components/thread/dialogs/ThreadRenameDialog.tsx",
    status: "M",
    insertions: 28,
    deletions: 11,
  },
  {
    path: "apps/app/src/components/thread/dialogs/ThreadRenameDialog.stories.tsx",
    status: "A",
    insertions: 64,
    deletions: 0,
  },
  {
    path: "apps/app/src/components/thread/dialogs/ThreadGitActionDialog.tsx",
    status: "M",
    insertions: 14,
    deletions: 6,
  },
];

const changedFilesSection: WorkspaceChangedFilesSection = {
  kind: "uncommitted",
  label: "Uncommitted",
  files: changedFiles,
  mergeBaseRef: null,
  stats: {
    files: changedFiles,
    insertions: 106,
    deletions: 17,
    lineStatsComplete: true,
  },
};

const dirtyGitStatus: ThreadGitStatusDisplay = {
  label: "Dirty",
  summary: "",
  summaryContent: "",
};

export function Overview() {
  return (
    <StoryCard>
      <StoryRow
        label="commit"
        hint='kind="commit" — branch + git status + changed files only, no merge base'
      >
        <DialogStage className={stageClassName}>
          <ThreadGitActionDialogContent
            branchName={BRANCH_NAMES.feature}
            gitStatusDisplay={dirtyGitStatus}
            changedFilesSection={changedFilesSection}
            onOpenChange={noop}
            onCommit={asyncNoop}
          />
        </DialogStage>
      </StoryRow>
      <StoryRow
        label="minimal"
        hint="no detail card — commit dialog with everything unknown"
      >
        <DialogStage className={stageClassName}>
          <ThreadGitActionDialogContent
            onOpenChange={noop}
            onCommit={asyncNoop}
          />
        </DialogStage>
      </StoryRow>
    </StoryCard>
  );
}
