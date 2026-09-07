import type { MobileRealtimeConnectionState } from "../realtime/mobile-realtime";
import type { SessionState } from "../session/session-scheduler";

export type ConnectionBannerKind =
  | "hidden"
  | "connecting"
  | "reconnecting"
  | "auth-required"
  | "auth-error";

export interface ConnectionBannerInput {
  session: SessionState;
  realtime: MobileRealtimeConnectionState;
  suspended: boolean;
  connectingForMs: number;
}

export const CONNECTING_BANNER_GRACE_MS = 1500;

export function deriveConnectionBanner(
  input: ConnectionBannerInput,
): ConnectionBannerKind {
  if (input.suspended) return "hidden";
  switch (input.session.status) {
    case "auth-required":
      return "auth-required";
    case "error":
      return "auth-error";
    case "authenticating":
    case "idle":
    case "authenticated":
      break;
  }
  switch (input.realtime) {
    case "connected":
      return "hidden";
    case "reconnecting":
      return "reconnecting";
    case "connecting":
      return input.connectingForMs >= CONNECTING_BANNER_GRACE_MS
        ? "connecting"
        : "hidden";
  }
}
