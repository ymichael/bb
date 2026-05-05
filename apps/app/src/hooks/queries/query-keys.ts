import type { ThreadListFilters } from "@/lib/api";
import type { ManagerTimelineView } from "@bb/server-contract";

export const HOSTS_QUERY_KEY = "hosts";
export const HOST_QUERY_KEY = "host";
export const PROJECTS_QUERY_KEY = "projects";
export const PROJECT_FILES_QUERY_KEY = "projectFiles";
export const PROJECT_PROMPT_HISTORY_QUERY_KEY = "projectPromptHistory";
export const THREADS_QUERY_KEY = "threads";
export const THREADS_DISABLED_QUERY_KEY = "threadsDisabled";
export const THREAD_QUERY_KEY = "thread";
export const THREAD_DEFAULT_EXECUTION_OPTIONS_QUERY_KEY =
  "threadDefaultExecutionOptions";
export const THREAD_DRAFTS_QUERY_KEY = "threadDrafts";
export const THREAD_PROMPT_HISTORY_QUERY_KEY = "threadPromptHistory";
export const THREAD_PENDING_INTERACTIONS_QUERY_KEY =
  "threadPendingInteractions";
export const THREAD_STORAGE_FILES_QUERY_KEY = "threadStorageFiles";
export const THREAD_STORAGE_FILE_PREVIEW_QUERY_KEY = "threadStorageFilePreview";
export const ENVIRONMENT_QUERY_KEY = "environment";
export const ENVIRONMENT_WORK_STATUS_QUERY_KEY = "environmentWorkStatus";
export const ENVIRONMENT_PROMOTION_QUERY_KEY = "environmentPromotion";
export const ENVIRONMENT_MERGE_BASE_BRANCHES_QUERY_KEY =
  "environmentMergeBaseBranches";
export const ENVIRONMENT_GIT_DIFF_QUERY_KEY = "environmentGitDiff";
export const PROJECT_SOURCE_WORKSPACE_STATUS_QUERY_KEY =
  "projectSourceWorkspaceStatus";
export const THREAD_TIMELINE_QUERY_KEY = "threadTimeline";
export const AVAILABLE_MODELS_QUERY_KEY = "availableModels";
export const SYSTEM_PROVIDERS_QUERY_KEY = "systemProviders";
export const SANDBOX_BACKENDS_QUERY_KEY = "sandboxBackends";
export const CLOUD_AUTH_SETTINGS_QUERY_KEY = "cloudAuthSettings";
export const CLOUD_AUTH_ATTEMPT_QUERY_KEY = "cloudAuthAttempt";
export const SANDBOX_ENV_VARS_QUERY_KEY = "sandboxEnvVars";
export const GITHUB_REPOS_QUERY_KEY = "githubRepos";
export const STATUS_QUERY_KEY = "status";
export const LOCAL_PATH_EXISTENCE_QUERY_KEY = "localPathExistence";
export const REPLAY_CAPTURES_QUERY_KEY = "internalReplayCaptures";

export interface ThreadListQueryFilters {
  projectId?: string;
  type?: ThreadListFilters["type"];
  parentThreadId?: string;
  archived: boolean;
}

