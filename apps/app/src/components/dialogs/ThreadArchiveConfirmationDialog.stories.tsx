import {
  ThreadArchiveConfirmationDialogContent,
  type ThreadArchiveConfirmationDialogTarget,
} from "./ThreadArchiveConfirmationDialog";
import { makeThread } from "../../../.ladle/story-fixtures";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";
import { DialogStage } from "../../../.ladle/story-dialog-stage";

export default {
  title: "dialogs/Thread Archive Confirmation",
};

const noop = () => {};

const target: ThreadArchiveConfirmationDialogTarget = {
  managerChildThreadsConfirmed: false,
  thread: makeThread(),
};

export function Overview() {
  return (
    <StoryCard>
      <StoryRow
        label="default"
        hint="uncommitted/unmerged work — warns that changes may be lost"
      >
        <DialogStage>
          <ThreadArchiveConfirmationDialogContent
            target={target}
            pending={false}
            onArchive={noop}
          />
        </DialogStage>
      </StoryRow>
      <StoryRow label="pending" hint="archive in flight — submit disabled">
        <DialogStage>
          <ThreadArchiveConfirmationDialogContent
            target={target}
            pending
            onArchive={noop}
          />
        </DialogStage>
      </StoryRow>
    </StoryCard>
  );
}
