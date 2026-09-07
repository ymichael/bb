import type { WorkspaceDiffTarget } from "@bb/domain";
import type { ThreadListFilters, ThreadSearchFilters } from "@bb/client-core";
import type { EnvironmentFilePreviewSource } from "@bb/client-core";
import {
  DEFAULT_THREAD_STORAGE_FILE_LIST_OPTIONS,
  type ThreadStorageFileListOptions,
} from "@/lib/thread-storage-files";
import {
  DEFAULT_FILE_ONLY_PATH_LIST_OPTIONS,
  type PathListOptions,
} from "@/lib/path-list-options";

const HOSTS_QUERY_KEY = "hosts";
const HOST_QUERY_KEY = "host";
const HOST_DIRECTORY_QUERY_KEY = "hostDirectory";
const HOST_CLONE_DEFAULT_PATH_QUERY_KEY = "hostCloneDefaultPath";
const PROJECTS_QUERY_KEY = "projects";
const PROJECT_PATHS_QUERY_KEY = "projectPaths";
const PROJECT_FILE_PREVIEW_QUERY_KEY = "projectFilePreview";
export const PROJECT_SOURCE_BRANCHES_QUERY_KEY = "projectSourceBranches";
const PROJECT_DEFAULT_EXECUTION_OPTIONS_QUERY_KEY =
  "projectDefaultExecutionOptions";
const PROJECT_PROMPT_HISTORY_QUERY_KEY = "projectPromptHistory";
export const SIDEBAR_NAVIGATION_QUERY_KEY = "sidebarNavigation";
export const THREADS_QUERY_KEY = "threads";
const THREAD_SEARCH_QUERY_KEY = "threadSearch";
const THREADS_DISABLED_QUERY_KEY = "threadsDisabled";
export const THREAD_QUERY_KEY = "thread";
const THREAD_TABS_QUERY_KEY = "threadTabs";
const THREAD_DETAIL_BOOTSTRAP_QUERY_KEY = "threadDetailBootstrap";
const THREAD_DEFAULT_EXECUTION_OPTIONS_QUERY_KEY =
  "threadDefaultExecutionOptions";
const THREAD_QUEUED_MESSAGES_QUERY_KEY = "threadQueuedMessages";
const THREAD_PROMPT_HISTORY_QUERY_KEY = "threadPromptHistory";
const THREAD_PENDING_INTERACTIONS_QUERY_KEY = "threadPendingInteractions";
const TERMINALS_QUERY_KEY = "terminals";
const PROJECT_COMMANDS_QUERY_KEY = "projectCommands";
const THREAD_STORAGE_FILES_QUERY_KEY = "threadStorageFiles";
const THREAD_STORAGE_LOCATION_QUERY_KEY = "threadStorageLocation";
const THREAD_STORAGE_PATHS_QUERY_KEY = "threadStoragePaths";
const THREAD_STORAGE_FILE_PREVIEW_QUERY_KEY = "threadStorageFilePreview";
const THREAD_HOST_FILE_PREVIEW_QUERY_KEY = "threadHostFilePreview";
const HOST_FILE_PREVIEW_QUERY_KEY = "hostFilePreview";
const ENVIRONMENT_QUERY_KEY = "environment";
export const ENVIRONMENT_WORK_STATUS_QUERY_KEY = "environmentWorkStatus";
const ENVIRONMENT_PULL_REQUEST_QUERY_KEY = "environmentPullRequest";
export const ENVIRONMENT_MERGE_BASE_BRANCHES_QUERY_KEY =
  "environmentMergeBaseBranches";
export const ENVIRONMENT_DIFF_FILES_QUERY_KEY = "environmentDiffFiles";
const ENVIRONMENT_DIFF_PATCH_QUERY_KEY = "environmentDiffPatch";
const ENVIRONMENT_DIFF_FILE_QUERY_KEY = "environmentDiffFile";
const ENVIRONMENT_FILE_PREVIEW_QUERY_KEY = "environmentFilePreview";
const ENVIRONMENT_PATHS_QUERY_KEY = "environmentPaths";
export const THREAD_TIMELINE_QUERY_KEY = "threadTimeline";
const THREAD_CONVERSATION_OUTLINE_QUERY_KEY = "threadConversationOutline";
const THREAD_TIMELINE_TURN_SUMMARY_DETAILS_QUERY_KEY =
  "threadTimelineTurnSummaryDetails";
