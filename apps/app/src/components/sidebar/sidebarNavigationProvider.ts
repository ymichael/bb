import { useAtomValue } from "jotai";
import {
  createReplacementPreferenceAtom,
  resolvePreferredReplacement,
} from "@/lib/plugin-replacement-preference";
import type { ResolvedReplacement } from "@/lib/plugin-slot-resolvers";
import {
  usePluginSlots,
  type ExperimentalSidebarNavigationSlot,
} from "@/lib/plugin-slots";

const SIDEBAR_NAVIGATION_PROVIDER_STORAGE_KEY = "bb.sidebar.navigationProvider";

export const sidebarNavigationProviderAtom = createReplacementPreferenceAtom(
  SIDEBAR_NAVIGATION_PROVIDER_STORAGE_KEY,
);

export function useSidebarNavigationReplacement(): ResolvedReplacement<ExperimentalSidebarNavigationSlot> {
  const { experimentalSidebarNavigations } = usePluginSlots();
  const preference = useAtomValue(sidebarNavigationProviderAtom);
  return resolvePreferredReplacement(
    experimentalSidebarNavigations,
    preference,
  );
}
