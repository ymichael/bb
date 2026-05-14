import { useMemo } from "react";
import type { Host } from "@bb/domain";
import type { WebSocketConnectionState } from "@/lib/ws";
import { useServerConnectionState } from "../useServerConnectionState";
import { useHost, useHosts } from "./system-queries";
import type { HostQueryId } from "./query-keys";

interface EffectiveHostInput {
  host: Host;
  serverConnectionState: WebSocketConnectionState;
}

interface UseEffectiveHostOptions {
  enabled?: boolean;
}

function isHostStatusUnavailable(
  serverConnectionState: WebSocketConnectionState,
): boolean {
  return serverConnectionState === "reconnecting";
}

export function getEffectiveHost({
  host,
  serverConnectionState,
}: EffectiveHostInput): Host {
  if (
    !isHostStatusUnavailable(serverConnectionState) ||
    host.status !== "connected"
  ) {
    return host;
  }

  return {
    ...host,
    status: "disconnected",
  };
}

function getEffectiveHostList(
  hosts: Host[] | undefined,
  serverConnectionState: WebSocketConnectionState,
): Host[] | undefined {
  if (!hosts) {
    return hosts;
  }

  let changed = false;
  const nextHosts = hosts.map((host) => {
    const nextHost = getEffectiveHost({ host, serverConnectionState });
    if (nextHost !== host) {
      changed = true;
    }
    return nextHost;
  });

  return changed ? nextHosts : hosts;
}

export function useEffectiveHosts() {
  const hostsQuery = useHosts();
  const serverConnectionState = useServerConnectionState();
  const effectiveHosts = useMemo(
    () => getEffectiveHostList(hostsQuery.data, serverConnectionState),
    [hostsQuery.data, serverConnectionState],
  );

  return {
    ...hostsQuery,
    data: effectiveHosts,
  };
}

export function useEffectiveHost(
  hostId: HostQueryId,
  options?: UseEffectiveHostOptions,
) {
  const hostQuery = useHost(hostId, {
    enabled: (options?.enabled ?? true) && Boolean(hostId),
  });
  const serverConnectionState = useServerConnectionState();
  const effectiveHost = useMemo(
    () => {
      const host = hostQuery.data;
      if (!host) {
        return undefined;
      }
      return getEffectiveHost({
        host,
        serverConnectionState,
      });
    },
    [hostQuery.data, serverConnectionState],
  );

  return {
    ...hostQuery,
    data: effectiveHost,
  };
}
