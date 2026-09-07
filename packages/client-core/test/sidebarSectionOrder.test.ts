import { describe, expect, it } from "vitest";
import {
  buildSidebarEntitySectionId,
  normalizeSidebarSectionOrder,
  reorderSidebarSectionOrder,
} from "../src/sidebar/sidebarSectionOrder.js";

describe("normalizeSidebarSectionOrder", () => {
  const projectA = buildSidebarEntitySectionId("project", "a");
  const projectB = buildSidebarEntitySectionId("project", "b");

  it("expands the legacy aggregate section without changing its placement", () => {
    expect(
      normalizeSidebarSectionOrder({
        storedOrder: ["threads", "projects", "pinned"],
        entitySectionIds: [projectA, projectB],
        legacyEntityAnchor: "projects",
        hasPinnedSection: true,
      }),
    ).toEqual(["threads", projectA, projectB, "pinned"]);
  });

  it("preserves a free mixed order of built-ins and entities", () => {
    expect(
      normalizeSidebarSectionOrder({
        storedOrder: [projectB, "pinned", "threads", projectA],
        entitySectionIds: [projectA, projectB],
        legacyEntityAnchor: "projects",
        hasPinnedSection: true,
      }),
    ).toEqual([projectB, "pinned", "threads", projectA]);
  });

  it("drops removed entities and appends new ones after existing entities", () => {
    const projectC = buildSidebarEntitySectionId("project", "c");
    expect(
      normalizeSidebarSectionOrder({
        storedOrder: ["project:removed", "threads", projectB],
        entitySectionIds: [projectA, projectB, projectC],
        legacyEntityAnchor: "projects",
        hasPinnedSection: true,
      }),
    ).toEqual(["pinned", "threads", projectB, projectA, projectC]);
  });

  it("drops a stored Threads section when it is not available", () => {
    expect(
      normalizeSidebarSectionOrder({
        storedOrder: [projectA, "threads", projectB],
        entitySectionIds: [projectA, projectB],
        legacyEntityAnchor: "projects",
        hasPinnedSection: true,
        hasThreadsSection: false,
      }),
    ).toEqual(["pinned", projectA, projectB]);
  });

  it("uses the same reconciliation for sections", () => {
    const section = buildSidebarEntitySectionId("section", "work");
    expect(
      normalizeSidebarSectionOrder({
        storedOrder: ["pinned", "sections", "threads"],
        entitySectionIds: [section],
        legacyEntityAnchor: "sections",
        hasPinnedSection: true,
      }),
    ).toEqual(["pinned", section, "threads"]);
  });
});

describe("reorderSidebarSectionOrder", () => {
  it("moves any entity or built-in section through the shared order", () => {
    expect(
      reorderSidebarSectionOrder({
        activeId: "threads",
        overId: "project:a",
        order: ["pinned", "project:a", "project:b", "threads"],
      }),
    ).toEqual(["pinned", "threads", "project:a", "project:b"]);
  });

  it("rejects ids outside the top-level section contract", () => {
    expect(
      reorderSidebarSectionOrder({
        activeId: "thread:a",
        overId: "project:a",
        order: ["project:a", "threads"],
      }),
    ).toBeNull();
  });
});
