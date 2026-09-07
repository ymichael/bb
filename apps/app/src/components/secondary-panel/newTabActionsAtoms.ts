import { atomWithStorage } from "jotai/utils";
import { createJsonLocalStorage } from "@/lib/browser-storage";

const NEW_TAB_ACTION_ORDER_STORAGE_KEY = "bb.newTab.actionOrder";

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

export const newTabActionOrderAtom = atomWithStorage<string[]>(
  NEW_TAB_ACTION_ORDER_STORAGE_KEY,
  [],
  createJsonLocalStorage(isStringArray),
  { getOnInit: true },
);
