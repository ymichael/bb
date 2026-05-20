import type { QueryKey } from "@tanstack/react-query";
import type { ThreadListFilters } from "@/lib/api";
import type { EnvironmentFilePreviewSource } from "@/lib/file-preview";
import {
  DEFAULT_THREAD_STORAGE_FILE_LIST_OPTIONS,
  type ThreadStorageFileListOptions,
} from "@/lib/thread-storage-files";
import {
  DEFAULT_FILE_ONLY_PATH_LIST_OPTIONS,
  type PathListOptions,
} from "@/lib/path-list-options";
import type { ManagerTimelineView } from "@bb/server-contract";

export const HOSTS_QUERY_KEY = "hosts";
export const HOST_QUERY_KEY = "host";
export const PROJECTS_QUERY_KEY = "projects";
export const PROJECT_FILES_QUERY_KEY = "projectFiles";
export const PROJECT_PATHS_QUERY_KEY = "projectPaths";
export const PROJECT_SOURCE_BRANCHES_QUERY_KEY = "projectSourceBranches";
export const PROJECT_PROMPT_HISTORY_QUERY_KEY = "projectPromptHistory";
export const SIDEBAR_BOOTSTRAP_QUERY_KEY = "sidebarBootstrap";
export const THREADS_QUERY_KEY = "threads";
export const THREADS_DISABLED_QUERY_KEY = "threadsDisabled";
export const THREAD_QUERY_KEY = "thread";
export const THREAD_DETAIL_BOOTSTRAP_QUERY_KEY = "threadDetailBootstrap";
export const THREAD_COMPOSER_BOOTSTRAP_QUERY_KEY = "threadComposerBootstrap";
export const THREAD_DEFAULT_EXECUTION_OPTIONS_QUERY_KEY =
  "threadDefaultExecutionOptions";
export const THREAD_QUEUED_MESSAGES_QUERY_KEY = "threadQueuedMessages";
export const THREAD_PROMPT_HISTORY_QUERY_KEY = "threadPromptHistory";
export const THREAD_PENDING_INTERACTIONS_QUERY_KEY =
  "threadPendingInteractions";
export const THREAD_TERMINALS_QUERY_KEY = "threadTerminals";
export const THREAD_STORAGE_FILES_QUERY_KEY = "threadStorageFiles";
export const THREAD_STORAGE_PATHS_QUERY_KEY = "threadStoragePaths";
export const THREAD_STORAGE_FILE_PREVIEW_QUERY_KEY = "threadStorageFilePreview";
export const THREAD_STATUS_VERSION_QUERY_KEY = "threadStatusVersion";
export const THREAD_HOST_FILE_PREVIEW_QUERY_KEY = "threadHostFilePreview";
export const ENVIRONMENT_QUERY_KEY = "environment";
export const ENVIRONMENT_WORK_STATUS_QUERY_KEY = "environmentWorkStatus";
export const ENVIRONMENT_MERGE_BASE_BRANCHES_QUERY_KEY =
  "environmentMergeBaseBranches";
export const ENVIRONMENT_GIT_DIFF_QUERY_KEY = "environmentGitDiff";
export const ENVIRONMENT_DIFF_FILE_QUERY_KEY = "environmentDiffFile";
export const ENVIRONMENT_FILE_PREVIEW_QUERY_KEY = "environmentFilePreview";
export const THREAD_TIMELINE_QUERY_KEY = "threadTimeline";
export const SYSTEM_PROVIDERS_QUERY_KEY = "systemProviders";
export const SYSTEM_EXECUTION_OPTIONS_QUERY_KEY = "systemExecutionOptions";
export const SYSTEM_VERSION_QUERY_KEY = "systemVersion";
export const LOCAL_PATH_EXISTENCE_QUERY_KEY = "localPathExistence";
export const REPLAY_CAPTURES_QUERY_KEY = "internalReplayCaptures";
export const CONVERSATION_MANAGER_TIMELINE_VIEW =
  "conversation" satisfies ManagerTimelineView;
export const STANDARD_MANAGER_TIMELINE_VIEW =
  "standard" satisfies ManagerTimelineView;

export interface ThreadListQueryFilters {
  projectId?: string;
  type?: ThreadListFilters["type"];
  parentThreadId?: string;
  archived: boolean;
}

export type ArchivedThreadsKindFilter =
  | "all"
  | "manager"
  | "managed"
  | "unmanaged";

