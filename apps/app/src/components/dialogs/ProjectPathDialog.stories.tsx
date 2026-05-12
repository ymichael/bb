import {
  ProjectPathDialogContent,
  type ProjectPathDialogTarget,
} from "./ProjectPathDialog";
import {
  PROJECT_IDS,
  PROJECT_NAMES,
} from "../../../.ladle/story-fixtures";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";
import { DialogStage } from "../../../.ladle/story-dialog-stage";

export default {
  title: "dialogs/Project Path",
};

const noop = async () => {};

const createTarget: ProjectPathDialogTarget = { kind: "create" };

const updateTarget: ProjectPathDialogTarget = {
  kind: "update",
  projectId: PROJECT_IDS.bb,
  projectName: PROJECT_NAMES.bb,
  currentPath: "/Users/michael/Projects/bb",
};

const addSourceTarget: ProjectPathDialogTarget = {
  kind: "add-source",
  projectId: PROJECT_IDS.bb,
  projectName: PROJECT_NAMES.bb,
};

export function Overview() {
  return (
    <StoryCard>
      <StoryRow
        label="create"
        hint='kind="create" — empty input; project-name preview appears once a path is typed'
      >
        <DialogStage>
          <ProjectPathDialogContent
            target={createTarget}
            pending={false}
            platform="darwin"
            onSubmit={noop}
          />
        </DialogStage>
      </StoryRow>
      <StoryRow
        label="update"
        hint='kind="update" — prefilled with currentPath, submit reads "Save path"'
      >
        <DialogStage>
          <ProjectPathDialogContent
            target={updateTarget}
            pending={false}
            platform="darwin"
            onSubmit={noop}
          />
        </DialogStage>
      </StoryRow>
      <StoryRow
        label="add-source"
        hint='kind="add-source" — empty input, submit reads "Add source"'
      >
        <DialogStage>
          <ProjectPathDialogContent
            target={addSourceTarget}
            pending={false}
            platform="darwin"
            onSubmit={noop}
          />
        </DialogStage>
      </StoryRow>
      <StoryRow
        label="wsl"
        hint="WSL host — description hints at /mnt/c/... paths"
      >
        <DialogStage>
          <ProjectPathDialogContent
            target={createTarget}
            pending={false}
            platform="wsl"
            onSubmit={noop}
          />
        </DialogStage>
      </StoryRow>
      <StoryRow
        label="unknown platform"
        hint="platform null — falls back to generic absolute-path copy"
      >
        <DialogStage>
          <ProjectPathDialogContent
            target={createTarget}
            pending={false}
            platform={null}
            onSubmit={noop}
          />
        </DialogStage>
      </StoryRow>
      <StoryRow label="pending" hint="submit in flight — input + submit disabled">
        <DialogStage>
          <ProjectPathDialogContent
            target={updateTarget}
            pending
            platform="darwin"
            onSubmit={noop}
          />
        </DialogStage>
      </StoryRow>
    </StoryCard>
  );
}
