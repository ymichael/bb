import {
  ThreadDeleteDialogContent,
  type ThreadDeleteDialogTarget,
} from "./ThreadDeleteDialog";
import { makeThread } from "../../../.ladle/story-fixtures";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";
import { DialogStage } from "../../../.ladle/story-dialog-stage";

export default {
  title: "dialogs/Thread Delete",
};

const noop = () => {};

const standardThread = makeThread();
const managerThread = makeThread({
  id: "thr_manager",
  type: "manager",
  title: "Frontend Manager",
  titleFallback: "Frontend Manager",
});

const threadStandardTarget: ThreadDeleteDialogTarget = {
  kind: "standard",
  thread: standardThread,
};

const managerStandardTarget: ThreadDeleteDialogTarget = {
  kind: "standard",
  thread: managerThread,
};

const managerAssignedChildrenTarget: ThreadDeleteDialogTarget = {
  kind: "assigned-children",
  thread: managerThread,
  assignedChildCount: 3,
};

const managerOneChildTarget: ThreadDeleteDialogTarget = {
  kind: "assigned-children",
  thread: managerThread,
  assignedChildCount: 1,
};

export function Thread() {
  return (
    <StoryCard>
      <StoryRow
        label="standard"
        hint="non-manager thread — basic confirm"
      >
        <DialogStage>
          <ThreadDeleteDialogContent
            target={threadStandardTarget}
            pending={false}
            onOpenChange={noop}
            onDelete={noop}
          />
        </DialogStage>
      </StoryRow>
      <StoryRow label="pending" hint="delete in flight — button disabled">
        <DialogStage>
          <ThreadDeleteDialogContent
            target={threadStandardTarget}
            pending
            onOpenChange={noop}
            onDelete={noop}
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
        label="no children"
        hint="manager with no assigned children — same minimal confirm as a thread"
      >
        <DialogStage>
          <ThreadDeleteDialogContent
            target={managerStandardTarget}
            pending={false}
            onOpenChange={noop}
            onDelete={noop}
          />
        </DialogStage>
      </StoryRow>
      <StoryRow
        label="assigned children"
        hint="N child threads will lose their manager — verbose warning + Cancel button"
      >
        <DialogStage>
          <ThreadDeleteDialogContent
            target={managerAssignedChildrenTarget}
            pending={false}
            onOpenChange={noop}
            onDelete={noop}
          />
        </DialogStage>
      </StoryRow>
      <StoryRow
        label="assigned child (singular)"
        hint="1 child thread — singular phrasing"
      >
        <DialogStage>
          <ThreadDeleteDialogContent
            target={managerOneChildTarget}
            pending={false}
            onOpenChange={noop}
            onDelete={noop}
          />
        </DialogStage>
      </StoryRow>
    </StoryCard>
  );
}
