import {
  Suspense,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import {
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from "@tanstack/react-query";
import { createStore, Provider } from "jotai";
import { PERSONAL_PROJECT_ID } from "@bb/domain";
import type { SidebarBootstrapResponse } from "@bb/server-contract";
import {
  BRANCH_NAMES,
  HOST_IDS,
  HOST_NAMES,
  makeHost,
  makeProject,
  makeThreadListEntry,
} from "../../../.ladle/story-fixtures";
import { ProjectActionsProvider } from "@/components/project/ProjectActionsProvider";
import { ThreadActionsProvider } from "@/components/thread/ThreadActionsProvider";
import { Icon } from "@bb/shared-ui/icon";
import {
  ProjectList,
  ProjectListActionButtons,
  ProjectListNavigationLoadingState,
  ProjectListShell,
} from "./ProjectList";
import {
  hostsQueryKey,
  sidebarNavigationQueryKey,
} from "@/hooks/queries/query-keys";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";
import { PluginNavSidebarItems } from "@/components/plugin/PluginNavSidebarItems";
import {
  removePluginSlotRegistrations,
  setPluginSlotRegistrations,
  type PluginRegistrationSet,
} from "@/lib/plugin-slots";
import {
  AUTOMATIONS_PLUGIN_ID,
  AUTOMATIONS_PLUGIN_PANEL_PATH,
} from "@/lib/route-paths";
import { splitLayoutAtom } from "@/lib/split-layout/atoms";
import {
  SIDEBAR_ORGANIZATION_MODE_STORAGE_KEY,
  sidebarOrganizationModeAtom,
  type SidebarOrganizationMode,
} from "./sidebarCollapsedAtoms";
import { makePluginRegistrationSet } from "@/test/fixtures/plugins";
import {
  makeProjectWithThreadsResponse,
  makeSidebarBootstrapResponse,
} from "@/test/fixtures/projects";

export default {
  title: "Sidebar/Overview",
};

interface SidebarFrameProps {
  children: ReactNode;
}

const noop = () => {};
const SIDEBAR_NAVIGATION_STORY_QUERY_KEY = sidebarNavigationQueryKey();

const bbProject = makeProject({
  id: "proj_story_bb",
  name: "bb",
});
const docsProject = makeProject({
  id: "proj_story_docs",
  name: "docs-app",
});
const personalProject = makeProject({
  id: PERSONAL_PROJECT_ID,
  kind: "personal",
  name: "Personal",
});

const loadedSidebarNavigation = makeSidebarBootstrapResponse({
  personalProject: makeProjectWithThreadsResponse({
    ...personalProject,
    threads: [
      makeThreadListEntry({
        id: "thr_story_personal",
        projectId: PERSONAL_PROJECT_ID,
        title: "Sketch launch checklist",
        titleFallback: "Sketch launch checklist",
        latestAttentionAt: 85,
        createdAt: 85,
        updatedAt: 85,
      }),
      makeThreadListEntry({
        id: "thr_story_personal_parent",
        projectId: PERSONAL_PROJECT_ID,
        title: "Investigate flaky timeline test",
        titleFallback: "Investigate flaky timeline test",
        latestAttentionAt: 80,
        createdAt: 80,
        updatedAt: 80,
      }),
      makeThreadListEntry({
        id: "thr_story_personal_child",
        projectId: PERSONAL_PROJECT_ID,
        parentThreadId: "thr_story_personal_parent",
        title: "Add Mutex to Watcher",
        titleFallback: "Add Mutex to Watcher",
        latestAttentionAt: 75,
        createdAt: 75,
        updatedAt: 75,
      }),
    ],
  }),
  projects: [
    makeProjectWithThreadsResponse({
      ...bbProject,
      threads: [
        makeThreadListEntry({
          id: "thr_story_pinned",
          projectId: bbProject.id,
          title: "Improve sidebar loading state",
          titleFallback: "Improve sidebar loading state",
          pinnedAt: 200,
          pinSortKey: "0001",
          latestAttentionAt: 200,
          createdAt: 200,
          updatedAt: 200,
        }),
        makeThreadListEntry({
          id: "thr_story_pinned_child",
          projectId: bbProject.id,
          parentThreadId: "thr_story_pinned",
          title: "Verify Ladle coverage",
          titleFallback: "Verify Ladle coverage",
          latestAttentionAt: 190,
          createdAt: 190,
          updatedAt: 190,
        }),
        makeThreadListEntry({
          id: "thr_story_active",
          projectId: bbProject.id,
          title: "Ship realtime sidebar updates",
          titleFallback: "Ship realtime sidebar updates",
          status: "active",
          runtime: {
            displayStatus: "active",
            hostReconnectGraceExpiresAt: null,
          },
          latestAttentionAt: 180,
          createdAt: 180,
          updatedAt: 180,
        }),
        makeThreadListEntry({
          id: "thr_story_ancestor",
          projectId: bbProject.id,
          title: "Rework the command palette",
          titleFallback: "Rework the command palette",
          latestAttentionAt: 176,
          createdAt: 176,
          updatedAt: 176,
        }),
        makeThreadListEntry({
          id: "thr_story_ancestor_child",
          projectId: bbProject.id,
          parentThreadId: "thr_story_ancestor",
          title: "Wire async command loading",
          titleFallback: "Wire async command loading",
          latestAttentionAt: 175,
          createdAt: 175,
          updatedAt: 175,
        }),
        makeThreadListEntry({
          id: "thr_story_worktree_a",
          projectId: bbProject.id,
          environmentId: "env_story_sidebar",
          environmentName: "Sidebar polish",
          environmentBranchName: BRANCH_NAMES.feature,
          queuedWork: "none",
          environmentWorkspaceDisplayKind: "managed-worktree",
          title: "Tighten loading skeleton",
          titleFallback: "Tighten loading skeleton",
          latestAttentionAt: 170,
          createdAt: 170,
          updatedAt: 170,
        }),
        makeThreadListEntry({
          id: "thr_story_worktree_b",
          projectId: bbProject.id,
          environmentId: "env_story_sidebar",
          environmentName: "Sidebar polish",
          environmentBranchName: BRANCH_NAMES.feature,
          queuedWork: "none",
          environmentWorkspaceDisplayKind: "managed-worktree",
          title: "Audit sidebar stories",
          titleFallback: "Audit sidebar stories",
          hasPendingInteraction: true,
          latestAttentionAt: 160,
          createdAt: 160,
          updatedAt: 160,
        }),
      ],
    }),
    makeProjectWithThreadsResponse({
      ...docsProject,
      threads: [
        makeThreadListEntry({
          id: "thr_story_docs",
          projectId: docsProject.id,
          title: "Refresh onboarding docs",
          titleFallback: "Refresh onboarding docs",
          latestAttentionAt: 120,
          createdAt: 120,
          updatedAt: 120,
        }),
      ],
    }),
  ],
});

const emptySidebarNavigation = {
  ...loadedSidebarNavigation,
  personalProject: {
    ...loadedSidebarNavigation.personalProject,
    threads: [],
  },
  projects: loadedSidebarNavigation.projects.map((project) => ({
    ...project,
    threads: [],
  })),
} satisfies SidebarBootstrapResponse;

const machineStoryHosts = [
  makeHost(),
  makeHost({ id: HOST_IDS.remote, name: HOST_NAMES.remote }),
];

const machineSidebarNavigation = {
  ...loadedSidebarNavigation,
  personalProject: {
    ...loadedSidebarNavigation.personalProject,
    threads: loadedSidebarNavigation.personalProject.threads.map((thread) => ({
      ...thread,
      environmentHostId: HOST_IDS.local,
    })),
  },
  projects: loadedSidebarNavigation.projects.map((project) => ({
    ...project,
    threads: project.threads.map((thread) => ({
      ...thread,
      environmentHostId:
        project.id === docsProject.id ? HOST_IDS.remote : HOST_IDS.local,
    })),
  })),
} satisfies SidebarBootstrapResponse;

function SidebarFrame({ children }: SidebarFrameProps) {
  return (
    <ProjectActionsProvider>
      <ThreadActionsProvider>
        <div className="flex h-[680px] w-full max-w-[320px] min-w-0 flex-col overflow-hidden rounded-md border border-sidebar-border bg-sidebar text-sidebar-foreground shadow-sm">
          <div className="shrink-0 px-2 py-2">
            <ProjectListActionButtons onNewChat={noop} />
          </div>
          {}
          <PluginNavSidebarItems />
          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
          <div className="shrink-0 border-t border-sidebar-border/70 px-2 py-2">
            <button
              type="button"
              aria-label="Settings"
              title="Settings"
              className="flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none ring-sidebar-ring transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2"
            >
              <Icon name="Settings" className="size-4" />
            </button>
          </div>
        </div>
      </ThreadActionsProvider>
    </ProjectActionsProvider>
  );
}

function LoadingSidebar() {
  return (
    <ProjectListShell>
      <ProjectListNavigationLoadingState />
    </ProjectListShell>
  );
}

function LoadedSidebar({
  hosts,
  navigation = loadedSidebarNavigation,
}: {
  hosts?: typeof machineStoryHosts;
  navigation?: SidebarBootstrapResponse;
}) {
  const queryClient = useQueryClient();
  const [isSeeded, setIsSeeded] = useState(false);

  useEffect(() => {
    queryClient.setQueryData(SIDEBAR_NAVIGATION_STORY_QUERY_KEY, navigation);
    if (hosts) {
      queryClient.setQueryData(hostsQueryKey(), hosts);
    }
    setIsSeeded(true);

    return () => {
      queryClient.removeQueries({
        queryKey: SIDEBAR_NAVIGATION_STORY_QUERY_KEY,
        exact: true,
      });
      if (hosts) {
        queryClient.removeQueries({
          queryKey: hostsQueryKey(),
          exact: true,
        });
      }
    };
  }, [hosts, navigation, queryClient]);

  if (!isSeeded) {
    return <LoadingSidebar />;
  }

  return (
    <Suspense fallback={<LoadingSidebar />}>
      <ProjectList onNewProject={noop} onProjectSelect={noop} />
    </Suspense>
  );
}

function registrationSet(
  navPanels: PluginRegistrationSet["navPanels"],
): PluginRegistrationSet {
  return makePluginRegistrationSet({
    navPanels,
  });
}

function StoryPluginPageRegistrations() {
  useEffect(() => {
    const pluginPages = [
      {
        pluginId: AUTOMATIONS_PLUGIN_ID,
        panel: {
          id: AUTOMATIONS_PLUGIN_PANEL_PATH,
          title: "Automations",
          icon: "TimeSchedule" as const,
          path: AUTOMATIONS_PLUGIN_PANEL_PATH,
          component: () => null,
        },
      },
      {
        pluginId: "github",
        panel: {
          id: "github",
          title: "GitHub",
          icon: "Github" as const,
          path: "github",
          component: () => null,
        },
      },
      {
        pluginId: "docs",
        panel: {
          id: "docs",
          title: "Docs",
          icon: "FileText" as const,
          path: "docs",
          component: () => null,
        },
      },
      {
        pluginId: "tasks",
        panel: {
          id: "tasks",
          title: "Tasks",
          icon: "ListTodo" as const,
          path: "tasks",
          component: () => null,
        },
      },
    ];

    for (const { pluginId, panel } of pluginPages) {
      setPluginSlotRegistrations(pluginId, registrationSet([panel]));
    }

    return () => {
      for (const { pluginId } of pluginPages) {
        removePluginSlotRegistrations(pluginId);
      }
    };
  }, []);
  return null;
}

function LoadedSidebarWithPluginPages() {
  const [store] = useState(() => createStore());
  return (
    <Provider store={store}>
      <StoryPluginPageRegistrations />
      <SidebarFrame>
        <LoadedSidebar />
      </SidebarFrame>
    </Provider>
  );
}

function OrganizationSidebar({
  hosts,
  mode,
  navigation,
}: {
  hosts?: typeof machineStoryHosts;
  mode: SidebarOrganizationMode;
  navigation?: SidebarBootstrapResponse;
}) {
  const [store] = useState(() => createStore());
  const [isModeSeeded, setIsModeSeeded] = useState(false);
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: false,
          },
        },
      }),
  );

  useLayoutEffect(() => {
    setIsModeSeeded(false);

    let localStorage: Storage | null = null;
    let persistedMode: string | null = null;

    if (typeof window !== "undefined") {
      try {
        localStorage = window.localStorage;
        persistedMode = localStorage.getItem(
          SIDEBAR_ORGANIZATION_MODE_STORAGE_KEY,
        );
      } catch {
        localStorage = null;
      }
    }

    const unsubscribe = store.sub(sidebarOrganizationModeAtom, noop);

    try {
      store.set(sidebarOrganizationModeAtom, mode);
    } finally {
      if (localStorage) {
        try {
          if (persistedMode === null) {
            localStorage.removeItem(SIDEBAR_ORGANIZATION_MODE_STORAGE_KEY);
          } else {
            localStorage.setItem(
              SIDEBAR_ORGANIZATION_MODE_STORAGE_KEY,
              persistedMode,
            );
          }
        } catch {}
      }
    }

    setIsModeSeeded(true);

    return unsubscribe;
  }, [mode, store]);

  return (
    <Provider store={store}>
      <QueryClientProvider client={queryClient}>
        <SidebarFrame>
          {isModeSeeded ? (
            <LoadedSidebar hosts={hosts} navigation={navigation} />
          ) : (
            <LoadingSidebar />
          )}
        </SidebarFrame>
      </QueryClientProvider>
    </Provider>
  );
}

