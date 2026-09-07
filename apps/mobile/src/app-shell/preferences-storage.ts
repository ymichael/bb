import { createMMKV } from "react-native-mmkv";
import type { ClearableStorage } from "@/lib/e2e";

export function getPreferencesStorage(): ClearableStorage {
  return createMMKV({ id: "bb.preferences" });
}