const SYSTEM_PROVIDERS_QUERY_KEY = "systemProviders";
const SYSTEM_CONFIG_QUERY_KEY = "systemConfig";
export const SYSTEM_EXECUTION_OPTIONS_QUERY_KEY = "systemExecutionOptions";
const SYSTEM_CLI_SKILLS_QUERY_KEY = "systemCliSkills";
const SYSTEM_VERSION_QUERY_KEY = "systemVersion";
const HOST_PROVIDER_CLI_STATUS_QUERY_KEY = "hostProviderCliStatus";
const SYSTEM_USAGE_LIMITS_QUERY_KEY = "systemUsageLimits";
const SYSTEM_PROVIDER_STATES_QUERY_KEY = "systemProviderStates";
const HOST_PATH_EXISTENCE_QUERY_KEY = "hostPathExistence";
const PROJECT_SKILLS_QUERY_KEY = "projectSkills";
export const SKILL_CONTENT_QUERY_KEY = "skillContent";
export const SKILL_FILES_QUERY_KEY = "skillFiles";
const PLUGIN_LIST_QUERY_KEY = "plugin-list";
const PLUGIN_SETTINGS_VIEW_QUERY_KEY = "plugin-settings-view";
const PLUGIN_CONTRIBUTIONS_QUERY_KEY = "plugin-contributions";
const PLUGIN_SDK_SETTINGS_QUERY_KEY = "plugin-settings";
const PLUGIN_SOURCE_QUERY_KEY = "plugin-source";
const PLUGIN_CATALOG_SEARCH_QUERY_KEY = "plugin-catalog-search";
const PLUGIN_CATALOG_INSTALL_PLAN_QUERY_KEY = "plugin-catalog-install-plan";
const PLUGIN_MARKETPLACES_QUERY_KEY = "plugin-marketplaces";
export interface ThreadListQueryFilters {
  projectId?: string;
  hasParent?: ThreadListFilters["hasParent"];
  parentThreadId?: string;
  sourceThreadId?: string;
  originKind?: ThreadListFilters["originKind"];
  archived: boolean;
  limit?: number;
}

interface ThreadSearchQueryFilters {
  query: ThreadSearchFilters["query"];
  limitPerGroup: NonNullable<ThreadSearchFilters["limitPerGroup"]>;
}

export type ArchivedThreadsKindFilter = "all" | "root" | "child";

export interface ArchivedThreadsListFilters {
  projectId?: string;
  kind?: ArchivedThreadsKindFilter;
}

export const ARCHIVED_THREADS_LIST_KIND = "archivedList";

type HostsQueryKey = readonly [typeof HOSTS_QUERY_KEY];
type HostQueryId = string | null | undefined;
type HostQueryKey = readonly [typeof HOST_QUERY_KEY, HostQueryId];
type AllHostQueryKeyPrefix = readonly [typeof HOST_QUERY_KEY];
type HostDirectoryQueryKey = readonly [
  typeof HOST_DIRECTORY_QUERY_KEY,
  HostQueryId,
  string | null,
];
type HostCloneDefaultPathQueryKey = readonly [
  typeof HOST_CLONE_DEFAULT_PATH_QUERY_KEY,
  HostQueryId,
  string | null,
];
type ProjectsQueryKey = readonly [typeof PROJECTS_QUERY_KEY];
type AllProjectPathsQueryKeyPrefix = readonly [typeof PROJECT_PATHS_QUERY_KEY];
type AllProjectSourceBranchesQueryKeyPrefix = readonly [
  typeof PROJECT_SOURCE_BRANCHES_QUERY_KEY,
];
type ProjectSourceBranchesQueryKeyPrefix = readonly [
  typeof PROJECT_SOURCE_BRANCHES_QUERY_KEY,
  string,
];
type ProjectDefaultExecutionOptionsQueryKey = readonly [
  typeof PROJECT_DEFAULT_EXECUTION_OPTIONS_QUERY_KEY,
  string,
];
type ProjectPromptHistoryQueryKeyPrefix = readonly [
  typeof PROJECT_PROMPT_HISTORY_QUERY_KEY,
];
type ProjectPromptHistoryQueryKey = readonly [
  typeof PROJECT_PROMPT_HISTORY_QUERY_KEY,
  string | null | undefined,
];
type ProjectPathsQueryKey = readonly [
  typeof PROJECT_PATHS_QUERY_KEY,
  string | undefined,
  string | null,
  string | null,
  string,
  number,
  boolean,
  boolean,
];
type ProjectPathsQueryKeyPrefix = readonly [
  typeof PROJECT_PATHS_QUERY_KEY,
  string,
];
type ProjectFilePreviewQueryKey = readonly [
  typeof PROJECT_FILE_PREVIEW_QUERY_KEY,
  string | undefined,
  string | null,
  string | null,
  string | null,
];
type ProjectSourceBranchesQueryKey = readonly [
  typeof PROJECT_SOURCE_BRANCHES_QUERY_KEY,
  string,
  string,
  string,
  number,
  string,
];
export type SidebarNavigationQueryKey = readonly [
  typeof SIDEBAR_NAVIGATION_QUERY_KEY,
];
type ThreadsQueryKey = readonly [typeof THREADS_QUERY_KEY];
type ThreadListQueryKey = readonly [
  typeof THREADS_QUERY_KEY,
  ThreadListQueryFilters,
];
type ThreadSearchQueryKey = readonly [
  typeof THREAD_SEARCH_QUERY_KEY,
  ThreadSearchQueryFilters,
];
type ThreadSearchQueryKeyPrefix = readonly [typeof THREAD_SEARCH_QUERY_KEY];
type ArchivedThreadsListQueryKey = readonly [
  typeof THREADS_QUERY_KEY,
  typeof ARCHIVED_THREADS_LIST_KIND,
  ArchivedThreadsListFilters,
];
type DisabledThreadListQueryKey = readonly [
  typeof THREADS_DISABLED_QUERY_KEY,
  ThreadListQueryFilters?,
];
type ThreadQueryKeyPrefix = readonly [typeof THREAD_QUERY_KEY];
type ThreadQueryKey = readonly [typeof THREAD_QUERY_KEY, string];
type ThreadTabsQueryKey = readonly [typeof THREAD_TABS_QUERY_KEY, string];
type ThreadDetailBootstrapQueryKeyPrefix = readonly [
  typeof THREAD_DETAIL_BOOTSTRAP_QUERY_KEY,
];
type ThreadDetailBootstrapQueryKey = readonly [
  typeof THREAD_DETAIL_BOOTSTRAP_QUERY_KEY,
  string,
];
type ThreadDefaultExecutionOptionsQueryKeyPrefix = readonly [
  typeof THREAD_DEFAULT_EXECUTION_OPTIONS_QUERY_KEY,
];
type ThreadDefaultExecutionOptionsQueryKey = readonly [
  typeof THREAD_DEFAULT_EXECUTION_OPTIONS_QUERY_KEY,
  string,
];
type ThreadQueuedMessagesQueryKeyPrefix = readonly [
  typeof THREAD_QUEUED_MESSAGES_QUERY_KEY,
];
type ThreadQueuedMessagesQueryKey = readonly [
  typeof THREAD_QUEUED_MESSAGES_QUERY_KEY,
  string,
];
type ThreadPromptHistoryQueryKeyPrefix = readonly [
  typeof THREAD_PROMPT_HISTORY_QUERY_KEY,
];
type ThreadPromptHistoryQueryKey = readonly [
  typeof THREAD_PROMPT_HISTORY_QUERY_KEY,
  string,
];
type ThreadPendingInteractionsQueryKeyPrefix = readonly [
  typeof THREAD_PENDING_INTERACTIONS_QUERY_KEY,
];
type ThreadPendingInteractionsQueryKey = readonly [
  typeof THREAD_PENDING_INTERACTIONS_QUERY_KEY,
  string,
];
export type TerminalQueryScope =
  | { kind: "thread"; threadId: string }
  | { kind: "environment"; environmentId: string }
  | { kind: "host_path"; cwd?: string; hostId: string };
