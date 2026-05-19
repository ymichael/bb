import { useCallback, useState, type ReactNode } from "react";
import type { ThreadListEntry } from "@bb/domain";
import type { ProjectResponse } from "@bb/server-contract";
import {
  BRANCH_NAMES,
  HOST_IDS,
  PROJECT_IDS,
  makeProject as makeSharedProject,
  makeThreadListEntry,
} from "../../../.ladle/story-fixtures";
import { SidebarMenu, SidebarStickyStack } from "@/components/ui/sidebar.js";
import { ProjectActionsProvider } from "@/components/project/ProjectActionsProvider";
import { ThreadActionsProvider } from "@/components/thread/ThreadActionsProvider";
import { ProjectListActionButtons, ProjectListShell } from "./ProjectList";
import { ProjectRow, type ProjectThreadListState } from "./ProjectRow";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";

export default {
  title: "sidebar/Projects",
};

// Caps at the production sidebar max (460px) but shrinks with the parent so
// truncation behavior is visible at any container width. Provides the outer
// sidebar frame only; each story decides whether to use ProjectListShell (for
// full-sidebar shots) or a bare SidebarStickyStack (for isolated ProjectRow
// demos).
function SidebarStage({ children }: { children: ReactNode }) {
  return (
    <ProjectActionsProvider>
      <ThreadActionsProvider>
        <div className="w-full max-w-[460px] min-w-0 rounded-md bg-sidebar p-2 text-sidebar-foreground">
          {children}
        </div>
      </ThreadActionsProvider>
    </ProjectActionsProvider>
  );
}

// Wrap the shared builders for slightly different defaults the sidebar wants
// (a different demo project id; ThreadListEntry instead of Thread).
const makeProject = (overrides: Partial<ProjectResponse> = {}) =>
  makeSharedProject({ id: PROJECT_IDS.bb, name: "bb", ...overrides });

const makeThread = (overrides: Partial<ThreadListEntry> = {}) =>
  makeThreadListEntry({ id: "thr_default", ...overrides });

type ToggleStoryCollapsedId = (id: string) => void;

interface InteractiveProjectRowArgs {
  project?: ProjectResponse;
  threadListState: ProjectThreadListState;
  initialCollapsed?: boolean;
  initialCollapsedManagerIds?: ReadonlySet<string>;
  initialCollapsedEnvironmentIds?: ReadonlySet<string>;
  isActive?: boolean;
  isLocalPathInvalid?: boolean;
}

// Holds local collapse state so the chevrons in stories actually toggle. The
// component is fully controlled in production (by jotai atoms in ProjectList),
// so here we just stand in for that owner.
function InteractiveProjectRow({
  project = makeProject(),
  threadListState,
  initialCollapsed = false,
  initialCollapsedManagerIds,
  initialCollapsedEnvironmentIds,
  isActive = false,
  isLocalPathInvalid = false,
}: InteractiveProjectRowArgs) {
  const [isCollapsed, setIsCollapsed] = useState(initialCollapsed);
  const [collapsedManagerIds, setCollapsedManagerIds] = useState<Set<string>>(
    () => new Set(initialCollapsedManagerIds ?? []),
  );
  const [collapsedEnvironmentIds, setCollapsedEnvironmentIds] = useState<
    Set<string>
  >(() => new Set(initialCollapsedEnvironmentIds ?? []));
  const onToggleProjectCollapsed = useCallback(() => {
    setIsCollapsed((current) => !current);
  }, []);
  const onToggleManagerCollapsed = useCallback<ToggleStoryCollapsedId>(
    (threadId) => {
      setCollapsedManagerIds((current) => {
        const next = new Set(current);
        if (next.has(threadId)) {
          next.delete(threadId);
        } else {
          next.add(threadId);
        }
        return next;
      });
    },
    [],
  );
  const onToggleEnvironmentCollapsed = useCallback<ToggleStoryCollapsedId>(
    (environmentId) => {
      setCollapsedEnvironmentIds((current) => {
        const next = new Set(current);
        if (next.has(environmentId)) {
          next.delete(environmentId);
        } else {
          next.add(environmentId);
        }
        return next;
      });
    },
    [],
  );
  return (
    <ProjectRow
      project={project}
      threadListState={threadListState}
      isActive={isActive}
      isCollapsed={isCollapsed}
      collapsedManagerIds={collapsedManagerIds}
      collapsedEnvironmentIds={collapsedEnvironmentIds}
      isLocalPathInvalid={isLocalPathInvalid}
      onToggleProjectCollapsed={onToggleProjectCollapsed}
      onToggleManagerCollapsed={onToggleManagerCollapsed}
      onToggleEnvironmentCollapsed={onToggleEnvironmentCollapsed}
    />
  );
}

