import { useMemo } from "react";
import { useAtomValue } from "jotai";
import { skipToken, useQuery } from "@tanstack/react-query";
import { checkPathsExist } from "@/lib/api-host-daemon";
import { hostDaemonPortAtom, localHostIdAtom } from "@/lib/system-config-atoms";
import { localPathExistenceQueryKey } from "./query-keys";

export type LocalPathExistence = Record<string, boolean>;

/**
 * Probe the local host daemon to check whether each given path still exists
 * on disk. Returns `{}` while loading / disconnected; the consumer should
 * treat a missing entry as "unknown", not "exists".
 */
export function useLocalPathExistence(
  paths: readonly string[],
): LocalPathExistence {
  const localHostId = useAtomValue(localHostIdAtom);
  const daemonPort = useAtomValue(hostDaemonPortAtom);

  const sortedPaths = useMemo(() => {
    if (paths.length === 0) return [];
    return [...new Set(paths)].sort();
  }, [paths]);

  const enabled =
    localHostId != null && daemonPort != null && sortedPaths.length > 0;

  const query = useQuery({
    queryKey: localPathExistenceQueryKey(localHostId ?? "", sortedPaths),
    queryFn: enabled
      ? () => checkPathsExist(daemonPort, sortedPaths)
      : skipToken,
    staleTime: 10_000,
  });

  return query.data ?? {};
}

/**
 * Returns true only when we have a definitive "missing" answer from the
 * daemon. Loading, errors, and unknown paths all return false so the UI
 * doesn't flash a destructive warning for transient state.
 */
export function isLocalPathMissing(
  existence: LocalPathExistence,
  path: string | null | undefined,
): boolean {
  if (path == null) return false;
  return existence[path] === false;
}
