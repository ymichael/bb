import { useRef } from "react";
import {
  EnvironmentRenameDialogContent,
  type EnvironmentRenameDialogTarget,
} from "./EnvironmentRenameDialog";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";
import { DialogStage } from "../../../.ladle/story-dialog-stage";

export default {
  title: "dialogs/Environment Rename",
};

const noop = () => {};

const unnamedTarget: EnvironmentRenameDialogTarget = {
  id: "env_unnamed",
  currentName: "",
  branchName: "bb/support-environment-renaming",
  canClearName: false,
};

const customNameTarget: EnvironmentRenameDialogTarget = {
  id: "env_named",
  currentName: "Review workspace",
  branchName: "bb/support-environment-renaming",
  canClearName: true,
};

export function BranchContext() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  return (
    <StoryCard>
      <StoryRow
        label="branch context"
        hint="current branch beneath the custom worktree name"
      >
        <DialogStage>
          <EnvironmentRenameDialogContent
            target={{
              id: "env_named",
              currentName: "Design system polish",
              branchName: "bb/design-system-polish",
              canClearName: true,
            }}
            pending={false}
            onRename={noop}
            inputRef={inputRef}
          />
        </DialogStage>
      </StoryRow>
    </StoryCard>
  );
}

export function Overview() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  return (
    <StoryCard>
      <StoryRow label="branch placeholder" hint="unnamed worktree">
        <DialogStage>
          <EnvironmentRenameDialogContent
            target={unnamedTarget}
            pending={false}
            onRename={noop}
            inputRef={inputRef}
          />
        </DialogStage>
      </StoryRow>
      <StoryRow label="custom name" hint="can clear back to branch name">
        <DialogStage>
          <EnvironmentRenameDialogContent
            target={customNameTarget}
            pending={false}
            onRename={noop}
            inputRef={inputRef}
          />
        </DialogStage>
      </StoryRow>
      <StoryRow label="pending" hint="submit in flight">
        <DialogStage>
          <EnvironmentRenameDialogContent
            target={customNameTarget}
            pending
            onRename={noop}
            inputRef={inputRef}
          />
        </DialogStage>
      </StoryRow>
      <StoryRow label="server error" hint="mutation error surfaced">
        <DialogStage>
          <EnvironmentRenameDialogContent
            target={customNameTarget}
            pending={false}
            errorMessage="Worktree name must be 80 characters or fewer."
            onRename={noop}
            inputRef={inputRef}
          />
        </DialogStage>
      </StoryRow>
    </StoryCard>
  );
}
