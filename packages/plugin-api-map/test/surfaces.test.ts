import { describe, expect, it } from "vitest";

import { ANATOMY_MANIFEST as anatomy } from "../src/index";
import {
  fixtureResponsiveStrategy,
  SURFACE_GROUPS,
  SURFACE_NUMBERS,
  SURFACES_BY_ID,
} from "../src/index";
import {
  ANATOMY_RENDERER_KEYS,
  APP_SHELL_MARKS,
  COMMAND_PALETTE_MARKS,
  COMPOSE_MARKS,
  COMPOSER_MARKS,
  EXTENSIONS_MARKS,
  SETTINGS_MARKS,
} from "../src/index";

const groupById = new Map(SURFACE_GROUPS.map((group) => [group.id, group]));

function surfaceIds(groupId: string): string[] {
  return (groupById.get(groupId as never)?.surfaces ?? []).map(
    (surface) => surface.id,
  );
}

describe("product-map surfaces", () => {
  it("keeps app-window annotations in column-major visual reading order", () => {
    const ordered = [
      "sidebar-navigation",
      "nav-panel",
      "thread-row-status",
      "thread-list",
      "sidebar-footer",
      "thread-header",
      "timeline-renderers",
      "message-directives",
      "message-actions",
      "pending-interaction",
      "code-renderers",
      "thread-panel",
      "file-opener",
      "app-overlay",
      "content-scripts",
    ];
    expect(surfaceIds("app-shell")).toEqual(ordered);
    expect([...APP_SHELL_MARKS]).toEqual(ordered);
  });

  it("gives command palette actions their own numbered page", () => {
    expect(surfaceIds("command-palette")).toEqual(["command-palette-actions"]);
    expect([...COMMAND_PALETTE_MARKS]).toEqual(["command-palette-actions"]);
  });

  it("has globally unique surface ids", () => {
    const all = SURFACE_GROUPS.flatMap((group) =>
      group.surfaces.map((surface) => surface.id),
    );
    expect(new Set(all).size).toBe(all.length);
    expect(SURFACES_BY_ID.size).toBe(all.length);
  });

  it("marks every visual-group surface on its fixture exactly once", () => {
    expect([...APP_SHELL_MARKS].sort()).toEqual(surfaceIds("app-shell").sort());
    expect([...COMMAND_PALETTE_MARKS].sort()).toEqual(
      surfaceIds("command-palette").sort(),
    );
    expect([...COMPOSER_MARKS].sort()).toEqual(surfaceIds("composer").sort());
    expect([...COMPOSE_MARKS].sort()).toEqual(surfaceIds("home").sort());
    expect([...SETTINGS_MARKS].sort()).toEqual(surfaceIds("settings").sort());
    expect([...EXTENSIONS_MARKS].sort()).toEqual(
      surfaceIds("extensions").sort(),
    );
  });

  it("numbers the surfaces a fixture draws, and only those", () => {
    for (const group of SURFACE_GROUPS) {
      const numbers = group.surfaces.map((surface) =>
        SURFACE_NUMBERS.get(surface.id),
      );
      if (group.id === "headless") {
        expect(numbers.every((number) => number === undefined)).toBe(true);
        continue;
      }
      expect(numbers).toEqual(group.surfaces.map((_, index) => index + 1));
    }
  });

  it("derives one responsive strategy from each group's fixture kind", () => {
    for (const group of SURFACE_GROUPS) {
      expect(fixtureResponsiveStrategy(group), group.id).toBe(
        group.fixtureKind === "spatial" ? "scale-together" : "reflow",
      );
    }
    expect(
      SURFACE_GROUPS.filter(
        (group) => fixtureResponsiveStrategy(group) === "scale-together",
      ).map((group) => group.id),
    ).toEqual([
      "app-shell",
      "command-palette",
      "composer",
      "home",
      "settings",
      "extensions",
    ]);
  });

  it("renders every anatomy-manifest region and nothing else", () => {
    for (const area of [
      "appSidebar",
      "sidebarFooter",
      "messageActionBar",
    ] as const) {
      expect([...ANATOMY_RENDERER_KEYS[area]].sort()).toEqual(
        [...anatomy[area]].sort(),
      );
    }
  });

  it("ties every deterministic fixture contract to its visual surface group", () => {
    for (const [surfaceId, contract] of Object.entries(
      anatomy.surfaceFixtures,
    )) {
      const group = groupById.get(contract.groupId as never);
      expect(
        group,
        `${surfaceId}: unknown group ${contract.groupId}`,
      ).toBeDefined();
      expect(
        group?.surfaces.some((surface) => surface.id === surfaceId),
        `${surfaceId}: missing from ${contract.groupId}`,
      ).toBe(true);
      expect(["anchor", "state", "flow"]).toContain(contract.fidelity);
      expect(contract.responsiveStrategy).toBe("scale-together");
      expect(contract.sources.length).toBeGreaterThan(0);
    }
  });

  it("clusters every headless surface into exactly one named section", () => {
    const headless = groupById.get("headless" as never);
    const sectioned = (headless?.sections ?? []).flatMap(
      (section) => section.surfaceIds,
    );
    expect([...sectioned].sort()).toEqual(surfaceIds("headless").sort());
    expect(new Set(sectioned).size).toBe(sectioned.length);
    expect(surfaceIds("headless")).toEqual(sectioned);
  });

  it("keeps the headless group off the surface fixtures", () => {
    const marked = new Set<string>([
      ...APP_SHELL_MARKS,
      ...COMMAND_PALETTE_MARKS,
      ...COMPOSER_MARKS,
      ...COMPOSE_MARKS,
      ...SETTINGS_MARKS,
      ...EXTENSIONS_MARKS,
    ]);
    for (const id of surfaceIds("headless")) {
      expect(marked.has(id)).toBe(false);
    }
  });
});

describe("surface cross-references", () => {
  it("points every [label](id) at a real surface", () => {
    const dangling: string[] = [];
    for (const group of SURFACE_GROUPS) {
      for (const surface of group.surfaces) {
        for (const copy of [surface.summary, ...surface.bullets]) {
          for (const [, id] of copy.matchAll(/\[[^\]]+\]\(([a-z0-9-]+)\)/g)) {
            if (!SURFACES_BY_ID.has(id)) {
              dangling.push(`${surface.id}: "${id}"`);
            }
            if (id === surface.id) {
              dangling.push(`${surface.id}: references itself`);
            }
          }
        }
      }
    }
    expect(dangling).toEqual([]);
  });
});

describe("surface card copy", () => {
  it("follows the lead-then-bullets template", () => {
    for (const group of SURFACE_GROUPS) {
      for (const surface of group.surfaces) {
        expect(surface.summary, surface.id).toMatch(
          /\. With this, a plugin can:$/,
        );
        expect(surface.bullets.length, surface.id).toBeGreaterThanOrEqual(2);
        for (const bullet of surface.bullets) {
          expect(bullet.trim().length, surface.id).toBeGreaterThan(0);
          expect(bullet, `${surface.id}: "${bullet}"`).not.toMatch(/^Can\b/);
        }
      }
    }
  });
});
