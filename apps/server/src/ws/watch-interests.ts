import { getEnvironment, getThread, type DbConnection } from "@bb/db";
import {
  realtimeSubscriptionTargetKey,
  type ChangedMessage,
  type EnvironmentChangeKind,
  type RealtimeSubscriptionTarget,
  type ThreadChangeKind,
  type ThreadEventType,
} from "@bb/domain";
import type {
  HostDaemonWatchSet,
  HostDaemonWatchSetThreadStorageTarget,
  HostDaemonWatchSetWorkspaceTarget,
} from "@bb/host-daemon-contract";
import { workspaceContextFromPath } from "../services/environments/workspace-command-target.js";
import type { NotificationHub } from "./hub.js";

interface WatchInterestSocket {
  close(code?: number, reason?: string): void;
  send(data: string): void;
}

interface WatchInterestCoordinatorDeps {
  db: DbConnection;
  hub: NotificationHub;
}

interface ResolvedWatchInterestTarget {
  hostId: string;
  threadStorageTarget?: HostDaemonWatchSetThreadStorageTarget;
  workspaceTarget?: HostDaemonWatchSetWorkspaceTarget;
}

const WATCH_TARGET_ENVIRONMENT_CHANGE_KINDS = new Set<EnvironmentChangeKind>([
  "environment-created",
  "environment-deleted",
  "metadata-changed",
  "status-changed",
]);
const WATCH_TARGET_THREAD_CHANGE_KINDS = new Set<ThreadChangeKind>([
  "archived-changed",
  "environment-changed",
  "status-changed",
  "thread-created",
  "thread-deleted",
]);
const THREAD_PROVISIONING_EVENT_TYPE =
  "system/thread-provisioning" satisfies ThreadEventType;

function emptyWatchSet(generation: number): HostDaemonWatchSet {
  return {
    generation,
    workspaceTargets: [],
    threadStorageTargets: [],
  };
}

function isWatchableSubscriptionTarget(
  target: RealtimeSubscriptionTarget,
): target is Extract<
  RealtimeSubscriptionTarget,
  { kind: "environment-detail" | "thread-detail" }
> {
  return (
    target.kind === "environment-detail" || target.kind === "thread-detail"
  );
}

export class WatchInterestCoordinator {
  private readonly interestsBySocket = new Map<
    WatchInterestSocket,
    Set<string>
  >();
  private readonly socketsByInterest = new Map<
    string,
    Set<WatchInterestSocket>
  >();
  private readonly targetsByInterest = new Map<
    string,
    RealtimeSubscriptionTarget
  >();
  private readonly generationByHost = new Map<string, number>();
  private readonly lastWatchTargetFingerprintByHost = new Map<string, string>();
  private readonly lastResolvedHostIdsByInterest = new Map<
    string,
    Set<string>
  >();

  constructor(private readonly deps: WatchInterestCoordinatorDeps) {
    this.deps.hub.onChangedMessage((message) => {
      this.refreshWatchSetsForChangedMessage(message);
    });
  }

  subscribe(
    socket: WatchInterestSocket,
    target: RealtimeSubscriptionTarget,
  ): void {
    if (!isWatchableSubscriptionTarget(target)) {
      return;
    }

    const key = realtimeSubscriptionTargetKey(target);
    const socketInterests =
      this.interestsBySocket.get(socket) ?? new Set<string>();
    const wasPresent = socketInterests.has(key);
    socketInterests.add(key);
    this.interestsBySocket.set(socket, socketInterests);

    const sockets =
      this.socketsByInterest.get(key) ?? new Set<WatchInterestSocket>();
    sockets.add(socket);
    this.socketsByInterest.set(key, sockets);
    this.targetsByInterest.set(key, target);

    if (wasPresent) {
      return;
    }
    this.sendSnapshotsForInterestKey(key);
  }

  unsubscribe(
    socket: WatchInterestSocket,
    target: RealtimeSubscriptionTarget,
  ): void {
    if (!isWatchableSubscriptionTarget(target)) {
      return;
    }

    const key = realtimeSubscriptionTargetKey(target);
    const socketInterests = this.interestsBySocket.get(socket);
    if (!socketInterests?.has(key)) {
      return;
    }

    socketInterests.delete(key);
    if (socketInterests.size === 0) {
      this.interestsBySocket.delete(socket);
    }

    const sockets = this.socketsByInterest.get(key);
    if (sockets) {
      sockets.delete(socket);
      if (sockets.size === 0) {
        this.socketsByInterest.delete(key);
        this.targetsByInterest.delete(key);
      }
    }

    this.sendSnapshotsForInterestKey(key);
    if (!this.socketsByInterest.has(key)) {
      this.lastResolvedHostIdsByInterest.delete(key);
    }
  }

