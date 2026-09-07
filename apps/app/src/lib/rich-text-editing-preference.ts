import { useAtom } from "jotai";
import { createBooleanPreferenceAtom } from "./browser-storage";

const RICH_TEXT_EDITING_STORAGE_KEY = "bb.promptbox.rich-text-editing";

const RICH_TEXT_EDITING_DEFAULT = false;

const richTextEditingPreferenceAtom = createBooleanPreferenceAtom(
  RICH_TEXT_EDITING_STORAGE_KEY,
  RICH_TEXT_EDITING_DEFAULT,
);

export function useRichTextEditingPreference() {
  return useAtom(richTextEditingPreferenceAtom);
}
