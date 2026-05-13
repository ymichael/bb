import { useQuery } from "@tanstack/react-query";
import type {
  Environment,
  ThreadGitDiffResponse,
  WorkspaceDiffTarget,
  WorkspaceStatus,
} from "@bb/domain";
import type { FilePreview } from "@/lib/api";
import type { EnvironmentFilePreviewSource } from "@/lib/file-preview";
import * as api from "@/lib/api";
import {
  environmentFilePreviewQueryKey,
  environmentGitDiffQueryKey,
  environmentMergeBaseBranchesQueryKey,
  environmentQueryKey,
  environmentWorkStatusQueryKey,
} from "./query-keys";
import {
  resolveEnvironmentGitDiffPlaceholder,
  resolveEnvironmentWorkStatusPlaceholder,
} from "./query-placeholders";

interface QueryOptions {
  enabled?: boolean;
}

interface UseEnvironmentGitDiffOptions extends QueryOptions {
  target?: WorkspaceDiffTarget;
}

const ENVIRONMENT_WORK_STATUS_STALE_MS = 10_000;
const MERGE_BASE_BRANCHES_STALE_MS = 30_000;

function requireEnvironmentId(
  environmentId: string | null | undefined,
  hookName: string,
): string {
  if (!environmentId) {
    throw new Error(
      `${hookName}: environmentId is required when query is enabled`,
    );
  }

  return environmentId;
}

function requireEnvironmentFilePreviewPath(path: string | null): string {
  if (!path) {
    throw new Error(
      "useEnvironmentFilePreview: path is required when query is enabled",
    );
  }
  return path;
}

function requireEnvironmentFilePreviewSource(
  source: EnvironmentFilePreviewSource | null,
): EnvironmentFilePreviewSource {
  if (!source) {
    throw new Error(
      "useEnvironmentFilePreview: source is required when query is enabled",
    );
  }
  return source;
}

function requireGitDiffTarget(
  target: WorkspaceDiffTarget | undefined,
): WorkspaceDiffTarget {
  if (!target) {
    throw new Error(
      "useEnvironmentGitDiff: target is required when query is enabled",
    );
  }

  return target;
}

export function useEnvironment(environmentId: string | null | undefined) {
  return useQuery<Environment>({
    queryKey: environmentQueryKey(environmentId),
    queryFn: () =>
      api.getEnvironment(requireEnvironmentId(environmentId, "useEnvironment")),
    enabled: Boolean(environmentId),
  });
}

export function useEnvironmentWorkStatus(
  environmentId: string | null | undefined,
  mergeBaseBranch?: string,
  options?: QueryOptions,
) {
  const normalizedMergeBaseBranch = mergeBaseBranch ?? null;

  return useQuery<WorkspaceStatus | null>({
    queryKey: environmentWorkStatusQueryKey(
      environmentId,
      normalizedMergeBaseBranch,
    ),
    queryFn: () =>
      api.getEnvironmentWorkStatus(
        requireEnvironmentId(environmentId, "useEnvironmentWorkStatus"),
        mergeBaseBranch,
      ),
    enabled: (options?.enabled ?? true) && Boolean(environmentId),
    refetchOnWindowFocus: false,
    staleTime: ENVIRONMENT_WORK_STATUS_STALE_MS,
    placeholderData: (previousData, previousQuery) =>
      environmentId
        ? resolveEnvironmentWorkStatusPlaceholder(
            previousData,
            previousQuery?.queryKey,
            environmentId,
          )
        : undefined,
  });
}

export function useEnvironmentMergeBaseBranches(
  environmentId: string,
  options?: QueryOptions,
) {
  return useQuery<string[]>({
    queryKey: environmentMergeBaseBranchesQueryKey(environmentId),
    queryFn: () => api.getEnvironmentDiffBranches(environmentId),
    enabled: (options?.enabled ?? true) && Boolean(environmentId),
    refetchOnWindowFocus: false,
    staleTime: MERGE_BASE_BRANCHES_STALE_MS,
  });
}

export function useEnvironmentFilePreview(
  environmentId: string | null | undefined,
  path: string | null,
  source: EnvironmentFilePreviewSource | null,
  options?: QueryOptions,
) {
  return useQuery<FilePreview>({
    queryKey: environmentFilePreviewQueryKey(environmentId, path, source),
    queryFn: ({ signal }) =>
      api.getEnvironmentFilePreview({
        id: requireEnvironmentId(environmentId, "useEnvironmentFilePreview"),
        path: requireEnvironmentFilePreviewPath(path),
        source: requireEnvironmentFilePreviewSource(source),
        signal,
      }),
    enabled:
      (options?.enabled ?? true) &&
      Boolean(environmentId) &&
      Boolean(path) &&
      source !== null,
    refetchOnWindowFocus: false,
  });
}

export function useEnvironmentGitDiff(
  environmentId: string,
  options: UseEnvironmentGitDiffOptions,
) {
  const target = options.target;
  const targetKey =
    target?.type === "commit"
      ? target.sha
      : target?.type === "all" || target?.type === "branch_committed"
        ? target.mergeBaseBranch
        : null;

  return useQuery<ThreadGitDiffResponse>({
    queryKey: environmentGitDiffQueryKey(
      environmentId,
      target?.type ?? null,
      targetKey,
    ),
    queryFn: () =>
      api.getEnvironmentDiff(environmentId, requireGitDiffTarget(target)),
    enabled:
      (options.enabled ?? true) &&
      Boolean(environmentId) &&
      target !== undefined,
    placeholderData: (previousData, previousQuery) =>
      resolveEnvironmentGitDiffPlaceholder(
        previousData,
        previousQuery?.queryKey,
        environmentId,
      ),
    refetchOnWindowFocus: false,
    staleTime: 5_000,
  });
}
