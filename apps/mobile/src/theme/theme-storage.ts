import { createMMKV } from "react-native-mmkv";
import type { ThemePreferenceStorage } from "./theme-preference";

export function createThemePreferenceStorage(): ThemePreferenceStorage {
  const store = createMMKV({ id: "bb.preferences" });
  return {
    getString: (key) => store.getString(key),
    set: (key, value) => store.set(key, value),
    remove: (key) => {
      store.remove(key);
    },
  };
}
