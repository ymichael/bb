import { useCallback, useMemo } from "react";
import { useStore } from "jotai";
import {
  PERSONAL_PROJECT_ID,
  type Host,
  type ThreadListEntry,
} from "@bb/domain";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import type {
  PluginSidebarProject,
  PluginSidebarThread,
  PluginSidebarThreadActions,
  PluginSidebarThreadPullRequestState,
  PluginSidebarThreadsState,
} from "@get-bb/plugin-sdk";
import { useThreadActions } from "@/components/thread/ThreadActionsProvider";
import {
  getEnvironmentPullRequestFromResponse,
  useEnvironmentPullRequest,
} from "@/hooks/queries/environment-queries";
import { useHosts } from "@/hooks/queries/host-queries";
import { useSidebarNavigation } from "@/hooks/queries/sidebar-navigation-query";
import { useUpdateThread } from "@/hooks/mutations/thread-state-mutations";
import { useRouteNavigate } from "@/components/ui/app-route-anchor";
import { toPluginSidebarThread } from "./plugin-sidebar-threads";
import { useSetRootComposeProjectId } from "./root-compose-selection";
import { openThreadInSplit } from "./split-layout/openThreadInSplit";
import { getRootComposeRoutePath, getThreadRoutePath } from "./route-paths";

const EMPTY_THREADS: readonly PluginSidebarThread[] = [];
const EMPTY_PROJECTS: readonly PluginSidebarProject[] = [];
const EMPTY_ENTRIES: ReadonlyMap<string, ThreadListEntry> = new Map();
const EMPTY_HOST_NAMES: ReadonlyMap<string, string> = new Map();

const hostNamesByHosts = new WeakMap<
  readonly Host[],
  ReadonlyMap<string, string>
>();

function hostNamesFor(
  hosts: readonly Host[] | undefined,
): ReadonlyMap<string, string> {
  if (hosts === undefined) return EMPTY_HOST_NAMES;
  const cached = hostNamesByHosts.get(hosts);
  if (cached !== undefined) return cached;
  const names = new Map(hosts.map((host) => [host.id, host.name] as const));
  hostNamesByHosts.set(hosts, names);
  return names;
}

const pluginSidebarThreadByEntry = new WeakMap<
  ThreadListEntry,
  { hostNamesById: ReadonlyMap<string, string>; thread: PluginSidebarThread }
>();

function toPluginSidebarThreadCached(
  entry: ThreadListEntry,
  hostNamesById: ReadonlyMap<string, string>,
): PluginSidebarThread {
  const cached = pluginSidebarThreadByEntry.get(entry);
  if (cached !== undefined && cached.hostNamesById === hostNamesById) {
    return cached.thread;
  }
  const thread = toPluginSidebarThread(entry, hostNamesById);
  pluginSidebarThreadByEntry.set(entry, { hostNamesById, thread });
  return thread;
}

export function useSidebarThreads(): PluginSidebarThreadsState {
  const query = useSidebarNavigation();
  const data = query.data;
  const { data: hosts } = useHosts();
  const hostNamesById = hostNamesFor(hosts);

  return useMemo<PluginSidebarThreadsState>(() => {
    if (data === undefined) {
      return {
        status: query.isError ? "error" : "loading",
        threads: EMPTY_THREADS,
        projects: EMPTY_PROJECTS,
      };
    }
    const allProjects = [...data.projects, data.personalProject];
    return {
      status: "ready",
      threads: allProjects.flatMap((project) =>
        project.threads.map((thread) =>
          toPluginSidebarThreadCached(thread, hostNamesById),
        ),
      ),
      projects: allProjects.map((project) => ({
        id: project.id,
        name: project.name,
        isPersonal: project.id === PERSONAL_PROJECT_ID,
      })),
    };
  }, [data, hostNamesById, query.isError]);
}

function useThreadEntryMap(): ReadonlyMap<string, ThreadListEntry> {
  const { data } = useSidebarNavigation();
  return useMemo(() => {
    if (data === undefined) return EMPTY_ENTRIES;
    const entries = new Map<string, ThreadListEntry>();
    for (const project of [...data.projects, data.personalProject]) {
      for (const thread of project.threads) entries.set(thread.id, thread);
    }
    return entries;
  }, [data]);
}

export function useSidebarThreadEntry(
  threadId: string,
): ThreadListEntry | null {
  return useThreadEntryMap().get(threadId) ?? null;
}

export function useSidebarThreadActions(): PluginSidebarThreadActions {
  const navigate = useRouteNavigate();
  const store = useStore();
  const isCompact = useIsCompactViewport();
  const setRootComposeProjectId = useSetRootComposeProjectId();
  const hostActions = useThreadActions();
  const entriesById = useThreadEntryMap();
  const { mutateAsync: updateThreadAsync } = useUpdateThread();

  const requireEntry = useCallback(
    (threadId: string): ThreadListEntry => {
      const entry = entriesById.get(threadId);
      if (entry === undefined) {
        throw new Error(`Unknown thread: ${threadId}`);
      }
      return entry;
    },
    [entriesById],
  );

  return useMemo<PluginSidebarThreadActions>(
    () => ({
      open(threadId, options) {
        const entry = entriesById.get(threadId);
        if (entry === undefined) return;
        const { projectId } = entry;
        if (options?.split) {
          openThreadInSplit({
            store,
            navigate,
            projectId,
            threadId,
            isCompact,
          });
          return;
        }
        navigate(getThreadRoutePath({ projectId, threadId }));
      },
      openNewThread(options) {
        const projectId = options?.projectId;
        if (projectId !== undefined) {
          setRootComposeProjectId(projectId);
        }
        const state = options?.focusPrompt ? { focusPrompt: true } : undefined;
        navigate(getRootComposeRoutePath(), state ? { state } : undefined);
      },
      async setPinned(threadId, pinned) {
        const entry = requireEntry(threadId);
        if ((entry.pinnedAt !== null) === pinned) return;
        hostActions.togglePin(entry);
      },
      async setRead(threadId, read) {
        const entry = requireEntry(threadId);
        const isRead = (entry.lastReadAt ?? 0) >= entry.latestAttentionAt;
        if (isRead === read) return;
        hostActions.toggleRead(entry);
      },
      async rename(threadId, title) {
        await updateThreadAsync({ id: threadId, title });
      },
      archive(threadId) {
        hostActions.archiveThreadAndChildren(requireEntry(threadId));
      },
      requestDelete(threadId) {
        hostActions.requestDelete(requireEntry(threadId));
      },
    }),
    [
      entriesById,
      hostActions,
      isCompact,
      navigate,
      requireEntry,
      setRootComposeProjectId,
      store,
      updateThreadAsync,
    ],
  );
}

export function useSidebarThreadPullRequest(
  threadId: string,
): PluginSidebarThreadPullRequestState {
  const entry = useSidebarThreadEntry(threadId);
  const environmentId = entry?.environmentId ?? null;
  const query = useEnvironmentPullRequest(environmentId);
  const pullRequest = getEnvironmentPullRequestFromResponse(query.data);

  return useMemo<PluginSidebarThreadPullRequestState>(
    () => ({
      isLoading: environmentId !== null && query.isPending,
      pullRequest:
        pullRequest === null
          ? null
          : {
              number: pullRequest.number,
              title: pullRequest.title,
              url: pullRequest.url,
              state: pullRequest.state,
              attention: pullRequest.attention,
            },
    }),
    [environmentId, pullRequest, query.isPending],
  );
}
