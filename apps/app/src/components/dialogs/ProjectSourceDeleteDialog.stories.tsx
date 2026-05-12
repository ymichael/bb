import {
  ProjectSourceDeleteDialogContent,
  type ProjectSourceDeleteDialogTarget,
} from "./ProjectSourceDeleteDialog";
import { HOST_NAMES } from "../../../.ladle/story-fixtures";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";
import { DialogStage } from "../../../.ladle/story-dialog-stage";

export default {
  title: "dialogs/Project Source Delete",
};

const noop = () => {};

const localHostTarget: ProjectSourceDeleteDialogTarget = {
  id: "src_local",
  label: HOST_NAMES.local,
};

const githubTarget: ProjectSourceDeleteDialogTarget = {
  id: "src_github",
  label: "https://github.com/anthropics/bb",
};

const longTarget: ProjectSourceDeleteDialogTarget = {
  id: "src_long",
  label:
    "https://github.com/anthropics/internal-tooling-ingest-pipeline-rewrite-2026",
};

export function Overview() {
  return (
    <StoryCard>
      <StoryRow
        label="local source"
        hint="local_path source — label is the host name"
      >
        <DialogStage>
          <ProjectSourceDeleteDialogContent
            target={localHostTarget}
            pending={false}
            onDelete={noop}
          />
        </DialogStage>
      </StoryRow>
      <StoryRow
        label="github source"
        hint="github_repo source — label is the repo URL"
      >
        <DialogStage>
          <ProjectSourceDeleteDialogContent
            target={githubTarget}
            pending={false}
            onDelete={noop}
          />
        </DialogStage>
      </StoryRow>
      <StoryRow
        label="long label"
        hint="quoted URL expands inline inside the description"
      >
        <DialogStage>
          <ProjectSourceDeleteDialogContent
            target={longTarget}
            pending={false}
            onDelete={noop}
          />
        </DialogStage>
      </StoryRow>
      <StoryRow label="pending" hint="destructive button disabled">
        <DialogStage>
          <ProjectSourceDeleteDialogContent
            target={githubTarget}
            pending
            onDelete={noop}
          />
        </DialogStage>
      </StoryRow>
    </StoryCard>
  );
}
