import type { SidebarSectionId } from "./sidebarSectionId.js";
import {
  applyNeighborReorder,
  buildNeighborReorderRequest,
} from "./neighbor-reorder.js";

type SidebarEntitySectionKind = "project" | "section" | "machine";
export type LegacySidebarEntityAnchor = "projects" | "sections" | "machines";

export function buildSidebarEntitySectionId(
  kind: SidebarEntitySectionKind,
  id: string,
): SidebarSectionId {
  return `${kind}:${id}`;
}

function isSidebarSectionId(value: string): value is SidebarSectionId {
  return (
    value === "pinned" ||
    value === "threads" ||
    value.startsWith("project:") ||
    value.startsWith("section:") ||
    value.startsWith("machine:")
  );
}

interface ReorderSidebarSectionOrderArgs {
  activeId: string;
  overId: string;
  order: readonly SidebarSectionId[];
}

export function reorderSidebarSectionOrder({
  activeId,
  overId,
  order,
}: ReorderSidebarSectionOrderArgs): SidebarSectionId[] | null {
  if (!isSidebarSectionId(activeId) || !isSidebarSectionId(overId)) {
    return null;
  }
  const items = order.map((id) => ({ id }));
  const request = buildNeighborReorderRequest({ activeId, overId, items });
  if (!request) return null;
  return applyNeighborReorder({ items, request })
    .map((item) => item.id)
    .filter(isSidebarSectionId);
}

interface NormalizeSidebarSectionOrderArgs {
  storedOrder: readonly string[];
  entitySectionIds: readonly SidebarSectionId[];
  legacyEntityAnchor: LegacySidebarEntityAnchor;
  hasPinnedSection: boolean;
  hasThreadsSection?: boolean;
}

export function normalizeSidebarSectionOrder({
  storedOrder,
  entitySectionIds,
  legacyEntityAnchor,
  hasPinnedSection,
  hasThreadsSection = true,
}: NormalizeSidebarSectionOrderArgs): SidebarSectionId[] {
  const available = new Set<SidebarSectionId>([
    ...(hasPinnedSection ? (["pinned"] as const) : []),
    ...entitySectionIds,
    ...(hasThreadsSection ? (["threads"] as const) : []),
  ]);
  const entitySet = new Set(entitySectionIds);
  const seen = new Set<SidebarSectionId>();
  const normalized: SidebarSectionId[] = [];
  let expandedLegacyAnchor = false;

  const append = (sectionId: SidebarSectionId) => {
    if (!available.has(sectionId) || seen.has(sectionId)) {
      return;
    }
    seen.add(sectionId);
    normalized.push(sectionId);
  };

  for (const storedId of storedOrder) {
    if (storedId === legacyEntityAnchor) {
      expandedLegacyAnchor = true;
      for (const entityId of entitySectionIds) {
        append(entityId);
      }
      continue;
    }
    if (isSidebarSectionId(storedId)) {
      append(storedId);
    }
  }

  if (hasPinnedSection && !seen.has("pinned")) {
    normalized.unshift("pinned");
    seen.add("pinned");
  }

  const missingEntities = entitySectionIds.filter(
    (sectionId) => !seen.has(sectionId),
  );
  if (missingEntities.length > 0) {
    const lastEntityIndex = normalized.reduce(
      (lastIndex, sectionId, index) =>
        entitySet.has(sectionId) ? index : lastIndex,
      -1,
    );
    const threadsIndex = normalized.indexOf("threads");
    const insertionIndex =
      lastEntityIndex >= 0
        ? lastEntityIndex + 1
        : threadsIndex >= 0 || expandedLegacyAnchor
          ? Math.max(threadsIndex, 0)
          : normalized.length;
    normalized.splice(insertionIndex, 0, ...missingEntities);
    for (const sectionId of missingEntities) {
      seen.add(sectionId);
    }
  }

  if (hasThreadsSection && !seen.has("threads")) {
    normalized.push("threads");
  }

  return normalized;
}
