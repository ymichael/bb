import { describe, expect, it, vi } from "vitest";
import {
  PROFILE_INDEX_STORAGE_KEY,
  createProfileStore,
  profileStorageKey,
} from "../profiles/profile-store";
import { createMemorySecureStorage } from "../profiles/secure-storage";
import { isE2eModeEnabled, resetAppState, shouldResetOnLaunch } from "./reset";

describe("resetAppState", () => {
  it("removes every profile, clears the index, disposes clients, and wipes preferences", async () => {
    const storage = createMemorySecureStorage();
    const seed = createProfileStore({ storage });
    const a = await seed.addProfile({
      mode: "direct",
      serverUrl: "http://127.0.0.1:1",
      label: "a",
    });
    const b = await seed.addProfile({
      mode: "direct",
      serverUrl: "http://127.0.0.1:2",
      label: "b",
    });
    await seed.setActiveProfile(b.id);

    const profileStore = createProfileStore({ storage });
    const preferences = { clearAll: vi.fn() };
    const disposeClients = vi.fn();
    await resetAppState({ profileStore, preferences, disposeClients });

    expect(profileStore.getSnapshot()).toMatchObject({
      status: "ready",
      profiles: [],
      activeProfileId: null,
    });
    expect(await storage.getItem(profileStorageKey(a.id))).toBeNull();
    expect(await storage.getItem(profileStorageKey(b.id))).toBeNull();
    expect(
      JSON.parse((await storage.getItem(PROFILE_INDEX_STORAGE_KEY)) ?? ""),
    ).toEqual({
      ids: [],
      activeProfileId: null,
    });
    expect(disposeClients).toHaveBeenCalledTimes(1);
    expect(preferences.clearAll).toHaveBeenCalledTimes(1);
  });
});

describe("e2e mode flags", () => {
  it("wipes on launch only with the explicit env, and accepts the deep link in dev builds", () => {
    expect(shouldResetOnLaunch({})).toBe(false);
    expect(shouldResetOnLaunch({ EXPO_PUBLIC_BB_E2E: "1" })).toBe(true);
    expect(shouldResetOnLaunch({ EXPO_PUBLIC_BB_E2E: "true" })).toBe(false);
    expect(isE2eModeEnabled({}, false)).toBe(false);
    expect(isE2eModeEnabled({}, true)).toBe(true);
    expect(isE2eModeEnabled({ EXPO_PUBLIC_BB_E2E: "1" }, false)).toBe(true);
  });
});
