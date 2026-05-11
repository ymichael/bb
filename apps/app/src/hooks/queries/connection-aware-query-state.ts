import { useEffect, useMemo, useState } from "react";
import type { WebSocketConnectionState } from "@/lib/ws";
import { useServerConnectionState } from "../useServerConnectionState";

/**
 * How long an errored query is treated as "still loading" while the WebSocket
 * is not connected. Past this point we assume the server isn't coming up and
 * surface the failure so the user can act on it.
 */
export const CONNECTION_GRACE_PERIOD_MS = 10_000;

export type ConnectionAwareQueryStatus = "loading" | "ready" | "unavailable";

export interface ConnectionAwareQuerySnapshot {
  hasResolvedData: boolean;
  isFetching: boolean;
  isLoadingError: boolean;
}

export interface ConnectionAwareQueryStateArgs
  extends ConnectionAwareQuerySnapshot {
  serverConnectionState: WebSocketConnectionState;
  connectionGracePeriodElapsed: boolean;
}

export interface UseConnectionAwareQueryStateArgs
  extends ConnectionAwareQuerySnapshot {}

export interface ConnectionAwareQueryState {
  status: ConnectionAwareQueryStatus;
}

export function getConnectionAwareQueryState({
  hasResolvedData,
  isFetching,
  isLoadingError,
  serverConnectionState,
  connectionGracePeriodElapsed,
}: ConnectionAwareQueryStateArgs): ConnectionAwareQueryState {
  if (!hasResolvedData && isFetching) {
    return { status: "loading" };
  }

  if (
    !hasResolvedData &&
    isLoadingError &&
    serverConnectionState !== "connected" &&
    !connectionGracePeriodElapsed
  ) {
    return { status: "loading" };
  }

  if (!hasResolvedData && isLoadingError) {
    return { status: "unavailable" };
  }

  return { status: "ready" };
}

/**
 * True once the WebSocket has been disconnected for longer than the grace
 * period without re-establishing. Resets on every transition into "connected".
 */
export function useServerConnectionGracePeriodElapsed(
  gracePeriodMs: number = CONNECTION_GRACE_PERIOD_MS,
): boolean {
  const connectionState = useServerConnectionState();
  const [elapsed, setElapsed] = useState(false);

  useEffect(() => {
    if (connectionState === "connected") {
      setElapsed(false);
      return;
    }
    const timer = setTimeout(() => setElapsed(true), gracePeriodMs);
    return () => clearTimeout(timer);
  }, [connectionState, gracePeriodMs]);

  return elapsed;
}

export function useConnectionAwareQueryState({
  hasResolvedData,
  isFetching,
  isLoadingError,
}: UseConnectionAwareQueryStateArgs): ConnectionAwareQueryState {
  const serverConnectionState = useServerConnectionState();
  const connectionGracePeriodElapsed = useServerConnectionGracePeriodElapsed();

  return useMemo(
    () =>
      getConnectionAwareQueryState({
        hasResolvedData,
        isFetching,
        isLoadingError,
        serverConnectionState,
        connectionGracePeriodElapsed,
      }),
    [
      hasResolvedData,
      isFetching,
      isLoadingError,
      serverConnectionState,
      connectionGracePeriodElapsed,
    ],
  );
}
