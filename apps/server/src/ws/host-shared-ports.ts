import { getNonDestroyedHost, getSessionById, type DbConnection } from "@bb/db";
import {
  hostDaemonConnectTunnelIdentitySchema,
  type HostDaemonConnectShares,
  type HostDaemonConnectTunnelIdentity,
} from "@bb/host-daemon-contract";
import { ApiError } from "../errors.js";
import type { NotificationHub } from "./hub.js";

interface HostSharedPortCoordinatorDeps {
  db: DbConnection;
  hub: Pick<NotificationHub, "sendDaemonMessage">;
}

interface SharedPortDeclaration {
  ports: number[];
}

interface HostConnectCapability {
  hasMachineCredential: boolean;
  sessionId: string;
}

interface HostConnectCapabilityState {
  capability: HostConnectCapability;
  leaseExpiresAt: number;
}

function normalizePorts(ports: readonly number[]): number[] {
  const normalized = new Set<number>();
  for (const port of ports) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(
        `shared port ${String(port)} must be an integer between 1 and 65535`,
      );
    }
    normalized.add(port);
  }
  return [...normalized].sort((a, b) => a - b);
}

function fingerprint(shares: HostDaemonConnectShares): string {
  return JSON.stringify(shares.ports);
}

export class HostSharedPortCoordinator {
  private readonly declarationsByHost = new Map<
    string,
    Map<string, SharedPortDeclaration>
  >();
  private readonly generationByHost = new Map<string, number>();
  private readonly fingerprintByHost = new Map<string, string>();
  private readonly tunnelIdentityByHost = new Map<
    string,
    HostDaemonConnectTunnelIdentity
  >();
  private readonly tunnelIdentityPromiseByHost = new Map<
    string,
    Promise<HostDaemonConnectTunnelIdentity>
  >();
  private readonly connectCapabilityByHost = new Map<
    string,
    HostConnectCapability
  >();

  constructor(private readonly deps: HostSharedPortCoordinatorDeps) {}

  recordHostConnectCapability(args: {
    hostId: string;
    sessionId: string;
    hasMachineCredential: boolean;
  }): void {
    this.requireShareCapableHost(args.hostId);
    this.connectCapabilityByHost.set(args.hostId, {
      hasMachineCredential: args.hasMachineCredential,
      sessionId: args.sessionId,
    });
  }

  clearHostConnectCapability(sessionId: string): void {
    for (const [hostId, capability] of this.connectCapabilityByHost) {
      if (capability.sessionId === sessionId) {
        this.connectCapabilityByHost.delete(hostId);
      }
    }
  }

  validateSharedPortDeclaration(
    hostId: string,
    ports: readonly number[],
  ): number[] {
    if (hostId.trim().length === 0) {
      throw new Error("shared-port declaration hostId must be non-empty");
    }
    const normalized = normalizePorts(ports);
    if (normalized.length > 0) {
      const host = this.requireDurablyEnrolledHost(hostId);
      const state = this.connectCapabilityState(hostId);
      if (state !== null && !state.capability.hasMachineCredential) {
        this.throwMissingMachineCredential(host);
      }
    }
    return normalized;
  }

  declareSharedPorts(args: {
    ownerId: string;
    hostId: string;
    ports: readonly number[];
  }): void {
    if (args.ownerId.trim().length === 0) {
      throw new Error("shared-port declaration ownerId must be non-empty");
    }
    const ports = this.validateSharedPortDeclaration(args.hostId, args.ports);
    const current = this.declarationsByHost.get(args.hostId);
    const candidate = new Map(current ?? []);
    candidate.set(args.ownerId, { ports });
    this.declarationsByHost.set(args.hostId, candidate);
    this.publishIfChanged(args.hostId);
  }

  replaceDeclarationsForOwner(
    ownerId: string,
    declarations: readonly {
      hostId: string;
      ports: readonly number[];
    }[],
  ): void {
    if (ownerId.trim().length === 0) {
      throw new Error("shared-port declaration ownerId must be non-empty");
    }

    const normalizedByHost = new Map<string, number[]>();
    for (const declaration of declarations) {
      const ports = this.validateSharedPortDeclaration(
        declaration.hostId,
        declaration.ports,
      );
      normalizedByHost.set(declaration.hostId, ports);
    }

    const affectedHostIds = new Set(normalizedByHost.keys());
    for (const [hostId, current] of this.declarationsByHost) {
      if (current.has(ownerId)) affectedHostIds.add(hostId);
    }

    const replacements = new Map<string, Map<string, SharedPortDeclaration>>();
    for (const hostId of affectedHostIds) {
      const replacement = new Map(this.declarationsByHost.get(hostId) ?? []);
      const ports = normalizedByHost.get(hostId);
      if (ports === undefined) replacement.delete(ownerId);
      else replacement.set(ownerId, { ports });
      replacements.set(hostId, replacement);
    }

    for (const [hostId, replacement] of replacements) {
      if (replacement.size === 0) this.declarationsByHost.delete(hostId);
      else this.declarationsByHost.set(hostId, replacement);
    }
    for (const hostId of affectedHostIds) this.publishIfChanged(hostId);
  }

  clearDeclarationsForOwner(ownerId: string): void {
    for (const [hostId, declarations] of this.declarationsByHost) {
      if (!declarations.delete(ownerId)) {
        continue;
      }
      if (declarations.size === 0) {
        this.declarationsByHost.delete(hostId);
      }
      this.publishIfChanged(hostId);
    }
  }

  recordTunnelIdentity(
    hostId: string,
    identity: HostDaemonConnectTunnelIdentity,
  ): HostDaemonConnectTunnelIdentity {
    this.requireConnectedEnrolledHost(hostId);
    const parsed = hostDaemonConnectTunnelIdentitySchema.parse(identity);
    this.tunnelIdentityByHost.set(hostId, parsed);
    return parsed;
  }