// Isolated ProjectRow demos: no action buttons, no "Projects" label — just the
// minimum sticky-stack context the row depends on.
function singleProject(args: InteractiveProjectRowArgs) {
  return (
    <SidebarStage>
      <SidebarStickyStack>
        <SidebarMenu className="gap-1">
          <InteractiveProjectRow {...args} />
        </SidebarMenu>
      </SidebarStickyStack>
    </SidebarStage>
  );
}

const idleThread = makeThread({
  id: "thr_idle",
  title: "Audit and reduce codebase cognitive load",
  titleFallback: "Audit and reduce codebase cognitive load",
});
const busyThread = makeThread({
  id: "thr_busy",
  title: "Implement timeline pagination v2",
  titleFallback: "Implement timeline pagination v2",
  status: "active",
  runtime: {
    displayStatus: "active",
    hostReconnectGraceExpiresAt: null,
  },
});
const pendingThread = makeThread({
  id: "thr_pending",
  title: "Diagnose Claude CLI auth path",
  titleFallback: "Diagnose Claude CLI auth path",
  hasPendingInteraction: true,
});
const standardThread = makeThread({
  id: "thr_standard",
  title: "Stabilize Pnpm Dev Environment",
  titleFallback: "Stabilize Pnpm Dev Environment",
  environmentHostId: HOST_IDS.local,
  environmentBranchName: BRANCH_NAMES.default,
  environmentWorkspaceDisplayKind: "managed-worktree",
});
const sharedWorktreeThreadA = makeThread({
  id: "thr_shared_wt_a",
  title: "Refactor timeline row types",
  titleFallback: "Refactor timeline row types",
  environmentId: "env_shared_worktree",
  environmentHostId: HOST_IDS.local,
  environmentBranchName: "bb/set-default-tab-for-panel-thr_vnj2qze4fg",
  environmentWorkspaceDisplayKind: "managed-worktree",
});
const sharedWorktreeThreadB = makeThread({
  id: "thr_shared_wt_b",
  title: "Add story for env-grouped sidebar",
  titleFallback: "Add story for env-grouped sidebar",
  environmentId: "env_shared_worktree",
  environmentHostId: HOST_IDS.local,
  environmentBranchName: "bb/set-default-tab-for-panel-thr_vnj2qze4fg",
  environmentWorkspaceDisplayKind: "managed-worktree",
});
const manager = makeThread({
  id: "thr_manager",
  type: "manager",
  title: "Frontend Manager",
  titleFallback: "Frontend Manager",
});
const managerChildA = makeThread({
  id: "thr_manager_child_a",
  title: "Update Timeline Row Types",
  titleFallback: "Update Timeline Row Types",
  parentThreadId: manager.id,
});
const managerChildB = makeThread({
  id: "thr_manager_child_b",
  title: "Fix Timeline Pagination Bugs",
  titleFallback: "Fix Timeline Pagination Bugs",
  parentThreadId: manager.id,
  status: "active",
  runtime: {
    displayStatus: "active",
    hostReconnectGraceExpiresAt: null,
  },
});

interface MultiProjectEntry extends InteractiveProjectRowArgs {
  key: string;
}

