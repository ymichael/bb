import {
  ProjectRenameDialogContent,
  type ProjectRenameDialogTarget,
} from "./ProjectRenameDialog";
import {
  PROJECT_IDS,
  PROJECT_NAMES,
} from "../../../.ladle/story-fixtures";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";
import { DialogStage } from "../../../.ladle/story-dialog-stage";

export default {
  title: "dialogs/Project Rename",
};

const noop = () => {};

const target: ProjectRenameDialogTarget = {
  id: PROJECT_IDS.bb,
  currentName: PROJECT_NAMES.bb,
};

const longTarget: ProjectRenameDialogTarget = {
  id: "proj_long",
  currentName: "internal-tooling-ingest-pipeline-rewrite-2026",
};

const emptyTarget: ProjectRenameDialogTarget = {
  id: "proj_blank",
  currentName: "",
};

export function Overview() {
  return (
    <StoryCard>
      <StoryRow label="default" hint="standard project name in the input">
        <DialogStage>
          <ProjectRenameDialogContent
            target={target}
            pending={false}
            onRename={noop}
          />
        </DialogStage>
      </StoryRow>
      <StoryRow label="long name" hint="overflows horizontally inside the input">
        <DialogStage>
          <ProjectRenameDialogContent
            target={longTarget}
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
          <ProjectRenameDialogContent
            target={target}
            pending
            onRename={noop}
          />
        </DialogStage>
      </StoryRow>
      <StoryRow
        label="empty input"
        hint="clear the field and submit to see the validation message"
      >
        <DialogStage>
          <ProjectRenameDialogContent
            target={emptyTarget}
            pending={false}
            onRename={noop}
          />
        </DialogStage>
      </StoryRow>
    </StoryCard>
  );
}
