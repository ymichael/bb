import { createMMKV } from "react-native-mmkv";
import {
  createPushStore,
  createPushSubscriptionsApi,
  type PushStore,
  type PushSubscriptionsApi,
} from "@/data/notifications";
import { createMobileFetch } from "@/lib/sdk/mobile-fetch";

let store: PushStore | null = null;
let api: PushSubscriptionsApi | null = null;

export function getPushStore(): PushStore {
  if (!store) {
    const mmkv = createMMKV({ id: "bb.preferences" });
    store = createPushStore({
      getString: (key) => mmkv.getString(key),
      set: (key, value) => mmkv.set(key, value),
      remove: (key) => {
        mmkv.remove(key);
      },
    });
  }
  return store;
}

export function getPushSubscriptionsApi(): PushSubscriptionsApi {
  api ??= createPushSubscriptionsApi(
    createMobileFetch((input, init) => fetch(input, init)),
  );
  return api;
}