export interface ArchivedThreadsListFilters {
  projectId: string;
  kind: ArchivedThreadsKindFilter;
}

export const ARCHIVED_THREADS_LIST_KIND = "archivedList";

export type HostsQueryKey = readonly [typeof HOSTS_QUERY_KEY];
export type HostQueryId = string | null | undefined;
export type HostQueryKey = readonly [typeof HOST_QUERY_KEY, HostQueryId];
export type AllHostQueryKeyPrefix = readonly [typeof HOST_QUERY_KEY];
export type ProjectsQueryKey = readonly [typeof PROJECTS_QUERY_KEY];
export type AllProjectFilesQueryKeyPrefix = readonly [
  typeof PROJECT_FILES_QUERY_KEY,
];
export type AllProjectPathsQueryKeyPrefix = readonly [
  typeof PROJECT_PATHS_QUERY_KEY,
];
export type AllProjectSourceBranchesQueryKeyPrefix = readonly [
  typeof PROJECT_SOURCE_BRANCHES_QUERY_KEY,
];
export type ProjectSourceBranchesQueryKeyPrefix = readonly [
  typeof PROJECT_SOURCE_BRANCHES_QUERY_KEY,
  string,
];
export type ProjectPromptHistoryQueryKeyPrefix = readonly [
  typeof PROJECT_PROMPT_HISTORY_QUERY_KEY,
];
export type ProjectPromptHistoryQueryKey = readonly [
  typeof PROJECT_PROMPT_HISTORY_QUERY_KEY,
  string | null | undefined,
];
export type ProjectFilesQueryKey = readonly [
  typeof PROJECT_FILES_QUERY_KEY,
  string | undefined,
  string,
  number,
  string | null,
];
export type ProjectPathsQueryKey = readonly [
  typeof PROJECT_PATHS_QUERY_KEY,
  string | undefined,
  string,
  number,
  string | null,
  boolean,
  boolean,
];
export type ProjectFilesQueryKeyPrefix = readonly [
  typeof PROJECT_FILES_QUERY_KEY,
  string,
];
export type ProjectPathsQueryKeyPrefix = readonly [
  typeof PROJECT_PATHS_QUERY_KEY,
  string,
];
export type ProjectSourceBranchesQueryKey = readonly [
  typeof PROJECT_SOURCE_BRANCHES_QUERY_KEY,
  string,
  string,
];
export type SidebarBootstrapQueryKey = readonly [
  typeof SIDEBAR_BOOTSTRAP_QUERY_KEY,
];
export type ThreadsQueryKey = readonly [typeof THREADS_QUERY_KEY];
export type ThreadListQueryKey = readonly [
  typeof THREADS_QUERY_KEY,
  ThreadListQueryFilters,
];
export type ArchivedThreadsListQueryKey = readonly [
  typeof THREADS_QUERY_KEY,
  typeof ARCHIVED_THREADS_LIST_KIND,
  ArchivedThreadsListFilters,
];
export type DisabledThreadListQueryKey = readonly [
  typeof THREADS_DISABLED_QUERY_KEY,
  ThreadListQueryFilters?,
];
export type ThreadQueryKeyPrefix = readonly [typeof THREAD_QUERY_KEY];
export type ThreadQueryKey = readonly [typeof THREAD_QUERY_KEY, string];
export type ThreadDetailBootstrapQueryKey = readonly [
  typeof THREAD_DETAIL_BOOTSTRAP_QUERY_KEY,
  string,
];
export type ThreadComposerBootstrapQueryKey = readonly [
  typeof THREAD_COMPOSER_BOOTSTRAP_QUERY_KEY,
  string | null,
  string,
];
export type ThreadComposerBootstrapQueryKeyPrefix = readonly [
  typeof THREAD_COMPOSER_BOOTSTRAP_QUERY_KEY,
];
export type ThreadComposerBootstrapEnvironmentQueryKeyPrefix = readonly [
  typeof THREAD_COMPOSER_BOOTSTRAP_QUERY_KEY,
  string | null,
];
export type ThreadDefaultExecutionOptionsQueryKeyPrefix = readonly [
  typeof THREAD_DEFAULT_EXECUTION_OPTIONS_QUERY_KEY,
];
export type ThreadDefaultExecutionOptionsQueryKey = readonly [
  typeof THREAD_DEFAULT_EXECUTION_OPTIONS_QUERY_KEY,
  string,
];
export type ThreadQueuedMessagesQueryKeyPrefix = readonly [
  typeof THREAD_QUEUED_MESSAGES_QUERY_KEY,
];
export type ThreadQueuedMessagesQueryKey = readonly [
  typeof THREAD_QUEUED_MESSAGES_QUERY_KEY,
  string,
];
export type ThreadPromptHistoryQueryKeyPrefix = readonly [
  typeof THREAD_PROMPT_HISTORY_QUERY_KEY,
];
export type ThreadPromptHistoryQueryKey = readonly [
  typeof THREAD_PROMPT_HISTORY_QUERY_KEY,
  string,
];
export type ThreadPendingInteractionsQueryKeyPrefix = readonly [
  typeof THREAD_PENDING_INTERACTIONS_QUERY_KEY,
];
export type ThreadPendingInteractionsQueryKey = readonly [
  typeof THREAD_PENDING_INTERACTIONS_QUERY_KEY,
  string,
];
export type AllThreadTerminalsQueryKeyPrefix = readonly [
  typeof THREAD_TERMINALS_QUERY_KEY,
];
export type ThreadTerminalsQueryKey = readonly [
  typeof THREAD_TERMINALS_QUERY_KEY,
  string,
];
export type ThreadStorageFilesQueryKey = readonly [
  typeof THREAD_STORAGE_FILES_QUERY_KEY,
  string,
  ThreadStorageFileListOptions,
];
export type ThreadStoragePathsQueryKey = readonly [
  typeof THREAD_STORAGE_PATHS_QUERY_KEY,
  string,
  PathListOptions,
];
export type AllThreadStorageFilesQueryKeyPrefix = readonly [
  typeof THREAD_STORAGE_FILES_QUERY_KEY,
];
export type AllThreadStoragePathsQueryKeyPrefix = readonly [
  typeof THREAD_STORAGE_PATHS_QUERY_KEY,
];
export type ThreadStorageFilesForThreadQueryKeyPrefix = readonly [
  typeof THREAD_STORAGE_FILES_QUERY_KEY,
  string,
];
export type ThreadStoragePathsForThreadQueryKeyPrefix = readonly [
  typeof THREAD_STORAGE_PATHS_QUERY_KEY,
  string,
];
export type AllThreadStorageFilePreviewQueryKeyPrefix = readonly [
  typeof THREAD_STORAGE_FILE_PREVIEW_QUERY_KEY,
];
export type ThreadStorageFilePreviewQueryKey = readonly [
  typeof THREAD_STORAGE_FILE_PREVIEW_QUERY_KEY,
  string,
  string | null,
];
export type ThreadStorageFilePreviewQueryKeyPrefix = readonly [
  typeof THREAD_STORAGE_FILE_PREVIEW_QUERY_KEY,
  string,
];
export type ThreadStatusVersionQueryKey = readonly [
  typeof THREAD_STATUS_VERSION_QUERY_KEY,
  string,
];
export type AllThreadHostFilePreviewQueryKeyPrefix = readonly [
  typeof THREAD_HOST_FILE_PREVIEW_QUERY_KEY,
];
export type ThreadHostFilePreviewQueryKey = readonly [
  typeof THREAD_HOST_FILE_PREVIEW_QUERY_KEY,
  string,
  string | null | undefined,
  string | null,
];
export type ThreadHostFilePreviewQueryKeyPrefix = readonly [
  typeof THREAD_HOST_FILE_PREVIEW_QUERY_KEY,
  string,
];
export type EnvironmentQueryKeyPrefix = readonly [typeof ENVIRONMENT_QUERY_KEY];
export type EnvironmentQueryKey = readonly [
  typeof ENVIRONMENT_QUERY_KEY,
  string | null | undefined,
];
export type EnvironmentWorkStatusQueryKeyRootPrefix = readonly [
  typeof ENVIRONMENT_WORK_STATUS_QUERY_KEY,
];
export type EnvironmentWorkStatusQueryKey = readonly [
  typeof ENVIRONMENT_WORK_STATUS_QUERY_KEY,
  string | null | undefined,
  string | null,
];
export type EnvironmentWorkStatusQueryKeyPrefix = readonly [
  typeof ENVIRONMENT_WORK_STATUS_QUERY_KEY,
  string,
];
export type EnvironmentMergeBaseBranchesQueryKeyRootPrefix = readonly [
  typeof ENVIRONMENT_MERGE_BASE_BRANCHES_QUERY_KEY,
];
export type EnvironmentMergeBaseBranchesQueryKey = readonly [
  typeof ENVIRONMENT_MERGE_BASE_BRANCHES_QUERY_KEY,
  string,
];
export type EnvironmentMergeBaseBranchesQueryKeyPrefix = readonly [
  typeof ENVIRONMENT_MERGE_BASE_BRANCHES_QUERY_KEY,
  string,
];
export type ThreadTimelineQueryKey = readonly [
  typeof THREAD_TIMELINE_QUERY_KEY,
  string,
  ManagerTimelineView | undefined,
];
export type ThreadTimelineQueryKeyPrefix = readonly [
  typeof THREAD_TIMELINE_QUERY_KEY,
  string,
];
export type AllThreadTimelineQueryKeyPrefix = readonly [
  typeof THREAD_TIMELINE_QUERY_KEY,
];
export type EnvironmentGitDiffQueryKey = readonly [
  typeof ENVIRONMENT_GIT_DIFF_QUERY_KEY,
  string,
  string | null,
  string | null,
];
export type EnvironmentGitDiffQueryKeyRootPrefix = readonly [
  typeof ENVIRONMENT_GIT_DIFF_QUERY_KEY,
];
export type EnvironmentGitDiffQueryKeyPrefix = readonly [
  typeof ENVIRONMENT_GIT_DIFF_QUERY_KEY,
  string,
];
export type EnvironmentDiffFileQueryKey = readonly [
  typeof ENVIRONMENT_DIFF_FILE_QUERY_KEY,
  string,
  string,
  string | null,
  string,
  "old" | "new",
];
export type EnvironmentDiffFileQueryKeyRootPrefix = readonly [
  typeof ENVIRONMENT_DIFF_FILE_QUERY_KEY,
];
export type EnvironmentDiffFileQueryKeyPrefix = readonly [
  typeof ENVIRONMENT_DIFF_FILE_QUERY_KEY,
  string,
];
export type EnvironmentFilePreviewQueryKey = readonly [
  typeof ENVIRONMENT_FILE_PREVIEW_QUERY_KEY,
  string | null | undefined,
  string | null,
  EnvironmentFilePreviewSource | null,
];
export type EnvironmentFilePreviewQueryKeyRootPrefix = readonly [
  typeof ENVIRONMENT_FILE_PREVIEW_QUERY_KEY,
];
export type EnvironmentFilePreviewQueryKeyPrefix = readonly [
  typeof ENVIRONMENT_FILE_PREVIEW_QUERY_KEY,
  string,
];
export type SystemProvidersQueryKey = readonly [
  typeof SYSTEM_PROVIDERS_QUERY_KEY,
];
export type SystemVersionQueryKey = readonly [typeof SYSTEM_VERSION_QUERY_KEY];
export type SystemExecutionOptionsQueryKey = readonly [
  typeof SYSTEM_EXECUTION_OPTIONS_QUERY_KEY,
  string | null,
  string | null,
];
export type AllSystemExecutionOptionsQueryKeyPrefix = readonly [
  typeof SYSTEM_EXECUTION_OPTIONS_QUERY_KEY,
];
export type SystemExecutionOptionsEnvironmentQueryKeyPrefix = readonly [
  typeof SYSTEM_EXECUTION_OPTIONS_QUERY_KEY,
  string | null,
];
export type LocalPathExistenceQueryKey = readonly [
  typeof LOCAL_PATH_EXISTENCE_QUERY_KEY,
  string,
  readonly string[],
];
export type LocalPathExistenceQueryKeyPrefix = readonly [
  typeof LOCAL_PATH_EXISTENCE_QUERY_KEY,
];
export type ReplayCapturesQueryKey = readonly [
  typeof REPLAY_CAPTURES_QUERY_KEY,
];

