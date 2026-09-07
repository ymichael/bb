import { useState } from "react";
import {
  BranchPicker,
  type BranchPickerProps,
} from "@/components/pickers/BranchPicker";
import {
  EnvironmentPickerUI,
  type EnvironmentPickerUIProps,
} from "@/components/pickers/EnvironmentPicker";
import { parseEnvironmentValue } from "@/components/pickers/environment-picker-value";
import { ProjectSelector } from "@/components/pickers/ProjectSelector";
import { WorktreePicker } from "@/components/pickers/WorktreePicker";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";
import {
  HOST_IDS,
  makeHost,
  PROJECT_IDS,
  STORY_BRANCH_OPTIONS,
  STORY_PROJECTS,
  STORY_PROJECT_SOURCES,
  STORY_WORKTREE_OPTIONS,
} from "../../../.ladle/story-fixtures";

export default {
  title: "promptbox/Environment Options",
};

const noop = () => {};

function getStoryBranchMenuKind(
  environmentValue: string,
): BranchPickerProps["menuKind"] {
  const parsedEnvironment = parseEnvironmentValue(environmentValue);
  if (parsedEnvironment?.type !== "host") {
    return undefined;
  }

  return parsedEnvironment.mode === "worktree" ? "base" : "checkout";
}

interface EnvironmentOptionsStripProps {
  project?: { value: string | null; allowNoProject?: boolean };
  projectless?: boolean;
  environment?: Partial<EnvironmentPickerUIProps>;
  branch?: Partial<BranchPickerProps>;
  worktreeValue?: string | null;
}

