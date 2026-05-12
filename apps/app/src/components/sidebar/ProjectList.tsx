import { memo, useCallback, useMemo } from "react";
import { useAtom } from "jotai";
import {
  useQueries,
  type QueryFunctionContext,
  type UseQueryResult,
} from "@tanstack/react-query";
import {
  findLocalPathProjectSourceForHost,
  type ThreadListEntry,
} from "@bb/domain";
import type { ProjectSourceWorkspaceStatusResponse } from "@bb/server-contract";
import { Folder, MessageSquarePlus, Plus, UserRoundPlus } from "lucide-react";
import { useLocation } from "react-router-dom";
import {
  getConnectionAwareQueryState,
  useConnectionAwareQueryState,
  useServerConnectionGracePeriodElapsed,
  type ConnectionAwareQueryStatus,
} from "@/hooks/queries/connection-aware-query-state";
import { useProjects } from "@/hooks/queries/project-queries";
import {
  isLocalPathMissing,
  useLocalPathExistence,
} from "@/hooks/queries/host-path-queries";
import {
  projectSourceWorkspaceStatusQueryKey,
  threadListQueryKey,
  type ThreadListQueryKey,
} from "@/hooks/queries/query-keys";
import { useHostDaemon } from "@/hooks/useHostDaemon";
import { useServerConnectionState } from "@/hooks/useServerConnectionState";
import type { WebSocketConnectionState } from "@/lib/ws";
import * as api from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button, EmptyState } from "@/components/ui";
import {
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarStickyStack,
  SidebarStickyTier,
} from "@/components/ui";
import {
  COARSE_POINTER_ADD_PROJECT_BUTTON_SIZE_CLASS,
  COARSE_POINTER_ICON_SIZE_CLASS,
  COARSE_POINTER_ROW_ACTION_SIZE_CLASS,
  COARSE_POINTER_ROW_HEIGHT_CLASS,
} from "@/components/ui";
import { ProjectRow } from "./ProjectRow";
import type { ProjectThreadListState } from "./ProjectRow";
import {
  collapsedManagerIdsAtom,
  collapsedProjectIdsAtom,
} from "./sidebarCollapsedAtoms";
import {
  SIDEBAR_ROW_BASE_CLASS,
  SIDEBAR_ROW_INTERACTIVE_STATE_CLASS,
  SIDEBAR_STANDARD_ROW_PADDING_CLASS,
} from "./sidebarRowClasses";

interface ProjectListProps {
  onNewChat?: () => void;
  onNewManager?: (projectId: string) => void;
  onNewProject?: () => void;
  onProjectSelect?: () => void;
  selectedProjectId?: string;
  isCreatingProject?: boolean;
  isManagerActionPending?: boolean;
}

interface ProjectListActionButtonsProps {
  onNewChat?: () => void;
  onNewManager?: (projectId: string) => void;
  selectedProjectId?: string;
  isManagerActionPending: boolean;
}

interface ProjectSourceStatusTarget {
  path: string;
  projectId: string;
  sourceId: string;
}

interface ProjectThreadQueryState {
  status: ConnectionAwareQueryStatus;
}

type ProjectThreadQueryResult = Pick<
  UseQueryResult<ThreadListEntry[]>,
  "data" | "isFetching" | "isLoadingError"
>;

type ProjectSourceWorkspaceStatusQueryResult = Pick<
  UseQueryResult<ProjectSourceWorkspaceStatusResponse>,
  "data"
>;

type ThreadQueryFnContext = QueryFunctionContext<ThreadListQueryKey>;

interface ProjectThreadQueryAggregation {
  threads: ThreadListEntry[];
  threadStatesByProjectId: Map<string, ProjectThreadQueryState>;
}

interface BuildProjectThreadQueryAggregationArgs {
  projectIds: readonly string[];
  queryResults: readonly ProjectThreadQueryResult[];
  serverConnectionState: WebSocketConnectionState;
  connectionGracePeriodElapsed: boolean;
}