const multipleProjects: MultiProjectEntry[] = [
  {
    key: "bb",
    project: makeProject({ id: "proj_bb", name: "bb" }),
    isActive: true,
    threadListState: {
      status: "ready",
      threads: [
        { ...standardThread, projectId: "proj_bb" },
        { ...manager, projectId: "proj_bb" },
        { ...managerChildA, projectId: "proj_bb" },
        { ...managerChildB, projectId: "proj_bb" },
        { ...busyThread, projectId: "proj_bb" },
        { ...pendingThread, projectId: "proj_bb" },
      ],
    },
  },
  {
    key: "pierre",
    project: makeProject({
      id: "proj_pierre",
      name: "pierre — long project name that should truncate cleanly",
    }),
    initialCollapsed: true,
    threadListState: {
      status: "ready",
      threads: [{ ...idleThread, projectId: "proj_pierre" }],
    },
  },
  {
    key: "ingest",
    project: makeProject({ id: "proj_ingest", name: "ingest-pipeline" }),
    threadListState: {
      status: "ready",
      threads: [
        { ...idleThread, id: "thr_ingest_1", projectId: "proj_ingest" },
        { ...idleThread, id: "thr_ingest_2", projectId: "proj_ingest" },
      ],
    },
  },
  {
    key: "experiment",
    project: makeProject({ id: "proj_empty", name: "fresh-experiment" }),
    threadListState: { status: "ready", threads: [] },
  },
];

export function Overview() {
  return (
    <StoryCard>
      <StoryRow
        label="loading threads"
        hint="project header rendered, skeleton stands in for the thread list"
      >
        {singleProject({ threadListState: { status: "loading" } })}
      </StoryRow>
      <StoryRow
        label="ready, no threads"
        hint='empty state: "No threads"'
      >
        {singleProject({
          threadListState: { status: "ready", threads: [] },
        })}
      </StoryRow>
      <StoryRow
        label="unavailable"
        hint="thread query failed (e.g., server disconnected)"
      >
        {singleProject({ threadListState: { status: "unavailable" } })}
      </StoryRow>
      <StoryRow
        label="starts collapsed"
        hint="children hidden by default — click the folder to expand"
      >
        {singleProject({
          initialCollapsed: true,
          threadListState: {
            status: "ready",
            threads: [idleThread],
          },
        })}
      </StoryRow>
      <StoryRow
        label="active project route"
        hint="header has the selected sidebar-border background"
      >
        {singleProject({
          isActive: true,
          threadListState: { status: "ready", threads: [] },
        })}
      </StoryRow>
      <StoryRow
        label="local path missing"
        hint="warning triangle navigates to project settings to repair"
      >
        {singleProject({
          isLocalPathInvalid: true,
          threadListState: { status: "ready", threads: [idleThread] },
        })}
      </StoryRow>
      <StoryRow
        label="manager + standard"
        hint="ProjectRow groups managers before unmanaged standards — click the manager chevron to collapse its children"
      >
        {singleProject({
          threadListState: {
            status: "ready",
            threads: [manager, managerChildA, managerChildB, idleThread],
          },
        })}
      </StoryRow>
      <StoryRow
        label="manager starts collapsed"
        hint="children hidden by default"
      >
        {singleProject({
          initialCollapsedManagerIds: new Set([manager.id]),
          threadListState: {
            status: "ready",
            threads: [manager, managerChildA, managerChildB],
          },
        })}
      </StoryRow>
      <StoryRow
        label="nested manager"
        hint="manager-of-managers: a root manager owns one standard child and one nested manager that owns its own children — each level keeps the user icon + chevron and indents one step further"
      >
        {singleProject({
          threadListState: {
            status: "ready",
            threads: [
              makeThread({
                id: "thr_root_manager",
                type: "manager",
                title: "Release Coordinator",
                titleFallback: "Release Coordinator",
              }),
              makeThread({
                id: "thr_root_child",
                title: "Audit release blockers",
                titleFallback: "Audit release blockers",
                parentThreadId: "thr_root_manager",
              }),
              makeThread({
                id: "thr_nested_manager",
                type: "manager",
                title: "Frontend Sub-Team",
                titleFallback: "Frontend Sub-Team",
                parentThreadId: "thr_root_manager",
              }),
              makeThread({
                id: "thr_nested_child_a",
                title: "Update Timeline Row Types",
                titleFallback: "Update Timeline Row Types",
                parentThreadId: "thr_nested_manager",
              }),
              makeThread({
                id: "thr_nested_child_b",
                title: "Fix Timeline Pagination Bugs",
                titleFallback: "Fix Timeline Pagination Bugs",
                parentThreadId: "thr_nested_manager",
                status: "active",
                runtime: {
                  displayStatus: "active",
                  hostReconnectGraceExpiresAt: null,
                },
              }),
            ],
          },
        })}
      </StoryRow>
      <StoryRow
        label="environment group"
        hint="two unmanaged standard threads sharing one worktree environment — grouped under a worktree header that surfaces the branch"
      >
        {singleProject({
          threadListState: {
            status: "ready",
            threads: [sharedWorktreeThreadA, sharedWorktreeThreadB],
          },
        })}
      </StoryRow>
      <StoryRow
        label="environment starts collapsed"
        hint="worktree header remains visible while child threads are hidden"
      >
        {singleProject({
          initialCollapsedEnvironmentIds: new Set(["env_shared_worktree"]),
          threadListState: {
            status: "ready",
            threads: [sharedWorktreeThreadA, sharedWorktreeThreadB],
          },
        })}
      </StoryRow>
      <StoryRow
        label="multiple projects"
        hint="four projects stacked — active project at the top with a standard thread, manager group, and busy/pending threads; another collapsed with a long truncated name; one with two idle threads; an empty one at the bottom"
      >
        <SidebarStage>
          <SidebarStickyStack>
            <SidebarMenu className="gap-1">
              {multipleProjects.map(({ key, ...args }) => (
                <InteractiveProjectRow key={key} {...args} />
              ))}
            </SidebarMenu>
          </SidebarStickyStack>
        </SidebarStage>
      </StoryRow>
    </StoryCard>
  );
}

