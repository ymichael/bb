import type { QueryKey } from "@tanstack/react-query";
import type {
  Thread,
  ThreadGitDiffResponse,
  WorkspaceStatus,
} from "@bb/domain";
import type { ThreadTimelineResponse } from "@bb/server-contract";
import {
  ENVIRONMENT_GIT_DIFF_QUERY_KEY,
  ENVIRONMENT_WORK_STATUS_QUERY_KEY,
  THREAD_QUERY_KEY,
  THREAD_TIMELINE_QUERY_KEY,
} from "./query-keys";

type ThreadScopedQueryKeyPrefix =
  | typeof THREAD_QUERY_KEY
  | typeof ENVIRONMENT_WORK_STATUS_QUERY_KEY
  | typeof ENVIRONMENT_GIT_DIFF_QUERY_KEY
  | typeof THREAD_TIMELINE_QUERY_KEY;

function extractThreadIdFromThreadScopedQueryKey(
  queryKey: QueryKey | undefined,
  queryKeyPrefix: ThreadScopedQueryKeyPrefix,
): string | undefined {
  if (!queryKey || queryKey[0] !== queryKeyPrefix) {
    return undefined;
  }

  const threadId = queryKey[1];
  return typeof threadId === "string" ? threadId : undefined;
}

function resolveThreadScopedPlaceholder<TData>(
  previousData: TData | undefined,
  previousQueryKey: QueryKey | undefined,
  nextThreadId: string,
  queryKeyPrefix: ThreadScopedQueryKeyPrefix,
): TData | undefined {
  if (previousData === undefined) {
    return undefined;
  }

  return extractThreadIdFromThreadScopedQueryKey(previousQueryKey, queryKeyPrefix) ===
    nextThreadId
    ? previousData
    : undefined;
}

export function resolveEnvironmentWorkStatusPlaceholder(
  previousData: WorkspaceStatus | null | undefined,
  previousQueryKey: QueryKey | undefined,
  nextEnvironmentId: string,
): WorkspaceStatus | null | undefined {
  return resolveThreadScopedPlaceholder(
    previousData,
    previousQueryKey,
    nextEnvironmentId,
    ENVIRONMENT_WORK_STATUS_QUERY_KEY,
  );
}

export function resolveEnvironmentGitDiffPlaceholder(
  previousData: ThreadGitDiffResponse | undefined,
  previousQueryKey: QueryKey | undefined,
  nextEnvironmentId: string,
): ThreadGitDiffResponse | undefined {
  return resolveThreadScopedPlaceholder(
    previousData,
    previousQueryKey,
    nextEnvironmentId,
    ENVIRONMENT_GIT_DIFF_QUERY_KEY,
  );
}

export function resolveThreadPlaceholder(
  previousData: Thread | undefined,
  previousQueryKey: QueryKey | undefined,
  nextThreadId: string,
): Thread | undefined {
  return resolveThreadScopedPlaceholder(
    previousData,
    previousQueryKey,
    nextThreadId,
    THREAD_QUERY_KEY,
  );
}

export function resolveThreadTimelinePlaceholder(
  previousData: ThreadTimelineResponse | undefined,
  previousQueryKey: QueryKey | undefined,
  nextThreadId: string,
): ThreadTimelineResponse | undefined {
  return resolveThreadScopedPlaceholder(
    previousData,
    previousQueryKey,
    nextThreadId,
    THREAD_TIMELINE_QUERY_KEY,
  );
}
