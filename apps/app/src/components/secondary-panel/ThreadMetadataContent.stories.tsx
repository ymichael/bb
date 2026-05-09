import {
  ThreadMetadataContent,
  type ThreadMetadataContentProps,
} from "./ThreadMetadataContent";
import {
  PanelStage,
  baseProps,
  makeThread,
} from "./ThreadMetadataContent.fixtures";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";

export default {
  title: "secondary-panel/Info",
};

function render(overrides: Partial<ThreadMetadataContentProps>) {
  return (
    <PanelStage>
      <ThreadMetadataContent {...baseProps} {...overrides} />
    </PanelStage>
  );
}

export function Overview() {
  return (
    <StoryCard>
      <StoryRow
        label="standard"
        hint="canonical state — manager selector + host + env + branch + merge base + clean git status"
      >
        {render({})}
      </StoryRow>
      <StoryRow
        label="standard, assigned to manager"
        hint='thread.parentThreadId set — selector renders the link form'
      >
        {render({
          thread: makeThread({ parentThreadId: "thr_codex_manager" }),
          parentThreadDisplayName: "Codex Manager",
          canAssignToManager: false,
          canTakeOverThread: true,
        })}
      </StoryRow>
      <StoryRow
        label="standard, archived"
        hint="thread.archivedAt set — Archived row + unarchive button render"
      >
        {render({
          thread: makeThread({ archivedAt: 1_700_000_000_000 }),
        })}
      </StoryRow>
      <StoryRow
        label="manager thread"
        hint='thread.type=manager — Kind row reads "Manager"; environment/branch/merge-base hidden'
      >
        {render({
          thread: makeThread({
            type: "manager",
            title: "Codex Manager",
            titleFallback: "Codex Manager",
            environmentId: null,
          }),
          environment: null,
          environmentHost: null,
          workspaceStatus: undefined,
        })}
      </StoryRow>
    </StoryCard>
  );
}