function EnvironmentOptionsStrip({
  project,
  projectless = false,
  environment,
  branch,
  worktreeValue = null,
}: EnvironmentOptionsStripProps) {
  const [projectValue, setProjectValue] = useState<string | null>(
    project?.value ?? PROJECT_IDS.bb,
  );
  const environmentValue = environment?.value ?? `host:${HOST_IDS.local}:local`;
  const showWorktreePicker = environmentValue === "reuse";
  return (
    <div data-promptbox-shell="" className="w-full min-w-0 max-w-[760px]">
      <div className="mt-1 flex min-w-0 max-w-full items-center gap-1 border border-transparent px-3.5">
        <ProjectSelector
          projects={STORY_PROJECTS}
          value={projectValue}
          onChange={setProjectValue}
          allowNoProject={project?.allowNoProject ?? false}
          className="h-7 px-1.5"
          modal={false}
        />
        {projectless ? null : (
          <>
            <EnvironmentPickerUI
              value={environmentValue}
              onChange={noop}
              sources={STORY_PROJECT_SOURCES}
              host={makeHost({ id: HOST_IDS.local })}
              isLocal
              muted
              modal={false}
              {...environment}
            />
            {showWorktreePicker ? (
              <WorktreePicker
                options={STORY_WORKTREE_OPTIONS}
                value={worktreeValue}
                onChange={noop}
                muted
                modal={false}
              />
            ) : (
              <BranchPicker
                variant="option"
                muted
                value={null}
                options={STORY_BRANCH_OPTIONS}
                currentOptionLabel="Current: main"
                currentOptionTitle="Use the current checkout without switching branches"
                placeholder="Current checkout"
                triggerLabel="Current (main)"
                triggerTitle="Current: main"
                menuKind={getStoryBranchMenuKind(environmentValue)}
                onChange={noop}
                onClear={noop}
                onCreate={noop}
                modal={false}
                {...branch}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function Overview() {
  return (
    <div className="flex flex-col">
      <StoryCard labelWidth="180px">
        <StoryRow
          label="project · current branch"
          hint="default: a project, the current checkout"
        >
          <EnvironmentOptionsStrip />
        </StoryRow>
        <StoryRow
          label="project · checkout"
          hint="explicit existing branch intent"
        >
          <EnvironmentOptionsStrip
            branch={{
              value: "release/1.2",
              triggerLabel: "Checkout: release/1.2",
              triggerTitle: "Checkout: release/1.2",
            }}
          />
        </StoryRow>
        <StoryRow
          label="project · new branch"
          hint="server-minted branch in primary checkout"
        >
          <EnvironmentOptionsStrip
            branch={{
              value: "main",
              isCreatingNew: true,
              triggerLabel: "New branch from: main",
              triggerTitle: "Create a new branch from main",
            }}
          />
        </StoryRow>
        <StoryRow
          label="project · dirty checkout"
          hint="branch-changing choices blocked"
        >
          <EnvironmentOptionsStrip
            branch={{
              optionDisabledReason: "Dirty",
              optionDisabledTitle: "Checkout blocked by uncommitted changes",
              createDisabledReason: "Dirty",
              createDisabledTitle: "Checkout blocked by uncommitted changes",
            }}
          />
        </StoryRow>
        <StoryRow
          label="project · detached HEAD"
          hint="current checkout shown explicitly"
        >
          <EnvironmentOptionsStrip
            branch={{
              currentOptionLabel: "Current (detached)",
              currentOptionTitle: "Detached HEAD at a1b2c3d",
              triggerLabel: "Current (detached)",
              triggerTitle: "Detached HEAD at a1b2c3d",
              optionDisabledReason: "Detached",
              optionDisabledTitle: "Checkout blocked while HEAD is detached",
              createDisabledReason: "Detached",
              createDisabledTitle: "Checkout blocked while HEAD is detached",
            }}
          />
        </StoryRow>
        <StoryRow label="project · empty repo" hint="unborn branch state">
          <EnvironmentOptionsStrip
            branch={{
              currentOptionLabel: "Current (empty repo)",
              currentOptionTitle: "Repository has no commits yet",
              triggerLabel: "Current (empty repo)",
              triggerTitle: "Repository has no commits yet",
              optionDisabledReason: "Empty",
              optionDisabledTitle: "Checkout blocked before the first commit",
              createDisabledReason: "Empty",
              createDisabledTitle: "Checkout blocked before the first commit",
            }}
          />
        </StoryRow>
        <StoryRow label="project · loading" hint="loading checkout state">
          <EnvironmentOptionsStrip
            branch={{
              loading: true,
              triggerLabel: "Loading...",
              triggerTitle: "Loading",
            }}
          />
        </StoryRow>
        <StoryRow
          label="project · worktree from default"
          hint="new worktree from default base"
        >
          <EnvironmentOptionsStrip
            environment={{ value: `host:${HOST_IDS.local}:worktree` }}
            branch={{
              currentOptionLabel: "main",
              triggerLabel: "Branch from: main",
              triggerTitle: "Branch from: main",
              onCreate: undefined,
            }}
          />
        </StoryRow>
        <StoryRow
          label="project · worktree from branch"
          hint="new worktree from named base"
        >
          <EnvironmentOptionsStrip
            environment={{ value: `host:${HOST_IDS.local}:worktree` }}
            branch={{
              currentOptionLabel: "main",
              value: "release/1.2",
              triggerLabel: "Branch from: release/1.2",
              triggerTitle: "Branch from: release/1.2",
              onCreate: undefined,
            }}
          />
        </StoryRow>
        <StoryRow
          label="project · reuse selected"
          hint="reuse mode with a chosen worktree"
        >
          <EnvironmentOptionsStrip
            environment={{ value: "reuse" }}
            worktreeValue="env_review_flow"
          />
        </StoryRow>
        <StoryRow
          label="project · reuse empty"
          hint="reuse mode before picking a worktree"
        >
          <EnvironmentOptionsStrip environment={{ value: "reuse" }} />
        </StoryRow>
        <StoryRow
          label="project · reuse unavailable"
          hint="environment row disabled in menu"
        >
          <EnvironmentOptionsStrip
            environment={{
              value: `host:${HOST_IDS.local}:local`,
              reuseDisabled: true,
            }}
          />
        </StoryRow>
        <StoryRow
          label="no project · allowed"
          hint="allowNoProject flag on, no project chosen — trigger reads 'Work in a project'"
        >
          <EnvironmentOptionsStrip
            project={{ value: null, allowNoProject: true }}
            projectless
          />
        </StoryRow>
        <StoryRow
          label="other project · pierre"
          hint="swapping project changes the env strip context"
        >
          <EnvironmentOptionsStrip project={{ value: PROJECT_IDS.pierre }} />
        </StoryRow>
      </StoryCard>
    </div>
  );
}
