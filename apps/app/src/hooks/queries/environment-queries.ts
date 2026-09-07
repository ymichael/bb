import { useQuery } from "@tanstack/react-query";
import type {
  Environment,
  ThreadPullRequest,
  WorkspaceDiffTarget,
} from "@bb/domain";
import type {
  EnvironmentDiffFileQuery,
  EnvironmentDiffFileResponse,
  EnvironmentDiffBranchesResponse,
  EnvironmentDiffFilesResponse,
  EnvironmentPullRequestResponse,
  EnvironmentStatusResponse,
  WorkspacePathListResponse,
} from "@bb/server-contract";
import type { EnvironmentDiffArgs } from "@bb/sdk/browser";
import {
  buildFilePreview,
  normalizeFilePreviewMimeType,
  type EnvironmentFilePreviewSource,
  type FilePreview,
} from "@bb/client-core";
import { decodeBase64Bytes, encodeBase64Bytes } from "@/lib/base64-bytes";
import { buildEnvironmentDiffFileContentUrl } from "@/lib/file-content-urls";
import { sdk } from "@/lib/sdk";
import { useEnvironmentDetailRealtimeSubscription } from "@/hooks/useRealtimeSubscription";
import {
  environmentDiffFilesQueryKey,
  environmentDiffTargetKey,
  environmentFilePreviewQueryKey,
  environmentMergeBaseBranchesQueryKey,
  environmentPullRequestQueryKey,
  environmentPathsQueryKey,
  environmentQueryKey,
  environmentWorkStatusQueryKey,
} from "./query-keys";
import {
  resolveEnvironmentDiffFilesPlaceholder,
  resolveEnvironmentMergeBaseBranchesPlaceholder,
  resolveEnvironmentWorkStatusPlaceholder,
} from "./query-placeholders";
import { requireEnabledQueryArg, type QueryOptions } from "./query-helpers";
import {
  EXPENSIVE_MANUAL_QUERY_POLICY,
  HEAVY_PAYLOAD_QUERY_POLICY,
  REALTIME_OWNED_MOUNT_BASELINE_QUERY_POLICY,
  REALTIME_OWNED_NO_FOCUS_QUERY_POLICY,
  TYPEAHEAD_QUERY_POLICY,
} from "./query-policies";

interface EnvironmentQueryOptions extends QueryOptions {
  staleTime?: number;
}

interface BranchQueryOptions extends QueryOptions {
  limit?: number;
  query?: string;
  selectedBranch?: string;
}

interface UseEnvironmentDiffFilesOptions extends QueryOptions {
  target?: WorkspaceDiffTarget;
}

const ENVIRONMENT_PULL_REQUEST_STALE_MS = 30_000;
const ENVIRONMENT_SETTLED_PULL_REQUEST_STALE_MS = 60 * 60_000;
const ENVIRONMENT_ACTIVE_PULL_REQUEST_REFETCH_MS = 30_000;
const MERGE_BASE_BRANCHES_STALE_MS = 30_000;
const MERGE_BASE_BRANCHES_LIMIT = 50;
const ENVIRONMENT_DIFF_STALE_MS = 5_000;

function requireEnvironmentId(
  environmentId: string | null | undefined,
  hookName: string,
): string {
  return requireEnabledQueryArg({
    value: environmentId,
    hookName,
    argName: "environmentId",
  });
}

export function useEnvironment(
  environmentId: string | null | undefined,
  options?: EnvironmentQueryOptions,
) {
  const enabled = (options?.enabled ?? true) && Boolean(environmentId);
  useEnvironmentDetailRealtimeSubscription(environmentId, { enabled });

  return useQuery<Environment>({
    queryKey: environmentQueryKey(environmentId),
    queryFn: ({ signal }) =>
      sdk.environments.get({
        environmentId: requireEnvironmentId(environmentId, "useEnvironment"),
        signal,
      }),
    enabled,
    staleTime: options?.staleTime,
  });
}

