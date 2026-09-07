import { useEffect, useMemo } from "react";
import type { SidebarSectionId } from "./sidebarCollapsedAtoms";
import {
  normalizeSidebarSectionOrder,
  type LegacySidebarEntityAnchor,
} from "@bb/client-core";
import { haveSameOrder } from "@/lib/stored-order";

interface UsePersistedSidebarSectionOrderArgs {
  entitySectionIds: readonly SidebarSectionId[];
  hasPinnedSection: boolean;
  hasThreadsSection?: boolean;
  isReady: boolean;
  legacyEntityAnchor: LegacySidebarEntityAnchor;
  setStoredOrder: (order: string[]) => void;
  storedOrder: readonly string[];
}

export function usePersistedSidebarSectionOrder({
  entitySectionIds,
  hasPinnedSection,
  hasThreadsSection,
  isReady,
  legacyEntityAnchor,
  setStoredOrder,
  storedOrder,
}: UsePersistedSidebarSectionOrderArgs): SidebarSectionId[] {
  const order = useMemo(
    () =>
      normalizeSidebarSectionOrder({
        storedOrder,
        entitySectionIds,
        legacyEntityAnchor,
        hasPinnedSection,
        ...(hasThreadsSection === undefined ? {} : { hasThreadsSection }),
      }),
    [
      entitySectionIds,
      hasPinnedSection,
      hasThreadsSection,
      legacyEntityAnchor,
      storedOrder,
    ],
  );

  useEffect(() => {
    if (!isReady || haveSameOrder(storedOrder, order)) return;
    setStoredOrder(order);
  }, [isReady, order, setStoredOrder, storedOrder]);

  return order;
}