  releaseSocket(socket: WatchInterestSocket): void {
    const socketInterests = this.interestsBySocket.get(socket);
    if (!socketInterests) {
      return;
    }

    const affectedInterestKeys = [...socketInterests];
    this.interestsBySocket.delete(socket);
    for (const key of affectedInterestKeys) {
      const sockets = this.socketsByInterest.get(key);
      if (!sockets) {
        continue;
      }
      sockets.delete(socket);
      if (sockets.size === 0) {
        this.socketsByInterest.delete(key);
        this.targetsByInterest.delete(key);
      }
    }

    const affectedHostIds = new Set<string>();
    for (const key of affectedInterestKeys) {
      for (const hostId of this.hostIdsForInterestKey(key)) {
        affectedHostIds.add(hostId);
      }
      if (!this.socketsByInterest.has(key)) {
        this.lastResolvedHostIdsByInterest.delete(key);
      }
    }
    this.sendSnapshotsForHosts(affectedHostIds);
  }

  reconcileWatchSetForHost(hostId: string): HostDaemonWatchSet {
    return this.resolveWatchSetForHost({
      generation: this.generationByHost.get(hostId) ?? 0,
      hostId,
    });
  }

  refreshWatchSetsForChangedMessage(message: ChangedMessage): void {
    const affectedInterestKeys = this.interestKeysForChangedMessage(message);
    if (affectedInterestKeys.size === 0) {
      return;
    }

    const affectedHostIds = new Set<string>();
    for (const key of affectedInterestKeys) {
      for (const hostId of this.hostIdsForInterestKey(key)) {
        affectedHostIds.add(hostId);
      }
    }
    this.sendSnapshotsForHosts(affectedHostIds);
  }

  private sendSnapshotsForInterestKey(key: string): void {
    this.sendSnapshotsForHosts(this.hostIdsForInterestKey(key));
  }

  private sendSnapshotsForHosts(hostIds: ReadonlySet<string>): void {
    for (const hostId of hostIds) {
      const generation = (this.generationByHost.get(hostId) ?? 0) + 1;
      const watchSet = this.resolveWatchSetForHost({ generation, hostId });
      const fingerprint = JSON.stringify({
        workspaceTargets: watchSet.workspaceTargets,
        threadStorageTargets: watchSet.threadStorageTargets,
      });
      if (this.lastWatchTargetFingerprintByHost.get(hostId) === fingerprint) {
        continue;
      }
      this.lastWatchTargetFingerprintByHost.set(hostId, fingerprint);
      this.generationByHost.set(hostId, generation);
      this.deps.hub.sendDaemonMessage(hostId, {
        type: "watch-set.replace",
        ...watchSet,
      });
    }
  }

  private hostIdsForInterestKey(key: string): Set<string> {
    const hostIds = new Set(this.lastResolvedHostIdsByInterest.get(key) ?? []);
    const target = this.targetsByInterest.get(key);
    if (!target) {
      return hostIds;
    }
    const resolved = this.resolveTarget(target);
    if (resolved) {
      hostIds.add(resolved.hostId);
      this.lastResolvedHostIdsByInterest.set(key, new Set([resolved.hostId]));
    } else {
      this.lastResolvedHostIdsByInterest.delete(key);
    }
    return hostIds;
  }

  private resolveWatchSetForHost(args: {
    generation: number;
    hostId: string;
  }): HostDaemonWatchSet {
    if (this.targetsByInterest.size === 0) {
      return emptyWatchSet(args.generation);
    }

    const workspaceTargets = new Map<
      string,
      HostDaemonWatchSetWorkspaceTarget
    >();
    const threadStorageTargets = new Map<
      string,
      HostDaemonWatchSetThreadStorageTarget
    >();

    for (const [key, target] of this.targetsByInterest) {
      const resolved = this.resolveTarget(target);
      if (!resolved) {
        this.lastResolvedHostIdsByInterest.delete(key);
        continue;
      }
      this.lastResolvedHostIdsByInterest.set(key, new Set([resolved.hostId]));
      if (resolved.hostId !== args.hostId) {
        continue;
      }
      if (resolved.workspaceTarget) {
        workspaceTargets.set(
          resolved.workspaceTarget.environmentId,
          resolved.workspaceTarget,
        );
      }
      if (resolved.threadStorageTarget) {
        threadStorageTargets.set(
          resolved.threadStorageTarget.threadId,
          resolved.threadStorageTarget,
        );
      }
    }

    return {
      generation: args.generation,
      workspaceTargets: [...workspaceTargets.values()],
      threadStorageTargets: [...threadStorageTargets.values()],
    };
  }