export function useEnvironmentWorkStatus(
  environmentId: string | null | undefined,
  mergeBaseBranch?: string,
  options?: QueryOptions,
) {
  const normalizedMergeBaseBranch = mergeBaseBranch ?? null;
  const enabled = (options?.enabled ?? true) && Boolean(environmentId);
  useEnvironmentDetailRealtimeSubscription(environmentId, { enabled });

  return useQuery<EnvironmentStatusResponse>({
    queryKey: environmentWorkStatusQueryKey(
      environmentId,
      normalizedMergeBaseBranch,
    ),
    queryFn: ({ signal }) =>
      sdk.environments.status({
        environmentId: requireEnvironmentId(
          environmentId,
          "useEnvironmentWorkStatus",
        ),
        mergeBaseBranch,
        signal,
      }),
    enabled,
    ...REALTIME_OWNED_MOUNT_BASELINE_QUERY_POLICY,
    staleTime: 0,
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

export function getEnvironmentPullRequestFromResponse(
  response: EnvironmentPullRequestResponse | undefined,
): ThreadPullRequest | null {
  return response?.outcome === "available" ? response.pullRequest : null;
}

export function getEnvironmentPullRequestStaleTime(
  pullRequest: ThreadPullRequest | null | undefined,
): number {
  return pullRequest?.state === "closed" || pullRequest?.state === "merged"
    ? ENVIRONMENT_SETTLED_PULL_REQUEST_STALE_MS
    : ENVIRONMENT_PULL_REQUEST_STALE_MS;
}

export function getEnvironmentPullRequestRefetchInterval(
  pullRequest: ThreadPullRequest | null | undefined,
): number | false {
  if (!pullRequest || pullRequest.state !== "open") {
    return false;
  }
  if (
    pullRequest.checks.state === "pending" ||
    pullRequest.mergeability.state === "unknown"
  ) {
    return ENVIRONMENT_ACTIVE_PULL_REQUEST_REFETCH_MS;
  }
  return false;
}

export function useEnvironmentPullRequest(
  environmentId: string | null | undefined,
  options?: QueryOptions,
) {
  const enabled = (options?.enabled ?? true) && Boolean(environmentId);
  useEnvironmentDetailRealtimeSubscription(environmentId, { enabled });

  return useQuery<EnvironmentPullRequestResponse>({
    queryKey: environmentPullRequestQueryKey(environmentId),
    queryFn: ({ signal }) =>
      sdk.environments.pullRequest({
        environmentId: requireEnvironmentId(
          environmentId,
          "useEnvironmentPullRequest",
        ),
        signal,
      }),
    enabled,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
    refetchInterval: (query) =>
      getEnvironmentPullRequestRefetchInterval(
        getEnvironmentPullRequestFromResponse(query.state.data),
      ),
    staleTime: (query) =>
      getEnvironmentPullRequestStaleTime(
        getEnvironmentPullRequestFromResponse(query.state.data),
      ),
  });
}

export function useEnvironmentMergeBaseBranches(
  environmentId: string,
  options?: BranchQueryOptions,
) {
  const query = options?.query?.trim() ?? "";
  const selectedBranch = options?.selectedBranch?.trim();
  const limit = options?.limit ?? MERGE_BASE_BRANCHES_LIMIT;
  const enabled = (options?.enabled ?? true) && Boolean(environmentId);
  useEnvironmentDetailRealtimeSubscription(environmentId, { enabled });
  return useQuery<EnvironmentDiffBranchesResponse>({
    queryKey: environmentMergeBaseBranchesQueryKey(
      environmentId,
      query,
      limit,
      selectedBranch ?? "",
    ),
    queryFn: ({ signal }) =>
      sdk.environments.diffBranches({
        environmentId,
        ...(query ? { query } : {}),
        ...(selectedBranch ? { selectedBranch } : {}),
        limit: String(limit),
        signal,
      }),
    enabled,
    ...REALTIME_OWNED_NO_FOCUS_QUERY_POLICY,
    staleTime: MERGE_BASE_BRANCHES_STALE_MS,
    placeholderData: (previousData, previousQuery) =>
      environmentId
        ? resolveEnvironmentMergeBaseBranchesPlaceholder({
            previousData,
            previousQueryKey: previousQuery?.queryKey,
            environmentId,
            limit,
            selectedBranch: selectedBranch ?? "",
          })
        : undefined,
  });
}

export function useEnvironmentFilePreview(
  environmentId: string | null | undefined,
  path: string | null,
  source: EnvironmentFilePreviewSource | null,
  options?: QueryOptions,
) {
  const enabled =
    (options?.enabled ?? true) &&
    Boolean(environmentId) &&
    Boolean(path) &&
    source !== null;
  useEnvironmentDetailRealtimeSubscription(environmentId, { enabled });

  return useQuery<FilePreview>({
    queryKey: environmentFilePreviewQueryKey(environmentId, path, source),
    queryFn: async ({ signal }) => {
      const resolvedPath = requireEnabledQueryArg({
        value: path,
        hookName: "useEnvironmentFilePreview",
        argName: "path",
      });
      const resolvedSource = requireEnabledQueryArg({
        value: source,
        hookName: "useEnvironmentFilePreview",
        argName: "source",
      });
      const resolvedEnvironmentId = requireEnvironmentId(
        environmentId,
        "useEnvironmentFilePreview",
      );
      const query = buildEnvironmentFilePreviewQuery(
        resolvedPath,
        resolvedSource,
      );
      const response = await sdk.environments.diffFile({
        environmentId: resolvedEnvironmentId,
        signal,
        ...query,
      });
      return buildEnvironmentFilePreview({
        contentUrl: buildEnvironmentDiffFileContentUrl(
          resolvedEnvironmentId,
          query,
        ),
        path: resolvedPath,
        response,
      });
    },
    enabled,
    ...EXPENSIVE_MANUAL_QUERY_POLICY,
    ...HEAVY_PAYLOAD_QUERY_POLICY,
  });
}

interface UseEnvironmentPathSuggestionsArgs {
  environmentId: string | null | undefined;
  query: string | null;
  limit?: number;
  includeFiles: boolean;
  includeDirectories: boolean;
}

export function useEnvironmentPathSuggestions(
  args: UseEnvironmentPathSuggestionsArgs,
) {
  const {
    environmentId,
    query,
    limit = 8,
    includeFiles,
    includeDirectories,
  } = args;
  const trimmedQuery = query?.trim() ?? "";
  const enabled = Boolean(environmentId) && trimmedQuery.length > 0;
  useEnvironmentDetailRealtimeSubscription(environmentId, { enabled });

  return useQuery<WorkspacePathListResponse>({
    queryKey: environmentPathsQueryKey(
      environmentId ?? undefined,
      trimmedQuery,
      limit,
      includeFiles,
      includeDirectories,
    ),
    queryFn: ({ signal }) =>
      sdk.environments.paths({
        environmentId: requireEnvironmentId(
          environmentId,
          "useEnvironmentPathSuggestions",
        ),
        query: trimmedQuery,
        limit: String(limit),
        includeFiles: includeFiles ? "true" : "false",
        includeDirectories: includeDirectories ? "true" : "false",
        signal,
      }),
    enabled,
    ...TYPEAHEAD_QUERY_POLICY,
    placeholderData: (previousData) => previousData,
  });
}

export function useEnvironmentDiffFiles(
  environmentId: string,
  options: UseEnvironmentDiffFilesOptions,
) {
  const target = options.target;
  const enabled =
    (options.enabled ?? true) && Boolean(environmentId) && target !== undefined;
  useEnvironmentDetailRealtimeSubscription(environmentId, { enabled });

  return useQuery<EnvironmentDiffFilesResponse>({
    queryKey: environmentDiffFilesQueryKey(
      environmentId,
      target?.type ?? null,
      environmentDiffTargetKey(target),
    ),
    queryFn: ({ signal }) =>
      sdk.environments.diffFiles({
        ...buildEnvironmentDiffArgs(
          environmentId,
          requireEnabledQueryArg({
            value: target,
            hookName: "useEnvironmentDiffFiles",
            argName: "target",
          }),
        ),
        signal,
      }),
    enabled,
    placeholderData: (previousData, previousQuery) =>
      resolveEnvironmentDiffFilesPlaceholder(
        previousData,
        previousQuery?.queryKey,
        environmentId,
      ),
    ...REALTIME_OWNED_MOUNT_BASELINE_QUERY_POLICY,
    staleTime: ENVIRONMENT_DIFF_STALE_MS,
  });
}

function buildEnvironmentDiffArgs(
  environmentId: string,
  target: WorkspaceDiffTarget,
): EnvironmentDiffArgs {
  switch (target.type) {
    case "uncommitted":
      return { environmentId, target: target.type };
    case "branch_committed":
    case "all":
      return {
        environmentId,
        mergeBaseBranch: target.mergeBaseBranch,
        target: target.type,
      };
    case "commit":
      return { environmentId, sha: target.sha, target: target.type };
  }
}

function buildEnvironmentFilePreviewQuery(
  path: string,
  source: EnvironmentFilePreviewSource,
): EnvironmentDiffFileQuery {
  const side = source.kind === "working-tree" ? "new" : "old";
  return source.kind === "merge-base"
    ? { target: "branch_committed", mergeBaseRef: source.ref, path, side }
    : { target: "uncommitted", path, side };
}

export function buildEnvironmentFilePreview({
  contentUrl,
  path,
  response,
}: {
  contentUrl: string;
  path: string;
  response: EnvironmentDiffFileResponse;
}): FilePreview {
  const contentBytes =
    response.contentEncoding === "base64"
      ? decodeBase64Bytes(response.content)
      : new TextEncoder().encode(response.content);
  const mimeType = normalizeFilePreviewMimeType(response.mimeType ?? null);
  const preview = buildFilePreview({
    contentBytes,
    mimeType,
    name: path.split("/").at(-1),
    path,
    url: contentUrl,
  });
  if (preview.kind !== "image" && preview.kind !== "video") {
    return preview;
  }
  const base64Content =
    response.contentEncoding === "base64"
      ? response.content
      : encodeBase64Bytes(contentBytes);
  return { ...preview, url: `data:${mimeType};base64,${base64Content}` };
}
