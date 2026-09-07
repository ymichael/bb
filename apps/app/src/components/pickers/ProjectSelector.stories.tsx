import { useState } from "react";
import { ProjectSelector, type ProjectSelectorOption } from "./ProjectSelector";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";

export default {
  title: "pickers/Project Selector",
};

const projects: readonly ProjectSelectorOption[] = [
  { id: "proj_bb", name: "bb" },
  { id: "proj_pierre", name: "pierre" },
];

const noop = () => {};

export function Overview() {
  return (
    <StoryCard>
      <StoryRow
        label="project selected"
        hint="trigger shows the project name + Folder icon"
      >
        <ProjectSelector projects={projects} value="proj_bb" onChange={noop} />
      </StoryRow>
      <StoryRow
        label="no project selected — required mode"
        hint="allowNoProject=false (default): trigger falls back to the first project so it is never blank"
      >
        <ProjectSelector projects={projects} value={null} onChange={noop} />
      </StoryRow>
      <StoryRow
        label="no project selected — optional mode"
        hint='allowNoProject=true: trigger shows "Work in a project" + FolderPlus icon, menu adds "Don&apos;t work in a project" item'
      >
        <ProjectSelector
          projects={projects}
          value={null}
          onChange={noop}
          allowNoProject
        />
      </StoryRow>
      <StoryRow
        label="open menu"
        hint="defaultOpen + modal=false (allowNoProject=true — shows the no-project item below a separator)"
      >
        <ProjectSelectorInteractive allowNoProject />
      </StoryRow>
      <StoryRow
        label="open menu with actions"
        hint="createProject + allowNoProject share one separator below the project list"
      >
        <ProjectSelectorInteractive allowNoProject createProject />
      </StoryRow>
      <StoryRow
        label="no projects"
        hint='empty project list with allowNoProject=true — menu adds a "New project" item'
      >
        <ProjectSelector
          projects={[]}
          value={null}
          onChange={noop}
          allowNoProject
          createProject={{ onCreate: noop }}
          defaultOpen
          modal={false}
        />
      </StoryRow>
    </StoryCard>
  );
}

function ProjectSelectorInteractive({
  allowNoProject = false,
  createProject = false,
}: {
  allowNoProject?: boolean;
  createProject?: boolean;
}) {
  const [value, setValue] = useState<string | null>("proj_bb");
  return (
    <ProjectSelector
      projects={projects}
      value={value}
      onChange={setValue}
      allowNoProject={allowNoProject}
      createProject={createProject ? { onCreate: noop } : undefined}
      defaultOpen
      modal={false}
    />
  );
}