type AllTerminalsQueryKeyPrefix = readonly [typeof TERMINALS_QUERY_KEY];
type TerminalsQueryKey = readonly [
  typeof TERMINALS_QUERY_KEY,
  TerminalQueryScope,
];
type ProjectCommandsQueryKey = readonly [
  typeof PROJECT_COMMANDS_QUERY_KEY,
  string | undefined,
  string | undefined,
  string | null,
  string | null,
];
type AllProjectCommandsQueryKeyPrefix = readonly [
  typeof PROJECT_COMMANDS_QUERY_KEY,
];
type ThreadStorageFilesQueryKey = readonly [
  typeof THREAD_STORAGE_FILES_QUERY_KEY,
  string,
  ThreadStorageFileListOptions,
];
type ThreadStorageLocationQueryKey = readonly [
  typeof THREAD_STORAGE_LOCATION_QUERY_KEY,
  string,
];
type AllThreadStorageLocationsQueryKeyPrefix = readonly [
  typeof THREAD_STORAGE_LOCATION_QUERY_KEY,
];
type ThreadStoragePathsQueryKey = readonly [
  typeof THREAD_STORAGE_PATHS_QUERY_KEY,
  string,
  PathListOptions,
];
type AllThreadStorageFilesQueryKeyPrefix = readonly [
  typeof THREAD_STORAGE_FILES_QUERY_KEY,
];
type AllThreadStoragePathsQueryKeyPrefix = readonly [
  typeof THREAD_STORAGE_PATHS_QUERY_KEY,
];
type ThreadStorageFilesForThreadQueryKeyPrefix = readonly [
  typeof THREAD_STORAGE_FILES_QUERY_KEY,
  string,
];
type ThreadStoragePathsForThreadQueryKeyPrefix = readonly [
  typeof THREAD_STORAGE_PATHS_QUERY_KEY,
  string,
];
type AllThreadStorageFilePreviewQueryKeyPrefix = readonly [
  typeof THREAD_STORAGE_FILE_PREVIEW_QUERY_KEY,
];
type ThreadStorageFilePreviewQueryKey = readonly [
  typeof THREAD_STORAGE_FILE_PREVIEW_QUERY_KEY,
  string,
  string | null,
];
type ThreadStorageFilePreviewQueryKeyPrefix = readonly [
  typeof THREAD_STORAGE_FILE_PREVIEW_QUERY_KEY,
  string,
];
type ThreadHostFilePreviewQueryKey = readonly [
  typeof THREAD_HOST_FILE_PREVIEW_QUERY_KEY,
  string,
  string | null | undefined,
  string | null,
];
type AllThreadHostFilePreviewQueryKeyPrefix = readonly [
  typeof THREAD_HOST_FILE_PREVIEW_QUERY_KEY,
];
type HostFilePreviewQueryKey = readonly [
  typeof HOST_FILE_PREVIEW_QUERY_KEY,
  string | null,
  string | null,
];
type EnvironmentQueryKeyPrefix = readonly [typeof ENVIRONMENT_QUERY_KEY];
type EnvironmentQueryKey = readonly [
  typeof ENVIRONMENT_QUERY_KEY,
  string | null | undefined,
];
type EnvironmentWorkStatusQueryKeyRootPrefix = readonly [
  typeof ENVIRONMENT_WORK_STATUS_QUERY_KEY,
];
export type EnvironmentWorkStatusQueryKey = readonly [
  typeof ENVIRONMENT_WORK_STATUS_QUERY_KEY,
  string | null | undefined,
  string | null,
];
type EnvironmentWorkStatusQueryKeyPrefix = readonly [
  typeof ENVIRONMENT_WORK_STATUS_QUERY_KEY,
  string,
];
type EnvironmentPullRequestQueryKey = readonly [
  typeof ENVIRONMENT_PULL_REQUEST_QUERY_KEY,
  string | null | undefined,
];
type EnvironmentMergeBaseBranchesQueryKeyRootPrefix = readonly [
  typeof ENVIRONMENT_MERGE_BASE_BRANCHES_QUERY_KEY,
];
type EnvironmentMergeBaseBranchesQueryKey = readonly [
  typeof ENVIRONMENT_MERGE_BASE_BRANCHES_QUERY_KEY,
  string,
  string,
  number,
  string,
];
type EnvironmentMergeBaseBranchesQueryKeyPrefix = readonly [
  typeof ENVIRONMENT_MERGE_BASE_BRANCHES_QUERY_KEY,
  string,
];
type ThreadTimelineQueryKey = readonly [
  typeof THREAD_TIMELINE_QUERY_KEY,
  string,
];
type ThreadConversationOutlineQueryKey = readonly [
  typeof THREAD_CONVERSATION_OUTLINE_QUERY_KEY,
  string,
];
type ThreadConversationOutlineQueryKeyPrefix = readonly [
  typeof THREAD_CONVERSATION_OUTLINE_QUERY_KEY,
  string,
];
type AllThreadConversationOutlineQueryKeyPrefix = readonly [
  typeof THREAD_CONVERSATION_OUTLINE_QUERY_KEY,
];
export interface ThreadTimelineTurnSummaryDetailsQueryIdentity {
  sourceSeqEnd: number;
  sourceSeqStart: number;
  threadId: string;
  turnId: string;
}
type ThreadTimelineTurnSummaryDetailsQueryKey = readonly [
  typeof THREAD_TIMELINE_TURN_SUMMARY_DETAILS_QUERY_KEY,
  string,
  string,
  number,
  number,
];
type ThreadTimelineQueryKeyPrefix = readonly [
  typeof THREAD_TIMELINE_QUERY_KEY,
  string,
];
type AllThreadTimelineQueryKeyPrefix = readonly [
  typeof THREAD_TIMELINE_QUERY_KEY,
];
type ThreadTimelineTurnSummaryDetailsQueryKeyPrefix = readonly [
  typeof THREAD_TIMELINE_TURN_SUMMARY_DETAILS_QUERY_KEY,
  string,
];
type AllThreadTimelineTurnSummaryDetailsQueryKeyPrefix = readonly [
  typeof THREAD_TIMELINE_TURN_SUMMARY_DETAILS_QUERY_KEY,
];
type EnvironmentDiffFilesQueryKey = readonly [
  typeof ENVIRONMENT_DIFF_FILES_QUERY_KEY,
  string,
  string | null,
  string | null,
];
type EnvironmentDiffFilesQueryKeyRootPrefix = readonly [
  typeof ENVIRONMENT_DIFF_FILES_QUERY_KEY,
];
type EnvironmentDiffFilesQueryKeyPrefix = readonly [
  typeof ENVIRONMENT_DIFF_FILES_QUERY_KEY,
  string,
];
type EnvironmentDiffPatchQueryKey = readonly [
  typeof ENVIRONMENT_DIFF_PATCH_QUERY_KEY,
  string,
  string | null,
  string | null,
  string,
];
type EnvironmentDiffPatchQueryKeyRootPrefix = readonly [
  typeof ENVIRONMENT_DIFF_PATCH_QUERY_KEY,
];
type EnvironmentDiffPatchQueryKeyPrefix = readonly [
  typeof ENVIRONMENT_DIFF_PATCH_QUERY_KEY,
  string,
];
type EnvironmentDiffFileQueryKey = readonly [
  typeof ENVIRONMENT_DIFF_FILE_QUERY_KEY,
  string,
  string,
  string | null,
  string,
  "old" | "new",
];
type EnvironmentFilePreviewQueryKey = readonly [
  typeof ENVIRONMENT_FILE_PREVIEW_QUERY_KEY,
  string | null | undefined,
  string | null,
  EnvironmentFilePreviewSource | null,
];
type EnvironmentFilePreviewQueryKeyRootPrefix = readonly [
  typeof ENVIRONMENT_FILE_PREVIEW_QUERY_KEY,
];
type EnvironmentFilePreviewQueryKeyPrefix = readonly [
  typeof ENVIRONMENT_FILE_PREVIEW_QUERY_KEY,
  string,
];
type EnvironmentPathsQueryKey = readonly [
  typeof ENVIRONMENT_PATHS_QUERY_KEY,
  string | undefined,
  string,
  number,
  boolean,
  boolean,
];
type EnvironmentPathsQueryKeyPrefix = readonly [
  typeof ENVIRONMENT_PATHS_QUERY_KEY,
  string,
];
type SystemProvidersQueryKey = readonly [
  typeof SYSTEM_PROVIDERS_QUERY_KEY,
  string | null,
  string | null,
  "usage" | null,
];
type AllSystemProvidersQueryKeyPrefix = readonly [
  typeof SYSTEM_PROVIDERS_QUERY_KEY,
];
type SystemConfigQueryKey = readonly [typeof SYSTEM_CONFIG_QUERY_KEY];
type SystemCliSkillsQueryKey = readonly [typeof SYSTEM_CLI_SKILLS_QUERY_KEY];
type SystemVersionQueryKey = readonly [typeof SYSTEM_VERSION_QUERY_KEY];
type HostProviderCliStatusQueryKey = readonly [
  typeof HOST_PROVIDER_CLI_STATUS_QUERY_KEY,
  string | null,
];
type SystemUsageLimitsQueryKey = readonly [
  typeof SYSTEM_USAGE_LIMITS_QUERY_KEY,
  string | null,
  string | null,
];
type SystemProviderStatesQueryKey = readonly [
  typeof SYSTEM_PROVIDER_STATES_QUERY_KEY,
  string | null,
  string | null,
];
type SystemExecutionOptionsQueryKey = readonly [
  typeof SYSTEM_EXECUTION_OPTIONS_QUERY_KEY,
  string | null,
  string | null,
  string | null,
];
type AllSystemExecutionOptionsQueryKeyPrefix = readonly [
  typeof SYSTEM_EXECUTION_OPTIONS_QUERY_KEY,
];
type SystemExecutionOptionsEnvironmentQueryKeyPrefix = readonly [
  typeof SYSTEM_EXECUTION_OPTIONS_QUERY_KEY,
  string | null,
];
type HostPathExistenceQueryKey = readonly [
  typeof HOST_PATH_EXISTENCE_QUERY_KEY,
  string | null,
  readonly string[],
];
type HostPathExistenceQueryKeyPrefix = readonly [
  typeof HOST_PATH_EXISTENCE_QUERY_KEY,
];
interface ProjectDefaultExecutionOptionsQueryKeyArgs {
  projectId: string;
}

