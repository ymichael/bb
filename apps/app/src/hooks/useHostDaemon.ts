import { useAtomValue } from "jotai";
import { useCallback, useMemo } from "react";
import { hostDaemonPortAtom, localHostIdAtom } from "@/lib/atoms";
import { openPath as daemonOpenPath, pickFolder as daemonPickFolder } from "@/lib/api-host-daemon";

/**
 * Hook for host daemon operations (open-path, pick-folder).
 *
 * Provides:
 * - `localHostId` — this machine's host ID, null if no daemon
 * - `hasDaemon` — whether a daemon is reachable
 * - `isLocalHost(hostId)` — whether the given host matches this machine
 * - `openPath(path)` — open a path in the user's editor (null if no daemon)
 * - `pickFolder()` — open native folder picker (null if no daemon)
 */
export function useHostDaemon() {
  const localHostId = useAtomValue(localHostIdAtom);
  const daemonPort = useAtomValue(hostDaemonPortAtom);

  const hasDaemon = localHostId != null;

  const isLocalHost = useCallback(
    (hostId: string | null | undefined) => {
      if (!localHostId || !hostId) return false;
      return hostId === localHostId;
    },
    [localHostId],
  );

  const openPath = useMemo(() => {
    if (!localHostId || !daemonPort) return null;
    const port = daemonPort;
    return (path: string) => daemonOpenPath(port, path);
  }, [localHostId, daemonPort]);

  const pickFolder = useMemo(() => {
    if (!localHostId || !daemonPort) return null;
    const port = daemonPort;
    return () => daemonPickFolder(port);
  }, [localHostId, daemonPort]);

  return {
    localHostId,
    hasDaemon,
    isLocalHost,
    openPath,
    pickFolder,
  };
}
