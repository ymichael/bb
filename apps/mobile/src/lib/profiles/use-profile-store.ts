import { useSyncExternalStore } from "react";
import type { ProfileStore, ProfileStoreState } from "./profile-store";

export function useProfileStoreState(store: ProfileStore): ProfileStoreState {
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
}
