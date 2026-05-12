import {
  ProjectDeleteDialogContent,
  type ProjectDeleteDialogTarget,
} from "./ProjectDeleteDialog";
import {
  PROJECT_IDS,
  PROJECT_NAMES,
} from "../../../.ladle/story-fixtures";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";
import { DialogStage } from "../../../.ladle/story-dialog-stage";

export default {
  title: "dialogs/Project Delete",
};

const noop = () => {};

const target: ProjectDeleteDialogTarget = {
  id: PROJECT_IDS.bb,
  name: PROJECT_NAMES.bb,
};

const longName: ProjectDeleteDialogTarget = {
  id: "proj_long",
  name: "internal-tooling-ingest-pipeline-rewrite-2026",
};

export function Overview() {
  return (
    <StoryCard>
      <StoryRow label="default" hint="standard short project name">
        <DialogStage>
          <ProjectDeleteDialogContent
            target={target}
            pending={false}
            onDelete={noop}
          />
        </DialogStage>
      </StoryRow>
      <StoryRow
        label="long name"
        hint="quoted name expands inline inside the description"
      >
        <DialogStage>
          <ProjectDeleteDialogContent
            target={longName}
            pending={false}
            onDelete={noop}
          />
        </DialogStage>
      </StoryRow>
      <StoryRow label="pending" hint="destructive button disabled">
        <DialogStage>
          <ProjectDeleteDialogContent
            target={target}
            pending
            onDelete={noop}
          />
        </DialogStage>
      </StoryRow>
    </StoryCard>
  );
}