export function hostsQueryKey(): HostsQueryKey {
  return [HOSTS_QUERY_KEY];
}

export function hostQueryKey(hostId: HostQueryId): HostQueryKey {
  return [HOST_QUERY_KEY, hostId];
}

export function allHostQueryKeyPrefix(): AllHostQueryKeyPrefix {
  return [HOST_QUERY_KEY];
}

export function hostDirectoryQueryKey(
  hostId: HostQueryId,
  path: string | null,
): HostDirectoryQueryKey {
  return [HOST_DIRECTORY_QUERY_KEY, hostId, path];
}

export function hostCloneDefaultPathQueryKey(
  hostId: HostQueryId,
  projectId: string | null,
): HostCloneDefaultPathQueryKey {
  return [HOST_CLONE_DEFAULT_PATH_QUERY_KEY, hostId, projectId];
}

export function projectsQueryKey(): ProjectsQueryKey {
  return [PROJECTS_QUERY_KEY];
}

export function projectPathsQueryKey(
  projectId: string | undefined,
  environmentId: string | null,
  hostId: string | null,
  query: string,
  limit: number,
  includeFiles: boolean,
  includeDirectories: boolean,
): ProjectPathsQueryKey {
  return [
    PROJECT_PATHS_QUERY_KEY,
    projectId,
    environmentId,
    hostId,
    query,
    limit,
    includeFiles,
    includeDirectories,
  ];
}

