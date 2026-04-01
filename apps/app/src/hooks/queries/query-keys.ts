import type { ThreadListFilters } from "@/lib/api";

export const HOSTS_QUERY_KEY = "hosts";
export const PROJECTS_QUERY_KEY = "projects";
export const PROJECT_FILES_QUERY_KEY = "projectFiles";
export const THREADS_QUERY_KEY = "threads";
export const THREAD_QUERY_KEY = "thread";
export const THREAD_DEFAULT_EXECUTION_OPTIONS_QUERY_KEY = "threadDefaultExecutionOptions";
export const THREAD_DRAFTS_QUERY_KEY = "threadDrafts";
export const THREAD_STORAGE_FILES_QUERY_KEY = "threadStorageFiles";
export const THREAD_STORAGE_FILE_PREVIEW_QUERY_KEY = "threadStorageFilePreview";
export const ENVIRONMENT_QUERY_KEY = "environment";
export const ENVIRONMENT_WORK_STATUS_QUERY_KEY = "environmentWorkStatus";
export const ENVIRONMENT_MERGE_BASE_BRANCHES_QUERY_KEY = "environmentMergeBaseBranches";
export const ENVIRONMENT_GIT_DIFF_QUERY_KEY = "environmentGitDiff";
export const THREAD_TIMELINE_QUERY_KEY = "threadTimeline";
export const AVAILABLE_MODELS_QUERY_KEY = "availableModels";
export const SYSTEM_PROVIDERS_QUERY_KEY = "systemProviders";
export const STATUS_QUERY_KEY = "status";

export interface ThreadListQueryFilters {
  projectId?: string;
  type?: ThreadListFilters["type"];
  parentThreadId?: string;
  archived?: boolean;
}

export type HostsQueryKey = readonly [typeof HOSTS_QUERY_KEY];
export type ProjectsQueryKey = readonly [typeof PROJECTS_QUERY_KEY];
export type ProjectFilesQueryKey = readonly [
  typeof PROJECT_FILES_QUERY_KEY,
  string | undefined,
  string,
  number,
];
export type ProjectFilesQueryKeyPrefix = readonly [
  typeof PROJECT_FILES_QUERY_KEY,
  string,
];
export type ThreadsQueryKey = readonly [typeof THREADS_QUERY_KEY];
export type ThreadListQueryKey = readonly [typeof THREADS_QUERY_KEY, ThreadListQueryFilters?];
export type ThreadQueryKeyPrefix = readonly [typeof THREAD_QUERY_KEY];
export type ThreadQueryKey = readonly [typeof THREAD_QUERY_KEY, string];
export type ThreadDefaultExecutionOptionsQueryKey = readonly [
  typeof THREAD_DEFAULT_EXECUTION_OPTIONS_QUERY_KEY,
  string,
];
export type ThreadDraftsQueryKeyPrefix = readonly [typeof THREAD_DRAFTS_QUERY_KEY];
export type ThreadDraftsQueryKey = readonly [typeof THREAD_DRAFTS_QUERY_KEY, string];
export type ThreadStorageFilesQueryKey = readonly [typeof THREAD_STORAGE_FILES_QUERY_KEY, string];
export type ThreadStorageFilePreviewQueryKey = readonly [
  typeof THREAD_STORAGE_FILE_PREVIEW_QUERY_KEY,
  string,
  string | null,
];
export type ThreadStorageFilePreviewQueryKeyPrefix = readonly [
  typeof THREAD_STORAGE_FILE_PREVIEW_QUERY_KEY,
  string,
];
export type EnvironmentQueryKey = readonly [typeof ENVIRONMENT_QUERY_KEY, string | null | undefined];
export type EnvironmentWorkStatusQueryKey = readonly [
  typeof ENVIRONMENT_WORK_STATUS_QUERY_KEY,
  string | null | undefined,
  string | null,
];
export type EnvironmentWorkStatusQueryKeyPrefix = readonly [
  typeof ENVIRONMENT_WORK_STATUS_QUERY_KEY,
  string,
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
  boolean,
];
export type ThreadTimelineQueryKeyPrefix = readonly [
  typeof THREAD_TIMELINE_QUERY_KEY,
  string,
];
export type AllThreadTimelineQueryKeyPrefix = readonly [typeof THREAD_TIMELINE_QUERY_KEY];
export type EnvironmentGitDiffQueryKey = readonly [
  typeof ENVIRONMENT_GIT_DIFF_QUERY_KEY,
  string,
  string | null,
  string | null,
];
export type EnvironmentGitDiffQueryKeyPrefix = readonly [
  typeof ENVIRONMENT_GIT_DIFF_QUERY_KEY,
  string,
];
export type AvailableModelsQueryKey = readonly [
  typeof AVAILABLE_MODELS_QUERY_KEY,
  string | null,
];
export type SystemProvidersQueryKey = readonly [typeof SYSTEM_PROVIDERS_QUERY_KEY];
export type StatusQueryKey = readonly [typeof STATUS_QUERY_KEY];

