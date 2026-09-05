import ReconnectingWebSocket from "partysocket/ws";
import {
  type HostDaemonActiveThread,
  type HostDaemonLoadedEnvironment,
  type HostDaemonConnectSharesReplaceMessage,
  type HostDaemonOnlineRpcRequestMessage,
  type HostDaemonServerWsMessage,
  type HostDaemonSessionOpenResponse,
  type HostDaemonWatchSetReplaceMessage,
} from "@bb/host-daemon-contract";
import type { HostDaemonLogger } from "./logger.js";
import type { ServerClient } from "./server-client.js";
import type { ProtocolSelfUpdater } from "./protocol-self-update.js";
import { createNodeWebSocketConstructor } from "./websocket-constructor.js";

export interface ReconnectingWebSocketLike {
  readonly bufferedAmount?: number;
  readonly readyState: number;
  onopen: ((event: any) => void) | null;
  onmessage: ((event: any) => void) | null;
  onclose: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  reconnect(code?: number, reason?: string): void;
}

interface ReconnectingWebSocketOptions {
  minReconnectionDelay: number;
  maxReconnectionDelay: number;
  reconnectionDelayGrowFactor: number;
  connectionTimeout: number;
  headers?: Record<string, string>;
  maxRetries: number;
  protocols?: string[];
}

export type CreateReconnectingWebSocket = (
  urlProvider: () => Promise<string>,
  options: ReconnectingWebSocketOptions,
) => ReconnectingWebSocketLike;

export type HostDaemonServerTerminalMessage = Exclude<
  HostDaemonServerWsMessage,
  | { type: "session-close" }
  | { type: "heartbeat-ack" }
  | HostDaemonOnlineRpcRequestMessage
  | HostDaemonWatchSetReplaceMessage
  | HostDaemonConnectSharesReplaceMessage
>;

export interface ServerConnectionOptions {
  serverUrl: string;
  hostKey: string;
  logger: HostDaemonLogger;
  machineCredential?: string;
  connectMachineId?: string;
  serverClient: ServerClient;
  protocolSelfUpdater?: ProtocolSelfUpdater;
  onSelfUpdateInstalled?: () => void | Promise<void>;
  hostId: string;
  hostName: string;
  dataDir: string;
  instanceId: string;
  localApiPort: number | null;
  setSession?: (session: HostDaemonSessionOpenResponse | null) => void;
  getActiveThreads?: () =>
    | HostDaemonActiveThread[]
    | Promise<HostDaemonActiveThread[]>;
  getLoadedEnvironments?: () =>
    | HostDaemonLoadedEnvironment[]
    | Promise<HostDaemonLoadedEnvironment[]>;
  onTerminalMessage?: (
    message: HostDaemonServerTerminalMessage,
  ) => void | Promise<void>;
  onHostRpcRequest?: (
    message: HostDaemonOnlineRpcRequestMessage,
  ) => void | Promise<void>;
  onWatchSetReplace?: (
    message: HostDaemonWatchSetReplaceMessage,
  ) => void | Promise<void>;
  onConnectSharesReplace?: (
    message: HostDaemonConnectSharesReplaceMessage,
  ) => void | Promise<void>;
  onSessionOpened?: (
    session: HostDaemonSessionOpenResponse,
  ) => void | Promise<void>;
  createWebSocket?: CreateReconnectingWebSocket;
  startupTimeoutMs?: number;
}

export const DEFAULT_MIN_RECONNECTION_DELAY = 1_000;
export const DEFAULT_MAX_RECONNECTION_DELAY = 30_000;
export const DEFAULT_RECONNECTION_DELAY_GROW_FACTOR = 2;
export const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;
export const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;
export const OPEN_READY_STATE = 1;

export function createDefaultReconnectingWebSocket(
  urlProvider: () => Promise<string>,
  options: ReconnectingWebSocketOptions,
): ReconnectingWebSocketLike {
  const { headers, protocols, ...reconnectionOptions } = options;
  return new ReconnectingWebSocket(urlProvider, protocols ?? [], {
    ...reconnectionOptions,
    WebSocket: createNodeWebSocketConstructor(headers),
  });
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