export function hostsQueryKey(): HostsQueryKey {
  return [HOSTS_QUERY_KEY];
}

export function hostQueryKey(hostId: HostQueryId): HostQueryKey {
  return [HOST_QUERY_KEY, hostId];
}

export function allHostQueryKeyPrefix(): AllHostQueryKeyPrefix {
  return [HOST_QUERY_KEY];
}

export function projectsQueryKey(): ProjectsQueryKey {
  return [PROJECTS_QUERY_KEY];
}

export function projectFilesQueryKey(
  projectId: string | undefined,
  query: string,
  limit: number,
  environmentId: string | null,
): ProjectFilesQueryKey {
  return [PROJECT_FILES_QUERY_KEY, projectId, query, limit, environmentId];
}

export function projectPathsQueryKey(
  projectId: string | undefined,
  query: string,
  limit: number,
  environmentId: string | null,
  includeFiles: boolean,
  includeDirectories: boolean,
): ProjectPathsQueryKey {
  return [
    PROJECT_PATHS_QUERY_KEY,
    projectId,
    query,
    limit,
    environmentId,
    includeFiles,
    includeDirectories,
  ];
}

export function allProjectFilesQueryKeyPrefix(): AllProjectFilesQueryKeyPrefix {
  return [PROJECT_FILES_QUERY_KEY];
}

