import { useCallback } from "react";
import { useSetAtom } from "jotai";
import {
  localHostDaemonAccessStateAtom,
  localHostDaemonHostIdAtom,
  localHostDaemonReachableAtom,
  localHostIdAtom,
  localHostStatusAtom,
  requestLocalHostDaemonAccessAtom,
} from "@/lib/system-config-atoms";
import { useAsyncAtomValue } from "@/lib/use-async-atom-value";

export function useHostDaemon() {
  const localHostDaemonReachable = useAsyncAtomValue(
    localHostDaemonReachableAtom,
    false,
  );
  const localDaemonHostId = useAsyncAtomValue(localHostDaemonHostIdAtom, null);
  const localHostStatus = useAsyncAtomValue(localHostStatusAtom, null);
  const localHostId = useAsyncAtomValue(localHostIdAtom, null);

  const hasDaemon = localHostDaemonReachable;
  const supportsNativeFolderPicker =
    localHostStatus?.supportsNativeFolderPicker ?? false;
  const platform = localHostStatus?.platform ?? null;

  const isLocalDaemonHost = useCallback(
    (hostId: string | null | undefined) => {
      if (!localDaemonHostId || !hostId) return false;
      return hostId === localDaemonHostId;
    },
    [localDaemonHostId],
  );

  return {
    localDaemonHostId,
    localHostId,
    hasDaemon,
    supportsNativeFolderPicker,
    platform,
    isLocalDaemonHost,
  };
}

export function useLocalHostDaemonAccess() {
  const accessState = useAsyncAtomValue(
    localHostDaemonAccessStateAtom,
    "unavailable",
  );
  const requestAccess = useSetAtom(requestLocalHostDaemonAccessAtom);

  return { accessState, requestAccess };
}
