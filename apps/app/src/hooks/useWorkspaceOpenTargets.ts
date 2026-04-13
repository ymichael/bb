import { atom, useAtomValue } from "jotai";
import { useMemo } from "react";
import type {
  OpenWorkspaceRequest,
  WorkspaceOpenTarget,
} from "@bb/host-daemon-contract";
import {
  hostDaemonPortAtom,
  localHostIdAtom,
  localWorkspaceOpenTargetsAtom,
} from "@/lib/atoms";
import { openWorkspace as daemonOpenWorkspace } from "@/lib/api-host-daemon";

const disabledLocalHostIdAtom = atom<string | null>(null);
const disabledHostDaemonPortAtom = atom<number | null>(null);
const disabledWorkspaceOpenTargetsAtom = atom<WorkspaceOpenTarget[]>([]);

export interface UseWorkspaceOpenTargetsArgs {
  enabled: boolean;
}

export interface UseWorkspaceOpenTargetsResult {
  openWorkspace: ((request: OpenWorkspaceRequest) => Promise<void>) | null;
  workspaceOpenTargets: WorkspaceOpenTarget[];
}

export function useWorkspaceOpenTargets(
  args: UseWorkspaceOpenTargetsArgs,
): UseWorkspaceOpenTargetsResult {
  const localHostId = useAtomValue(
    args.enabled ? localHostIdAtom : disabledLocalHostIdAtom,
  );
  const daemonPort = useAtomValue(
    args.enabled ? hostDaemonPortAtom : disabledHostDaemonPortAtom,
  );
  const workspaceOpenTargets = useAtomValue(
    args.enabled
      ? localWorkspaceOpenTargetsAtom
      : disabledWorkspaceOpenTargetsAtom,
  );

  const openWorkspace = useMemo(() => {
    if (
      !args.enabled ||
      !localHostId ||
      !daemonPort ||
      workspaceOpenTargets.length === 0
    ) {
      return null;
    }
    const port = daemonPort;
    return (request: OpenWorkspaceRequest) => daemonOpenWorkspace(port, request);
  }, [args.enabled, localHostId, daemonPort, workspaceOpenTargets.length]);

  return {
    openWorkspace,
    workspaceOpenTargets,
  };
}
