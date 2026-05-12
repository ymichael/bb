import {
  HostRenameDialogContent,
  type HostRenameDialogTarget,
} from "./HostRenameDialog";
import { HOST_IDS, HOST_NAMES } from "../../../.ladle/story-fixtures";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";
import { DialogStage } from "../../../.ladle/story-dialog-stage";

export default {
  title: "dialogs/Host Rename",
};

const noop = () => {};

const target: HostRenameDialogTarget = {
  id: HOST_IDS.remote,
  currentName: HOST_NAMES.remote,
};

const emptyTarget: HostRenameDialogTarget = {
  id: HOST_IDS.local,
  currentName: "",
};

export function Overview() {
  return (
    <StoryCard>
      <StoryRow label="default" hint="standard host with current name prefilled">
        <DialogStage>
          <HostRenameDialogContent
            target={target}
            pending={false}
            onRename={noop}
          />
        </DialogStage>
      </StoryRow>
      <StoryRow
        label="pending"
        hint="submit in flight — input and submit disabled"
      >
        <DialogStage>
          <HostRenameDialogContent target={target} pending onRename={noop} />
        </DialogStage>
      </StoryRow>
      <StoryRow
        label="empty input"
        hint="clear the field and submit to see the validation message"
      >
        <DialogStage>
          <HostRenameDialogContent
            target={emptyTarget}
            pending={false}
            onRename={noop}
          />
        </DialogStage>
      </StoryRow>
    </StoryCard>
  );
}