export type HostsQueryKey = readonly [typeof HOSTS_QUERY_KEY];
export type HostQueryId = string | null | undefined;
export type HostQueryKey = readonly [typeof HOST_QUERY_KEY, HostQueryId];
export type AllHostQueryKeyPrefix = readonly [typeof HOST_QUERY_KEY];
export type ProjectsQueryKey = readonly [typeof PROJECTS_QUERY_KEY];
export type AllProjectFilesQueryKeyPrefix = readonly [
  typeof PROJECT_FILES_QUERY_KEY,
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
export type ProjectFilesQueryKeyPrefix = readonly [
  typeof PROJECT_FILES_QUERY_KEY,
  string,
];
export type ProjectSourceWorkspaceStatusQueryKey = readonly [
  typeof PROJECT_SOURCE_WORKSPACE_STATUS_QUERY_KEY,
  string | null | undefined,
  string | null | undefined,
];
export type ProjectSourceWorkspaceStatusQueryKeyPrefix = readonly [
  typeof PROJECT_SOURCE_WORKSPACE_STATUS_QUERY_KEY,
];
export type ThreadsQueryKey = readonly [typeof THREADS_QUERY_KEY];
export type ThreadListQueryKey = readonly [
  typeof THREADS_QUERY_KEY,
  ThreadListQueryFilters,
];
export type DisabledThreadListQueryKey = readonly [
  typeof THREADS_DISABLED_QUERY_KEY,
  ThreadListQueryFilters?,
];
export type ThreadQueryKeyPrefix = readonly [typeof THREAD_QUERY_KEY];
export type ThreadQueryKey = readonly [typeof THREAD_QUERY_KEY, string];
export type ThreadDefaultExecutionOptionsQueryKeyPrefix = readonly [
  typeof THREAD_DEFAULT_EXECUTION_OPTIONS_QUERY_KEY,
];
export type ThreadDefaultExecutionOptionsQueryKey = readonly [
  typeof THREAD_DEFAULT_EXECUTION_OPTIONS_QUERY_KEY,
  string,
];
export type ThreadDraftsQueryKeyPrefix = readonly [
  typeof THREAD_DRAFTS_QUERY_KEY,
];
export type ThreadDraftsQueryKey = readonly [
  typeof THREAD_DRAFTS_QUERY_KEY,
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
export type ThreadStorageFilesQueryKey = readonly [
  typeof THREAD_STORAGE_FILES_QUERY_KEY,
  string,
];
export type ThreadStorageFilesQueryKeyPrefix = readonly [
  typeof THREAD_STORAGE_FILES_QUERY_KEY,
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
export type EnvironmentPromotionQueryKeyRootPrefix = readonly [
  typeof ENVIRONMENT_PROMOTION_QUERY_KEY,
];
export type EnvironmentPromotionQueryKey = readonly [
  typeof ENVIRONMENT_PROMOTION_QUERY_KEY,
  string | null | undefined,
];
export type EnvironmentPromotionQueryKeyPrefix = readonly [
  typeof ENVIRONMENT_PROMOTION_QUERY_KEY,
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
export type AvailableModelsQueryKey = readonly [
  typeof AVAILABLE_MODELS_QUERY_KEY,
  string | null,
  string | null,
];
export type AllAvailableModelsQueryKeyPrefix = readonly [
  typeof AVAILABLE_MODELS_QUERY_KEY,
];
export type SystemProvidersQueryKey = readonly [
  typeof SYSTEM_PROVIDERS_QUERY_KEY,
];
export type SandboxBackendsQueryKey = readonly [
  typeof SANDBOX_BACKENDS_QUERY_KEY,
];
export type CloudAuthSettingsQueryKey = readonly [
  typeof CLOUD_AUTH_SETTINGS_QUERY_KEY,
];
export type CloudAuthAttemptId = string | null;
export type CloudAuthAttemptQueryKey = readonly [
  typeof CLOUD_AUTH_ATTEMPT_QUERY_KEY,
  CloudAuthAttemptId,
];
export type SandboxEnvVarsQueryKey = readonly [
  typeof SANDBOX_ENV_VARS_QUERY_KEY,
];
export type GithubReposQueryKey = readonly [
  typeof GITHUB_REPOS_QUERY_KEY,
  string,
];
export type StatusQueryKey = readonly [typeof STATUS_QUERY_KEY];
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

export function allProjectFilesQueryKeyPrefix(): AllProjectFilesQueryKeyPrefix {
  return [PROJECT_FILES_QUERY_KEY];
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

export function projectSourceWorkspaceStatusQueryKey(
  projectId: string | null | undefined,
  sourceId: string | null | undefined,
): ProjectSourceWorkspaceStatusQueryKey {
  return [PROJECT_SOURCE_WORKSPACE_STATUS_QUERY_KEY, projectId, sourceId];
}

export function projectSourceWorkspaceStatusQueryKeyPrefix(): ProjectSourceWorkspaceStatusQueryKeyPrefix {
  return [PROJECT_SOURCE_WORKSPACE_STATUS_QUERY_KEY];
}

export function threadsQueryKey(): ThreadsQueryKey {
  return [THREADS_QUERY_KEY];
}

export function threadListQueryKey(
  filters: ThreadListQueryFilters,
): ThreadListQueryKey {
  return [THREADS_QUERY_KEY, filters];
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

export function threadDraftsQueryKey(threadId: string): ThreadDraftsQueryKey {
  return [THREAD_DRAFTS_QUERY_KEY, threadId];
}

export function allThreadDraftsQueryKeyPrefix(): ThreadDraftsQueryKeyPrefix {
  return [THREAD_DRAFTS_QUERY_KEY];
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

export function threadStorageFilesQueryKey(
  threadId: string,
): ThreadStorageFilesQueryKey {
  return [THREAD_STORAGE_FILES_QUERY_KEY, threadId];
}

export function allThreadStorageFilesQueryKeyPrefix(): ThreadStorageFilesQueryKeyPrefix {
  return [THREAD_STORAGE_FILES_QUERY_KEY];
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

export function environmentPromotionQueryKey(
  environmentId: string | null | undefined,
): EnvironmentPromotionQueryKey {
  return [ENVIRONMENT_PROMOTION_QUERY_KEY, environmentId];
}

export function allEnvironmentPromotionQueryKeyPrefix(): EnvironmentPromotionQueryKeyRootPrefix {
  return [ENVIRONMENT_PROMOTION_QUERY_KEY];
}

export function environmentPromotionQueryKeyPrefix(
  environmentId: string,
): EnvironmentPromotionQueryKeyPrefix {
  return [ENVIRONMENT_PROMOTION_QUERY_KEY, environmentId];
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

export function availableModelsQueryKey(
  providerId: string | null,
  selectedModel: string | null,
): AvailableModelsQueryKey {
  return [AVAILABLE_MODELS_QUERY_KEY, providerId, selectedModel];
}

export function allAvailableModelsQueryKeyPrefix(): AllAvailableModelsQueryKeyPrefix {
  return [AVAILABLE_MODELS_QUERY_KEY];
}

export function systemProvidersQueryKey(): SystemProvidersQueryKey {
  return [SYSTEM_PROVIDERS_QUERY_KEY];
}

export function sandboxBackendsQueryKey(): SandboxBackendsQueryKey {
  return [SANDBOX_BACKENDS_QUERY_KEY];
}

export function cloudAuthSettingsQueryKey(): CloudAuthSettingsQueryKey {
  return [CLOUD_AUTH_SETTINGS_QUERY_KEY];
}

export function cloudAuthAttemptQueryKey(
  attemptId: CloudAuthAttemptId,
): CloudAuthAttemptQueryKey {
  return [CLOUD_AUTH_ATTEMPT_QUERY_KEY, attemptId];
}

export function sandboxEnvVarsQueryKey(): SandboxEnvVarsQueryKey {
  return [SANDBOX_ENV_VARS_QUERY_KEY];
}

export function githubReposQueryKey(q: string): GithubReposQueryKey {
  return [GITHUB_REPOS_QUERY_KEY, q];
}

export function statusQueryKey(): StatusQueryKey {
  return [STATUS_QUERY_KEY];
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
