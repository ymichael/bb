import {
  ThreadManagerChildThreadsConfirmationDialogContent,
  type ThreadManagerChildThreadsDialogTarget,
} from "./ThreadManagerChildThreadsConfirmationDialog";
import { makeThread } from "../../../.ladle/story-fixtures";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";
import { DialogStage } from "../../../.ladle/story-dialog-stage";

export default {
  title: "dialogs/Thread Manager Children",
};

const noop = () => {};

const managerThread = makeThread({
  id: "thr_manager",
  type: "manager",
  title: "Frontend Manager",
  titleFallback: "Frontend Manager",
});

const archiveMany: ThreadManagerChildThreadsDialogTarget = {
  action: "archive",
  nonDeletedAssignedChildCount: 4,
  thread: managerThread,
};

const archiveOne: ThreadManagerChildThreadsDialogTarget = {
  action: "archive",
  nonDeletedAssignedChildCount: 1,
  thread: managerThread,
};

const deleteMany: ThreadManagerChildThreadsDialogTarget = {
  action: "delete",
  nonDeletedAssignedChildCount: 4,
  thread: managerThread,
};

const deleteOne: ThreadManagerChildThreadsDialogTarget = {
  action: "delete",
  nonDeletedAssignedChildCount: 1,
  thread: managerThread,
};

export function Overview() {
  return (
    <StoryCard>
      <StoryRow
        label="archive, N children"
        hint='action="archive" with multiple non-deleted assigned child threads'
      >
        <DialogStage>
          <ThreadManagerChildThreadsConfirmationDialogContent
            target={archiveMany}
            pending={false}
            onOpenChange={noop}
            onConfirm={noop}
          />
        </DialogStage>
      </StoryRow>
      <StoryRow
        label="archive, 1 child"
        hint="singular phrasing — 'child thread' (no s)"
      >
        <DialogStage>
          <ThreadManagerChildThreadsConfirmationDialogContent
            target={archiveOne}
            pending={false}
            onOpenChange={noop}
            onConfirm={noop}
          />
        </DialogStage>
      </StoryRow>
      <StoryRow
        label="delete, N children"
        hint='action="delete" — title + confirm switch to delete copy'
      >
        <DialogStage>
          <ThreadManagerChildThreadsConfirmationDialogContent
            target={deleteMany}
            pending={false}
            onOpenChange={noop}
            onConfirm={noop}
          />
        </DialogStage>
      </StoryRow>
      <StoryRow label="delete, 1 child">
        <DialogStage>
          <ThreadManagerChildThreadsConfirmationDialogContent
            target={deleteOne}
            pending={false}
            onOpenChange={noop}
            onConfirm={noop}
          />
        </DialogStage>
      </StoryRow>
      <StoryRow label="pending" hint="both buttons disabled">
        <DialogStage>
          <ThreadManagerChildThreadsConfirmationDialogContent
            target={archiveMany}
            pending
            onOpenChange={noop}
            onConfirm={noop}
          />
        </DialogStage>
      </StoryRow>
    </StoryCard>
  );
}