  getTunnelIdentity(hostId: string): HostDaemonConnectTunnelIdentity | null {
    this.requireConnectedEnrolledHost(hostId);
    return this.tunnelIdentityByHost.get(hostId) ?? null;
  }

  ensureTunnelIdentity(
    hostId: string,
    ensure: () => Promise<HostDaemonConnectTunnelIdentity>,
  ): Promise<HostDaemonConnectTunnelIdentity> {
    const current = this.getTunnelIdentity(hostId);
    if (current !== null) {
      return Promise.resolve(current);
    }
    const existing = this.tunnelIdentityPromiseByHost.get(hostId);
    if (existing) {
      return existing;
    }
    let pending: Promise<HostDaemonConnectTunnelIdentity>;
    pending = ensure()
      .then((identity) => this.recordTunnelIdentity(hostId, identity))
      .finally(() => {
        if (this.tunnelIdentityPromiseByHost.get(hostId) === pending) {
          this.tunnelIdentityPromiseByHost.delete(hostId);
        }
      });
    this.tunnelIdentityPromiseByHost.set(hostId, pending);
    return pending;
  }

  reconcileSharedPortsForHost(hostId: string): HostDaemonConnectShares {
    const generation = this.generationByHost.get(hostId) ?? 0;
    if (!this.canReceiveSharedPorts(hostId)) {
      return { generation, ports: [] };
    }
    return this.resolveDeclarations(
      this.declarationsByHost.get(hostId) ?? new Map(),
      generation,
    );
  }

  pushCurrentSharedPortsForHost(hostId: string): HostDaemonConnectShares {
    const shares = this.reconcileSharedPortsForHost(hostId);
    this.deps.hub.sendDaemonMessage(hostId, {
      type: "connect-shares.replace",
      ...shares,
    });
    return shares;
  }

  private requireShareCapableHost(hostId: string) {
    if (hostId.trim().length === 0) {
      throw new Error("shared-port declaration hostId must be non-empty");
    }
    const host = getNonDestroyedHost(this.deps.db, hostId);
    if (!host) {
      throw new Error(`cannot declare shared ports for unknown host ${hostId}`);
    }
    return host;
  }

  private requireDurablyEnrolledHost(hostId: string) {
    const host = this.requireShareCapableHost(hostId);
    if (host.connectMachineId === null) {
      throw new ApiError(
        409,
        "connect_host_unenrolled",
        `cannot share ports from host "${host.name}" (${host.id}) because it has no bb connect machine credential; enroll it via Connect in Settings > Machines`,
        false,
      );
    }
    return host;
  }

  private connectCapabilityState(
    hostId: string,
  ): HostConnectCapabilityState | null {
    const capability = this.connectCapabilityByHost.get(hostId);
    const session = capability
      ? getSessionById(this.deps.db, { sessionId: capability.sessionId })
      : null;
    if (
      capability === undefined ||
      session?.hostId !== hostId ||
      session.status !== "active"
    ) {
      return null;
    }
    return { capability, leaseExpiresAt: session.leaseExpiresAt };
  }

  private canReceiveSharedPorts(hostId: string): boolean {
    const host = getNonDestroyedHost(this.deps.db, hostId);
    if (!host || host.connectMachineId === null) return false;
    return (
      this.connectCapabilityState(hostId)?.capability.hasMachineCredential ===
      true
    );
  }

  private requireConnectedEnrolledHost(hostId: string) {
    const host = this.requireDurablyEnrolledHost(hostId);
    const state = this.connectCapabilityState(hostId);
    if (state === null || state.leaseExpiresAt <= Date.now()) {
      throw new ApiError(
        503,
        "connect_host_offline",
        `cannot share ports from host "${host.name}" (${host.id}) because it is not connected right now; bring the host online and try again`,
        true,
      );
    }
    if (!state.capability.hasMachineCredential) {
      this.throwMissingMachineCredential(host);
    }
    return host;
  }

  private throwMissingMachineCredential(host: {
    id: string;
    name: string;
  }): never {
    throw new ApiError(
      409,
      "connect_host_unenrolled",
      `cannot share ports from host "${host.name}" (${host.id}) because it has no bb connect machine credential; enroll it via Connect in Settings > Machines`,
      false,
    );
  }

  private publishIfChanged(hostId: string): void {
    const currentGeneration = this.generationByHost.get(hostId) ?? 0;
    const nextGeneration = currentGeneration + 1;
    const shares = this.resolveDeclarations(
      this.declarationsByHost.get(hostId) ?? new Map(),
      nextGeneration,
    );
    const nextFingerprint = fingerprint(shares);
    const previousFingerprint =
      this.fingerprintByHost.get(hostId) ??
      fingerprint({ generation: currentGeneration, ports: [] });
    if (nextFingerprint === previousFingerprint) {
      return;
    }

    this.fingerprintByHost.set(hostId, nextFingerprint);
    this.generationByHost.set(hostId, nextGeneration);
    if (this.canReceiveSharedPorts(hostId)) {
      this.deps.hub.sendDaemonMessage(hostId, {
        type: "connect-shares.replace",
        ...shares,
      });
    }
  }

  private resolveDeclarations(
    declarations: ReadonlyMap<string, SharedPortDeclaration>,
    generation: number,
  ): HostDaemonConnectShares {
    const ports = new Set<number>();
    for (const declaration of declarations.values()) {
      for (const port of declaration.ports) {
        ports.add(port);
      }
    }
    return {
      generation,
      ports: [...ports].sort((a, b) => a - b),
    };
  }
}