const PROJECT_LIST_ACTION_BUTTON_CLASS = cn(
  SIDEBAR_ROW_BASE_CLASS,
  SIDEBAR_STANDARD_ROW_PADDING_CLASS,
  SIDEBAR_ROW_INTERACTIVE_STATE_CLASS,
  COARSE_POINTER_ROW_HEIGHT_CLASS,
  "min-w-0 justify-start overflow-hidden font-normal ring-sidebar-ring focus-visible:ring-2 max-md:pointer-coarse:[&_svg]:size-5",
);

const PROJECT_LIST_ACTION_TRAILING_SLOT_CLASS = cn(
  "inline-flex shrink-0 items-center justify-center",
  COARSE_POINTER_ROW_ACTION_SIZE_CLASS,
);

interface ProjectThreadListStateArgs {
  status: ConnectionAwareQueryStatus | undefined;
  threads: ThreadListEntry[] | undefined;
}

function buildProjectThreadQueryAggregation({
  projectIds,
  queryResults,
  serverConnectionState,
  connectionGracePeriodElapsed,
}: BuildProjectThreadQueryAggregationArgs): ProjectThreadQueryAggregation {
  const threads: ThreadListEntry[] = [];
  const threadStatesByProjectId = new Map<string, ProjectThreadQueryState>();

  for (let index = 0; index < queryResults.length; index += 1) {
    const projectId = projectIds[index];
    const result = queryResults[index];
    if (!projectId || !result) {
      continue;
    }

    if (result.data !== undefined) {
      threads.push(...result.data);
    }
    threadStatesByProjectId.set(projectId, {
      status: getConnectionAwareQueryState({
        hasResolvedData: result.data !== undefined,
        isFetching: result.isFetching,
        isLoadingError: result.isLoadingError,
        serverConnectionState,
        connectionGracePeriodElapsed,
      }).status,
    });
  }

  return {
    threads,
    threadStatesByProjectId,
  };
}

function getProjectThreadListState({
  status,
  threads,
}: ProjectThreadListStateArgs): ProjectThreadListState {
  switch (status) {
    case "ready":
      return {
        status: "ready",
        threads: threads ?? [],
      };
    case "unavailable":
      return { status: "unavailable" };
    case "loading":
    case undefined:
      return { status: "loading" };
  }
}

function ProjectListActionButtons({
  onNewChat,
  onNewManager,
  selectedProjectId,
  isManagerActionPending,
}: ProjectListActionButtonsProps) {
  const isNewChatDisabled = !onNewChat;
  const isNewManagerDisabled =
    !onNewManager || !selectedProjectId || isManagerActionPending;
  const newChatTitle = isNewChatDisabled
    ? "Select a project to start a new chat"
    : "New Chat";
  const newManagerTitle =
    !onNewManager || !selectedProjectId
      ? "Select a project to hire a new manager"
      : isManagerActionPending
        ? "Hiring manager..."
        : "New Manager";

  return (
    <div className="space-y-0.5">
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className={PROJECT_LIST_ACTION_BUTTON_CLASS}
        onClick={onNewChat}
        disabled={isNewChatDisabled}
        title={newChatTitle}
      >
        <MessageSquarePlus />
        <span className="min-w-0 flex-1 truncate text-left">New Chat</span>
        <span
          className={PROJECT_LIST_ACTION_TRAILING_SLOT_CLASS}
          aria-hidden="true"
        />
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className={PROJECT_LIST_ACTION_BUTTON_CLASS}
        onClick={() => {
          if (!selectedProjectId) return;
          onNewManager?.(selectedProjectId);
        }}
        disabled={isNewManagerDisabled}
        title={newManagerTitle}
      >
        <UserRoundPlus />
        <span className="min-w-0 flex-1 truncate text-left">New Manager</span>
        <span
          className={PROJECT_LIST_ACTION_TRAILING_SLOT_CLASS}
          aria-hidden="true"
        />
      </Button>
    </div>
  );
}

