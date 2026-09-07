import { useSyncExternalStore } from "react";
import type { PushStoreSnapshot } from "@/data/notifications";
import { getPushStore } from "./push-storage";

export function usePushStoreSnapshot(): PushStoreSnapshot {
  const store = getPushStore();
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
}