export function Overview() {
  return (
    <StoryCard labelWidth="120px">
      <StoryRow label="loading">
        <SidebarFrame>
          <LoadingSidebar />
        </SidebarFrame>
      </StoryRow>
      <StoryRow label="loaded">
        <SidebarFrame>
          <LoadedSidebar />
        </SidebarFrame>
      </StoryRow>
    </StoryCard>
  );
}

export function PluginPages() {
  return (
    <StoryCard labelWidth="120px">
      <StoryRow
        label="expanded"
        hint="all shipped plugin navigation above the real thread list"
      >
        <LoadedSidebarWithPluginPages />
      </StoryRow>
    </StoryCard>
  );
}

export function OrganizationModes() {
  return (
    <StoryCard
      labelWidth="120px"
      columns={["Populated", "No threads"]}
      className="min-w-max items-start"
    >
      <StoryRow label="By project">
        <OrganizationSidebar
          mode="project"
          navigation={loadedSidebarNavigation}
        />
        <OrganizationSidebar
          mode="project"
          navigation={emptySidebarNavigation}
        />
      </StoryRow>
      <StoryRow label="Manually">
        <OrganizationSidebar
          mode="chronological"
          navigation={loadedSidebarNavigation}
        />
        <OrganizationSidebar
          mode="chronological"
          navigation={emptySidebarNavigation}
        />
      </StoryRow>
      <StoryRow label="By machine">
        <OrganizationSidebar
          mode="machine"
          hosts={machineStoryHosts}
          navigation={machineSidebarNavigation}
        />
        <OrganizationSidebar
          mode="machine"
          hosts={machineStoryHosts}
          navigation={emptySidebarNavigation}
        />
      </StoryRow>
    </StoryCard>
  );
}

