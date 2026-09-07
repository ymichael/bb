import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  describePushStatus,
  isPushRegistrationAllowed,
  type PushPermissionState,
  type PushProfileSyncState,
  type PushSyncOutcome,
} from "@/data/notifications";
import { getPushNotificationsModule } from "./expo-push-module";
import { getPushRegistrationController } from "./push-controller";
import { getPushStore } from "./push-storage";

export interface PushRegistration {
  available: boolean;
  enabled: boolean;
  permission: PushPermissionState | null;
  syncing: boolean;
  lastOutcome: PushSyncOutcome | null;
  statusText: string;
  setEnabled(enabled: boolean): Promise<PushSyncOutcome>;
}

const IDLE_STATE: PushProfileSyncState = {
  syncing: false,
  lastOutcome: null,
  permission: null,
};

export function usePushRegistration(profile: {
  id: string;
  serverUrl: string;
  mode: "direct" | "connect";
}): PushRegistration {
  const store = getPushStore();
  const controller = getPushRegistrationController();
  const notifications = getPushNotificationsModule();
  const storeSnapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const controllerSnapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  useEffect(() => {
    void controller.refreshPermission();
  }, [controller]);

  const state = controllerSnapshot.byProfileId[profile.id] ?? IDLE_STATE;
  const enabled = storeSnapshot.enabledProfileIds.includes(profile.id);
  const registration = storeSnapshot.registrations[profile.id] ?? null;
  const setEnabled = useCallback(
    (next: boolean) => controller.setEnabled(profile, next),
    [controller, profile],
  );
  return {
    available:
      notifications.projectId !== null && isPushRegistrationAllowed(profile),
    enabled,
    permission: state.permission,
    syncing: state.syncing,
    lastOutcome: state.lastOutcome,
    statusText: describePushStatus({
      profile,
      projectId: notifications.projectId,
      enabled,
      permission: state.permission,
      registration,
      lastOutcome: state.lastOutcome,
    }),
    setEnabled,
  };
}
