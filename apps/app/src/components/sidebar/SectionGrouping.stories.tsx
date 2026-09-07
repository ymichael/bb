import type { ReactNode } from "react";
import type { ThreadListEntry } from "@bb/domain";
import {
  PROJECT_IDS,
  makeThreadListEntry,
} from "../../../.ladle/story-fixtures";
import { ProjectActionsProvider } from "@/components/project/ProjectActionsProvider";
import { ThreadActionsProvider } from "@/components/thread/ThreadActionsProvider";
import { SidebarStickyStack } from "@/components/ui/sidebar.js";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";
import {
  ChronologicalSectionThreadSections,
  type ProjectThreadListState,
} from "./ProjectRow";
import {
  buildSidebarEntitySectionId,
  compareStandardThreads,
  type SidebarSectionDefinition,
} from "@bb/client-core";

export default {
  title: "sidebar/Section grouping",
};

const noop = () => {};
const PROJECT_ID = PROJECT_IDS.bb;
const STORY_SECTIONS: readonly SidebarSectionDefinition[] = [
  { id: "sec_work_q3", name: "Work/Q3" },
  { id: "sec_work_q4", name: "Work/Q4" },
  { id: "sec_personal_q3", name: "Personal/Q3" },
  { id: "sec_build", name: "Build" },
  { id: "sec_empty", name: "Empty" },
];

function makeThread(overrides: Partial<ThreadListEntry>): ThreadListEntry {
  return makeThreadListEntry({
    projectId: PROJECT_ID,
    titleFallback: overrides.title ?? "Story thread",
    ...overrides,
  });
}

const sectionThreads: ThreadListEntry[] = [
  makeThread({
    id: "thr_work_plan",
    title: "Plan",
    sectionId: "sec_work_q3",
    latestAttentionAt: 90,
    createdAt: 90,
  }),
  makeThread({
    id: "thr_work_notes",
    title: "Notes",
    sectionId: "sec_work_q3",
    latestAttentionAt: 80,
    createdAt: 80,
  }),
  makeThread({
    id: "thr_work_parent",
    title: "Kickoff",
    sectionId: "sec_work_q4",
    latestAttentionAt: 70,
    createdAt: 70,
  }),
  makeThread({
    id: "thr_work_child",
    parentThreadId: "thr_work_parent",
    title: "Child section stays with the child",
    sectionId: "sec_personal_q3",
    latestAttentionAt: 65,
    createdAt: 65,
  }),
  makeThread({
    id: "thr_personal_plan",
    title: "Plan",
    sectionId: "sec_personal_q3",
    latestAttentionAt: 60,
    createdAt: 60,
  }),
  makeThread({
    id: "thr_standalone",
    title: "Standalone follow-up",
    latestAttentionAt: 50,
    createdAt: 50,
  }),
  makeThread({
    id: "thr_env_a",
    title: "Daemon",
    sectionId: "sec_build",
    environmentId: "env_story_section",
    environmentName: "Section build",
    environmentBranchName: "bb/sidebar-sections",
    queuedWork: "none",
    environmentWorkspaceDisplayKind: "managed-worktree",
    latestAttentionAt: 40,
    createdAt: 40,
  }),
  makeThread({
    id: "thr_env_b",
    title: "Stories",
    sectionId: "sec_build",
    environmentId: "env_story_section",
    environmentName: "Section build",
    environmentBranchName: "bb/sidebar-sections",
    queuedWork: "none",
    environmentWorkspaceDisplayKind: "managed-worktree",
    hasPendingInteraction: true,
    latestAttentionAt: 30,
    createdAt: 30,
  }),
];

function SidebarStage({ children }: { children: ReactNode }) {
  return (
    <ProjectActionsProvider>
      <ThreadActionsProvider>
        <div className="w-full max-w-[460px] min-w-0 rounded-md bg-sidebar p-2 text-sidebar-foreground">
          <SidebarStickyStack>{children}</SidebarStickyStack>
        </div>
      </ThreadActionsProvider>
    </ProjectActionsProvider>
  );
}

function projectTree(
  threads: readonly ThreadListEntry[],
): ProjectThreadListState {
  return { status: "ready", threads: [...threads] };
}

export function ChronologicalSections() {
  return (
    <StoryCard>
      <StoryRow
        label="threads"
        hint="stored sectionId groups matching threads across projects"
      >
        <SidebarStage>
          <ChronologicalSectionThreadSections
            threadListState={projectTree(sectionThreads)}
            compareThreads={compareStandardThreads}
            sections={STORY_SECTIONS}
            collapsedThreadIds={new Set()}
            collapsedEnvironmentIds={new Set()}
            onToggleThreadCollapsed={noop}
            onToggleEnvironmentCollapsed={noop}
            topLevelSectionOrder={[
              ...STORY_SECTIONS.map((section) =>
                buildSidebarEntitySectionId("section", section.id),
              ),
              "threads",
            ]}
            onTopLevelSectionOrderChange={noop}
            pinnedReorderPending={false}
            pinnedThreads={[]}
            onReorderPinnedThread={noop}
            renderPinnedSection={() => null}
            renderThreadsSection={(content) => content}
          />
        </SidebarStage>
      </StoryRow>
    </StoryCard>
  );
}
