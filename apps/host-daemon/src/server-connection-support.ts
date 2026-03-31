import ReconnectingWebSocket from "partysocket/ws";
import {
  HOST_DAEMON_PROTOCOL_VERSION,
  type HostDaemonActiveThread,
  type HostDaemonSessionOpenRequest,
  type HostDaemonSessionOpenResponse,
} from "@bb/host-daemon-contract";
import type { HostDaemonLogger } from "./logger.js";
import type { ServerClient } from "./server-client.js";

export type TimeoutHandle = ReturnType<typeof setTimeout>;
export type IntervalHandle = ReturnType<typeof setInterval>;

export interface ReconnectingWebSocketLike {
  readonly readyState: number;
  onopen: ((event: any) => void) | null;
  onmessage: ((event: any) => void) | null;
  onclose: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface ReconnectingWebSocketOptions {
  minReconnectionDelay: number;
  maxReconnectionDelay: number;
  reconnectionDelayGrowFactor: number;
  connectionTimeout: number;
  maxRetries: number;
}

export type CreateReconnectingWebSocket = (
  urlProvider: () => Promise<string>,
  options: ReconnectingWebSocketOptions,
) => ReconnectingWebSocketLike;

export interface ServerConnectionOptions {
  serverUrl: string;
  authToken: string;
  logger: HostDaemonLogger;
  serverClient: ServerClient;
  hostId: string;
  hostName: string;
  hostType: HostDaemonSessionOpenRequest["hostType"];
  dataDir: string;
  instanceId: string;
  setSession?: (session: HostDaemonSessionOpenResponse | null) => void;
  getActiveThreads?: () =>
    | HostDaemonActiveThread[]
    | Promise<HostDaemonActiveThread[]>;
  onCommandsAvailable?: () => void | Promise<void>;
  onSessionClose?: (
    reason: "replaced" | "expired" | "daemon-disconnect",
  ) => void | Promise<void>;
  onSessionOpened?: (
    session: HostDaemonSessionOpenResponse,
  ) => void | Promise<void>;
  protocolVersion?: typeof HOST_DAEMON_PROTOCOL_VERSION;
  createWebSocket?: CreateReconnectingWebSocket;
  minReconnectionDelay?: number;
  maxReconnectionDelay?: number;
  reconnectionDelayGrowFactor?: number;
  connectionTimeout?: number;
  pollAfterDisconnectMs?: number;
  pollIntervalMs?: number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

export const DEFAULT_MIN_RECONNECTION_DELAY = 1_000;
export const DEFAULT_MAX_RECONNECTION_DELAY = 30_000;
export const DEFAULT_RECONNECTION_DELAY_GROW_FACTOR = 2;
export const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;
export const DEFAULT_POLL_AFTER_DISCONNECT_MS = 5_000;
export const DEFAULT_POLL_INTERVAL_MS = 10_000;
export const OPEN_READY_STATE = 1;

export function createDefaultReconnectingWebSocket(
  urlProvider: () => Promise<string>,
  options: ReconnectingWebSocketOptions,
): ReconnectingWebSocketLike {
  return new ReconnectingWebSocket(urlProvider, [], options);
}

export function decodeWebSocketMessageData(data: unknown): string {
  if (typeof data === "string") {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  return String(data);
}