export function allProjectPathsQueryKeyPrefix(): AllProjectPathsQueryKeyPrefix {
  return [PROJECT_PATHS_QUERY_KEY];
}

export function projectPromptHistoryQueryKey(
  projectId: string | null | undefined,
): ProjectPromptHistoryQueryKey {
  return [PROJECT_PROMPT_HISTORY_QUERY_KEY, projectId];
}

export function projectPromptHistoryQueryKeyPrefix(): ProjectPromptHistoryQueryKeyPrefix {
  return [PROJECT_PROMPT_HISTORY_QUERY_KEY];
}

export function projectFilesQueryKeyPrefix(
  projectId: string,
): ProjectFilesQueryKeyPrefix {
  return [PROJECT_FILES_QUERY_KEY, projectId];
}

export function projectPathsQueryKeyPrefix(
  projectId: string,
): ProjectPathsQueryKeyPrefix {
  return [PROJECT_PATHS_QUERY_KEY, projectId];
}

export function projectSourceBranchesQueryKey(
  projectId: string,
  hostId: string,
): ProjectSourceBranchesQueryKey {
  return [PROJECT_SOURCE_BRANCHES_QUERY_KEY, projectId, hostId];
}

export function allProjectSourceBranchesQueryKeyPrefix(): AllProjectSourceBranchesQueryKeyPrefix {
  return [PROJECT_SOURCE_BRANCHES_QUERY_KEY];
}

