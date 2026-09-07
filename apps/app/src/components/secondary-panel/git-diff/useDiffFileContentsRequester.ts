import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { WorkspaceDiffTarget } from "@bb/domain";
import type { EnvironmentDiffFileResponse } from "@bb/server-contract";
import type { EnvironmentDiffFileArgs } from "@bb/sdk/browser";
import { environmentDiffFileQueryKey } from "@/hooks/queries/query-keys";
import { sdk } from "@/lib/sdk";
import type {
  DiffFileContentsResult,
  RequestDiffFileContents,
} from "@/components/git-diff/GitDiffCardBody";

interface UseDiffFileContentsRequesterArgs {
  environmentId?: string;
  target?: WorkspaceDiffTarget;
  mergeBaseRef: string | null;
}

type DiffFileTarget =
  | { type: "uncommitted" }
  | { type: "branch_committed"; mergeBaseRef: string }
  | { type: "all"; mergeBaseRef: string }
  | { type: "commit"; sha: string };

export function useDiffFileContentsRequester({
  environmentId,
  target,
  mergeBaseRef,
}: UseDiffFileContentsRequesterArgs): RequestDiffFileContents | undefined {
  const queryClient = useQueryClient();
  const fileTarget = useMemo<DiffFileTarget | undefined>(
    () => buildDiffFileTarget(target, mergeBaseRef),
    [target, mergeBaseRef],
  );

  return useMemo<RequestDiffFileContents | undefined>(() => {
    if (!environmentId || fileTarget === undefined) return undefined;
    const envId = environmentId;
    const resolvedTarget = fileTarget;
    const targetKey = fileTargetKey(resolvedTarget);
    return async (path, side) => {
      const result = await queryClient.fetchQuery({
        queryKey: environmentDiffFileQueryKey(
          envId,
          resolvedTarget.type,
          targetKey,
          path,
          side,
        ),
        queryFn: ({ signal }) =>
          sdk.environments.diffFile(
            buildEnvironmentDiffFileArgs(
              envId,
              resolvedTarget,
              path,
              side,
              signal,
            ),
          ),
        staleTime: 5_000,
      });
      return toDiffFileContentsResult(path, result);
    };
  }, [environmentId, fileTarget, queryClient]);
}

function buildEnvironmentDiffFileArgs(
  environmentId: string,
  target: DiffFileTarget,
  path: string,
  side: "old" | "new",
  signal: AbortSignal,
): EnvironmentDiffFileArgs {
  switch (target.type) {
    case "uncommitted":
      return { environmentId, path, side, signal, target: target.type };
    case "branch_committed":
    case "all":
      return {
        environmentId,
        mergeBaseRef: target.mergeBaseRef,
        path,
        side,
        signal,
        target: target.type,
      };
    case "commit":
      return {
        environmentId,
        path,
        sha: target.sha,
        side,
        signal,
        target: target.type,
      };
  }
}

function fileTargetKey(target: DiffFileTarget): string | null {
  switch (target.type) {
    case "uncommitted":
      return null;
    case "branch_committed":
    case "all":
      return target.mergeBaseRef;
    case "commit":
      return target.sha;
    default: {
      const _exhaustive: never = target;
      return _exhaustive;
    }
  }
}

function buildDiffFileTarget(
  target: WorkspaceDiffTarget | undefined,
  mergeBaseRef: string | null,
): DiffFileTarget | undefined {
  if (!target) return undefined;
  switch (target.type) {
    case "uncommitted":
      return { type: "uncommitted" };
    case "branch_committed":
      return mergeBaseRef
        ? { type: "branch_committed", mergeBaseRef }
        : undefined;
    case "all":
      return mergeBaseRef ? { type: "all", mergeBaseRef } : undefined;
    case "commit":
      return { type: "commit", sha: target.sha };
    default: {
      const _exhaustive: never = target;
      return _exhaustive;
    }
  }
}

const PREVIEWABLE_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/vnd.microsoft.icon",
  "image/webp",
  "image/x-icon",
]);

function toDiffFileContentsResult(
  path: string,
  response: EnvironmentDiffFileResponse,
): DiffFileContentsResult | null {
  if (response.contentEncoding === "utf8") {
    return { kind: "text", file: { name: path, contents: response.content } };
  }
  const mimeType = response.mimeType;
  if (mimeType !== undefined && PREVIEWABLE_IMAGE_MIME_TYPES.has(mimeType)) {
    return {
      kind: "image",
      dataUrl: `data:${mimeType};base64,${response.content}`,
      sizeBytes: response.sizeBytes,
    };
  }
  return null;
}
