import { createMMKV } from "react-native-mmkv";
import {
  createShellPreferenceStore,
  type ShellPreferenceStore,
} from "./shell-preferences";

let store: ShellPreferenceStore | null = null;

export function getShellPreferenceStore(): ShellPreferenceStore {
  store ??= createShellPreferenceStore(createMMKV({ id: "bb.preferences" }));
  return store;
}
