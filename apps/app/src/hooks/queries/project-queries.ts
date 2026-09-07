import { useQuery } from "@tanstack/react-query";
import { useCallback, useRef } from "react";
import type {
  CommandListResponse,
  ProjectBranchesResponse,
  ProjectWithThreadsResponse,
  PromptHistoryResponse,
  WorkspacePathListResponse,
} from "@bb/server-contract";
import {
  buildFilePreview,
  normalizeFilePreviewMimeType,
  type FilePreview,
} from "@bb/client-core";
import { decodeBase64Bytes } from "@/lib/base64-bytes";
import { buildProjectFileContentUrl } from "@/lib/file-content-urls";
import { readProjectBranchOptions } from "@/lib/project-branch-options";
import { sdk } from "@/lib/sdk";
import { useProjectDetailRealtimeSubscription } from "@/hooks/useRealtimeSubscription";
import {
  projectCommandsQueryKey,
  projectFilePreviewQueryKey,
  projectPathsQueryKey,
  projectPromptHistoryQueryKey,
  projectSourceBranchesQueryKey,
} from "./query-keys";
import { resolveProjectSourceBranchesPlaceholder } from "./query-placeholders";
import {
  PROMPT_HISTORY_STALE_TIME_MS,
  requireEnabledQueryArg,
  requireProjectId,
  type QueryOptions,
} from "./query-helpers";
import {
  EXPENSIVE_MANUAL_QUERY_POLICY,
  HEAVY_PAYLOAD_QUERY_POLICY,
  REALTIME_OWNED_NO_FOCUS_QUERY_POLICY,
  TYPEAHEAD_QUERY_POLICY,
} from "./query-policies";

interface BranchQueryOptions extends QueryOptions {
  limit?: number;
  query?: string;
  selectedBranch?: string;
}

interface UseProjectPathSuggestionsArgs {
  projectId: string | undefined;
  environmentId: string | null;
  hostId: string | null;
  query: string | null;
  limit?: number;
  includeFiles: boolean;
  includeDirectories: boolean;
}

interface UseProjectCommandsArgs {
  projectId: string | undefined;
  providerId: string | undefined;
  environmentId: string | null;
  hostId: string | null;
}

const PROJECT_SOURCE_BRANCHES_LIMIT = 50;
const PROJECT_SOURCE_BRANCHES_STALE_MS = 30_000;

function requireProviderId(
  providerId: string | undefined,
  hookName: string,
): string {
  return requireEnabledQueryArg({
    value: providerId,
    hookName,
    argName: "providerId",
  });
}

export type SidebarProject = Omit<ProjectWithThreadsResponse, "threads">;

export function stripProjectThreads(
  project: ProjectWithThreadsResponse,
): SidebarProject {
  const { threads, ...rest } = project;
  return rest;
}

export function useProjectSourceBranches(
  projectId: string | undefined,
  hostId: string | null,
  options?: BranchQueryOptions,
) {
  const enabled =
    (options?.enabled ?? true) && Boolean(projectId) && Boolean(hostId);
  useProjectDetailRealtimeSubscription(projectId, { enabled });
  const query = options?.query?.trim() ?? "";
  const limit = options?.limit ?? PROJECT_SOURCE_BRANCHES_LIMIT;
  const selectedBranch = options?.selectedBranch?.trim() ?? "";
  const remoteRefreshRef = useRef<{
    blockingSignal: AbortSignal | null;
    inFlight: Promise<void> | null;
    requested: boolean;
  }>({ blockingSignal: null, inFlight: null, requested: false });
  const result = useQuery<ProjectBranchesResponse>({
    queryKey: projectSourceBranchesQueryKey(
      projectId ?? "",
      hostId ?? "",
      query,
      limit,
      selectedBranch,
    ),
    queryFn: ({ signal }) => {
      const remoteRefresh = remoteRefreshRef.current;
      const startsBlockingRefresh =
        remoteRefresh.requested && remoteRefresh.blockingSignal === null;
      const blocking =
        startsBlockingRefresh || remoteRefresh.blockingSignal === signal;
      if (startsBlockingRefresh) {
        remoteRefresh.requested = false;
        remoteRefresh.blockingSignal = signal;
      }
      const readBranches = blocking
        ? sdk.projects.branches
        : readProjectBranchOptions;
      return readBranches({
        projectId: requireProjectId(projectId, "useProjectSourceBranches"),
        hostId: hostId ?? "",
        ...(query ? { query } : {}),
        ...(selectedBranch ? { selectedBranch } : {}),
        limit: String(limit),
        signal,
      });
    },
    enabled,
    ...REALTIME_OWNED_NO_FOCUS_QUERY_POLICY,
    staleTime: PROJECT_SOURCE_BRANCHES_STALE_MS,
    placeholderData: (previousData, previousQuery) =>
      projectId && hostId
        ? resolveProjectSourceBranchesPlaceholder({
            previousData,
            previousQueryKey: previousQuery?.queryKey,
            projectId,
            hostId,
            limit,
            selectedBranch,
          })
        : undefined,
  });
  const refetch = result.refetch;
  const refreshFromRemote = useCallback((): Promise<void> => {
    const remoteRefresh = remoteRefreshRef.current;
    if (remoteRefresh.inFlight) return remoteRefresh.inFlight;

    const run = async (): Promise<void> => {
      remoteRefresh.requested = true;
      remoteRefresh.blockingSignal = null;
      try {
        await refetch();
        if (remoteRefresh.requested) await refetch();
      } finally {
        remoteRefresh.requested = false;
        remoteRefresh.blockingSignal = null;
        remoteRefresh.inFlight = null;
      }
    };
    remoteRefresh.inFlight = run();
    return remoteRefresh.inFlight;
  }, [refetch]);
  return { ...result, refreshFromRemote };
}

