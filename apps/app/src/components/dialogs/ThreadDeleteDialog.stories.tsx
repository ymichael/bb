import { ThreadDeleteDialogContent } from "./ThreadDeleteDialog";
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

export function Overview() {
  return (
    <StoryCard>
      <StoryRow label="standard" hint="standard thread — copy reads 'Delete thread?'">
        <DialogStage>
          <ThreadDeleteDialogContent
            target={standardThread}
            pending={false}
            onDelete={noop}
          />
        </DialogStage>
      </StoryRow>
      <StoryRow
        label="manager"
        hint='threadType="manager" — copy reads "Delete manager?"'
      >
        <DialogStage>
          <ThreadDeleteDialogContent
            target={managerThread}
            pending={false}
            onDelete={noop}
          />
        </DialogStage>
      </StoryRow>
      <StoryRow
        label="pending"
        hint="submit in flight — destructive button disabled"
      >
        <DialogStage>
          <ThreadDeleteDialogContent
            target={standardThread}
            pending
            onDelete={noop}
          />
        </DialogStage>
      </StoryRow>
    </StoryCard>
  );
}