// ---------------------------------------------------------------------------
// Full sidebar — three realistic projects expanded together. Helpful for
// eyeballing the vertical rhythm: project↔project separation vs. the tighter
// grouping inside a manager.
// ---------------------------------------------------------------------------

const fullManagerA = makeThread({
  id: "thr_full_a_manager",
  projectId: "proj_full_a",
  type: "manager",
  title: "Codex Manager",
  titleFallback: "Codex Manager",
});

interface FullChildSpec {
  title: string;
  busy?: boolean;
  pending?: boolean;
}

const fullProjectAChildSpecs: FullChildSpec[] = [
  { title: "Implement UI and stories consolidation" },
  { title: "Fix Claude active stop recovery", busy: true },
  { title: "Update React Performance Audit" },
  { title: "Investigate Multiple Hosts Setup", pending: true },
];

const fullProjectAThreads: ThreadListEntry[] = [
  fullManagerA,
  ...fullProjectAChildSpecs.map((spec, index) =>
    makeThread({
      id: `thr_full_a_child_${index}`,
      projectId: "proj_full_a",
      title: spec.title,
      titleFallback: spec.title,
      parentThreadId: fullManagerA.id,
      ...(spec.busy
        ? {
            status: "active",
            runtime: {
              displayStatus: "active",
              hostReconnectGraceExpiresAt: null,
            },
          }
        : {}),
      ...(spec.pending ? { hasPendingInteraction: true } : {}),
    }),
  ),
  makeThread({
    id: "thr_full_a_managed_env_group_1",
    projectId: "proj_full_a",
    title: "Audit recurring permission failures",
    titleFallback: "Audit recurring permission failures",
    parentThreadId: fullManagerA.id,
    environmentId: "env_full_a_codex_train",
    environmentHostId: "host_local",
    environmentBranchName: "bb/squash-merge-ready-app-train-thr_s6fn8fuv9w",
    environmentWorkspaceDisplayKind: "managed-worktree",
  }),
  makeThread({
    id: "thr_full_a_managed_env_group_2",
    projectId: "proj_full_a",
    title: "Investigate ux regression bug",
    titleFallback: "Investigate ux regression bug",
    parentThreadId: fullManagerA.id,
    environmentId: "env_full_a_codex_train",
    environmentHostId: "host_local",
    environmentBranchName: "bb/squash-merge-ready-app-train-thr_s6fn8fuv9w",
    environmentWorkspaceDisplayKind: "managed-worktree",
  }),
  makeThread({
    id: "thr_full_a_standalone_1",
    projectId: "proj_full_a",
    title: "Stabilize Pnpm Dev Environment",
    titleFallback: "Stabilize Pnpm Dev Environment",
    environmentHostId: "host_local",
    environmentBranchName: "main",
    environmentWorkspaceDisplayKind: "managed-worktree",
  }),
  makeThread({
    id: "thr_full_a_standalone_2",
    projectId: "proj_full_a",
    title: "Investigate Laptop Sleep Bug",
    titleFallback: "Investigate Laptop Sleep Bug",
    lastReadAt: 50,
    latestAttentionAt: 200,
  }),
  makeThread({
    id: "thr_full_a_env_group_1",
    projectId: "proj_full_a",
    title: "Wire sidebar env-grouping data shape",
    titleFallback: "Wire sidebar env-grouping data shape",
    environmentId: "env_full_a_sidebar_rail",
    environmentHostId: "host_local",
    environmentBranchName: "bb/fix-diff-panel-issues-thr_u8cnp5fnea",
    environmentWorkspaceDisplayKind: "managed-worktree",
  }),
  makeThread({
    id: "thr_full_a_env_group_2",
    projectId: "proj_full_a",
    title: "Add story for env-grouped sidebar",
    titleFallback: "Add story for env-grouped sidebar",
    environmentId: "env_full_a_sidebar_rail",
    environmentHostId: "host_local",
    environmentBranchName: "bb/fix-diff-panel-issues-thr_u8cnp5fnea",
    environmentWorkspaceDisplayKind: "managed-worktree",
  }),
];

