import { WebSocket as NodeWebSocket } from "ws";
import {
  PROTOCOL_VERSION,
  TUNNEL_PROTOCOL_QUERY_PARAM,
} from "@bb/tunnel-contract";
import {
  humanizeTransportError,
  ReconnectBackoff,
  TunnelSession,
  type ReconnectBackoffOptions,
  type StreamOriginResult,
} from "@bb/tunnel-client";
import {
  hostDaemonConnectTunnelIdentitySchema,
  type HostDaemonConnectShares,
  type HostDaemonConnectTunnelIdentity,
} from "@bb/host-daemon-contract";
import { connectPublicProtocol } from "@bb/connect-client";
import type { HostDaemonLogger } from "../logger.js";

type ConnectTunnelState = "connected" | "reconnecting" | "offline";

export interface ConnectTunnelStatus {
  state: ConnectTunnelState;
  lastError: string | null;
  credentialRejected: boolean;
  generation: number;
  ports: number[];
}

export type CreateTunnelWebSocket = (
  url: string,
  options: { headers: Record<string, string> },
) => NodeWebSocket;

export type ConnectTunnelFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

interface ConnectTunnelClientOptions {
  serverUrl: string;
  hostName: string;
  machineCredential?: string;
  logger: HostDaemonLogger;
  onIdentity?: (identity: HostDaemonConnectTunnelIdentity) => void;
  onStatusChange?: (status: ConnectTunnelStatus) => void;
  createWebSocket?: CreateTunnelWebSocket;
  fetchFn?: ConnectTunnelFetch;
  reconnectBackoff?: ReconnectBackoffOptions;
}

interface TrustedConnectGate {
  apiOrigin: string;
  baseDomain: string;
}

class ConnectTunnelCredentialRejectedError extends Error {
  readonly code = "credential_rejected";

  constructor(message: string) {
    super(message);
    this.name = "ConnectTunnelCredentialRejectedError";
  }
}

export function resolveTrustedConnectGate(
  serverUrl: string,
): TrustedConnectGate {
  const parsed = new URL(serverUrl);
  const firstDot = parsed.hostname.indexOf(".");
  if (firstDot <= 0 || firstDot === parsed.hostname.length - 1) {
    throw new Error(
      `cannot derive the bb connect gate base domain from enrollment server ${parsed.origin}`,
    );
  }
  const baseHostname = parsed.hostname.slice(firstDot + 1);
  const baseDomain = `${baseHostname}${parsed.port ? `:${parsed.port}` : ""}`;
  if (parsed.protocol !== connectPublicProtocol(baseDomain)) {
    throw new Error(
      `bb connect machine credentials require HTTPS, or HTTP for a local *.localhost enrollment server, got ${parsed.origin}`,
    );
  }
  return {
    apiOrigin: parsed.origin,
    baseDomain,
  };
}

export function buildMachineTunnelUrl(
  identity: HostDaemonConnectTunnelIdentity,
): string {
  const websocketProtocol =
    connectPublicProtocol(identity.baseDomain) === "https:" ? "wss:" : "ws:";
  const url = new URL(
    `${websocketProtocol}//${identity.label}.${identity.baseDomain}/__tunnel`,
  );
  url.searchParams.set(TUNNEL_PROTOCOL_QUERY_PARAM, String(PROTOCOL_VERSION));
  return url.toString();
}

export function buildMachineSharePublicOrigin(
  identity: HostDaemonConnectTunnelIdentity,
  port: number,
): string {
  return `${connectPublicProtocol(identity.baseDomain)}//${identity.label}--${port}.${identity.baseDomain}`;
}

export class ConnectTunnelClient {
  private readonly createWebSocket: CreateTunnelWebSocket;
  private readonly fetchFn: ConnectTunnelFetch;
  private readonly backoff: ReconnectBackoff;
  private readonly machineCredential: string | undefined;
  private generation = -1;
  private ports = new Set<number>();
  private identity: HostDaemonConnectTunnelIdentity | undefined;
  private identityPromise: Promise<HostDaemonConnectTunnelIdentity> | undefined;
  private connectAttempt: Promise<void> | undefined;
  private connectionEpoch = 0;
  private socket: NodeWebSocket | undefined;
  private session: TunnelSession | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private state: ConnectTunnelState = "offline";
  private lastError: string | null = null;
  private credentialRejected = false;
  private stopped = false;

  constructor(private readonly options: ConnectTunnelClientOptions) {
    this.createWebSocket =
      options.createWebSocket ??
      ((url, websocketOptions) =>
        new NodeWebSocket(url, { headers: websocketOptions.headers }));
    this.fetchFn = options.fetchFn ?? fetch;
    this.backoff = new ReconnectBackoff(options.reconnectBackoff);
    this.machineCredential =
      options.machineCredential?.trim().length === 0
        ? undefined
        : options.machineCredential;
  }