export function SplitPageLabels() {
  const [store] = useState(createStore);

  useEffect(() => {
    store.set(splitLayoutAtom, {
      focusedPaneId: "pane-plugin",
      root: {
        type: "split",
        dir: "row",
        sizes: [0.5, 0.5],
        children: [
          {
            type: "pane",
            paneId: "pane-compose",
            content: { kind: "new-thread" },
          },
          {
            type: "pane",
            paneId: "pane-plugin",
            content: {
              kind: "plugin-panel",
              pluginId: "story-split-page",
              panelPath: "notes",
              subPath: "",
            },
          },
        ],
      },
    });
    setPluginSlotRegistrations(
      "story-split-page",
      makePluginRegistrationSet({
        navPanels: [
          {
            id: "notes",
            title: "Project notes",
            icon: "FileText",
            path: "notes",
            component: () => null,
          },
        ],
        threadPanelActions: [],
        composerCustomizations: [],
        pendingInteractions: [],
        sidebarFooterActions: [],
        fileOpeners: [],
      }),
    );

    return () => {
      store.set(splitLayoutAtom, null);
      removePluginSlotRegistrations("story-split-page");
    };
  }, [store]);

  return (
    <Provider store={store}>
      <StoryCard>
        <StoryRow
          label="non-thread pages"
          hint="each pane mini-map sits directly beside its page label"
        >
          <div className="w-full max-w-[320px] rounded-md bg-sidebar py-2 text-sidebar-foreground">
            <div className="px-2">
              <ProjectListActionButtons
                splitEnabled
                newThreadSplit={{ openInSplit: noop }}
                onNewChat={noop}
              />
            </div>
            <PluginNavSidebarItems splitEnabled />
          </div>
        </StoryRow>
      </StoryCard>
    </Provider>
  );
}
