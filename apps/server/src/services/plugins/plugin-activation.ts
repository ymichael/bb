import { PLUGIN_SDK_VERSION } from "@bb/domain";
import {
  getInstalledPlugin,
  getPluginArtifact,
  getPluginStateSnapshot,
  listIncompletePluginRollbackSnapshots,
  setInstalledPluginLastFailure,
  setPluginStateSnapshotRollbackPending,
  setPluginStateSnapshotStatus,
  upsertInstalledPlugin,
  type InstalledPluginRow,
  type PluginExactResolution,
  type PluginProvenance,
  type PluginSourceIntent,
  type PluginStateSnapshotRow,
} from "@bb/db";
import {
  createPluginStateSnapshotOnDisk,
  readPluginSnapshotRegistration,
  restorePluginHostStateSnapshot,
  restorePluginStateSnapshot,
} from "./plugin-state-snapshot.js";
import {
  garbageCollectPluginArtifacts,
  pluginArtifactStorageRoot,
} from "./plugin-artifact-gc.js";
import type {
  PluginRuntimeStatus,
  PluginServiceDeps,
} from "./plugin-service-internal.js";
import type { PluginManifest } from "./manifest.js";

export class PluginActivationRolledBackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginActivationRolledBackError";
  }
}

interface PluginActivationContext {
  deps: PluginServiceDeps;
  now: () => number;
  artifactRetentionMs: number;
  stabilizationWindowMs: number;
  scheduleStabilizationWindow: (
    durationMs: number,
    onElapsed: () => void,
  ) => () => void;
  stabilizingPluginIds: Set<string>;
  statuses: Map<string, { status: PluginRuntimeStatus; detail: string | null }>;
  statusListeners: Map<
    string,
    Set<(status: PluginRuntimeStatus, detail: string | null) => void>
  >;
  withArtifactLock: <T>(key: string, fn: () => Promise<T>) => Promise<T>;
  withLifecycleLock: <T>(id: string, fn: () => Promise<T>) => Promise<T>;
  disposeOne: (id: string) => Promise<void>;
  loadOne: (row: InstalledPluginRow) => Promise<string | null>;
  restoreRegistration: (row: InstalledPluginRow) => void;
  provenanceForRow: (row: InstalledPluginRow) => PluginProvenance;
  registrationMatchesForActivation: (
    current: InstalledPluginRow,
    expected: InstalledPluginRow,
  ) => boolean;
  emptyPluginUpdateState: () => {
    readonly lastCheckAt: null;
    readonly availableCompatibleVersion: null;
    readonly newestIncompatibleVersion: null;
    readonly statusDetail: null;
  };
  sourceFingerprint: (row: InstalledPluginRow) => string;
  syncCliSkill: () => Promise<void>;
  notifyPluginsChanged: () => void;
}