export function hostsQueryKey(): HostsQueryKey {
  return [HOSTS_QUERY_KEY];
}

export function projectsQueryKey(): ProjectsQueryKey {
  return [PROJECTS_QUERY_KEY];
}

export function projectFilesQueryKey(
  projectId: string | undefined,
  query: string,
  limit: number,
): ProjectFilesQueryKey {
  return [PROJECT_FILES_QUERY_KEY, projectId, query, limit];
}

export function projectFilesQueryKeyPrefix(
  projectId: string,
): ProjectFilesQueryKeyPrefix {
  return [PROJECT_FILES_QUERY_KEY, projectId];
}

export function threadsQueryKey(): ThreadsQueryKey {
  return [THREADS_QUERY_KEY];
}

export function threadListQueryKey(filters?: ThreadListQueryFilters): ThreadListQueryKey {
  return filters ? [THREADS_QUERY_KEY, filters] : [THREADS_QUERY_KEY];
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

export function threadDraftsQueryKey(threadId: string): ThreadDraftsQueryKey {
  return [THREAD_DRAFTS_QUERY_KEY, threadId];
}

export function allThreadDraftsQueryKeyPrefix(): ThreadDraftsQueryKeyPrefix {
  return [THREAD_DRAFTS_QUERY_KEY];
}

export function threadStorageFilesQueryKey(threadId: string): ThreadStorageFilesQueryKey {
  return [THREAD_STORAGE_FILES_QUERY_KEY, threadId];
}

export function threadStorageFilePreviewQueryKey(
  threadId: string,
  path: string | null,
): ThreadStorageFilePreviewQueryKey {
  return [THREAD_STORAGE_FILE_PREVIEW_QUERY_KEY, threadId, path];
}

export function threadStorageFilePreviewQueryKeyPrefix(
  threadId: string,
): ThreadStorageFilePreviewQueryKeyPrefix {
  return [THREAD_STORAGE_FILE_PREVIEW_QUERY_KEY, threadId];
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

export function environmentMergeBaseBranchesQueryKeyPrefix(
  environmentId: string,
): EnvironmentMergeBaseBranchesQueryKeyPrefix {
  return [ENVIRONMENT_MERGE_BASE_BRANCHES_QUERY_KEY, environmentId];
}

export function threadTimelineQueryKey(
  threadId: string,
  includeAllEvents: boolean,
): ThreadTimelineQueryKey {
  return [THREAD_TIMELINE_QUERY_KEY, threadId, includeAllEvents];
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

export function environmentGitDiffQueryKeyPrefix(
  environmentId: string,
): EnvironmentGitDiffQueryKeyPrefix {
  return [ENVIRONMENT_GIT_DIFF_QUERY_KEY, environmentId];
}

export function availableModelsQueryKey(
  providerId: string | null,
): AvailableModelsQueryKey {
  return [AVAILABLE_MODELS_QUERY_KEY, providerId];
}

export function systemProvidersQueryKey(): SystemProvidersQueryKey {
  return [SYSTEM_PROVIDERS_QUERY_KEY];
}

export function statusQueryKey(): StatusQueryKey {
  return [STATUS_QUERY_KEY];
}