export function projectFilePreviewQueryKey(
  projectId: string | undefined,
  environmentId: string | null,
  hostId: string | null,
  path: string | null,
): ProjectFilePreviewQueryKey {
  return [
    PROJECT_FILE_PREVIEW_QUERY_KEY,
    projectId,
    environmentId,
    hostId,
    path,
  ];
}

export function allProjectPathsQueryKeyPrefix(): AllProjectPathsQueryKeyPrefix {
  return [PROJECT_PATHS_QUERY_KEY];
}

export function environmentPathsQueryKey(
  environmentId: string | undefined,
  query: string,
  limit: number,
  includeFiles: boolean,
  includeDirectories: boolean,
): EnvironmentPathsQueryKey {
  return [
    ENVIRONMENT_PATHS_QUERY_KEY,
    environmentId,
    query,
    limit,
    includeFiles,
    includeDirectories,
  ];
}

export function environmentPathsQueryKeyPrefix(
  environmentId: string,
): EnvironmentPathsQueryKeyPrefix {
  return [ENVIRONMENT_PATHS_QUERY_KEY, environmentId];
}

export function projectPromptHistoryQueryKey(
  projectId: string | null | undefined,
): ProjectPromptHistoryQueryKey {
  return [PROJECT_PROMPT_HISTORY_QUERY_KEY, projectId];
}

export function projectDefaultExecutionOptionsQueryKey({
  projectId,
}: ProjectDefaultExecutionOptionsQueryKeyArgs): ProjectDefaultExecutionOptionsQueryKey {
  return [PROJECT_DEFAULT_EXECUTION_OPTIONS_QUERY_KEY, projectId];
}