export function createPluginActivation(context: PluginActivationContext) {
  const {
    deps,
    now,
    artifactRetentionMs,
    stabilizationWindowMs,
    scheduleStabilizationWindow,
    stabilizingPluginIds,
    statuses,
    statusListeners,
    withArtifactLock,
    withLifecycleLock,
    disposeOne,
    loadOne,
    restoreRegistration,
    provenanceForRow,
    registrationMatchesForActivation,
    emptyPluginUpdateState,
    sourceFingerprint,
    syncCliSkill,
    notifyPluginsChanged,
  } = context;
  const logger = deps.logger;

  function requireRollbackMetadata(snapshot: PluginStateSnapshotRow) {
    if (
      snapshot.rollbackCandidateVersion === null ||
      snapshot.rollbackSourceFingerprint === null ||
      snapshot.rollbackBbVersion === null ||
      snapshot.rollbackSdkVersion === null ||
      snapshot.rollbackDetail === null
    ) {
      throw new Error(
        `plugin rollback snapshot ${snapshot.id} is missing rollback metadata`,
      );
    }
    return {
      candidateVersion: snapshot.rollbackCandidateVersion,
      sourceFingerprint: snapshot.rollbackSourceFingerprint,
      bbVersion: snapshot.rollbackBbVersion,
      sdkVersion: snapshot.rollbackSdkVersion,
      detail: snapshot.rollbackDetail,
    };
  }

  async function recoverRollbackWithinLifecycle(
    snapshotId: string,
  ): Promise<void> {
    const snapshot = getPluginStateSnapshot(deps.db, snapshotId);
    if (snapshot === undefined) {
      throw new Error(`plugin rollback snapshot disappeared: ${snapshotId}`);
    }
    const rollback = requireRollbackMetadata(snapshot);
    const previousRegistration = await readPluginSnapshotRegistration({
      db: deps.db,
      snapshotId,
    });
    if (previousRegistration.id !== snapshot.pluginId) {
      throw new Error(
        `plugin rollback snapshot ${snapshot.id} registration id does not match`,
      );
    }
    await disposeOne(snapshot.pluginId);
    await restorePluginStateSnapshot({
      db: deps.db,
      dataDir: deps.dataDir,
      snapshotId,
      now: now(),
    });
    await deps.afterPluginRollbackStateRestored?.({
      pluginId: snapshot.pluginId,
      snapshotId,
    });
    restoreRegistration(previousRegistration);
    if (
      !setInstalledPluginLastFailure(deps.db, snapshot.pluginId, {
        version: rollback.candidateVersion,
        detail: rollback.detail,
        at: now(),
      })
    ) {
      throw new Error(
        `plugin "${snapshot.pluginId}" disappeared during rollback`,
      );
    }
    const previous = getInstalledPlugin(deps.db, snapshot.pluginId);
    if (previous) await loadOne(previous);
    const runtime = statuses.get(snapshot.pluginId);
    if (runtime?.status === "error") {
      throw new Error(
        `plugin "${snapshot.pluginId}" failed to reload during rollback: ${runtime.detail ?? "unknown error"}`,
      );
    }
    await restorePluginHostStateSnapshot({ db: deps.db, snapshotId });
    if (!setPluginStateSnapshotStatus(deps.db, snapshotId, "restored", now())) {
      throw new Error(`plugin rollback snapshot disappeared: ${snapshotId}`);
    }
  }

  async function recoverIncompletePluginRollbacks(): Promise<void> {
    for (const snapshot of listIncompletePluginRollbackSnapshots(deps.db)) {
      const artifact = getPluginArtifact(deps.db, snapshot.toArtifactId);
      const artifactLockKey =
        (artifact === undefined ? null : pluginArtifactStorageRoot(artifact)) ??
        snapshot.snapshotPath;
      await withArtifactLock(artifactLockKey, () =>
        withLifecycleLock(snapshot.pluginId, () =>
          recoverRollbackWithinLifecycle(snapshot.id),
        ),
      );
    }
  }

  async function activateManagedUpdate(args: {
    row: InstalledPluginRow;
    rootDir: string;
    manifest: PluginManifest;
    source: string;
    sourceIntent: PluginSourceIntent;
    exactResolution: PluginExactResolution;
    artifactId: string;
    beforePersist?: () => Promise<void>;
  }): Promise<void> {
    const provenance = provenanceForRow(args.row);
    const candidateVersion =
      args.exactResolution.kind === "npm"
        ? args.exactResolution.version
        : args.exactResolution.kind === "git"
          ? args.exactResolution.commit
          : args.manifest.version;
    await withLifecycleLock(args.row.id, async () => {
      const beforeDispose = getInstalledPlugin(deps.db, args.row.id);
      if (
        beforeDispose === undefined ||
        !registrationMatchesForActivation(beforeDispose, args.row)
      ) {
        throw new Error(
          `plugin "${args.row.id}" registration changed during update`,
        );
      }
      await disposeOne(args.row.id);
      const snapshotNow = now();
      let snapshot: Awaited<ReturnType<typeof createPluginStateSnapshotOnDisk>>;
      try {
        snapshot = await createPluginStateSnapshotOnDisk({
          db: deps.db,
          dataDir: deps.dataDir,
          pluginId: args.row.id,
          fromArtifactId: args.row.activeArtifactId,
          toArtifactId: args.artifactId,
          now: snapshotNow,
          retainedUntil: snapshotNow + artifactRetentionMs,
          previousRegistration: args.row,
        });
      } catch (error) {
        const previous = getInstalledPlugin(deps.db, args.row.id);
        if (previous) await loadOne(previous);
        throw error;
      }
      let pointerWritten = false;
      try {
        await args.beforePersist?.();
        const beforeWrite = getInstalledPlugin(deps.db, args.row.id);
        if (
          beforeWrite === undefined ||
          !registrationMatchesForActivation(beforeWrite, args.row)
        ) {
          throw new Error(
            `plugin "${args.row.id}" registration changed during activation`,
          );
        }
        upsertInstalledPlugin(deps.db, {
          id: args.row.id,
          source: args.source,
          provenance,
          sourceIntent: args.sourceIntent,
          exactResolution: args.exactResolution,
          updateState: emptyPluginUpdateState(),
          activeArtifactId: args.artifactId,
          rootDir: args.rootDir,
          version: args.manifest.version,
          enabled: args.row.enabled,
        });
        pointerWritten = true;
        const current = getInstalledPlugin(deps.db, args.row.id);
        stabilizingPluginIds.add(args.row.id);
        if (current) await loadOne(current);
        const immediate = statuses.get(args.row.id);
        if (immediate?.status === "error") {
          throw new Error(immediate.detail ?? "plugin failed to load");
        }
        if (stabilizationWindowMs > 0) {
          const failure = await new Promise<string | null>((resolveFailure) => {
            let cancelWindow = () => {};
            const listener = (
              status: PluginRuntimeStatus,
              detail: string | null,
            ) => {
              if (status !== "error") return;
              cancelWindow();
              const currentListeners = statusListeners.get(args.row.id);
              currentListeners?.delete(listener);
              if (currentListeners?.size === 0) {
                statusListeners.delete(args.row.id);
              }
              resolveFailure(detail ?? "plugin entered error status");
            };
            let listeners = statusListeners.get(args.row.id);
            if (listeners === undefined) {
              listeners = new Set();
              statusListeners.set(args.row.id, listeners);
            }
            listeners.add(listener);
            cancelWindow = scheduleStabilizationWindow(
              stabilizationWindowMs,
              () => {
                listeners.delete(listener);
                if (listeners.size === 0) statusListeners.delete(args.row.id);
                resolveFailure(null);
              },
            );
            const currentStatus = statuses.get(args.row.id);
            if (currentStatus?.status === "error") {
              listener(currentStatus.status, currentStatus.detail);
            }
          });
          if (failure !== null) throw new Error(failure);
        }
      } catch (error) {
        if (!pointerWritten) {
          const previous = getInstalledPlugin(deps.db, args.row.id);
          if (previous) await loadOne(previous);
          throw error;
        }
        const detail = error instanceof Error ? error.message : String(error);
        if (
          !setPluginStateSnapshotRollbackPending(deps.db, snapshot.id, {
            candidateVersion,
            sourceFingerprint: sourceFingerprint(args.row),
            bbVersion: deps.appVersion,
            sdkVersion: PLUGIN_SDK_VERSION,
            detail,
            updatedAt: now(),
          })
        ) {
          throw new Error(
            `plugin rollback snapshot ${snapshot.id} could not be marked pending`,
          );
        }
        await recoverRollbackWithinLifecycle(snapshot.id);
        throw new PluginActivationRolledBackError(
          `activation of ${args.manifest.version} failed and was rolled back: ${detail}; run apply update again to retry explicitly`,
        );
      } finally {
        stabilizingPluginIds.delete(args.row.id);
      }
    });
    await syncCliSkill();
    notifyPluginsChanged();
  }

  async function runArtifactGc(): Promise<void> {
    await garbageCollectPluginArtifacts({
      db: deps.db,
      dataDir: deps.dataDir,
      now: now(),
      retentionMs: artifactRetentionMs,
      warn: (message) => logger.warn(message),
    });
  }

  return {
    activateManagedUpdate,
    recoverIncompletePluginRollbacks,
    runArtifactGc,
  };
}