  status(): ConnectTunnelStatus {
    return {
      state: this.state,
      lastError: this.lastError,
      credentialRejected: this.credentialRejected,
      generation: Math.max(this.generation, 0),
      ports: [...this.ports].sort((a, b) => a - b),
    };
  }

  replaceShareSet(shares: HostDaemonConnectShares): boolean {
    if (shares.generation <= this.generation) {
      return false;
    }
    this.applyShareSet(shares);
    return true;
  }

  replaceAuthoritativeShareSet(shares: HostDaemonConnectShares): void {
    this.applyShareSet(shares);
    this.reportCurrentIdentity();
  }

  ensureTunnelIdentity(): Promise<HostDaemonConnectTunnelIdentity> {
    if (this.identity) {
      return Promise.resolve(this.identity);
    }
    if (this.identityPromise) {
      return this.identityPromise;
    }
    const credential = this.machineCredential;
    if (!credential) {
      return Promise.reject(
        new Error(
          "this host has no trusted bb connect machine enrollment; remove and re-add it from Settings > Machines",
        ),
      );
    }
    let gate: TrustedConnectGate;
    try {
      gate = resolveTrustedConnectGate(this.options.serverUrl);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.credentialRejected) {
      return Promise.reject(
        new ConnectTunnelCredentialRejectedError(
          "the bb connect gate rejected this machine credential; re-add the machine from Settings > Machines",
        ),
      );
    }

    const assignmentUrl = new URL("/api/connect/machine-label", gate.apiOrigin);
    let pending: Promise<HostDaemonConnectTunnelIdentity>;
    pending = this.fetchFn(assignmentUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-bb-connect-machine": credential,
      },
      body: JSON.stringify({ desiredName: this.options.hostName }),
    })
      .then(async (response) => {
        if (response.status === 401 || response.status === 403) {
          const error = new ConnectTunnelCredentialRejectedError(
            `machine label assignment rejected: HTTP ${response.status}`,
          );
          this.markCredentialRejected(error.message);
          throw error;
        }
        if (!response.ok) {
          throw new Error(
            `machine label assignment failed: HTTP ${response.status}`,
          );
        }
        const body: unknown = await response.json();
        if (
          typeof body !== "object" ||
          body === null ||
          !("label" in body) ||
          typeof body.label !== "string"
        ) {
          throw new Error("machine label assignment returned an invalid body");
        }
        const identity = hostDaemonConnectTunnelIdentitySchema.parse({
          label: body.label,
          baseDomain: gate.baseDomain,
        });
        this.identity = identity;
        this.options.onIdentity?.(identity);
        return identity;
      })
      .finally(() => {
        if (this.identityPromise === pending) {
          this.identityPromise = undefined;
        }
      });
    this.identityPromise = pending;
    return pending;
  }

  shutdown(): void {
    this.stopped = true;
    this.goOffline();
  }

  private applyShareSet(shares: HostDaemonConnectShares): void {
    const previousPorts = this.ports;
    this.generation = shares.generation;
    this.ports = new Set(shares.ports);

    if (!this.hasConnectIntent()) {
      this.goOffline();
      return;
    }

    const removedPort = [...previousPorts].some(
      (port) => !this.ports.has(port),
    );
    if (removedPort) {
      this.stopCurrentConnection();
    }
    this.state = "reconnecting";
    this.ensureConnected();
    this.publish();
  }

  private hasConnectIntent(): boolean {
    return (
      !this.stopped &&
      this.ports.size > 0 &&
      this.machineCredential !== undefined &&
      !this.credentialRejected
    );
  }

  private ensureConnected(): void {
    if (
      !this.hasConnectIntent() ||
      this.socket ||
      this.reconnectTimer ||
      this.connectAttempt
    ) {
      return;
    }
    const epoch = this.connectionEpoch;
    let attempt: Promise<void>;
    attempt = this.ensureTunnelIdentity()
      .then((identity) => {
        if (epoch !== this.connectionEpoch || !this.hasConnectIntent()) {
          return;
        }
        this.openTunnel(identity);
      })
      .catch((error: unknown) => {
        if (epoch !== this.connectionEpoch || !this.hasConnectIntent()) {
          return;
        }
        if (error instanceof ConnectTunnelCredentialRejectedError) {
          return;
        }
        this.lastError = error instanceof Error ? error.message : String(error);
        this.state = "reconnecting";
        this.options.logger.warn({ err: error }, this.lastError);
        this.scheduleReconnect(0);
        this.publish();
      })
      .finally(() => {
        if (this.connectAttempt === attempt) {
          this.connectAttempt = undefined;
        }
        if (this.hasConnectIntent() && !this.socket && !this.reconnectTimer) {
          this.ensureConnected();
        }
      });
    this.connectAttempt = attempt;
  }

  private openTunnel(identity: HostDaemonConnectTunnelIdentity): void {
    const credential = this.machineCredential;
    if (!this.hasConnectIntent() || !credential) {
      return;
    }

    const tunnelUrl = buildMachineTunnelUrl(identity);
    this.state = "reconnecting";
    this.options.logger.info(
      { label: identity.label, ports: [...this.ports], tunnelUrl },
      "Machine tunnel connecting",
    );

    let socket: NodeWebSocket;
    try {
      socket = this.createWebSocket(tunnelUrl, {
        headers: { authorization: `Bearer ${credential}` },
      });
    } catch (error) {
      this.lastError = `cannot dial ${tunnelUrl}: ${
        error instanceof Error ? error.message : String(error)
      }`;
      this.options.logger.warn({ err: error, tunnelUrl }, this.lastError);
      this.scheduleReconnect(0);
      this.publish();
      return;
    }

    this.socket = socket;
    let connectedAt = 0;
    let socketSession: TunnelSession | undefined;
    let rejectedStatus: number | undefined;
    socket.on("open", () => {
      if (this.socket !== socket || !this.hasConnectIntent()) {
        socket.terminate();
        return;
      }
      connectedAt = Date.now();
      this.state = "connected";
      this.lastError = null;
      socketSession = new TunnelSession({
        tunnel: socket,
        log: {
          warn: (message) =>
            this.options.logger.warn({ label: identity.label }, message),
        },
        resolveOrigin: (target) => this.resolveOrigin(target),
      });
      this.session = socketSession;
      socketSession.start();
      this.options.logger.info(
        { label: identity.label, ports: [...this.ports] },
        "Machine tunnel connected",
      );
      this.publish();
    });
    socket.on("unexpected-response", (_request, response) => {
      if (this.socket !== socket) {
        return;
      }
      rejectedStatus = response.statusCode ?? 0;
      this.lastError = `machine tunnel rejected: HTTP ${rejectedStatus}`;
      this.options.logger.warn(
        { label: identity.label, statusCode: rejectedStatus },
        this.lastError,
      );
      if (rejectedStatus === 401 || rejectedStatus === 403) {
        this.credentialRejected = true;
      }
      response.resume();
      socket.terminate();
      this.publish();
    });
    socket.on("error", (error: Error) => {
      if (this.socket !== socket || rejectedStatus !== undefined) {
        return;
      }
      this.lastError = humanizeTransportError(
        error,
        `${identity.label}.${identity.baseDomain}`,
      );
      this.publish();
    });
    socket.on("close", (code: number, reason: Buffer) => {
      socketSession?.dispose();
      if (this.session === socketSession) {
        this.session = undefined;
      }
      if (this.socket !== socket) {
        return;
      }
      this.socket = undefined;
      if (!this.hasConnectIntent()) {
        this.state = "offline";
        this.backoff.reset();
        this.publish();
        return;
      }
      if (this.lastError === null) {
        this.lastError = `machine tunnel closed (code ${code}${
          reason.length > 0 ? `, ${reason.toString()}` : ""
        })`;
      }
      this.state = "reconnecting";
      this.scheduleReconnect(connectedAt === 0 ? 0 : Date.now() - connectedAt);
      this.publish();
    });
    this.publish();
  }

  private scheduleReconnect(connectedForMs: number): void {
    if (!this.hasConnectIntent() || this.reconnectTimer) {
      return;
    }
    const delay = this.backoff.nextDelayAfterClose(connectedForMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.ensureConnected();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private resolveOrigin(target: string | undefined): StreamOriginResult {
    if (target === undefined) {
      return { kind: "unregistered" };
    }
    const port = Number(target);
    const identity = this.identity;
    if (!Number.isInteger(port) || !this.ports.has(port) || !identity) {
      return { kind: "unregistered" };
    }
    return {
      kind: "ok",
      resolved: {
        origin: `http://127.0.0.1:${port}`,
        publicOrigin: buildMachineSharePublicOrigin(identity, port),
        host: `127.0.0.1:${port}`,
      },
    };
  }

  private markCredentialRejected(message: string): void {
    this.credentialRejected = true;
    this.lastError = message;
    this.state = "offline";
    this.stopCurrentConnection();
    this.backoff.reset();
    this.publish();
  }

  private reportCurrentIdentity(): void {
    if (this.identity) {
      this.options.onIdentity?.(this.identity);
    }
  }

  private goOffline(): void {
    this.stopCurrentConnection();
    this.state = "offline";
    this.lastError = null;
    this.backoff.reset();
    this.publish();
  }

  private stopCurrentConnection(): void {
    this.connectionEpoch += 1;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.session?.dispose();
    this.session = undefined;
    const socket = this.socket;
    this.socket = undefined;
    socket?.terminate();
  }

  private publish(): void {
    this.options.onStatusChange?.(this.status());
  }
}