export function projectPromptHistoryQueryKeyPrefix(): ProjectPromptHistoryQueryKeyPrefix {
  return [PROJECT_PROMPT_HISTORY_QUERY_KEY];
}

export function projectPathsQueryKeyPrefix(
  projectId: string,
): ProjectPathsQueryKeyPrefix {
  return [PROJECT_PATHS_QUERY_KEY, projectId];
}

export function projectSourceBranchesQueryKey(
  projectId: string,
  hostId: string,
  query = "",
  limit = 50,
  selectedBranch = "",
): ProjectSourceBranchesQueryKey {
  return [
    PROJECT_SOURCE_BRANCHES_QUERY_KEY,
    projectId,
    hostId,
    query,
    limit,
    selectedBranch,
  ];
}

export function allProjectSourceBranchesQueryKeyPrefix(): AllProjectSourceBranchesQueryKeyPrefix {
  return [PROJECT_SOURCE_BRANCHES_QUERY_KEY];
}

export function projectSourceBranchesQueryKeyPrefix(
  projectId: string,
): ProjectSourceBranchesQueryKeyPrefix {
  return [PROJECT_SOURCE_BRANCHES_QUERY_KEY, projectId];
}

export function sidebarNavigationQueryKey(): SidebarNavigationQueryKey {
  return [SIDEBAR_NAVIGATION_QUERY_KEY];
}

export function threadsQueryKey(): ThreadsQueryKey {
  return [THREADS_QUERY_KEY];
}

export function threadListQueryKey(
  filters: ThreadListQueryFilters,
): ThreadListQueryKey {
  return [THREADS_QUERY_KEY, filters];
}

export function threadSearchQueryKey(
  filters: ThreadSearchQueryFilters,
): ThreadSearchQueryKey {
  return [THREAD_SEARCH_QUERY_KEY, filters];
}

export function threadSearchQueryKeyPrefix(): ThreadSearchQueryKeyPrefix {
  return [THREAD_SEARCH_QUERY_KEY];
}