const fullProjectBThreads: ThreadListEntry[] = [
  makeThread({
    id: "thr_full_b_1",
    projectId: "proj_full_b",
    title: "Add Support For System Theme",
    titleFallback: "Add Support For System Theme",
  }),
  makeThread({
    id: "thr_full_b_2",
    projectId: "proj_full_b",
    title: "Investigate User Manual Issue",
    titleFallback: "Investigate User Manual Issue",
    status: "active",
    runtime: {
      displayStatus: "active",
      hostReconnectGraceExpiresAt: null,
    },
  }),
  makeThread({
    id: "thr_full_b_3",
    projectId: "proj_full_b",
    title: "Optimize Dev Database Size",
    titleFallback: "Optimize Dev Database Size",
  }),
];

const fullManagerC = makeThread({
  id: "thr_full_c_manager",
  projectId: "proj_full_c",
  type: "manager",
  title: "Frontend Manager",
  titleFallback: "Frontend Manager",
});

const fullProjectCThreads: ThreadListEntry[] = [
  fullManagerC,
  makeThread({
    id: "thr_full_c_standalone",
    projectId: "proj_full_c",
    title: "Design timeline pagination v2",
    titleFallback: "Design timeline pagination v2",
  }),
];

interface FullProjectEntry extends InteractiveProjectRowArgs {
  key: string;
}

const fullProjects: FullProjectEntry[] = [
  {
    key: "bb",
    project: makeProject({ id: "proj_full_a", name: "bb" }),
    isActive: true,
    threadListState: { status: "ready", threads: fullProjectAThreads },
  },
  {
    key: "pierre",
    project: makeProject({ id: "proj_full_b", name: "pierre" }),
    threadListState: { status: "ready", threads: fullProjectBThreads },
  },
  {
    key: "ingest",
    project: makeProject({ id: "proj_full_c", name: "ingest-pipeline" }),
    threadListState: { status: "ready", threads: fullProjectCThreads },
  },
];

const noop = () => {};

export function Full() {
  return (
    <StoryCard>
      <StoryRow
        label="full sidebar"
        hint="action buttons + three projects: bb (active) with a manager that has 4 loose children + a 2-thread env sub-group, plus 2 standalones and a 2-thread project-level env group; pierre with 3 standalones; ingest-pipeline with a manager + 1 standalone"
      >
        <SidebarStage>
          <div className="px-2 pb-2">
            <ProjectListActionButtons
              onNewChat={noop}
              onNewManager={noop}
              selectedProjectId="proj_full_a"
              isManagerActionPending={false}
            />
          </div>
          <ProjectListShell onNewProject={noop}>
            {fullProjects.map(({ key, ...args }) => (
              <InteractiveProjectRow key={key} {...args} />
            ))}
          </ProjectListShell>
        </SidebarStage>
      </StoryRow>
    </StoryCard>
  );
}
