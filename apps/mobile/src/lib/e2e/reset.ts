import type { ProfileStore } from "../profiles/profile-store";

export interface E2eEnv {
  EXPO_PUBLIC_BB_E2E?: string;
}

export function isE2eModeEnabled(env: E2eEnv, isDevBuild: boolean): boolean {
  return env.EXPO_PUBLIC_BB_E2E === "1" || isDevBuild;
}

export function shouldResetOnLaunch(env: E2eEnv): boolean {
  return env.EXPO_PUBLIC_BB_E2E === "1";
}

export interface ClearableStorage {
  clearAll(): void;
}

export interface ResetAppStateDeps {
  profileStore: ProfileStore;
  preferences: ClearableStorage;
  disposeClients?: () => void;
}

export async function resetAppState(deps: ResetAppStateDeps): Promise<void> {
  await deps.profileStore.load();
  for (const profile of deps.profileStore.listProfiles()) {
    await deps.profileStore.removeProfile(profile.id);
  }
  deps.disposeClients?.();
  deps.preferences.clearAll();
}