  private interestKeysForChangedMessage(message: ChangedMessage): Set<string> {
    const keys = new Set<string>();
    switch (message.entity) {
      case "environment":
        if (!this.environmentChangeCanAffectWatchTargets(message.changes)) {
          return keys;
        }
        if (message.id) {
          this.addKnownInterestKey(
            keys,
            realtimeSubscriptionTargetKey({
              kind: "environment-detail",
              environmentId: message.id,
            }),
          );
        } else {
          this.addInterestKeysWithPrefix(keys, "environment-detail:");
        }
        this.addInterestKeysWithPrefix(keys, "thread-detail:");
        return keys;
      case "thread":
        if (
          !this.threadChangeCanAffectWatchTargets(
            message.changes,
            message.metadata?.eventTypes,
          )
        ) {
          return keys;
        }
        if (message.id) {
          this.addKnownInterestKey(
            keys,
            realtimeSubscriptionTargetKey({
              kind: "thread-detail",
              threadId: message.id,
            }),
          );
        } else {
          this.addInterestKeysWithPrefix(keys, "thread-detail:");
        }
        return keys;
      case "project":
      case "host":
      case "system":
        return keys;
    }
  }

  private addKnownInterestKey(keys: Set<string>, key: string): void {
    if (this.targetsByInterest.has(key)) {
      keys.add(key);
    }
  }

  private addInterestKeysWithPrefix(keys: Set<string>, prefix: string): void {
    for (const key of this.targetsByInterest.keys()) {
      if (key.startsWith(prefix)) {
        keys.add(key);
      }
    }
  }

  private environmentChangeCanAffectWatchTargets(
    changes: readonly EnvironmentChangeKind[],
  ): boolean {
    return changes.some((change) =>
      WATCH_TARGET_ENVIRONMENT_CHANGE_KINDS.has(change),
    );
  }

  private threadChangeCanAffectWatchTargets(
    changes: readonly ThreadChangeKind[],
    eventTypes: readonly ThreadEventType[] | undefined,
  ): boolean {
    return (
      changes.some((change) => WATCH_TARGET_THREAD_CHANGE_KINDS.has(change)) ||
      (changes.includes("events-appended") &&
        eventTypes?.includes(THREAD_PROVISIONING_EVENT_TYPE) === true)
    );
  }

  private resolveTarget(
    target: RealtimeSubscriptionTarget,
  ): ResolvedWatchInterestTarget | null {
    switch (target.kind) {
      case "environment-detail": {
        const environment = getEnvironment(this.deps.db, target.environmentId);
        if (
          !environment ||
          environment.status !== "ready" ||
          !environment.path
        ) {
          return null;
        }
        const workspacePath = environment.path;
        return {
          hostId: environment.hostId,
          workspaceTarget: {
            environmentId: environment.id,
            workspaceContext: workspaceContextFromPath({
              path: workspacePath,
              workspaceProvisionType: environment.workspaceProvisionType,
            }),
          },
        };
      }
      case "thread-detail": {
        const thread = getThread(this.deps.db, target.threadId);
        if (
          !thread ||
          thread.deletedAt !== null ||
          thread.archivedAt !== null
        ) {
          return null;
        }
        if (!thread.environmentId) {
          return null;
        }
        const environment = getEnvironment(this.deps.db, thread.environmentId);
        if (!environment || environment.status === "destroyed") {
          return null;
        }
        return {
          hostId: environment.hostId,
          threadStorageTarget: {
            environmentId: environment.id,
            threadId: thread.id,
          },
        };
      }
      case "thread-list":
      case "project-detail":
      case "project-list":
      case "environment-list":
      case "host-detail":
      case "host-list":
      case "system":
        return null;
    }
  }
}
