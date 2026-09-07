import { useEffect, useMemo, useState } from "react";
import type { WebSocketConnectionState } from "@/lib/ws";
import { useServerConnectionState } from "../useServerConnectionState";

const CONNECTION_GRACE_PERIOD_MS = 10_000;

export type ConnectionAwareQueryStatus = "loading" | "ready" | "unavailable";

interface ConnectionAwareQuerySnapshot {
  hasResolvedData: boolean;
  isFetching: boolean;
  isLoadingError: boolean;
  isRecoverableLoadingError?: boolean;
}

export interface ConnectionAwareQueryStateArgs extends ConnectionAwareQuerySnapshot {
  serverConnectionState: WebSocketConnectionState;
  connectionGracePeriodElapsed: boolean;
}

interface ConnectionAwareQueryState {
  status: ConnectionAwareQueryStatus;
}

export function getConnectionAwareQueryState({
  hasResolvedData,
  isFetching,
  isLoadingError,
  isRecoverableLoadingError = false,
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

  if (
    !hasResolvedData &&
    isLoadingError &&
    isRecoverableLoadingError &&
    (serverConnectionState === "connected" || !connectionGracePeriodElapsed)
  ) {
    return { status: "loading" };
  }

  if (!hasResolvedData && isLoadingError) {
    return { status: "unavailable" };
  }

  return { status: "ready" };
}

function useServerConnectionGracePeriodElapsed(): boolean {
  const connectionState = useServerConnectionState();
  const [elapsed, setElapsed] = useState(false);

  useEffect(() => {
    if (connectionState === "connected") {
      setElapsed(false);
      return;
    }
    const timer = setTimeout(
      () => setElapsed(true),
      CONNECTION_GRACE_PERIOD_MS,
    );
    return () => clearTimeout(timer);
  }, [connectionState]);

  return elapsed;
}

export function useConnectionAwareQueryState({
  hasResolvedData,
  isFetching,
  isLoadingError,
  isRecoverableLoadingError,
}: ConnectionAwareQuerySnapshot): ConnectionAwareQueryState {
  const serverConnectionState = useServerConnectionState();
  const connectionGracePeriodElapsed = useServerConnectionGracePeriodElapsed();

  return useMemo(
    () =>
      getConnectionAwareQueryState({
        hasResolvedData,
        isFetching,
        isLoadingError,
        isRecoverableLoadingError,
        serverConnectionState,
        connectionGracePeriodElapsed,
      }),
    [
      hasResolvedData,
      isFetching,
      isLoadingError,
      isRecoverableLoadingError,
      serverConnectionState,
      connectionGracePeriodElapsed,
    ],
  );
}
