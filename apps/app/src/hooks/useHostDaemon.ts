import { useAtomValue } from "jotai";
import { useCallback, useMemo } from "react";
import {
  hostDaemonPortAtom,
  localHostIdAtom,
  localHostStatusAtom,
} from "@/lib/system-config-atoms";
import {
  pickFolder as daemonPickFolder,
} from "@/lib/api-host-daemon";
import { useEffectiveHosts } from "./queries/effective-hosts";

/**
 * Hook for host daemon operations.
 *
 * Provides:
 * - `localHostId` — this machine's host ID, null if no daemon
 * - `localHost` — the full Host object for this machine, or null
 * - `hasConnectedPersistentHost` — whether the local host's status is "connected"
 * - `hasDaemon` — whether a daemon is reachable
 * - `supportsNativeFolderPicker` — whether the daemon can open a native folder picker
 * - `isLocalHost(hostId)` — whether the given host matches this machine
 * - `pickFolder()` — open native folder picker (null if no daemon)
 */
export function useHostDaemon() {
  const localHostId = useAtomValue(localHostIdAtom);
  const localHostStatus = useAtomValue(localHostStatusAtom);
  const daemonPort = useAtomValue(hostDaemonPortAtom);
  const { data: hosts } = useEffectiveHosts();

  const hasDaemon = localHostId != null;
  const supportsNativeFolderPicker =
    localHostStatus?.supportsNativeFolderPicker ?? false;
  const platform = localHostStatus?.platform ?? null;

  const localHost = useMemo(() => {
    if (!localHostId || !hosts) return null;
    return hosts.find((h) => h.id === localHostId) ?? null;
  }, [localHostId, hosts]);

  // This is derived from effective host availability, so UI does not treat a
  // stale "connected" server snapshot as online while the server is reconnecting.
  const connectedPersistentHost = useMemo(() => {
    if (!hosts) return null;
    return (
      hosts.find((h) => h.type === "persistent" && h.status === "connected") ??
      null
    );
  }, [hosts]);

  const hasConnectedPersistentHost = connectedPersistentHost !== null;

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
    localHost,
    connectedPersistentHost,
    hasConnectedPersistentHost,
    hasDaemon,
    supportsNativeFolderPicker,
    platform,
    isLocalHost,
    pickFolder,
  };
}
