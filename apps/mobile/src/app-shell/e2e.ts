import {
  isE2eModeEnabled,
  resetAppState,
  shouldResetOnLaunch,
  type E2eEnv,
} from "@/lib/e2e";
import { getProfileStore } from "@/lib/native";
import { getPushStore } from "@/notifications/push-storage";
import { getAppProfileClientRegistry } from "./client-registry";
import { getPreferencesStorage } from "./preferences-storage";

const env: E2eEnv = { EXPO_PUBLIC_BB_E2E: process.env.EXPO_PUBLIC_BB_E2E };

export const e2eModeEnabled = isE2eModeEnabled(env, __DEV__);

export const resetOnLaunch = shouldResetOnLaunch(env);

export async function resetLocalState(): Promise<void> {
  await resetAppState({
    profileStore: getProfileStore(),
    preferences: getPreferencesStorage(),
    disposeClients: () => getAppProfileClientRegistry().disposeAll(),
  });
  getPushStore().reload();
}