export function projectSourceBranchesQueryKeyPrefix(
  projectId: string,
): ProjectSourceBranchesQueryKeyPrefix {
  return [PROJECT_SOURCE_BRANCHES_QUERY_KEY, projectId];
}

export function sidebarBootstrapQueryKey(): SidebarBootstrapQueryKey {
  return [SIDEBAR_BOOTSTRAP_QUERY_KEY];
}

export function threadsQueryKey(): ThreadsQueryKey {
  return [THREADS_QUERY_KEY];
}

export function threadListQueryKey(
  filters: ThreadListQueryFilters,
): ThreadListQueryKey {
  return [THREADS_QUERY_KEY, filters];
}

export function archivedThreadsListQueryKey(
  filters: ArchivedThreadsListFilters,
): ArchivedThreadsListQueryKey {
  return [THREADS_QUERY_KEY, ARCHIVED_THREADS_LIST_KIND, filters];
}

export function isArchivedThreadsListQueryKey(
  queryKey: QueryKey,
): queryKey is ArchivedThreadsListQueryKey {
  return (
    queryKey[0] === THREADS_QUERY_KEY &&
    queryKey[1] === ARCHIVED_THREADS_LIST_KIND
  );
}

export function disabledThreadListQueryKey(
  filters?: ThreadListQueryFilters,
): DisabledThreadListQueryKey {
  return filters
    ? [THREADS_DISABLED_QUERY_KEY, filters]
    : [THREADS_DISABLED_QUERY_KEY];
}

export function threadQueryKey(threadId: string): ThreadQueryKey {
  return [THREAD_QUERY_KEY, threadId];
}

export function threadDetailBootstrapQueryKey(
  threadId: string,
): ThreadDetailBootstrapQueryKey {
  return [THREAD_DETAIL_BOOTSTRAP_QUERY_KEY, threadId];
}

export function threadComposerBootstrapQueryKey(
  threadId: string,
  environmentId: string | null,
): ThreadComposerBootstrapQueryKey {
  return [THREAD_COMPOSER_BOOTSTRAP_QUERY_KEY, environmentId, threadId];
}

export function allThreadComposerBootstrapQueryKeyPrefix(): ThreadComposerBootstrapQueryKeyPrefix {
  return [THREAD_COMPOSER_BOOTSTRAP_QUERY_KEY];
}

