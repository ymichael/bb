import { useMemo } from "react";
import { skipToken, useQuery } from "@tanstack/react-query";
import { sdk } from "@/lib/sdk";
import { hostPathExistenceQueryKey } from "./query-keys";

type HostPathExistence = Record<string, boolean>;

export function useHostPathExistence(
  hostId: string | null,
  paths: readonly string[],
): HostPathExistence {
  const sortedPaths = useMemo(() => {
    if (paths.length === 0) return [];
    return [...new Set(paths)].sort();
  }, [paths]);
  const enabledHostId =
    hostId !== null && sortedPaths.length > 0 ? hostId : null;

  const query = useQuery({
    queryKey: hostPathExistenceQueryKey(hostId, sortedPaths),
    queryFn: enabledHostId
      ? async ({ signal }) =>
          (
            await sdk.hosts.pathsExist({
              hostId: enabledHostId,
              paths: sortedPaths,
              signal,
            })
          ).existence
      : skipToken,
    staleTime: 10_000,
  });

  return query.data ?? {};
}

export function isHostPathMissing(
  existence: HostPathExistence,
  path: string | null | undefined,
): boolean {
  if (path == null) return false;
  return existence[path] === false;
}
