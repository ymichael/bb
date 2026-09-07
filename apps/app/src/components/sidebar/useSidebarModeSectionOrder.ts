import { useCallback, useMemo } from "react";
import { useAtom } from "jotai";
import {
  sidebarManualSectionOrderAtom,
  sidebarMachineSectionOrderAtom,
  sidebarSectionOrderAtom,
  type SidebarOrganizationMode,
  type SidebarSectionId,
} from "./sidebarCollapsedAtoms";
import type { LegacySidebarEntityAnchor } from "@bb/client-core";
import { usePersistedSidebarSectionOrder } from "./usePersistedSidebarSectionOrder";

const MODE_SECTION_ORDER_CONFIG: Record<
  SidebarOrganizationMode,
  {
    atom: typeof sidebarSectionOrderAtom;
    legacyEntityAnchor: LegacySidebarEntityAnchor;
  }
> = {
  project: {
    atom: sidebarSectionOrderAtom,
    legacyEntityAnchor: "projects",
  },
  chronological: {
    atom: sidebarManualSectionOrderAtom,
    legacyEntityAnchor: "sections",
  },
  machine: {
    atom: sidebarMachineSectionOrderAtom,
    legacyEntityAnchor: "machines",
  },
};

interface UseSidebarModeSectionOrderArgs {
  entitySectionIds: readonly SidebarSectionId[];
  hasThreadsSection?: boolean;
  isReady: boolean;
  mode: SidebarOrganizationMode;
  showPinnedSection: boolean;
}

interface UseSidebarModeSectionOrderResult {
  onOrderChange: (order: SidebarSectionId[]) => void;
  order: SidebarSectionId[];
  persistedOrder: SidebarSectionId[];
}

export function useSidebarModeSectionOrder({
  entitySectionIds,
  hasThreadsSection,
  isReady,
  mode,
  showPinnedSection,
}: UseSidebarModeSectionOrderArgs): UseSidebarModeSectionOrderResult {
  const config = MODE_SECTION_ORDER_CONFIG[mode];
  const [storedOrder, setStoredOrder] = useAtom(config.atom);
  const persistedOrder = usePersistedSidebarSectionOrder({
    storedOrder,
    setStoredOrder,
    entitySectionIds,
    legacyEntityAnchor: config.legacyEntityAnchor,
    hasPinnedSection: true,
    ...(hasThreadsSection === undefined ? {} : { hasThreadsSection }),
    isReady,
  });
  const order = useMemo(
    () =>
      persistedOrder.filter(
        (sectionId) => sectionId !== "pinned" || showPinnedSection,
      ),
    [persistedOrder, showPinnedSection],
  );
  const onOrderChange = useCallback(
    (nextOrder: SidebarSectionId[]) => setStoredOrder(nextOrder),
    [setStoredOrder],
  );

  return { onOrderChange, order, persistedOrder };
}