export function threadComposerBootstrapEnvironmentQueryKeyPrefix(
  environmentId: string | null,
): ThreadComposerBootstrapEnvironmentQueryKeyPrefix {
  return [THREAD_COMPOSER_BOOTSTRAP_QUERY_KEY, environmentId];
}

export function allThreadQueryKeyPrefix(): ThreadQueryKeyPrefix {
  return [THREAD_QUERY_KEY];
}

export function threadDefaultExecutionOptionsQueryKey(
  threadId: string,
): ThreadDefaultExecutionOptionsQueryKey {
  return [THREAD_DEFAULT_EXECUTION_OPTIONS_QUERY_KEY, threadId];
}

export function allThreadDefaultExecutionOptionsQueryKeyPrefix(): ThreadDefaultExecutionOptionsQueryKeyPrefix {
  return [THREAD_DEFAULT_EXECUTION_OPTIONS_QUERY_KEY];
}

export function threadQueuedMessagesQueryKey(
  threadId: string,
): ThreadQueuedMessagesQueryKey {
  return [THREAD_QUEUED_MESSAGES_QUERY_KEY, threadId];
}

export function allThreadQueuedMessagesQueryKeyPrefix(): ThreadQueuedMessagesQueryKeyPrefix {
  return [THREAD_QUEUED_MESSAGES_QUERY_KEY];
}

export function threadPromptHistoryQueryKey(
  threadId: string,
): ThreadPromptHistoryQueryKey {
  return [THREAD_PROMPT_HISTORY_QUERY_KEY, threadId];
}

export function threadPromptHistoryQueryKeyPrefix(): ThreadPromptHistoryQueryKeyPrefix {
  return [THREAD_PROMPT_HISTORY_QUERY_KEY];
}

export function threadPendingInteractionsQueryKey(
  threadId: string,
): ThreadPendingInteractionsQueryKey {
  return [THREAD_PENDING_INTERACTIONS_QUERY_KEY, threadId];
}

export function allThreadPendingInteractionsQueryKeyPrefix(): ThreadPendingInteractionsQueryKeyPrefix {
  return [THREAD_PENDING_INTERACTIONS_QUERY_KEY];
}

export function threadTerminalsQueryKey(
  threadId: string,
): ThreadTerminalsQueryKey {
  return [THREAD_TERMINALS_QUERY_KEY, threadId];
}

export function allThreadTerminalsQueryKeyPrefix(): AllThreadTerminalsQueryKeyPrefix {
  return [THREAD_TERMINALS_QUERY_KEY];
}

export function threadStorageFilesQueryKey(
  threadId: string,
  options: ThreadStorageFileListOptions = DEFAULT_THREAD_STORAGE_FILE_LIST_OPTIONS,
): ThreadStorageFilesQueryKey {
  return [THREAD_STORAGE_FILES_QUERY_KEY, threadId, options];
}

export function threadStoragePathsQueryKey(
  threadId: string,
  options: PathListOptions = DEFAULT_FILE_ONLY_PATH_LIST_OPTIONS,
): ThreadStoragePathsQueryKey {
  return [THREAD_STORAGE_PATHS_QUERY_KEY, threadId, options];
}

export function allThreadStorageFilesQueryKeyPrefix(): AllThreadStorageFilesQueryKeyPrefix {
  return [THREAD_STORAGE_FILES_QUERY_KEY];
}

export function allThreadStoragePathsQueryKeyPrefix(): AllThreadStoragePathsQueryKeyPrefix {
  return [THREAD_STORAGE_PATHS_QUERY_KEY];
}

export function threadStorageFilesForThreadQueryKeyPrefix(
  threadId: string,
): ThreadStorageFilesForThreadQueryKeyPrefix {
  return [THREAD_STORAGE_FILES_QUERY_KEY, threadId];
}

export function threadStoragePathsForThreadQueryKeyPrefix(
  threadId: string,
): ThreadStoragePathsForThreadQueryKeyPrefix {
  return [THREAD_STORAGE_PATHS_QUERY_KEY, threadId];
}

export function threadStorageFilePreviewQueryKey(
  threadId: string,
  path: string | null,
): ThreadStorageFilePreviewQueryKey {
  return [THREAD_STORAGE_FILE_PREVIEW_QUERY_KEY, threadId, path];
}

export function allThreadStorageFilePreviewQueryKeyPrefix(): AllThreadStorageFilePreviewQueryKeyPrefix {
  return [THREAD_STORAGE_FILE_PREVIEW_QUERY_KEY];
}

