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
import { SidebarStickyStack } from "@/components/ui/sidebar.js";
import { ProjectActionsProvider } from "@/components/project/ProjectActionsProvider";
import { ThreadActionsProvider } from "@/components/thread/ThreadActionsProvider";
import { ProjectListShell } from "./ProjectList";
import type { ProjectThreadListState } from "./ProjectRow";
import {
  ProjectListProjects,
  type ProjectListRowModel,
} from "./ProjectListProjects";
import { compareStandardThreads } from "@bb/client-core";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";

export default {
  title: "sidebar/Projects",
};

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

const makeProject = (overrides: Partial<ProjectResponse> = {}) =>
  makeSharedProject({ id: PROJECT_IDS.bb, name: "bb", ...overrides });

const makeThread = (overrides: Partial<ThreadListEntry> = {}) =>
  makeThreadListEntry({ id: "thr_default", ...overrides });

type ToggleStoryCollapsedId = (id: string) => void;

function toggleStoryCollapsedId(
  current: ReadonlySet<string>,
  id: string,
): Set<string> {
  const next = new Set(current);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  return next;
}

interface StoryProjectRow {
  project?: ProjectResponse;
  threadListState: ProjectThreadListState;
  isActive?: boolean;
  isLocalPathInvalid?: boolean;
  initiallyCollapsed?: boolean;
}

interface InteractiveProjectListArgs {
  rows: StoryProjectRow[];
  initialCollapsedThreadIds?: ReadonlySet<string>;
  initialCollapsedEnvironmentIds?: ReadonlySet<string>;
}

function InteractiveProjectList({
  rows,
  initialCollapsedThreadIds,
  initialCollapsedEnvironmentIds,
}: InteractiveProjectListArgs) {
  const resolvedRows: ProjectListRowModel[] = rows.map((row) => ({
    project: row.project ?? makeProject(),
    threadListState: row.threadListState,
    isActive: row.isActive ?? false,
    isLocalPathInvalid: row.isLocalPathInvalid ?? false,
  }));
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(
    () =>
      new Set(
        rows.flatMap((row, index) =>
          row.initiallyCollapsed ? [resolvedRows[index].project.id] : [],
        ),
      ),
  );
  const [collapsedThreadIds, setCollapsedThreadIds] = useState<Set<string>>(
    () => new Set(initialCollapsedThreadIds ?? []),
  );
  const [collapsedEnvironmentIds, setCollapsedEnvironmentIds] = useState<
    Set<string>
  >(() => new Set(initialCollapsedEnvironmentIds ?? []));
  const onToggleProjectCollapsed = useCallback<ToggleStoryCollapsedId>((id) => {
    setCollapsedProjectIds((current) => toggleStoryCollapsedId(current, id));
  }, []);
  const onToggleThreadCollapsed = useCallback<ToggleStoryCollapsedId>((id) => {
    setCollapsedThreadIds((current) => toggleStoryCollapsedId(current, id));
  }, []);
  const onToggleEnvironmentCollapsed = useCallback<ToggleStoryCollapsedId>(
    (id) => {
      setCollapsedEnvironmentIds((current) =>
        toggleStoryCollapsedId(current, id),
      );
    },
    [],
  );
  return (
    <ProjectListProjects
      status="ready"
      rows={resolvedRows}
      progressiveDisclosureEnabled
      collapsedProjectIds={collapsedProjectIds}
      collapsedThreadIds={collapsedThreadIds}
      collapsedEnvironmentIds={collapsedEnvironmentIds}
      compareThreads={compareStandardThreads}
      onCreateProjectThread={noop}
      onToggleProjectCollapsed={onToggleProjectCollapsed}
      onToggleThreadCollapsed={onToggleThreadCollapsed}
      onToggleEnvironmentCollapsed={onToggleEnvironmentCollapsed}
    />
  );
}

