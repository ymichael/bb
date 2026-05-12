import {
  ThreadArchiveDialogContent,
  type ThreadArchiveDialogTarget,
} from "./ThreadArchiveDialog";
import { makeThread } from "../../../.ladle/story-fixtures";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";
import { DialogStage } from "../../../.ladle/story-dialog-stage";

export default {
  title: "dialogs/Thread Archive",
};

const noop = () => {};

const threadTarget: ThreadArchiveDialogTarget = {
  kind: "workspace-dirty",
  thread: makeThread(),
  managerChildThreadsConfirmed: false,
};

const managerThread = makeThread({
  id: "thr_manager",
  type: "manager",
  title: "Frontend Manager",
  titleFallback: "Frontend Manager",
});

const managerWorkspaceDirtyTarget: ThreadArchiveDialogTarget = {
  kind: "workspace-dirty",
  thread: managerThread,
  managerChildThreadsConfirmed: true,
};

const managerAssignedChildrenTarget: ThreadArchiveDialogTarget = {
  kind: "assigned-children",
  thread: managerThread,
  assignedChildCount: 3,
};

const managerOneChildTarget: ThreadArchiveDialogTarget = {
  kind: "assigned-children",
  thread: managerThread,
  assignedChildCount: 1,
};

export function Thread() {
  return (
    <StoryCard>
      <StoryRow
        label="dirty workspace"
        hint="archive blocked by uncommitted/unmerged work — only path to a confirm for a non-manager thread"
      >
        <DialogStage>
          <ThreadArchiveDialogContent
            target={threadTarget}
            pending={false}
            onOpenChange={noop}
            onArchive={noop}
          />
        </DialogStage>
      </StoryRow>
      <StoryRow label="pending" hint="archive request in flight — button disabled">
        <DialogStage>
          <ThreadArchiveDialogContent
            target={threadTarget}
            pending
            onOpenChange={noop}
            onArchive={noop}
          />
        </DialogStage>
      </StoryRow>
    </StoryCard>
  );
}

export function Manager() {
  return (
    <StoryCard>
      <StoryRow
        label="assigned children"
        hint="N child threads assigned — first confirm in the archive flow"
      >
        <DialogStage>
          <ThreadArchiveDialogContent
            target={managerAssignedChildrenTarget}
            pending={false}
            onOpenChange={noop}
            onArchive={noop}
          />
        </DialogStage>
      </StoryRow>
      <StoryRow
        label="assigned child (singular)"
        hint="1 child thread — singular phrasing"
      >
        <DialogStage>
          <ThreadArchiveDialogContent
            target={managerOneChildTarget}
            pending={false}
            onOpenChange={noop}
            onArchive={noop}
          />
        </DialogStage>
      </StoryRow>
      <StoryRow
        label="dirty workspace"
        hint="second confirm after children-warning succeeded — force-required from the server"
      >
        <DialogStage>
          <ThreadArchiveDialogContent
            target={managerWorkspaceDirtyTarget}
            pending={false}
            onOpenChange={noop}
            onArchive={noop}
          />
        </DialogStage>
      </StoryRow>
    </StoryCard>
  );
}
