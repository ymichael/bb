import { useAtomValue } from "jotai";
import { useCallback, useMemo } from "react";
import { hostDaemonPortAtom, localHostIdAtom, localHostStatusAtom } from "@/lib/atoms";
import { openPath as daemonOpenPath, pickFolder as daemonPickFolder } from "@/lib/api-host-daemon";
import { useHosts } from "./queries/system-queries";

/**
 * Hook for host daemon operations (open-path, pick-folder).
 *
 * Provides:
 * - `localHostId` — this machine's host ID, null if no daemon
 * - `localHost` — the full Host object for this machine, or null
 * - `hasConnectedPersistentHost` — whether the local host's status is "connected"
 * - `hasDaemon` — whether a daemon is reachable
 * - `supportsNativeFolderPicker` — whether the daemon can open a native folder picker
 * - `isLocalHost(hostId)` — whether the given host matches this machine
 * - `openPath(path)` — open a path in the user's editor (null if no daemon)
 * - `pickFolder()` — open native folder picker (null if no daemon)
 */
export function useHostDaemon() {
  const localHostId = useAtomValue(localHostIdAtom);
  const localHostStatus = useAtomValue(localHostStatusAtom);
  const daemonPort = useAtomValue(hostDaemonPortAtom);
  const { data: hosts } = useHosts();

  const hasDaemon = localHostId != null;
  const supportsNativeFolderPicker =
    localHostStatus?.supportsNativeFolderPicker ?? false;

  const localHost = useMemo(() => {
    if (!localHostId || !hosts) return null;
    return hosts.find((h) => h.id === localHostId) ?? null;
  }, [localHostId, hosts]);

  // For the connection indicator we only need the hosts query — not the daemon
  // probe atom.  The atom can temporarily return null (e.g. after a server
  // restart while the daemon is still reconnecting), which would make the
  // indicator stuck on "Disconnected" even though the server already has an
  // active session.  Checking for any connected persistent host avoids that.
  const connectedPersistentHost = useMemo(() => {
    if (!hosts) return null;
    return hosts.find((h) => h.type === "persistent" && h.status === "connected") ?? null;
  }, [hosts]);

  const hasConnectedPersistentHost = connectedPersistentHost !== null;

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
    if (!localHostId || !daemonPort || !supportsNativeFolderPicker) return null;
    const port = daemonPort;
    return () => daemonPickFolder(port);
  }, [localHostId, daemonPort, supportsNativeFolderPicker]);

  return {
    localHostId,
    localHost,
    connectedPersistentHost,
    hasConnectedPersistentHost,
    hasDaemon,
    supportsNativeFolderPicker,
    isLocalHost,
    openPath,
    pickFolder,
  };
}
