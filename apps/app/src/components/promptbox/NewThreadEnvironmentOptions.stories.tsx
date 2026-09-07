import { useState } from "react";
import {
  BranchPicker,
  type BranchPickerProps,
} from "@/components/pickers/BranchPicker";
import {
  EnvironmentPickerUI,
  type EnvironmentPickerUIProps,
} from "@/components/pickers/EnvironmentPicker";
import { ProjectSelector } from "@/components/pickers/ProjectSelector";
import { ReuseEnvironmentPicker } from "@/components/pickers/ReuseEnvironmentPicker";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";
import {
  HOST_IDS,
  makeHost,
  PROJECT_IDS,
  STORY_BRANCH_OPTIONS,
  STORY_PROJECTS,
  STORY_ENVIRONMENT_PROVIDERS,
  STORY_PROJECT_SOURCES,
  STORY_WORKTREE_OPTIONS,
} from "../../../.ladle/story-fixtures";

export default {
  title: "promptbox/Environment Options",
};

const noop = () => {};

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
  const environmentValue = environment?.value ?? "provider:project-checkout";
  const showReuseEnvironmentPicker = environmentValue === "reuse";
  const showBranchPicker = environmentValue === "provider:git-worktree";
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
              sources={STORY_PROJECT_SOURCES}
              host={makeHost({ id: HOST_IDS.local })}
              isLocal
              providers={STORY_ENVIRONMENT_PROVIDERS}
              selectedProviderHostId={HOST_IDS.local}
              onSelectProvider={noop}
              muted
              modal={false}
              {...environment}
            />
            {showReuseEnvironmentPicker ? (
              <ReuseEnvironmentPicker
                options={STORY_WORKTREE_OPTIONS}
                value={worktreeValue}
                onChange={noop}
                muted
                modal={false}
              />
            ) : showBranchPicker ? (
              <BranchPicker
                variant="option"
                muted
                value={null}
                options={STORY_BRANCH_OPTIONS}
                placeholder="Branch from: main"
                triggerLabel="Branch from: main"
                triggerTitle="Branch from: main"
                menuKind="base"
                onChange={noop}
                modal={false}
                {...branch}
              />
            ) : null}
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
          label="project · checkout provider"
          hint="default project checkout environment"
        >
          <EnvironmentOptionsStrip />
        </StoryRow>
        <StoryRow
          label="project · worktree from default"
          hint="new worktree from default base"
        >
          <EnvironmentOptionsStrip
            environment={{
              value: "provider:git-worktree",
              providers: STORY_ENVIRONMENT_PROVIDERS,
              onSelectProvider: noop,
            }}
            branch={{
              triggerLabel: "Branch from: main",
              triggerTitle: "Branch from: main",
            }}
          />
        </StoryRow>
        <StoryRow
          label="project · worktree from branch"
          hint="new worktree from named base"
        >
          <EnvironmentOptionsStrip
            environment={{
              value: "provider:git-worktree",
              providers: STORY_ENVIRONMENT_PROVIDERS,
              onSelectProvider: noop,
            }}
            branch={{
              value: "release/1.2",
              triggerLabel: "Branch from: release/1.2",
              triggerTitle: "Branch from: release/1.2",
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