export function archivedThreadsListQueryKey(
  filters: ArchivedThreadsListFilters,
): ArchivedThreadsListQueryKey {
  return [THREADS_QUERY_KEY, ARCHIVED_THREADS_LIST_KIND, filters];
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

export function threadTabsQueryKey(threadId: string): ThreadTabsQueryKey {
  return [THREAD_TABS_QUERY_KEY, threadId];
}

export function threadDetailBootstrapQueryKey(
  threadId: string,
): ThreadDetailBootstrapQueryKey {
  return [THREAD_DETAIL_BOOTSTRAP_QUERY_KEY, threadId];
}

export function allThreadDetailBootstrapQueryKeyPrefix(): ThreadDetailBootstrapQueryKeyPrefix {
  return [THREAD_DETAIL_BOOTSTRAP_QUERY_KEY];
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

export function terminalsQueryKey(
  scope: TerminalQueryScope,
): TerminalsQueryKey {
  return [TERMINALS_QUERY_KEY, scope];
}

export function allTerminalsQueryKeyPrefix(): AllTerminalsQueryKeyPrefix {
  return [TERMINALS_QUERY_KEY];
}

export function projectCommandsQueryKey(
  projectId: string | undefined,
  providerId: string | undefined,
  environmentId: string | null,
  hostId: string | null,
): ProjectCommandsQueryKey {
  return [
    PROJECT_COMMANDS_QUERY_KEY,
    projectId,
    providerId,
    environmentId,
    hostId,
  ];
}

export function allProjectCommandsQueryKeyPrefix(): AllProjectCommandsQueryKeyPrefix {
  return [PROJECT_COMMANDS_QUERY_KEY];
}

export function threadStorageFilesQueryKey(
  threadId: string,
  options: ThreadStorageFileListOptions = DEFAULT_THREAD_STORAGE_FILE_LIST_OPTIONS,
): ThreadStorageFilesQueryKey {
  return [THREAD_STORAGE_FILES_QUERY_KEY, threadId, options];
}

export function threadStorageLocationQueryKey(
  threadId: string,
): ThreadStorageLocationQueryKey {
  return [THREAD_STORAGE_LOCATION_QUERY_KEY, threadId];
}

export function allThreadStorageLocationsQueryKeyPrefix(): AllThreadStorageLocationsQueryKeyPrefix {
  return [THREAD_STORAGE_LOCATION_QUERY_KEY];
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

export function threadHostFilePreviewQueryKey(
  threadId: string,
  environmentId: string | null | undefined,
  path: string | null,
): ThreadHostFilePreviewQueryKey {
  return [THREAD_HOST_FILE_PREVIEW_QUERY_KEY, threadId, environmentId, path];
}

export function hostFilePreviewQueryKey(
  hostId: string | null,
  path: string | null,
): HostFilePreviewQueryKey {
  return [HOST_FILE_PREVIEW_QUERY_KEY, hostId, path];
}

export function allThreadHostFilePreviewQueryKeyPrefix(): AllThreadHostFilePreviewQueryKeyPrefix {
  return [THREAD_HOST_FILE_PREVIEW_QUERY_KEY];
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

export function environmentPullRequestQueryKey(
  environmentId: string | null | undefined,
): EnvironmentPullRequestQueryKey {
  return [ENVIRONMENT_PULL_REQUEST_QUERY_KEY, environmentId];
}

export function environmentMergeBaseBranchesQueryKey(
  environmentId: string,
  query = "",
  limit = 50,
  selectedBranch = "",
): EnvironmentMergeBaseBranchesQueryKey {
  return [
    ENVIRONMENT_MERGE_BASE_BRANCHES_QUERY_KEY,
    environmentId,
    query,
    limit,
    selectedBranch,
  ];
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
): ThreadTimelineQueryKey {
  return [THREAD_TIMELINE_QUERY_KEY, threadId];
}

export function threadConversationOutlineQueryKey(
  threadId: string,
): ThreadConversationOutlineQueryKey {
  return [THREAD_CONVERSATION_OUTLINE_QUERY_KEY, threadId];
}

export function threadConversationOutlineQueryKeyPrefix(
  threadId: string,
): ThreadConversationOutlineQueryKeyPrefix {
  return [THREAD_CONVERSATION_OUTLINE_QUERY_KEY, threadId];
}

export function allThreadConversationOutlineQueryKeyPrefix(): AllThreadConversationOutlineQueryKeyPrefix {
  return [THREAD_CONVERSATION_OUTLINE_QUERY_KEY];
}

export function threadTimelineTurnSummaryDetailsQueryKey({
  sourceSeqEnd,
  sourceSeqStart,
  threadId,
  turnId,
}: ThreadTimelineTurnSummaryDetailsQueryIdentity): ThreadTimelineTurnSummaryDetailsQueryKey {
  return [
    THREAD_TIMELINE_TURN_SUMMARY_DETAILS_QUERY_KEY,
    threadId,
    turnId,
    sourceSeqStart,
    sourceSeqEnd,
  ];
}

export function threadTimelineQueryKeyPrefix(
  threadId: string,
): ThreadTimelineQueryKeyPrefix {
  return [THREAD_TIMELINE_QUERY_KEY, threadId];
}

export function allThreadTimelineQueryKeyPrefix(): AllThreadTimelineQueryKeyPrefix {
  return [THREAD_TIMELINE_QUERY_KEY];
}

export function threadTimelineTurnSummaryDetailsQueryKeyPrefix(
  threadId: string,
): ThreadTimelineTurnSummaryDetailsQueryKeyPrefix {
  return [THREAD_TIMELINE_TURN_SUMMARY_DETAILS_QUERY_KEY, threadId];
}

export function allThreadTimelineTurnSummaryDetailsQueryKeyPrefix(): AllThreadTimelineTurnSummaryDetailsQueryKeyPrefix {
  return [THREAD_TIMELINE_TURN_SUMMARY_DETAILS_QUERY_KEY];
}

export function environmentDiffTargetKey(
  target: WorkspaceDiffTarget | null | undefined,
): string | null {
  switch (target?.type) {
    case "commit":
      return target.sha;
    case "branch_committed":
    case "all":
      return target.mergeBaseBranch;
    default:
      return null;
  }
}

export function environmentDiffFilesQueryKey(
  environmentId: string,
  targetType: string | null,
  targetKey: string | null,
): EnvironmentDiffFilesQueryKey {
  return [
    ENVIRONMENT_DIFF_FILES_QUERY_KEY,
    environmentId,
    targetType,
    targetKey,
  ];
}

export function allEnvironmentDiffFilesQueryKeyPrefix(): EnvironmentDiffFilesQueryKeyRootPrefix {
  return [ENVIRONMENT_DIFF_FILES_QUERY_KEY];
}

export function environmentDiffFilesQueryKeyPrefix(
  environmentId: string,
): EnvironmentDiffFilesQueryKeyPrefix {
  return [ENVIRONMENT_DIFF_FILES_QUERY_KEY, environmentId];
}

export function environmentDiffPatchQueryKey(
  environmentId: string,
  targetType: string | null,
  targetKey: string | null,
  path: string,
): EnvironmentDiffPatchQueryKey {
  return [
    ENVIRONMENT_DIFF_PATCH_QUERY_KEY,
    environmentId,
    targetType,
    targetKey,
    path,
  ];
}

export function allEnvironmentDiffPatchQueryKeyPrefix(): EnvironmentDiffPatchQueryKeyRootPrefix {
  return [ENVIRONMENT_DIFF_PATCH_QUERY_KEY];
}

export function environmentDiffPatchQueryKeyPrefix(
  environmentId: string,
): EnvironmentDiffPatchQueryKeyPrefix {
  return [ENVIRONMENT_DIFF_PATCH_QUERY_KEY, environmentId];
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

interface SystemProvidersQueryKeyArgs {
  capability?: "usage" | null;
  environmentId?: string | null;
  hostId?: string | null;
}

export function systemProvidersQueryKey(
  args: SystemProvidersQueryKeyArgs = {},
): SystemProvidersQueryKey {
  return [
    SYSTEM_PROVIDERS_QUERY_KEY,
    args.environmentId ?? null,
    args.hostId ?? null,
    args.capability ?? null,
  ];
}

export function allSystemProvidersQueryKeyPrefix(): AllSystemProvidersQueryKeyPrefix {
  return [SYSTEM_PROVIDERS_QUERY_KEY];
}

export function systemCliSkillsQueryKey(): SystemCliSkillsQueryKey {
  return [SYSTEM_CLI_SKILLS_QUERY_KEY];
}

export function systemConfigQueryKey(): SystemConfigQueryKey {
  return [SYSTEM_CONFIG_QUERY_KEY];
}

export function systemVersionQueryKey(): SystemVersionQueryKey {
  return [SYSTEM_VERSION_QUERY_KEY];
}

export function hostProviderCliStatusQueryKey(
  hostId: string | null,
): HostProviderCliStatusQueryKey {
  return [HOST_PROVIDER_CLI_STATUS_QUERY_KEY, hostId];
}

export function systemUsageLimitsQueryKey(
  hostId: string | null,
  providerId: string | null = null,
): SystemUsageLimitsQueryKey {
  return [SYSTEM_USAGE_LIMITS_QUERY_KEY, hostId, providerId];
}

export function systemProviderStatesQueryKey(
  args: Pick<SystemExecutionOptionsQueryKeyArgs, "environmentId" | "hostId">,
): SystemProviderStatesQueryKey {
  return [SYSTEM_PROVIDER_STATES_QUERY_KEY, args.environmentId, args.hostId];
}

interface SystemExecutionOptionsQueryKeyArgs {
  environmentId: string | null;
  hostId: string | null;
  providerId: string | null;
}

export function systemExecutionOptionsQueryKey({
  environmentId,
  hostId,
  providerId,
}: SystemExecutionOptionsQueryKeyArgs): SystemExecutionOptionsQueryKey {
  return [
    SYSTEM_EXECUTION_OPTIONS_QUERY_KEY,
    environmentId,
    hostId,
    providerId,
  ];
}

export function allSystemExecutionOptionsQueryKeyPrefix(): AllSystemExecutionOptionsQueryKeyPrefix {
  return [SYSTEM_EXECUTION_OPTIONS_QUERY_KEY];
}

export function systemExecutionOptionsEnvironmentQueryKeyPrefix(
  environmentId: string | null,
): SystemExecutionOptionsEnvironmentQueryKeyPrefix {
  return [SYSTEM_EXECUTION_OPTIONS_QUERY_KEY, environmentId];
}

export function hostPathExistenceQueryKey(
  hostId: string | null,
  paths: readonly string[],
): HostPathExistenceQueryKey {
  return [HOST_PATH_EXISTENCE_QUERY_KEY, hostId, paths];
}

export function hostPathExistenceQueryKeyPrefix(): HostPathExistenceQueryKeyPrefix {
  return [HOST_PATH_EXISTENCE_QUERY_KEY];
}

export function projectSkillsQueryKey(projectId: string) {
  return [PROJECT_SKILLS_QUERY_KEY, projectId] as const;
}

export function skillContentQueryKey(
  projectId: string,
  skillId: string,
  path: string,
) {
  return [SKILL_CONTENT_QUERY_KEY, projectId, skillId, path] as const;
}

export function skillFilesQueryKey(projectId: string, skillId: string) {
  return [SKILL_FILES_QUERY_KEY, projectId, skillId] as const;
}

export function pluginListQueryKey(enabled: boolean) {
  return [PLUGIN_LIST_QUERY_KEY, enabled] as const;
}

export function allPluginListQueryKeyPrefix() {
  return [PLUGIN_LIST_QUERY_KEY] as const;
}

export function pluginSettingsViewQueryKey(pluginId: string) {
  return [PLUGIN_SETTINGS_VIEW_QUERY_KEY, pluginId] as const;
}

export function allPluginSettingsViewQueryKeyPrefix() {
  return [PLUGIN_SETTINGS_VIEW_QUERY_KEY] as const;
}

export function pluginContributionsQueryKey() {
  return [PLUGIN_CONTRIBUTIONS_QUERY_KEY] as const;
}

export function allPluginContributionsQueryKeyPrefix() {
  return [PLUGIN_CONTRIBUTIONS_QUERY_KEY] as const;
}

export function pluginSdkSettingsQueryKey(pluginId: string) {
  return [PLUGIN_SDK_SETTINGS_QUERY_KEY, pluginId] as const;
}

export function allPluginSettingsQueryKeyPrefix() {
  return [PLUGIN_SDK_SETTINGS_QUERY_KEY] as const;
}

export function pluginSourceQueryKey(pluginId: string) {
  return [PLUGIN_SOURCE_QUERY_KEY, pluginId] as const;
}

export function allPluginSourceQueryKeyPrefix() {
  return [PLUGIN_SOURCE_QUERY_KEY] as const;
}

export function pluginCatalogSearchQueryKey(query: string) {
  return [PLUGIN_CATALOG_SEARCH_QUERY_KEY, query] as const;
}

export function allPluginCatalogSearchQueryKeyPrefix() {
  return [PLUGIN_CATALOG_SEARCH_QUERY_KEY] as const;
}

export function pluginCatalogInstallPlanQueryKey(args: {
  entryId: string;
  marketplace?: string;
}) {
  return [
    PLUGIN_CATALOG_INSTALL_PLAN_QUERY_KEY,
    args.marketplace ?? "",
    args.entryId,
  ] as const;
}

export function pluginMarketplacesQueryKey() {
  return [PLUGIN_MARKETPLACES_QUERY_KEY] as const;
}