export function useProjectPromptHistory(
  projectId: string | undefined,
  options?: QueryOptions,
) {
  const enabled = (options?.enabled ?? true) && Boolean(projectId);
  useProjectDetailRealtimeSubscription(projectId, { enabled });

  return useQuery<PromptHistoryResponse>({
    queryKey: projectPromptHistoryQueryKey(projectId),
    queryFn: ({ signal }) =>
      sdk.projects.promptHistory({
        projectId: requireProjectId(projectId, "useProjectPromptHistory"),
        signal,
      }),
    enabled,
    staleTime: PROMPT_HISTORY_STALE_TIME_MS,
  });
}

export function useProjectPathSuggestions(args: UseProjectPathSuggestionsArgs) {
  const {
    projectId,
    query,
    limit = 8,
    includeFiles,
    includeDirectories,
  } = args;
  const trimmedQuery = query?.trim() ?? "";
  const enabled = Boolean(projectId) && trimmedQuery.length > 0;
  useProjectDetailRealtimeSubscription(projectId, { enabled });

  return useQuery<WorkspacePathListResponse>({
    queryKey: projectPathsQueryKey(
      projectId,
      args.environmentId,
      args.hostId,
      trimmedQuery,
      limit,
      includeFiles,
      includeDirectories,
    ),
    queryFn: ({ signal }) =>
      sdk.projects.paths({
        projectId: projectId ?? "",
        query: trimmedQuery,
        limit: String(limit),
        includeFiles: includeFiles ? "true" : "false",
        includeDirectories: includeDirectories ? "true" : "false",
        signal,
        ...(args.environmentId !== null
          ? { environmentId: args.environmentId }
          : args.hostId !== null
            ? { hostId: args.hostId }
            : {}),
      }),
    enabled,
    ...TYPEAHEAD_QUERY_POLICY,
    placeholderData: (previousData) => previousData,
  });
}

export function useProjectFilePreview(
  projectId: string | undefined,
  path: string | null,
  routing: { environmentId: string | null; hostId: string | null },
  options?: QueryOptions,
) {
  const enabled =
    (options?.enabled ?? true) && Boolean(projectId) && Boolean(path);
  useProjectDetailRealtimeSubscription(projectId, { enabled });

  return useQuery<FilePreview>({
    queryKey: projectFilePreviewQueryKey(
      projectId,
      routing.environmentId,
      routing.hostId,
      path,
    ),
    queryFn: async ({ signal }) => {
      const requiredProjectId = requireProjectId(
        projectId,
        "useProjectFilePreview",
      );
      const requiredPath = requireEnabledQueryArg({
        value: path,
        hookName: "useProjectFilePreview",
        argName: "path",
      });
      const content = await sdk.projects.fileContent({
        projectId: requiredProjectId,
        path: requiredPath,
        signal,
        ...(routing.environmentId !== null
          ? { environmentId: routing.environmentId }
          : routing.hostId !== null
            ? { hostId: routing.hostId }
            : {}),
      });
      const contentBytes =
        content.contentEncoding === "base64"
          ? decodeBase64Bytes(content.content)
          : new TextEncoder().encode(content.content);
      return buildFilePreview({
        contentBytes,
        mimeType: normalizeFilePreviewMimeType(content.mimeType),
        name: requiredPath.split("/").at(-1),
        path: requiredPath,
        url: buildProjectFileContentUrl(requiredProjectId, requiredPath, {
          ...(routing.environmentId !== null
            ? { environmentId: routing.environmentId }
            : routing.hostId !== null
              ? { hostId: routing.hostId }
              : {}),
        }),
      });
    },
    enabled,
    ...EXPENSIVE_MANUAL_QUERY_POLICY,
    ...HEAVY_PAYLOAD_QUERY_POLICY,
  });
}

export function projectCommandsQueryOptions(args: UseProjectCommandsArgs) {
  return {
    queryKey: projectCommandsQueryKey(
      args.projectId,
      args.providerId,
      args.environmentId,
      args.hostId,
    ),
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      sdk.projects.commands({
        projectId: requireProjectId(args.projectId, "useProjectCommands"),
        provider: requireProviderId(args.providerId, "useProjectCommands"),
        signal,
        ...(args.environmentId !== null
          ? { environmentId: args.environmentId }
          : args.hostId !== null
            ? { hostId: args.hostId }
            : {}),
      }),
  };
}

export function useProjectCommands(
  args: UseProjectCommandsArgs,
  options?: QueryOptions,
) {
  const enabled =
    (options?.enabled ?? true) &&
    Boolean(args.projectId) &&
    Boolean(args.providerId);
  useProjectDetailRealtimeSubscription(args.projectId, { enabled });

  return useQuery<CommandListResponse>({
    ...projectCommandsQueryOptions(args),
    enabled,
    ...TYPEAHEAD_QUERY_POLICY,
    staleTime: 0,
  });
}
