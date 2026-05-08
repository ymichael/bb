import { atom, useAtomValue } from "jotai";
import { useMemo } from "react";
import type {
  OpenInTargetRequest,
  WorkspaceOpenTarget,
} from "@bb/host-daemon-contract";
import {
  hostDaemonPortAtom,
  localHostIdAtom,
  localWorkspaceOpenTargetsAtom,
} from "@/lib/system-config-atoms";
import { openInTarget as daemonOpenInTarget } from "@/lib/api-host-daemon";

const disabledLocalHostIdAtom = atom<string | null>(null);
const disabledHostDaemonPortAtom = atom<number | null>(null);
const disabledWorkspaceOpenTargetsAtom = atom<WorkspaceOpenTarget[]>([]);

export interface UseWorkspaceOpenTargetsArgs {
  enabled: boolean;
}

export interface UseWorkspaceOpenTargetsResult {
  openWorkspace: ((request: OpenInTargetRequest) => Promise<void>) | null;
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
    return (request: OpenInTargetRequest) => daemonOpenInTarget(port, request);
  }, [args.enabled, localHostId, daemonPort, workspaceOpenTargets.length]);

  return {
    openWorkspace,
    workspaceOpenTargets,
  };
}
