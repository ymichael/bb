import { atomWithStorage } from "jotai/utils";
import { useAtom, useAtomValue } from "jotai";
import { createJsonLocalStorage } from "./browser-storage";
import {
  BUILT_IN_FILE_OPENER_PREFERENCE,
  buildFileOpenerRef,
  type FileOpenerPreferenceMap,
} from "./plugin-slot-resolvers";

export {
  BUILT_IN_FILE_OPENER_PREFERENCE,
  buildFileOpenerRef,
  type FileOpenerPreferenceMap,
};

const FILE_OPENER_PREFERENCE_STORAGE_KEY = "bb.fileOpenerByExtension";

const fileOpenerPreferenceAtom = atomWithStorage<FileOpenerPreferenceMap>(
  FILE_OPENER_PREFERENCE_STORAGE_KEY,
  {},
  createJsonLocalStorage<FileOpenerPreferenceMap>(),
  { getOnInit: true },
);

export function useFileOpenerPreference() {
  return useAtom(fileOpenerPreferenceAtom);
}

export function useFileOpenerPreferenceValue(): FileOpenerPreferenceMap {
  return useAtomValue(fileOpenerPreferenceAtom);
}
