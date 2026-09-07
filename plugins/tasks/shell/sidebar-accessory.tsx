import { useCallback, useEffect, useRef, useState } from "react";
import {
  useRealtime,
  useRealtimeConnectionState,
} from "@get-bb/plugin-sdk/app";
import { useTasksRpc } from "./data.js";

export function TasksSidebarAccessory() {
  const rpc = useTasksRpc();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const connectionState = useRealtimeConnectionState();
  const requestState = useRef({
    isMounted: true,
    isRunning: false,
    refreshQueued: false,
  });
  const [count, setCount] = useState<number | null>(null);

  const refresh = useCallback(() => {
    const request = requestState.current;
    if (!request.isMounted) return;
    request.refreshQueued = true;
    if (request.isRunning) return;
    request.isRunning = true;

    void (async () => {
      try {
        while (request.isMounted && request.refreshQueued) {
          request.refreshQueued = false;
          try {
            const { openTaskCount } = await rpcRef.current.call(
              "sidebarOpenTaskCount",
            );
            if (request.isMounted) setCount(openTaskCount);
          } catch {}
        }
      } finally {
        request.isRunning = false;
      }
    })();
  }, []);

  useEffect(() => {
    const request = requestState.current;
    request.isMounted = true;
    return () => {
      request.isMounted = false;
      request.refreshQueued = false;
    };
  }, []);

  useEffect(() => {
    if (connectionState === "connected") refresh();
  }, [connectionState, refresh]);
  useRealtime("tasks:changed", refresh);
  useRealtime("projects:changed", refresh);

  return count === null || count === 0 ? null : (
    <span className="text-muted-foreground tabular-nums">{count}</span>
  );
}
