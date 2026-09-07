import {
  enablePushForProfile,
  syncPushRegistration,
  unregisterPushRegistration,
  type PushPermissionState,
  type PushSyncDeps,
  type PushSyncOutcome,
  type PushSyncProfile,
} from "./push-registration";

export interface PushProfileSyncState {
  syncing: boolean;
  lastOutcome: PushSyncOutcome | null;
  permission: PushPermissionState | null;
}

export interface PushRegistrationControllerSnapshot {
  byProfileId: Readonly<Record<string, PushProfileSyncState>>;
}

export interface PushRegistrationController {
  getSnapshot(): PushRegistrationControllerSnapshot;
  subscribe(listener: () => void): () => void;
  sync(profile: PushSyncProfile): Promise<PushSyncOutcome>;
  setEnabled(
    profile: PushSyncProfile,
    enabled: boolean,
  ): Promise<PushSyncOutcome>;
  reconcileRemovedProfiles(currentProfileIds: readonly string[]): Promise<void>;
  handleTokenRolled(
    profiles: readonly PushSyncProfile[],
    deviceToken: string,
  ): Promise<void>;
  refreshPermission(): Promise<PushPermissionState>;
}

const IDLE: PushProfileSyncState = {
  syncing: false,
  lastOutcome: null,
  permission: null,
};

export function createPushRegistrationController(
  deps: PushSyncDeps,
): PushRegistrationController {
  const listeners = new Set<() => void>();
  let snapshot: PushRegistrationControllerSnapshot = { byProfileId: {} };
  const inFlight = new Map<
    string,
    { promise: Promise<PushSyncOutcome>; rerun: PushSyncProfile | null }
  >();
  let permission: PushPermissionState | null = null;
  let lastDeviceToken: string | null = null;

  function patch(profileId: string, next: Partial<PushProfileSyncState>): void {
    const current = snapshot.byProfileId[profileId] ?? IDLE;
    snapshot = {
      byProfileId: {
        ...snapshot.byProfileId,
        [profileId]: { ...current, ...next },
      },
    };
    for (const listener of listeners) listener();
  }

  function broadcastPermission(next: PushPermissionState): void {
    permission = next;
    const byProfileId: Record<string, PushProfileSyncState> = {};
    for (const [id, state] of Object.entries(snapshot.byProfileId)) {
      byProfileId[id] = { ...state, permission: next };
    }
    snapshot = { byProfileId };
    for (const listener of listeners) listener();
  }

  async function runSync(profile: PushSyncProfile): Promise<PushSyncOutcome> {
    patch(profile.id, { syncing: true, permission });
    const outcome = await syncPushRegistration(deps, profile);
    patch(profile.id, { syncing: false, lastOutcome: outcome, permission });
    return outcome;
  }

  function sync(profile: PushSyncProfile): Promise<PushSyncOutcome> {
    const existing = inFlight.get(profile.id);
    if (existing) {
      existing.rerun = profile;
      return existing.promise;
    }
    const entry: {
      promise: Promise<PushSyncOutcome>;
      rerun: PushSyncProfile | null;
    } = {
      promise: Promise.resolve({ action: "skipped", reason: "disabled" }),
      rerun: null,
    };
    entry.promise = (async () => {
      let outcome = await runSync(profile);
      while (entry.rerun) {
        const next = entry.rerun;
        entry.rerun = null;
        outcome = await runSync(next);
      }
      inFlight.delete(profile.id);
      return outcome;
    })();
    inFlight.set(profile.id, entry);
    return entry.promise;
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    sync,
    async setEnabled(profile, enabled) {
      if (enabled) {
        const next = await enablePushForProfile(deps, profile.id);
        broadcastPermission(next);
      } else {
        deps.store.setEnabled(profile.id, false);
      }
      return sync(profile);
    },
    async reconcileRemovedProfiles(currentProfileIds) {
      const current = new Set(currentProfileIds);
      for (const profileId of deps.store.registeredProfileIds()) {
        if (current.has(profileId)) continue;
        const outcome = await unregisterPushRegistration(deps, profileId);
        if (outcome.action !== "failed") deps.store.forgetProfile(profileId);
      }
    },
    async handleTokenRolled(profiles, deviceToken) {
      if (deviceToken === lastDeviceToken) return;
      lastDeviceToken = deviceToken;
      for (const profile of profiles) {
        if (!deps.store.getRegistration(profile.id)) continue;
        if (inFlight.has(profile.id)) continue;
        await sync(profile);
      }
    },
    async refreshPermission() {
      const next = await deps.notifications.getPermission();
      if (next !== permission) broadcastPermission(next);
      return next;
    },
  };
}