export function threadStorageFilePreviewQueryKeyPrefix(
  threadId: string,
): ThreadStorageFilePreviewQueryKeyPrefix {
  return [THREAD_STORAGE_FILE_PREVIEW_QUERY_KEY, threadId];
}

export function threadStatusVersionQueryKey(
  threadId: string,
): ThreadStatusVersionQueryKey {
  return [THREAD_STATUS_VERSION_QUERY_KEY, threadId];
}

export function threadHostFilePreviewQueryKey(
  threadId: string,
  environmentId: string | null | undefined,
  path: string | null,
): ThreadHostFilePreviewQueryKey {
  return [THREAD_HOST_FILE_PREVIEW_QUERY_KEY, threadId, environmentId, path];
}

export function allThreadHostFilePreviewQueryKeyPrefix(): AllThreadHostFilePreviewQueryKeyPrefix {
  return [THREAD_HOST_FILE_PREVIEW_QUERY_KEY];
}

export function threadHostFilePreviewQueryKeyPrefix(
  threadId: string,
): ThreadHostFilePreviewQueryKeyPrefix {
  return [THREAD_HOST_FILE_PREVIEW_QUERY_KEY, threadId];
}

export function allEnvironmentQueryKeyPrefix(): EnvironmentQueryKeyPrefix {
  return [ENVIRONMENT_QUERY_KEY];
}

export function environmentQueryKey(
  environmentId: string | null | undefined,
): EnvironmentQueryKey {
  return [ENVIRONMENT_QUERY_KEY, environmentId];
}

export function environmentWorkStatusQueryKey(
  environmentId: string | null | undefined,
  mergeBaseBranch: string | null,
): EnvironmentWorkStatusQueryKey {
  return [ENVIRONMENT_WORK_STATUS_QUERY_KEY, environmentId, mergeBaseBranch];
}

export function allEnvironmentWorkStatusQueryKeyPrefix(): EnvironmentWorkStatusQueryKeyRootPrefix {
  return [ENVIRONMENT_WORK_STATUS_QUERY_KEY];
}

export function environmentWorkStatusQueryKeyPrefix(
  environmentId: string,
): EnvironmentWorkStatusQueryKeyPrefix {
  return [ENVIRONMENT_WORK_STATUS_QUERY_KEY, environmentId];
}

export function environmentMergeBaseBranchesQueryKey(
  environmentId: string,
): EnvironmentMergeBaseBranchesQueryKey {
  return [ENVIRONMENT_MERGE_BASE_BRANCHES_QUERY_KEY, environmentId];
}

export function allEnvironmentMergeBaseBranchesQueryKeyPrefix(): EnvironmentMergeBaseBranchesQueryKeyRootPrefix {
  return [ENVIRONMENT_MERGE_BASE_BRANCHES_QUERY_KEY];
}

export function environmentMergeBaseBranchesQueryKeyPrefix(
  environmentId: string,
): EnvironmentMergeBaseBranchesQueryKeyPrefix {
  return [ENVIRONMENT_MERGE_BASE_BRANCHES_QUERY_KEY, environmentId];
}

export function threadTimelineQueryKey(
  threadId: string,
  managerTimelineView: ManagerTimelineView | undefined,
): ThreadTimelineQueryKey {
  return [THREAD_TIMELINE_QUERY_KEY, threadId, managerTimelineView];
}

export function managerTimelineViewFromThreadTimelineQueryKey(
  queryKey: QueryKey | undefined,
): ManagerTimelineView | undefined {
  if (!queryKey || queryKey[0] !== THREAD_TIMELINE_QUERY_KEY) {
    return undefined;
  }

  const managerTimelineView = queryKey[2];
  if (
    managerTimelineView === CONVERSATION_MANAGER_TIMELINE_VIEW ||
    managerTimelineView === STANDARD_MANAGER_TIMELINE_VIEW
  ) {
    return managerTimelineView;
  }

  return undefined;
}

export function isStandardManagerThreadTimelineQueryKey(
  queryKey: QueryKey,
): queryKey is ThreadTimelineQueryKey {
  return (
    queryKey[0] === THREAD_TIMELINE_QUERY_KEY &&
    typeof queryKey[1] === "string" &&
    managerTimelineViewFromThreadTimelineQueryKey(queryKey) ===
      STANDARD_MANAGER_TIMELINE_VIEW
  );
}

