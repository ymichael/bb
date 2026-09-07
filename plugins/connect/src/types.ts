export type ConnectStateName =
  | "disconnected"
  | "pairing"
  | "connected"
  | "reconnecting";

interface ConnectShareStatus {
  hostId: string;
  hostName: string;
  port: number;
  createdAt: number;
  url: string;
  unavailableReason?: string;
}

export interface ConnectStatus {
  state: ConnectStateName;
  paired: boolean;
  handle: string | null;
  url: string | null;
  dashboardUrl: string;
  lastError: string | null;
  nextRetryAt: number | null;
  since: number;
  remoteClients: number;
  lastRemoteActivityAt: number | null;
  shares: ConnectShareStatus[];
}

export const CONNECT_REALTIME_CHANNEL = "connect";

export const REMOTE_ACTIVITY_INSTRUCTIONS_MS = 5 * 60 * 1000;
