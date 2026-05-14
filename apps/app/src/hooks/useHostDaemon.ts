import { useAtomValue } from "jotai";
import { useCallback, useMemo } from "react";
import {
  hostDaemonPortAtom,
  localHostIdAtom,
  localHostStatusAtom,
} from "@/lib/system-config-atoms";
import { pickFolder as daemonPickFolder } from "@/lib/api-host-daemon";

/**
 * Hook for host daemon operations.
 *
 * Provides:
 * - `localHostId` — this machine's host ID, null if no daemon
 * - `hasDaemon` — whether a daemon is reachable
 * - `supportsNativeFolderPicker` — whether the daemon can open a native folder picker
 * - `isLocalHost(hostId)` — whether the given host matches this machine
 * - `pickFolder()` — open native folder picker (null if no daemon)
 */
export function useHostDaemon() {
  const localHostStatus = useAtomValue(localHostStatusAtom);
  const localHostId = useAtomValue(localHostIdAtom);
  const daemonPort = useAtomValue(hostDaemonPortAtom);

  const hasDaemon = localHostId != null;
  const supportsNativeFolderPicker =
    localHostStatus?.supportsNativeFolderPicker ?? false;
  const platform = localHostStatus?.platform ?? null;

  const isLocalHost = useCallback(
    (hostId: string | null | undefined) => {
      if (!localHostId || !hostId) return false;
      return hostId === localHostId;
    },
    [localHostId],
  );

  const pickFolder = useMemo(() => {
    if (!localHostId || !daemonPort || !supportsNativeFolderPicker) return null;
    const port = daemonPort;
    return () => daemonPickFolder(port);
  }, [localHostId, daemonPort, supportsNativeFolderPicker]);

  return {
    localHostId,
    hasDaemon,
    supportsNativeFolderPicker,
    platform,
    isLocalHost,
    pickFolder,
  };
}