export function threadTimelineQueryKeyPrefix(
  threadId: string,
): ThreadTimelineQueryKeyPrefix {
  return [THREAD_TIMELINE_QUERY_KEY, threadId];
}

export function allThreadTimelineQueryKeyPrefix(): AllThreadTimelineQueryKeyPrefix {
  return [THREAD_TIMELINE_QUERY_KEY];
}

export function environmentGitDiffQueryKey(
  environmentId: string,
  targetType: string | null,
  targetKey: string | null,
): EnvironmentGitDiffQueryKey {
  return [ENVIRONMENT_GIT_DIFF_QUERY_KEY, environmentId, targetType, targetKey];
}

export function allEnvironmentGitDiffQueryKeyPrefix(): EnvironmentGitDiffQueryKeyRootPrefix {
  return [ENVIRONMENT_GIT_DIFF_QUERY_KEY];
}

export function environmentGitDiffQueryKeyPrefix(
  environmentId: string,
): EnvironmentGitDiffQueryKeyPrefix {
  return [ENVIRONMENT_GIT_DIFF_QUERY_KEY, environmentId];
}

export function environmentDiffFileQueryKey(
  environmentId: string,
  targetType: string,
  targetKey: string | null,
  path: string,
  side: "old" | "new",
): EnvironmentDiffFileQueryKey {
  return [
    ENVIRONMENT_DIFF_FILE_QUERY_KEY,
    environmentId,
    targetType,
    targetKey,
    path,
    side,
  ];
}

export function allEnvironmentDiffFileQueryKeyPrefix(): EnvironmentDiffFileQueryKeyRootPrefix {
  return [ENVIRONMENT_DIFF_FILE_QUERY_KEY];
}

export function environmentDiffFileQueryKeyPrefix(
  environmentId: string,
): EnvironmentDiffFileQueryKeyPrefix {
  return [ENVIRONMENT_DIFF_FILE_QUERY_KEY, environmentId];
}

export function environmentFilePreviewQueryKey(
  environmentId: string | null | undefined,
  path: string | null,
  source: EnvironmentFilePreviewSource | null,
): EnvironmentFilePreviewQueryKey {
  return [ENVIRONMENT_FILE_PREVIEW_QUERY_KEY, environmentId, path, source];
}

export function allEnvironmentFilePreviewQueryKeyPrefix(): EnvironmentFilePreviewQueryKeyRootPrefix {
  return [ENVIRONMENT_FILE_PREVIEW_QUERY_KEY];
}

export function environmentFilePreviewQueryKeyPrefix(
  environmentId: string,
): EnvironmentFilePreviewQueryKeyPrefix {
  return [ENVIRONMENT_FILE_PREVIEW_QUERY_KEY, environmentId];
}

export function systemProvidersQueryKey(): SystemProvidersQueryKey {
  return [SYSTEM_PROVIDERS_QUERY_KEY];
}

export function systemVersionQueryKey(): SystemVersionQueryKey {
  return [SYSTEM_VERSION_QUERY_KEY];
}

export interface SystemExecutionOptionsQueryKeyArgs {
  environmentId: string | null;
  providerId: string | null;
}

export function systemExecutionOptionsQueryKey({
  environmentId,
  providerId,
}: SystemExecutionOptionsQueryKeyArgs): SystemExecutionOptionsQueryKey {
  return [SYSTEM_EXECUTION_OPTIONS_QUERY_KEY, environmentId, providerId];
}

export function allSystemExecutionOptionsQueryKeyPrefix(): AllSystemExecutionOptionsQueryKeyPrefix {
  return [SYSTEM_EXECUTION_OPTIONS_QUERY_KEY];
}

export function systemExecutionOptionsEnvironmentQueryKeyPrefix(
  environmentId: string | null,
): SystemExecutionOptionsEnvironmentQueryKeyPrefix {
  return [SYSTEM_EXECUTION_OPTIONS_QUERY_KEY, environmentId];
}

export function localPathExistenceQueryKey(
  hostId: string,
  paths: readonly string[],
): LocalPathExistenceQueryKey {
  return [LOCAL_PATH_EXISTENCE_QUERY_KEY, hostId, paths];
}

export function localPathExistenceQueryKeyPrefix(): LocalPathExistenceQueryKeyPrefix {
  return [LOCAL_PATH_EXISTENCE_QUERY_KEY];
}

export function replayCapturesQueryKey(): ReplayCapturesQueryKey {
  return [REPLAY_CAPTURES_QUERY_KEY];
}
