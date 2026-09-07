import { useEffect, useState, useSyncExternalStore } from "react";
import {
  CONNECTING_BANNER_GRACE_MS,
  deriveConnectionBanner,
  type ConnectionBannerKind,
} from "@/lib/connection";
import type { MobileRealtimeConnectionState } from "@/lib/realtime";
import { useProfiles } from "./ProfilesProvider";

export function useRealtimeConnectionState(): MobileRealtimeConnectionState {
  const { connection } = useProfiles();
  const realtime = connection?.client.realtime ?? null;
  return useSyncExternalStore(
    (listener) => realtime?.onConnectionStateChange(listener) ?? (() => {}),
    () => realtime?.getConnectionState() ?? "connecting",
    () => "connecting",
  );
}

export function useConnectionBanner(): ConnectionBannerKind {
  const { connection } = useProfiles();
  const realtimeState = useRealtimeConnectionState();
  const clientKey = connection?.client.profileId ?? null;
  const [graceElapsedFor, setGraceElapsedFor] = useState<string | null>(null);

  useEffect(() => {
    if (realtimeState !== "connecting" || clientKey === null) return;
    const timer = setTimeout(
      () => setGraceElapsedFor(clientKey),
      CONNECTING_BANNER_GRACE_MS,
    );
    return () => clearTimeout(timer);
  }, [realtimeState, clientKey]);

  if (!connection) return "hidden";
  return deriveConnectionBanner({
    session: connection.session,
    realtime: realtimeState,
    suspended: connection.client.realtime.isSuspended(),
    connectingForMs:
      graceElapsedFor === clientKey ? CONNECTING_BANNER_GRACE_MS : 0,
  });
}