interface SingleProjectArgs {
  project?: ProjectResponse;
  threadListState: ProjectThreadListState;
  initialCollapsed?: boolean;
  initialCollapsedThreadIds?: ReadonlySet<string>;
  initialCollapsedEnvironmentIds?: ReadonlySet<string>;
  isActive?: boolean;
  isLocalPathInvalid?: boolean;
}

function singleProject({
  project,
  threadListState,
  initialCollapsed,
  initialCollapsedThreadIds,
  initialCollapsedEnvironmentIds,
  isActive,
  isLocalPathInvalid,
}: SingleProjectArgs) {
  return (
    <SidebarStage>
      <SidebarStickyStack>
        <InteractiveProjectList
          rows={[
            {
              project,
              threadListState,
              isActive,
              isLocalPathInvalid,
              initiallyCollapsed: initialCollapsed,
            },
          ]}
          initialCollapsedThreadIds={initialCollapsedThreadIds}
          initialCollapsedEnvironmentIds={initialCollapsedEnvironmentIds}
        />
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
const rootThread = makeThread({
  id: "thr_root",
  title: "Stabilize Pnpm Dev Environment",
  titleFallback: "Stabilize Pnpm Dev Environment",
  environmentHostId: HOST_IDS.local,
  environmentBranchName: BRANCH_NAMES.default,
  queuedWork: "none",
  environmentWorkspaceDisplayKind: "managed-worktree",
});
const sharedWorktreeThreadA = makeThread({
  id: "thr_shared_wt_a",
  title: "Refactor timeline row types",
  titleFallback: "Refactor timeline row types",
  environmentId: "env_shared_worktree",
  environmentHostId: HOST_IDS.local,
  environmentBranchName: "bb/set-default-tab-for-panel-thr_vnj2qze4fg",
  queuedWork: "none",
  environmentWorkspaceDisplayKind: "managed-worktree",
});
const sharedWorktreeThreadB = makeThread({
  id: "thr_shared_wt_b",
  title: "Add story for env-grouped sidebar",
  titleFallback: "Add story for env-grouped sidebar",
  environmentId: "env_shared_worktree",
  environmentHostId: HOST_IDS.local,
  environmentBranchName: "bb/set-default-tab-for-panel-thr_vnj2qze4fg",
  queuedWork: "none",
  environmentWorkspaceDisplayKind: "managed-worktree",
});
const parentThread = makeThread({
  id: "thr_parent",
  title: "Frontend Parent",
  titleFallback: "Frontend Parent",
});
const parentChildA = makeThread({
  id: "thr_parent_child_a",
  title: "Update Timeline Row Types",
  titleFallback: "Update Timeline Row Types",
  parentThreadId: parentThread.id,
});
const parentChildB = makeThread({
  id: "thr_parent_child_b",
  title: "Fix Timeline Pagination Bugs",
  titleFallback: "Fix Timeline Pagination Bugs",
  parentThreadId: parentThread.id,
  status: "active",
  runtime: {
    displayStatus: "active",
    hostReconnectGraceExpiresAt: null,
  },
});
const deepRootParent = makeThread({
  id: "thr_deep_root_parent",
  title: "Prototype Parent",
  titleFallback: "Prototype Parent",
});
const deepIntermediateParent = makeThread({
  id: "thr_deep_intermediate_parent",
  title: "Sidebar Parent Thread",
  titleFallback: "Sidebar Parent Thread",
  parentThreadId: deepRootParent.id,
});
const deepParentChild = makeThread({
  id: "thr_deep_parent_child",
  title: "Child With Its Own Children",
  titleFallback: "Child With Its Own Children",
  parentThreadId: deepIntermediateParent.id,
});
const deepNestedParent = makeThread({
  id: "thr_deep_nested_parent",
  title: "Nested Parent Marker",
  titleFallback: "Nested Parent Marker",
  parentThreadId: deepParentChild.id,
});
const deepNestedParentChild = makeThread({
  id: "thr_deep_nested_parent_child",
  title: "Beyond The Sticky Cap",
  titleFallback: "Beyond The Sticky Cap",
  parentThreadId: deepNestedParent.id,
});
const deepWorktreeA = makeThread({
  id: "thr_deep_worktree_a",
  title: "Worktree Thread A",
  titleFallback: "Worktree Thread A",
  parentThreadId: deepIntermediateParent.id,
  environmentId: "env_deep_worktree",
  environmentHostId: HOST_IDS.local,
  environmentBranchName: "bb/sidebar-parent-child-nesting",
  queuedWork: "none",
  environmentWorkspaceDisplayKind: "managed-worktree",
});
const deepWorktreeB = makeThread({
  id: "thr_deep_worktree_b",
  title: "Worktree Thread B",
  titleFallback: "Worktree Thread B",
  parentThreadId: deepIntermediateParent.id,
  environmentId: "env_deep_worktree",
  environmentHostId: HOST_IDS.local,
  environmentBranchName: "bb/sidebar-parent-child-nesting",
  queuedWork: "none",
  environmentWorkspaceDisplayKind: "managed-worktree",
  hasPendingInteraction: true,
});

const multipleProjects: StoryProjectRow[] = [
  {
    project: makeProject({ id: "proj_bb", name: "bb" }),
    isActive: true,
    threadListState: {
      status: "ready",
      threads: [
        { ...rootThread, projectId: "proj_bb" },
        { ...parentThread, projectId: "proj_bb" },
        { ...parentChildA, projectId: "proj_bb" },
        { ...parentChildB, projectId: "proj_bb" },
        { ...busyThread, projectId: "proj_bb" },
        { ...pendingThread, projectId: "proj_bb" },
      ],
    },
  },
  {
    project: makeProject({
      id: "proj_pierre",
      name: "pierre — long project name that should truncate cleanly",
    }),
    initiallyCollapsed: true,
    threadListState: {
      status: "ready",
      threads: [{ ...idleThread, projectId: "proj_pierre" }],
    },
  },
  {
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
    project: makeProject({ id: "proj_empty", name: "fresh-experiment" }),
    threadListState: { status: "ready", threads: [] },
  },
];

export function Overview() {
  return (
    <StoryCard>
      <StoryRow label="ready, no threads" hint='empty state: "No threads"'>
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
        hint="children hidden by default — click the section to expand"
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
        label="collapsed project — child working"
        hint="collapsed project header right-aligns the hidden child activity in the trailing slot"
      >
        {singleProject({
          initialCollapsed: true,
          threadListState: {
            status: "ready",
            threads: [
              makeThread({
                id: "thr_collapsed_project_busy",
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
        label="collapsed project — child plan mode"
        hint="collapsed project header right-aligns the hidden child plan-mode glyph"
      >
        {singleProject({
          initialCollapsed: true,
          threadListState: {
            status: "ready",
            threads: [
              makeThread({
                id: "thr_collapsed_project_plan",
                activity: {
                  activeWorkflowCount: 0,
                  activeBackgroundAgentCount: 0,
                  activeBackgroundCommandCount: 0,
                  activePlanModeCount: 1,
                  activeGoalCount: 0,
                },
              }),
            ],
          },
        })}
      </StoryRow>
      <StoryRow
        label="active project route"
        hint="active project header stays static; only the chevron and row actions hover"
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
        label="parent + root"
        hint="ProjectRow nests child threads under their parent — click the parent chevron to collapse its children"
      >
        {singleProject({
          threadListState: {
            status: "ready",
            threads: [parentThread, parentChildA, parentChildB, idleThread],
          },
        })}
      </StoryRow>
      <StoryRow
        label="deep parent nesting"
        hint="nested parent threads past the sticky cap (4 levels), with a worktree group nested below a parent thread — scroll to see the deepest parent within the cap pin while the row past it stays loose"
      >
        {singleProject({
          threadListState: {
            status: "ready",
            threads: [
              deepRootParent,
              deepIntermediateParent,
              deepParentChild,
              deepNestedParent,
              deepNestedParentChild,
              deepWorktreeA,
              deepWorktreeB,
            ],
          },
        })}
      </StoryRow>
      <StoryRow
        label="parent starts collapsed"
        hint="children hidden by default"
      >
        {singleProject({
          initialCollapsedThreadIds: new Set([parentThread.id]),
          threadListState: {
            status: "ready",
            threads: [parentThread, parentChildA, parentChildB],
          },
        })}
      </StoryRow>
      <StoryRow
        label="environment group"
        hint="two root threads sharing one worktree environment — grouped under a worktree header that surfaces the branch"
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
        label="collapsed parent — child needs input"
        hint="trailing grey question icon surfaces a hidden child blocked on the user"
      >
        {singleProject({
          initialCollapsedThreadIds: new Set([parentThread.id]),
          threadListState: {
            status: "ready",
            threads: [
              parentThread,
              parentChildA,
              { ...parentChildB, hasPendingInteraction: true },
            ],
          },
        })}
      </StoryRow>
      <StoryRow
        label="collapsed parent — needs input + working"
        hint="one child blocked, another running: input needed wins, trailing slot shows the grey question icon"
      >
        {singleProject({
          initialCollapsedThreadIds: new Set([parentThread.id]),
          threadListState: {
            status: "ready",
            threads: [
              parentThread,
              { ...parentChildA, hasPendingInteraction: true },
              parentChildB,
            ],
          },
        })}
      </StoryRow>
      <StoryRow
        label="collapsed worktree — child working"
        hint="trailing slot shows the Loading03 working spinner when a hidden child is working"
      >
        {singleProject({
          initialCollapsedEnvironmentIds: new Set(["env_collapsed_busy"]),
          threadListState: {
            status: "ready",
            threads: [
              {
                ...sharedWorktreeThreadA,
                environmentId: "env_collapsed_busy",
                status: "active",
                runtime: {
                  displayStatus: "active",
                  hostReconnectGraceExpiresAt: null,
                },
              },
              { ...sharedWorktreeThreadB, environmentId: "env_collapsed_busy" },
            ],
          },
        })}
      </StoryRow>
      <StoryRow
        label="collapsed worktree — child goal"
        hint="trailing slot shows the target glyph when a hidden child has an active goal banner"
      >
        {singleProject({
          initialCollapsedEnvironmentIds: new Set(["env_collapsed_goal"]),
          threadListState: {
            status: "ready",
            threads: [
              {
                ...sharedWorktreeThreadA,
                id: "thr_collapsed_worktree_goal",
                environmentId: "env_collapsed_goal",
                activity: {
                  activeWorkflowCount: 0,
                  activeBackgroundAgentCount: 0,
                  activeBackgroundCommandCount: 0,
                  activePlanModeCount: 0,
                  activeGoalCount: 1,
                },
              },
              { ...sharedWorktreeThreadB, environmentId: "env_collapsed_goal" },
            ],
          },
        })}
      </StoryRow>
      <StoryRow
        label="collapsed worktree — unread child"
        hint="surfaces like a regular unread thread — the trailing slot shows the done dot"
      >
        {singleProject({
          initialCollapsedEnvironmentIds: new Set(["env_collapsed_unread"]),
          threadListState: {
            status: "ready",
            threads: [
              {
                ...sharedWorktreeThreadA,
                environmentId: "env_collapsed_unread",
                lastReadAt: 50,
                latestAttentionAt: 200,
              },
              {
                ...sharedWorktreeThreadB,
                environmentId: "env_collapsed_unread",
              },
            ],
          },
        })}
      </StoryRow>
      <StoryRow
        label="collapsed worktree — unread error child"
        hint="hidden child status=error and unread — worktree header shows the destructive failure icon"
      >
        {singleProject({
          initialCollapsedEnvironmentIds: new Set(["env_collapsed_error"]),
          threadListState: {
            status: "ready",
            threads: [
              {
                ...sharedWorktreeThreadA,
                environmentId: "env_collapsed_error",
                status: "error",
                lastReadAt: 50,
                latestAttentionAt: 200,
              },
              {
                ...sharedWorktreeThreadB,
                environmentId: "env_collapsed_error",
              },
            ],
          },
        })}
      </StoryRow>
      <StoryRow
        label="multiple projects"
        hint="four projects stacked — active project at the top with a root thread, parent group, and busy/pending threads; another collapsed with a long truncated name; one with two idle threads; an empty one at the bottom"
      >
        <SidebarStage>
          <SidebarStickyStack>
            <InteractiveProjectList rows={multipleProjects} />
          </SidebarStickyStack>
        </SidebarStage>
      </StoryRow>
    </StoryCard>
  );
}

const fullParentA = makeThread({
  id: "thr_full_a_parent",
  projectId: "proj_full_a",
  title: "Codex Parent",
  titleFallback: "Codex Parent",
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
  fullParentA,
  ...fullProjectAChildSpecs.map((spec, index) =>
    makeThread({
      id: `thr_full_a_child_${index}`,
      projectId: "proj_full_a",
      title: spec.title,
      titleFallback: spec.title,
      parentThreadId: fullParentA.id,
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
    id: "thr_full_a_worktree_env_group_1",
    projectId: "proj_full_a",
    title: "Audit recurring permission failures",
    titleFallback: "Audit recurring permission failures",
    parentThreadId: fullParentA.id,
    environmentId: "env_full_a_codex_train",
    environmentHostId: "host_local",
    environmentBranchName: "bb/ready-app-train-thr_s6fn8fuv9w",
    queuedWork: "none",
    environmentWorkspaceDisplayKind: "managed-worktree",
  }),
  makeThread({
    id: "thr_full_a_worktree_env_group_2",
    projectId: "proj_full_a",
    title: "Investigate ux regression bug",
    titleFallback: "Investigate ux regression bug",
    parentThreadId: fullParentA.id,
    environmentId: "env_full_a_codex_train",
    environmentHostId: "host_local",
    environmentBranchName: "bb/ready-app-train-thr_s6fn8fuv9w",
    queuedWork: "none",
    environmentWorkspaceDisplayKind: "managed-worktree",
  }),
  makeThread({
    id: "thr_full_a_standalone_1",
    projectId: "proj_full_a",
    title: "Stabilize Pnpm Dev Environment",
    titleFallback: "Stabilize Pnpm Dev Environment",
    environmentHostId: "host_local",
    environmentBranchName: "main",
    queuedWork: "none",
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
    queuedWork: "none",
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
    queuedWork: "none",
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

const fullParentC = makeThread({
  id: "thr_full_c_parent",
  projectId: "proj_full_c",
  title: "Frontend Parent",
  titleFallback: "Frontend Parent",
});

const fullProjectCThreads: ThreadListEntry[] = [
  fullParentC,
  makeThread({
    id: "thr_full_c_standalone",
    projectId: "proj_full_c",
    title: "Design timeline pagination v2",
    titleFallback: "Design timeline pagination v2",
  }),
];

const fullProjects: StoryProjectRow[] = [
  {
    project: makeProject({ id: "proj_full_a", name: "bb" }),
    isActive: true,
    threadListState: { status: "ready", threads: fullProjectAThreads },
  },
  {
    project: makeProject({ id: "proj_full_b", name: "pierre" }),
    threadListState: { status: "ready", threads: fullProjectBThreads },
  },
  {
    project: makeProject({ id: "proj_full_c", name: "ingest-pipeline" }),
    threadListState: { status: "ready", threads: fullProjectCThreads },
  },
];

const noop = () => {};

export function MultipleProjects() {
  return (
    <StoryCard>
      <StoryRow
        label="projects list — three projects"
        hint="the Projects section only (no Pinned/Threads/Apps): bb (active) with a parent that has 4 loose children + a 2-thread env sub-group, plus 2 standalones and a 2-thread project-level env group; pierre with 3 standalones; ingest-pipeline with a parent + 1 standalone"
      >
        <SidebarStage>
          <ProjectListShell>
            <InteractiveProjectList rows={fullProjects} />
          </ProjectListShell>
        </SidebarStage>
      </StoryRow>
    </StoryCard>
  );
}