function ProjectListComponent({
  onNewChat,
  onNewManager,
  onNewProject,
  onProjectSelect,
  selectedProjectId,
  isCreatingProject = false,
  isManagerActionPending = false,
}: ProjectListProps) {
  const projectsQuery = useProjects();
  const {
    data: projects,
    isFetching: projectsFetching,
    isLoadingError: projectsLoadingError,
  } = projectsQuery;
  const serverConnectionState = useServerConnectionState();
  const connectionGracePeriodElapsed = useServerConnectionGracePeriodElapsed();
  const projectsState = useConnectionAwareQueryState({
    hasResolvedData: projects !== undefined,
    isFetching: projectsFetching,
    isLoadingError: projectsLoadingError,
  });
  const projectIds = useMemo(
    () => (projects ?? []).map((project) => project.id),
    [projects],
  );
  const threadQueries = useMemo(
    () =>
      projectIds.map((projectId) => ({
        queryKey: threadListQueryKey({ projectId, archived: false }),
        queryFn: ({ signal }: ThreadQueryFnContext) =>
          api.listThreads({ projectId, archived: false }, signal),
        staleTime: 10_000,
      })),
    [projectIds],
  );
  // Keep combine stable so useQueries skips aggregation on unrelated renders.
  const combineProjectThreadQueries = useCallback(
    (results: readonly ProjectThreadQueryResult[]) =>
      buildProjectThreadQueryAggregation({
        projectIds,
        queryResults: results,
        serverConnectionState,
        connectionGracePeriodElapsed,
      }),
    [projectIds, serverConnectionState, connectionGracePeriodElapsed],
  );
  const { threads, threadStatesByProjectId } = useQueries({
    queries: threadQueries,
    combine: combineProjectThreadQueries,
  });
  const { localHostId } = useHostDaemon();
  const location = useLocation();

  const localSourceTargets = useMemo(() => {
    if (!localHostId || !projects) return [];
    const targets: ProjectSourceStatusTarget[] = [];
    for (const project of projects) {
      const source = findLocalPathProjectSourceForHost(
        project.sources,
        localHostId,
      );
      if (source) {
        targets.push({
          path: source.path,
          projectId: project.id,
          sourceId: source.id,
        });
      }
    }
    return targets;
  }, [localHostId, projects]);

  const localSourcePathsByProjectId = useMemo(() => {
    const pathsByProjectId = new Map<string, string>();
    for (const target of localSourceTargets) {
      pathsByProjectId.set(target.projectId, target.path);
    }
    return pathsByProjectId;
  }, [localSourceTargets]);

  const promotedBranchQueries = useMemo(
    () =>
      localSourceTargets.map((target) => ({
        queryKey: projectSourceWorkspaceStatusQueryKey(
          target.projectId,
          target.sourceId,
        ),
        queryFn: () =>
          api.getProjectSourceWorkspaceStatus(
            target.projectId,
            target.sourceId,
          ),
        staleTime: 5_000,
        refetchOnWindowFocus: true,
      })),
    [localSourceTargets],
  );
  const combinePromotedBranchQueries = useCallback(
    (results: readonly ProjectSourceWorkspaceStatusQueryResult[]) => {
      const branchNamesByProjectId = new Map<string, string | null>();
      for (let index = 0; index < results.length; index += 1) {
        const target = localSourceTargets[index];
        if (!target) continue;
        branchNamesByProjectId.set(
          target.projectId,
          results[index].data?.workspace?.branch.currentBranch ?? null,
        );
      }
      return branchNamesByProjectId;
    },
    [localSourceTargets],
  );
  const promotedBranchNamesByProjectId = useQueries({
    queries: promotedBranchQueries,
    combine: combinePromotedBranchQueries,
  });

  const localPaths = useMemo(() => {
    if (!localHostId) return [];
    return localSourceTargets.map((target) => target.path);
  }, [localHostId, localSourceTargets]);
  const pathExistence = useLocalPathExistence(localPaths);

  const [collapsedProjectIdList, setCollapsedProjectIdList] = useAtom(
    collapsedProjectIdsAtom,
  );
  const [collapsedManagerIdList, setCollapsedManagerIdList] = useAtom(
    collapsedManagerIdsAtom,
  );
  const selectedThreadId = location.pathname.match(
    /^\/projects\/[^/]+\/threads\/([^/]+)/,
  )?.[1];
  const collapsedProjectIds = useMemo(
    () => new Set(collapsedProjectIdList),
    [collapsedProjectIdList],
  );
  const collapsedManagerIds = useMemo(
    () => new Set(collapsedManagerIdList),
    [collapsedManagerIdList],
  );
  const threadsByProject = useMemo(() => {
    const grouped = new Map<string, ThreadListEntry[]>();

    for (const thread of threads) {
      const existing = grouped.get(thread.projectId);
      if (existing) {
        existing.push(thread);
      } else {
        grouped.set(thread.projectId, [thread]);
      }
    }

    return grouped;
  }, [threads]);

  const toggleProjectCollapsed = useCallback(
    (projectId: string) => {
      setCollapsedProjectIdList((current) => {
        const next = new Set(current);
        if (next.has(projectId)) {
          next.delete(projectId);
        } else {
          next.add(projectId);
        }

        return Array.from(next);
      });
    },
    [setCollapsedProjectIdList],
  );

  const toggleManagerCollapsed = useCallback(
    (threadId: string) => {
      setCollapsedManagerIdList((current) => {
        const next = new Set(current);
        if (next.has(threadId)) {
          next.delete(threadId);
        } else {
          next.add(threadId);
        }

        return Array.from(next);
      });
    },
    [setCollapsedManagerIdList],
  );

  return (
    <>
      <div className="px-2 pt-2 group-data-[collapsible=icon]:hidden">
        <ProjectListActionButtons
          onNewChat={onNewChat}
          onNewManager={onNewManager}
          selectedProjectId={selectedProjectId}
          isManagerActionPending={isManagerActionPending}
        />
      </div>
      <SidebarStickyStack data-sidebar-sticky-density="compact-actions">
        <SidebarStickyTier tier="label" className="justify-between pr-1">
          Projects
          {onNewProject ? (
            <button
              type="button"
              onClick={onNewProject}
              disabled={isCreatingProject}
              title={isCreatingProject ? "Creating project..." : "Add project"}
              aria-label="Add project"
              className={cn(
                "inline-flex items-center justify-center rounded text-sidebar-foreground/50 transition-colors hover:text-sidebar-foreground disabled:opacity-50",
                COARSE_POINTER_ADD_PROJECT_BUTTON_SIZE_CLASS,
              )}
            >
              <Plus className={COARSE_POINTER_ICON_SIZE_CLASS} />
            </button>
          ) : null}
        </SidebarStickyTier>
        <SidebarGroupContent>
          <SidebarMenu className="gap-1">
            {projectsState.status === "loading" ? (
              <>
                <SidebarMenuSkeleton />
                <SidebarMenuSkeleton />
              </>
            ) : projects && projects.length > 0 ? (
              projects.map((project) => {
                const threadState = threadStatesByProjectId.get(project.id);
                const threadListState = getProjectThreadListState({
                  status: threadState?.status,
                  threads: threadsByProject.get(project.id),
                });
                const localSourcePath = localSourcePathsByProjectId.get(
                  project.id,
                );
                const isLocalPathInvalid = isLocalPathMissing(
                  pathExistence,
                  localSourcePath,
                );
                return (
                  <ProjectRow
                    key={project.id}
                    project={project}
                    threadListState={threadListState}
                    selectedThreadId={selectedThreadId}
                    isActive={
                      selectedProjectId === project.id && !selectedThreadId
                    }
                    isCollapsed={collapsedProjectIds.has(project.id)}
                    collapsedManagerIds={collapsedManagerIds}
                    isLocalPathInvalid={isLocalPathInvalid}
                    localHostId={localHostId}
                    onProjectSelect={onProjectSelect}
                    onToggleProjectCollapsed={toggleProjectCollapsed}
                    onToggleManagerCollapsed={toggleManagerCollapsed}
                    promotedBranchName={
                      promotedBranchNamesByProjectId.get(project.id) ?? null
                    }
                  />
                );
              })
            ) : (
              <SidebarMenuItem>
                <EmptyState
                  message={
                    projectsState.status === "unavailable"
                      ? "Projects unavailable"
                      : "No projects"
                  }
                  icon={Folder}
                  className="px-2 py-1.5"
                  iconClassName="size-3.5"
                  messageClassName="text-xs"
                />
              </SidebarMenuItem>
            )}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarStickyStack>
    </>
  );
}

export const ProjectList = memo(ProjectListComponent);
